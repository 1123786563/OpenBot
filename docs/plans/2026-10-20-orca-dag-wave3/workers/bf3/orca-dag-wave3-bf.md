# Orca DAG Wave3 — Bifrost 批次（bf3 worktree）执行报告

- Worktree: `/Users/wuyongjun/orca/workspaces/OpenBot/bf3`，BASE = main@2306caaa，分支 `1123786563/bf3`，未提交（无 commit/push 授权）。
- 执行日期：2026-10-20。顺序：#222 → #263 → #265 → #274 → #280。
- 测试库：`postgres://postgres:postgres@127.0.0.1:5566/bf3`（容器 orca-w3-bf-pg）。建库后先以超户执行 `server/ops/enterprise/roles.sql`，再 `DATABASE_URL=... bun server/scripts/migrate.ts`（迁移链含本次新增 0164，journal 已登记）。
- bifrost 子模块：本 worktree 原为未初始化 submodule（github 克隆不可达）。改为从主 checkout 的共享 module store（`~/.git/modules/bifrost`，含 pinned commit e44890f8）做本地 bare clone，gitdir 放在本 worktree 专属的 `.git/worktrees/bf3/modules/bifrost.git`，checkout 到 OpenBot main 钉住的 e44890f8。**子模块零改动**（`git -C bifrost status` 干净）；#265/#274/#280 均为只读验证。
- Go 工具链：go.mod 1.27.0，用缓存 toolchain 直跑（避开 GOSUMDB 网络）：`GOROOT=.../toolchain@v0.0.1-go1.27.0.darwin-arm64 GOTOOLCHAIN=local GOSUMDB=off GOFLAGS=-mod=mod <toolchain>/bin/go test`。

---

## #222 Bifrost 02.8 管理员发放到指定个人账户 — **SATISFIED（零改动，main 已含等价实现）**

main 已交付完整切片：`server/src/billing/routes.ts` 的 `POST /api/admin/billing/credits/personal-grants`（目标账户由 userId 服务端解析，裸 externalCustomerId 为 400）、显式/派生幂等键规则、审计行（operator+解析账户+额度+原因）、甲乙隔离。验收逐条有既有测试钉住。

| 验收标准 | 既有测试（server/tests/admin-credit-grant.integration.test.ts） |
|---|---|
| 重复提交只入账一次 | `the same request with the same idempotencyKey lands once`、`a keyless replay ... also lands once (derived-key rule)` |
| 乙无法查询/消费甲余额 | `after each holds 10, Yi can neither read nor spend Jia's balance` |
| 非管理员被拒 | `a non-administrator is refused and nothing is written` |
| 审计存在且账户来自解析 | `every answered grant has a queryable row ...`、`a bare externalCustomerId ... is a 400` |

**证据**（命令一律先 `cd $(git rev-parse --show-toplevel)`）：
- `TEST_DATABASE_URL=... bun test server/tests/admin-credit-grant.integration.test.ts` → 11 pass / 0 fail，exit 0。
- `bun test app/tests/admin-credit-grant-ui.test.tsx` → 7 pass / 0 fail，exit 0。

## #263 Bifrost 06.12 预留/待结算/实扣接入用户视图 — **SATISFIED（零改动；见附录 A 的 harness 回归说明）**

main 已交付：02.6 只读接口扩展（待结算 reserved/unknown 拆分 + 逐笔预留状态/原因）、页面字段、消费明细按 Bot/模型归因、越权不可见。验收逐条有既有测试：

- 预留后待结算↑可用↓：`after a reserve the user sees pending rise and available fall by the hold`
- 结算后转已消费且与台账一致：`after a settle pending converts to consumed and matches the ledger row`
- 释放后回到可用：`after a release pending falls away and available is whole again`
- 归因+不泄露他人：`consumption entries attribute to the reserving Bot and model`、`a stranger's session sees none of this account's reservations or consumption`
- 只读约束：`the extended reads stay read-only: no insert, update, delete or transaction on the view path`

**证据**：
- `TEST_DATABASE_URL=... bun test server/tests/credit-views.integration.test.ts` → 13 pass / 0 fail，exit 0（本票全部四条 AC 的服务端契约）。
- `E2E_UNIT_OUTPUT=.e2e/tmp-bf-personal-credits bunx e2e run --config e2e.unit.config.ts app/tests/personal-credits-ui.test.tsx` → 3 pass / 5 fail（exit 1）。失败 5 条全部是页面级异步渲染用例，与本票代码无关：同一文件在 2026-10-19 的记录化全量运行（commit 0a85bb42，report 于主 checkout `.e2e/glob-wide/`）为 8/8 全绿，且产品与测试代码自该 commit 起字节不变（`git diff 0a85bb42 2306caaa -- <billing 组件/测试/preload/compat>` 为空）。今日失败属 main 级 e2e node 层 harness 回归，详见附录 A。

