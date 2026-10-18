# b5-271 (Bifrost 07.8) — PostLLM 结算与 result outbox

BASE: `3e8a6072`（工作区含 #267/#260 已集成的前置票未提交改动，本票不改前置实现）。
Go 工具链：`GOTOOLCHAIN=go1.27.0 GOPROXY=off`，go 可执行 `/Users/wuyongjun/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.27.0.darwin-arm64/bin/go`；测试 `go test -C plugins/governance -count=1 .`（bifrost 根无 go.mod）。
TS 测试库：`postgres://openbot:openbot@localhost:5594/openbot_b5_271`（b5-verify-pg2 5594 容器全新库，迁移已应用至 0144；严禁 5432/5435/55432）。

## 前置契约核实（已读实际实现）

- 07.4 `bifrost/plugins/governance/dispatchcommitment.go`：`DispatchCommitmentStore`（Claim 幂等 by AttemptID / ListPending 恢复扫描缝）+ `CreditReservationContextKey` 携带 `CreditReservation{ReservationID, AttemptID(bfat-), MaximumCredits, SnapshotVersion, RateVersion, OutputCapTokens}`。**消费，不改**。进程内 store + 持久后端实现同接口的模式是已验收先例（07.4 集成版），本票 outbox 沿用同一模式。
- 06.9 `server/src/billing/credit-settle.ts`：`POST /settle`（06.1 guard 内）。请求 `{reservationId|attemptId, actualUsage(12 维闭集,全维度必填非负整数), evidence{kind:"provider_usage_report",reference?}, settledBy, idempotencyKey}`；金额不由请求携带——服务端按预留行 LOCKED basis（06.5）精确换算；同预留同金额重放=200 首次结果，异金额=`settlement_conflict`；无预留=`settlement_conflict`。拒绝码封闭集 `{request_invalid, payer_conflict, settlement_conflict, price_basis_not_found, price_unknown, charge_exceeds_ledger}`（422，全部不可重试修复）。
- OpenBot 侧 attemptId = `att-<reservationId>`（reservation-status.ts），gateway 自有 bfat- 身份**不能**作 settle 的 attemptId 字段（服务端会 request_invalid）；settle 消息以 `reservationId`（cr-+16hex）指认预留，bfat- 身份作 outbox 记录幂等键与 `idempotencyKey`。
- 07.7 `outputcapevidence.go` `clampChatUsageToOutputCap(usage, cap)`：输出超 cap 时钳制 CompletionTokens 保留其余部分。结算提取必须复用同一钳制（结算 ≤ 预留证明可强制上限）。
- postHookWorker 现状：用量统计在异步 goroutine（PostLLMHook 返回后才跑）——**不满足**"响应结束前持久化"，故结算写入必须在 PostLLMHook 内同步完成；投递可异步（wg+Cleanup join 先例）。
- BifrostLLMUsage 语义（datasheet/cost.go computeTextCost 先例）：`PromptTokens` 含 cached read+write；`input = Prompt - CachedRead - CachedWrite`（钳非负），`cache_read/cache_write` 钳制后单列；`CompletionTokens` 含 reasoning（Bifrost 计价无独立 reasoning 费率，故 `reasoning` 维结算为 0、output 报完整 completion——与锁定 basis 换算一致，不双重计费）。`ToolUsage.WebSearch.NumRequests` → `surcharge_web_search`。
- OpenBot app.ts 尚未挂载 creditProtocolRoutes（属后续装配票）；本票 TS 侧不动生产代码，集成测试自挂路由（settle-idempotency.integration.test.ts 先例）。
- 边界：07.9 重复 ack 观测、07.10 流式断开 unknown、07.11 失败分类细化、08.1 恢复扫描——均不实现；本票交付其消费的 outbox 与投递语义。

## 设计决策

1. **新文件 `bifrost/plugins/governance/settlementoutbox.go`**（Go 唯一生产代码新文件）：
   - `SettlementOutboxRecord`：AttemptID（记录幂等键=idempotencyKey）、ReservationID、Provider/Model、RequestID/BillingNonce/FallbackIndex、GrantID/PayerKind/PayerID（恢复所需归属）、MaximumCredits/SnapshotVersion/RateVersion（锁定版本）、Outcome（`provider_usage_report`=用量已知可投递 / `usage_unknown`=结果未知保持预留，不投递）、Usage（12 维闭集 struct）、Status（pending/delivered/blocked）、DeliveryAttempts、LastErrorCode、RecordedAt。
   - `SettlementOutbox` 接口：`Record`（幂等 by AttemptID，首写锁定 RecordedAt/Status）、`Pending`（重试队列+08.x 扫描缝）、`MarkDelivered`、`RecordDeliveryFailure`、`MarkBlocked`；默认实现 `localSettlementOutbox`（mutex+map，先例 localDispatchCommitmentStore）。
   - `CreditSettleConfig{Endpoint, ServiceSecret, TimeoutMs}` 挂 `CreditAdmissionConfig.Settle`；未接线→记录照常持久化、投递延后（fail-durable，日志明示）；接线不完整→同上并 Warn。
   - `deliverSettlement`：POST settle door（Bearer 06.1 凭据，默认 5s 超时）；200→MarkDelivered；422（封闭拒绝码全部不可重试）→MarkBlocked(保留证据)；网络/超时/5xx→RecordDeliveryFailure 保持 pending（重试队列），投递尝试上限 8 次后 blocked。
   - `deliverPendingSettlements`：单次驱动 pending 重试队列（08.x 接周期扫描；本票不实现扫描器）。