## #265 Bifrost 07.2 PreLLM 认证并申请预留 — **SATISFIED（零改动）**

bifrost@e44890f8（OpenBot main 钉住的 commit，即 dev HEAD）已交付 PreLLM 预留链路，四条 AC 各有专属测试（bifrost/plugins/governance/creditreserve_test.go）：

- 成功后继续且上下文携带 reservation/锁定版本：`TestPreLLMReserveSuccessContinuesTheRequestAndCarriesTheReservation`
- 拒绝时供应商调用数为 0：`TestPreLLMReserveRefusalCallsNoProvider`
- 超时/不可达按拒绝：`TestPreLLMReserveTimeoutIsARefusalNotAPassThrough`、`TestPreLLMReserveUnreachableAndServerErrorAreRefusals`
- attemptId 稳定：`TestPreLLMReserveAttemptIDIsStablePerAttempt`、`TestCreditAttemptIDDerivesFromTheAttemptNotTheClock`

**证据**：
- `cd bifrost/plugins/governance && go test -run PreLLMReserve ./...` → ok，exit 0。
- `cd bifrost/plugins/governance && go test ./...` → ok（全包 16.6s），exit 0。

## #274 Bifrost 07.11 计费失败/取消/无 usage 处理 — **SATISFIED（零改动）**

main/子模块已实现三类结果语义（ticket 命名的 `FailureSettlement`/`settle-failure-semantics.test.ts` 不存在，但 AC 由以下既有实现与测试等价覆盖）：

- 已计费失败按实际结算：`settlementoutbox.go settlementUsageFrom` — `bifrostErr.ExtraFields.BilledUsage → known=true → outcome=provider_usage_report` 照常投递结算；内部台账同步计费（main.go `billedReason="partial_usage_on_error"`）。测试：`TestStreamSettlementClientDisconnectStillSettlesTheUsageAlreadyProcessed`（断言 outcome=provider_usage_report、delivered、金额=已发生量）。
- 取消无法确认 → 保持预留：`TestStreamSettlementDisconnectWithoutMeasurableUsageIsRecordedUnknownAndHolds`（outcome=usage_unknown、pending、不投递）。
- 无 usage → unknown 不估算：`TestStreamSettlementFinalChunkWithoutAUsableReportIsRecordedUnknownAndHolds` + `TestPostLLMSettlementOutboxWithoutUsableUsageHoldsTheReservation`（"an unknown result is never delivered as a zero"）。代码内无任何估算路径。
- 未派发且有证据才可释放：网关侧不存在任何自动 release 路径（全仓 `grep -n "elease"` governance 无 release 调用）；释放只由 OpenBot 侧 06.11 交付的 `credit-release.ts` 凭证据执行（`server/tests/settle-idempotency.integration.test.ts` "settling a released hold conflicts" 等覆盖）。失败/取消一律不自动释放（unknown 持续占用，Q12）。

**证据**：`cd bifrost/plugins/governance && go test ./...`（含上述全部用例）→ ok，exit 0。

## #280 Bifrost 08.5 provider 终态查询 — **SATISFIED（已实施）**

main 无等价实现（server/src/billing 仅 recovery-scan(08.1)/recovery-replay(08.2)，无终态查询模块；`recovery-provider-query.test.ts` 不存在）。已按 08.2 replay 的既有形状实施。

**交付物**（5 个文件，sha256 见下）：
1. `server/src/billing/recovery-provider-query.ts` — 终态查询模块：可注入 `ProviderFinalStateSource` 缝隙（未接线即拒绝创建——功能准入，不回答来自虚无的 still_unknown）；三态分类 `settled_evidence / no_charge_evidence / still_unknown`（词汇表闭合 CHECK 约束；无法映射的答案按 still_unknown 处理，绝不乐观解读）；结论写回 RecoveryItem.lastReason；**只记录证据，不结算、不释放、不重派**（实际处置归 08.9，进入释放路径仅当 no_charge_evidence）；still_unknown（含查询失败/无记录）failure_count +1，成功查询不计失败；08.2 replay 形状（有持久化未确认结果）原样让渡，不重复询问更差的证人。
2. `server/src/db/schema/credit-reservations.ts` — 新增 `credit_recovery_queries` 追加型证据表（item FK 级联、conclusion CHECK、usage 成对 CHECK、item+queried_at 索引；时间/来源/原始结论摘要/用量对齐可管理员只读核查——视图本身是 08.8 的票）。
3. `server/drizzle/0164_recovery_provider_queries.sql` — 迁移（expand-only）。
4. `server/drizzle/meta/_journal.json` — 登记 idx 164。
5. `server/tests/recovery-provider-query.integration.test.ts` — 9 条集成测试（真实 PostgreSQL + fake provider，按票面"三类查询结论测试/无记录保持 unknown 断言/证据记录完整性断言"逐条对应；隔离手法沿用 replay 套件的 claim-by-id + park 纪律）。