2. **PostLLMHook 集成（同步持久化，先于返回）**：在 `requestedModel != "" || chargeablePassthrough` 块内、读出 reservation 后、会计 goroutine 之前：仅当 `(!isStreaming || isFinalChunk)` 时提取用量（复用 clampChatUsageToOutputCap；chat/text/responses/embedding 形状，error 走 ExtraFields.BilledUsage）→ 构建 record → **同步 `Record()`**（失败仅记错误日志，commitment 仍 pending，恢复路径兜底，不阻塞响应）→ 用量已知且 settle door 已接线时 goroutine 投递（wg+panic recover，Cleanup join）。
3. **幂等/一致**：一次 attempt 一条记录（Record 幂等）；重投同消息同 idempotencyKey（Settle 以预留为深度幂等权威，同金额重放 200）；结算金额不带价格字段，服务端锁定版本换算（AC4 由 OpenBot 已有实现+集成测试钉住）。
4. **无迁移**：outbox 沿用 07.4 已验收的进程内 store+接口缝模式（"outbox 记录结构与迁移"中迁移部分按先例不需要；持久后端由部署按同一接口接入）。TS 侧无 schema/迁移改动。
5. **TS 侧（settle 消费面）**：新增集成测试 `server/tests/usage-outbox.integration.test.ts`（票面 Verification 指定路径）：以 Go outbox 实际序列化的消息形状（12 维 actualUsage、reservationId、evidence、bfat- idempotencyKey）经真实 06.1 guard 路由结算：金额=锁定 basis 精确换算且与预留一致；同消息重放收敛同一结果（07.9 依赖的既有语义回归）；异金额重放=422 不改台账；零用量消息释放预留不扣费。

## 文件级计划

| 文件 | 动作 |
| --- | --- |
| `bifrost/plugins/governance/settlementoutbox.go` | 新增：record/usage 结构、SettlementOutbox 接口+默认实现、CreditSettleConfig、投递与重试队列驱动 |
| `bifrost/plugins/governance/main.go` | 修改：plugin 字段 `settlements SettlementOutbox` + `settleDoor` 读配置；两个构造器装配；PostLLMHook 插入同步结算写入+异步投递 |
| `bifrost/plugins/governance/settlementoutbox_test.go` | 新增：SettlementOutbox* 命名的 RED→GREEN 测试（顺序/重试/422 blocked/崩溃/unknown/映射） |
| `server/tests/usage-outbox.integration.test.ts` | 新增：网关结算消息形状的 OpenBot 消费面集成测试（真实 guard 路由 + 5594 库） |

## RED→GREEN 验证命令

```bash
# Go（RED 先行：测试引用未实现符号无法编译即 RED；实现后全绿）
cd bifrost && GOTOOLCHAIN=go1.27.0 GOPROXY=off /Users/wuyongjun/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.27.0.darwin-arm64/bin/go test -C plugins/governance -run SettlementOutbox -count=1 .
cd bifrost && GOTOOLCHAIN=go1.27.0 GOPROXY=off /Users/wuyongjun/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.27.0.darwin-arm64/bin/go test -C plugins/governance -count=1 .
# TS（5594 专库）
cd server && TEST_DATABASE_URL='postgres://openbot:openbot@localhost:5594/openbot_b5_271' bun test ./tests/usage-outbox.integration.test.ts
cd server && TEST_DATABASE_URL='postgres://openbot:openbot@localhost:5594/openbot_b5_271' bun test ./tests/settle-idempotency.integration.test.ts ./tests/billing-usage-outbox.integration.test.ts
bun run --filter server typecheck
bunx biome lint --error-on-warnings server/tests/usage-outbox.integration.test.ts
```

## Review Focus

- 顺序性：Record 同步在 PostLLMHook 返回前完成（阻塞 door 测试钉死）；投递失败绝反压到用户响应。
- 不丢失：投递失败 pending+attempts 记录；422 blocked 保留完整记录；unknown 用量不投递不释放（Q12）。
- 金额路径：请求无价格字段；锁定版本换算只在 OpenBot 侧（AC4）。
- 越界检查：不改 07.4/06.9 前置实现；不做恢复扫描（08.1）；不做流式断开（07.10）。