**证据**（文件名按仓库惯例带 `.integration` 后缀——它需要 TEST_DATABASE_URL，与 08.1/08.2 套件一致；等价于票面 `recovery-provider-query.test.ts`）：
- `TEST_DATABASE_URL=... bun test server/tests/recovery-provider-query.integration.test.ts` → 9 pass / 0 fail，exit 0（连跑 4 次全绿，afterAll 前缀清理已验证无残留）。
- `cd bifrost/framework/jobaccounting && go test ./...` → ok，exit 0（Consumes 的供应商任务终态查询能力，既有交付）。
- `bun run --filter server typecheck` → exit 2，**全部错误来自 main 既有的 `server/scripts/bootstrap-local-gateway.ts`（3 处 TS2339）**，已在主 checkout（d7f68d0e）复现同样报错证明与本次改动无关；本次改动 0 新增错误。
- `bunx biome lint --error-on-warnings <3 个改动源文件>` → exit 0；`bunx biome format` 已应用。
- `bun scripts/db-drift-check.ts`（server/ 下）→ "no drift: 216 declared tables, all columns present both ways"，exit 0。
- 回归：`recovery-scan.integration` + `recovery-unacked-replay.integration` → 18 pass / 0 fail，exit 0；`billing-credits-writer.integration` + `credit-views.integration` → 29 pass / 0 fail，exit 0。

**改动文件 sha256**：
```
ffa4428a328aeb40ee5350a135039974e4ab5379bfb78248ea23a84ce393172c  server/src/billing/recovery-provider-query.ts
e2b9dc46194297023270909e9d5b25f797b22a22240c4d1f56dea1d2209f56e1  server/src/db/schema/credit-reservations.ts
f02ac8454e38657cd270aa845f0a63f3ae77050d5fb30429caadca8a774b3a45  server/drizzle/0164_recovery_provider_queries.sql
2258118e785845ab704c0057e980aba3852ebf6b35b31800aea99c4c80850d00  server/drizzle/meta/_journal.json
f65816a70242f63d07a68b735a9c12c747a157d79d9a051e3e1c59e089503a94  server/tests/recovery-provider-query.integration.test.ts
```

**依赖说明**：Blocked-by #279（08.4 重试调度）在 main 未见实现；本票按"查询动作 + 分类 + 证据"契约落在 08.1 的 claim/failure_count 原语上（与 08.2 replay 的无调度器形状一致），不消费也不阻塞 08.4 的调度切片。真实 provider source 尚未接线（无跨进程查询 API 契约），能力保持未启用，符合"缺凭据不编造供应商证据"的全局约束。

---

## 附录 A — main 级 harness 回归（非本批次代码，建议单独立票）

**现象**：`bunx e2e run --config e2e.unit.config.ts`（node 层）下，React 组件在初始渲染后，异步 setState 永远不再提交到 DOM。影响所有页面级异步 app 套件（如 personal-credits-ui 5/8、personal-orders-ui 6/8 失败），在 bf3 worktree 与主 checkout 上完全复现。

**证据链**：
1. 最小探针（render + useEffect + setTimeout(50ms) + setState，零业务代码）：DOM 恒为初值，`renders=1`、无 unhandledRejection、`await act(async()=>{})` 也无法排空；查询侧 react-query 缓存已 success 而 UI 仍 Skeleton。
2. 同一探针在 **bun 层**（bun-test-compat + `bun test`）立即通过（renders=2）。
3. 环境 primitives 均正常：setImmediate/MessageChannel 原生未被打补丁且会触发、performance.now 前进、happy-dom setTimeout 会触发。
4. 失败文件的产品/测试代码与最后一次全绿记录（0a85bb42，2026-10-19 04:18，`.e2e/glob-wide/report.json`，7930 用例中本文件 8/8 passed）**字节相同**；依赖版本与 bun.lock 一致（react 19.2.8、happy-dom 20.11.6、e2e 0.20.0、node v22.22.3 均与绿run 相同）。
5. RTL 的 `beforeAll` 全局探测为 undefined（e2e 层未注入全局 hook），`IS_REACT_ACT_ENVIRONMENT` 恒 undefined——推测与 RTL 16.3.2/React 19.2.8 在该运行器下的 act 语义交互有关，根因未定位（已停止深挖以守本批次边界）。

**影响**：任何依赖异步重渲染断言的 e2e-node 层 app 套件在本机当前环境红；bun 层与 server 侧不受影响。按仓库两层制（ADR-0008），如需临时绕过可按 manifest 归入 bun 层，但根因修复属测试迁移线所有，本批次未越界处理。

## 附录 B — 其他既存问题（非本批次引入）

- `server/scripts/bootstrap-local-gateway.ts` 3 处 TS2339（typecheck 红）在 main 复现，属 gateway probe 线。
- `tests/bun-suites` 清单中的 personal-credits-ui 为 e2e 原生收集（不在 bun 驱动清单），受附录 A 影响。
