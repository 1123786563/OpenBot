# [bf-B3] Bifrost B 类核验 — #279 / #287 / #295 / #325 / #341

批次：bf-B3（Bifrost 域，B 类）。Worktree：`1123786563/bf027`（BASE `3ca32d49`）。
DB：`TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5561/bf027`（容器 `orca-all-bf027-pg`，保留未删）；另为本批新建 `openbot_enterprise_bf027`（同容器，MT 族专用库，已跑 `scripts/migrate.ts` + MT069/MT070 任务迁移，保留）。
本批改动：**仅 1 处测试侧漂移修复（#287 佐证面，+6 行）**，产品侧零改动（IMPLEMENTED 配额 0/1）。
上一批遗留的 `server/tests/recovery-unacked-replay.integration.test.ts` 4 行 spy 断言保留未动（复核：main `origin/main` 尚未含该 4 行，仍在未提交区）。
本报告覆盖 bf-B2 旧报告（旧批 #264/#270/#272/#273/#278 已结算）。

## 总览

| 票 | 标题 | 结论 |
|---|---|---|
| #279 | Bifrost 08.4 后台重试与失败次数记录 | **SATISFIED（零改动）** |
| #287 | Bifrost 09.2 公司 payer 贯穿全链路 | **BLOCKED-GAP（另附 1 处测试侧漂移修复）** |
| #295 | Bifrost 10.6 个人订单与 Grant 追溯页面 | **SATISFIED（零改动）** |
| #325 | Bifrost 17.1 异步任务身份持久化 | **SATISFIED（零改动）** |
| #341 | Bifrost 20.1 工具/路由附加调用计价维度纳入 | **SATISFIED（零改动）** |

**前置说明（票号勘误）**：批次说明称 "#341（cleanup relations 345-348 线）曾有 b5-347/348 计划记录"。实取 `gh issue view 341` 为 **Bifrost 20.1 工具/路由附加调用计价维度纳入**；cleanup relations 线是 #345-348（`docs/plans/2026-10-17-b5-345/347/348-*.md`），不在本批票单。本批按票单实际票号核验，#341 的 Go 侧+DB 侧等价测试要求仍照做（见该节）。

## #279 Bifrost 08.4 后台重试与失败次数记录 — SATISFIED（零改动）

### AC 逐条实证

- **AC1 重试按退避策略执行，failureCount 与最近原因可查询**：✅ 等价实现＝`usage-delivery.ts` 的投递重试策略（生产已接线 `startUsageDeliverySweeps`，30s 扫描、`MAX_DELIVERY_ATTEMPTS=8`、`MIN_BLOCK_AGE_MS=24h` 双门槛、非重试码立即终态）+ `recovery-replay.ts` 失败计数（`failure_count +1`、`last_reason` 只存稳定 snake_case 码）。`RecoveryItem`（`recovery-scan.ts:105`）携带 failureCount/lastReason 可查询。测试：`billing-usage-delivery.test.ts` 25/25（"a transient failure stays pending until the attempt ceiling, then blocks"、"an exhausted row older than the block age blocks"）；`recovery-unacked-replay.integration.test.ts` 7/7（`failureCount=1`、`lastReason=reservation_released/transient_test_failure`）。
- **AC2 重试期间预留持续占用可用积分**：✅ `recovery-scan.integration.test.ts:358` 断言 unknown hold 仍占用（`held=500`）；replay 失败用例断言 ledger 零行（不结算也不释放）。
- **AC3 超过阈值后进入人工处置队列**：✅ attempts≥8 且 age>24h → `blocked` 终态（`usage-delivery.ts:219-228`），`reconcile.ts` 报表含 `blockedLago/blockedCredits` 人工处置面；`recovery-replay.ts` 对 blocked 项保留不碰。
- **AC4 重试不产生重复结算或重复派发**：✅ replay 用同一 `requestId=eventId` 幂等收敛；测试 "exactly one settlement at the original amount"、"a replay over an already-settled hold converges on the first settlement"。

### 命令与输出摘要

```
bun test ./server/tests/billing-usage-delivery.test.ts                     → 25 pass
TEST_DATABASE_URL=…5561/bf027 bun test ./server/tests/recovery-unacked-replay.integration.test.ts → 7 pass
TEST_DATABASE_URL=…5561/bf027 bun test ./server/tests/recovery-scan.integration.test.ts          → 11 pass
```

### 遗留（记录，不阻塞 AC）

- "退避"是**封顶策略**（固定间隔+次数上限+年龄双门槛），非指数退避；`intervalMs` 可配，`MAX_DELIVERY_ATTEMPTS`/`MIN_BLOCK_AGE_MS` 为编译常量（代码注释记录了该设计取舍，audit C1）。
- `createRecoveryReplay`（08.2 处理器）本身未接线为后台 sweep（`index.ts` 只接了 08.1 扫描）；结算重试由 usage-delivery sweeper 生产承担，recovery item 的 failureCount 由 handler 驱动。属 08 组后续票（08.5/08.9/告警）与产品决策范围。
- 票面 Verification 的 `recovery-retry.test.ts` 不存在；等价证据分散在上述三套件。

## #287 Bifrost 09.2 公司 payer 贯穿全链路 — BLOCKED-GAP（+1 处测试侧漂移修复）

### 结论

本票核心交付（内置工作台消费路径的面级公司 payer 绑定）**未实施**，且仓库内多处代码注释明确把它记为待办：
- `server/src/billing/payer-binding.ts:199`："until group 09 (09.2) wires per-surface payer resolution"；
- `server/src/index.ts:4271`："the branch group 09 (09.2) replaces with per-surface payer resolution"；
- `docs/plans/2026-10-16-b5-219-payer-no-fallback.md` R1：部署默认绑定是 "09.2 的文档化移除点"；
- `docs/plans/2026-10-16-bifrost-5-ledger.md:628`：#286 review 把两条范围裁定移交 "09.2+ 公司 payer 收口票"。

实证缺口：`withPayerBinding`/`resolvePayerForCompanyContext`/`resolveCompanyPayerAccount` 在 `server/src/` **零生产调用方**（仅各自测试引用）——公司工作台请求到达消费 gate（`index.ts:4400` `resolveConsumptionPayerBinding`）时仍解析到部署绑定，不是公司账户。

### AC 逐条实证（现有等价面）

- **AC1 公司调用只变公司余额、个人不变**：❌ 工作台路径未绑公司 payer。seam 级已有：`multitenancy/company-reservation.test.ts`（MT070）16/16 全绿——公司余额原子预扣、公司 A 不能动公司 B、个人账户对照不动。
- **AC2 准入/用量/结算与尾差同一公司 PayerRef**：半✅ "一个请求一个 payer、不切换" 不变量已钉死（`payer-no-fallback.test.ts` 28/28，含 "reserve, settle and remainder all carry the same external customer id"）；但工作台公司请求的 payer 不是公司账户。
- **AC3 用量记录包含团队与使用人维度**：半✅ `billing_call_attributions`（MT070）按公司/团队/使用人/Bot/调用标识记录，测试绿；`usage_outbox` 有 ownerUserId/botId 无 workspace 维度；均未接到工作台计量路径。
- **AC4 余额不足拒绝不回退个人账户**：✅ 完整（#219/B5-219 交付）：`payer-no-fallback.test.ts` "the hold is refused on the bound account only, with no second resolution"、AC13-forbidden shape 反面钉死。

### 命令与输出摘要

```
TEST_DATABASE_URL=…5561/bf027 bun test ./server/tests/payer-no-fallback.test.ts                       → 28 pass
TEST_DATABASE_URL=…5561/bf027 bunx e2e run --config e2e.unit.config.ts server/tests/payer-company-resolution.test.ts → 8 pass
TEST_DATABASE_URL=…5561/bf027 bun test ./server/tests/payer-company-resolution.integration.test.ts    → 5 pass（修复后）
TEST_DATABASE_URL=…5561/openbot_enterprise_bf027 bun test ./server/tests/multitenancy/company-reservation.test.ts → 16 pass
```

### 缺口（需专项派发，>20 行且跨票）

1. 工作台（公司 scope）请求在消费 gate 前绑定公司 PayerRef（`withPayerBinding(bindPayer(resolvePayerForCompanyContext(scope)))` 面级接线）；
2. 绑定后移除该面的部署默认解析分支（b5-219 清单测试钉住的移除点）；
3. 工作台计量路径补 workspace/使用人归因维度（可复用 `billing_call_attributions`）；
4. 公司/个人双账户余额端到端集成测试（票面 Tests to write）。

### 本批就地修复（测试侧，+6 行）

`server/tests/payer-company-resolution.integration.test.ts:98-108`：受控目录种子行补 `status: "active"`。根因：commit `253bf7e5`（MT005 workspace 资格检查）给 `store.ts` 的 scope 铸造加了 workspace-membership 查询，单测版夹具（`payer-company-resolution.test.ts:85`）同步修过、集成版漏改，导致 4/5 用例稳定 `WORKSPACE_FORBIDDEN`。修复后 5/5 绿，biome lint 干净，`bun run --filter server typecheck` 通过。

## #295 Bifrost 10.6 个人订单与 Grant 追溯页面 — SATISFIED（零改动）

### AC 逐条实证（`app/tests/personal-orders-ui.test.tsx` 8 用例全绿，须整组跑）

- **AC1 追溯来源订单/发放动作**：✅ `orderIdOfPlanGrant traces a plan grant to its funding order`；渲染用例断言 trace-cg-plan 含 `po_123` 与其资金状态、签到/活动发放不名订单、off-format plan grant 追溯到空而非臆猜订单号。
- **AC2 他人订单/订阅/Grant 不可读取**：✅ UI："页面不携带任何账户标识，仅请求本人作用域读取"（URL 审计无 userId/payerId/tenantId 等）；服务端：`billing-statements.test.ts`（原生层 23/23）"statement reads only expose orders created by the authenticated actor"、"bill list and detail return only the signed-in actor's orders"、"a signed-out caller is refused on both reads"（401）。读侧统一走 `billingReadScopeOf(context)`（`server/src/billing/routes.ts:50`）。
- **AC3 Grant 来源与有效期与后端一致**：✅ "Grant 过期状态与服务器一致"；渲染用例断言来源词（套餐/签到奖励/活动/管理员发放）与到期时间原样呈现、页面不自行推导。
- **AC4 订单状态变化在页面正确反映**：✅ "订单状态变化在页面正确反映：pending → paid 经刷新后更新"。

### 命令与输出摘要

```
E2E_UNIT_SCOPE=app bunx e2e run --config e2e.unit.config.ts   → 128 files / 967 tests 全绿（含本票 8 用例）
bunx e2e run --config e2e.unit.config.ts server/tests/billing-statements.test.ts → 23 pass
```

注意：该 app UI 文件**独跑必红**（进程偶合，happy-dom/preload 时序，已知坑），取证必须 `E2E_UNIT_SCOPE=app` 整组跑；独跑红不代表回归。

## #325 Bifrost 17.1 异步任务身份持久化 — SATISFIED（零改动）

### AC 逐条实证

- **AC1 稳定本地身份与固定归属**：✅ Go：`TableProviderJob`（`bifrost/framework/configstore/tables/batchjob.go`）稳定主键 `ProviderJobID(kind,provider,jobID)`（kind+provider+jobID，sweeper/结算/reconciler 同一行）+ fenced 归属列（SelectedKeyID/VirtualKeyID/CustomerID/UserID/TeamID）。openbot：reservation 为锚、`attemptIdForReservation` 纯函数（06.7），replay 同 id（`reservation-status.integration.test.ts` 14/14，含 "a reserve replay after a lost response returns the original reservation and the same attempt id"）。
- **AC2 providerJobID 与本地 jobId 双向映射，允许暂缺**：✅ 等价形态——Go 侧 `JobID` 列+复合主键即映射；openbot 侧 status API 双向可查（"by reservationId" 与 "by attemptId answers the same reservation"）；"允许暂缺"＝`dispatch_result_unknown` 恢复项在无 provider 结果/ID 时仍可命名与恢复（recovery-scan unknown-mark 路径，11/11 绿）。
- **AC3 归属不随会话、Key 或调用方变化**：✅ Go：`TestAccountBatchResults_PrefersBatchJobAttributionOverFetcher`（batch_test.go:1564）——创建者 key/vk 归属在他人 fetch 时不变；openbot："a status query stays answerable after the grant is revoked" + recovery item 固定原 payer（"fixed original reservation, payment account"）。
- **AC4 任务记录含恢复所需预留与版本信息**：✅ `credit_recovery_items` 携带 reservationId/maximum/provider/model/capability/snapshotVersion/rateVersion（全有或全无 CHECK）；Go 侧 `Params` 提交时捕获（video 定价恢复的唯一来源，字段注释明说 load-bearing）。

### 命令与输出摘要

```
cd bifrost/framework && go test ./jobaccounting/...  → ok  0.875s（全模块）
TEST_DATABASE_URL=…5561/bf027 bun test ./server/tests/reservation-status.integration.test.ts → 14 pass
TEST_DATABASE_URL=…5561/bf027 bun test ./server/tests/recovery-scan.integration.test.ts     → 11 pass（#279 节已列）
```

环境注：本机 `GOSUMDB=off`（go env 全局）挡住 GOTOOLCHAIN 自动下载 1.27；用已缓存工具链直跑：`/Users/wuyongjun/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.27.0.darwin-arm64/bin/go test`。后续批次跑 Go 同此法。

## #341 Bifrost 20.1 工具/路由附加调用计价维度纳入 — SATISFIED（零改动）

### AC 逐条实证

- **AC1 全部附加费用调用类型枚举并映射维度**：✅ openbot：`PRICE_DIMENSIONS` 封闭维度表含 `surcharge_web_search`（gateway `pricing.web_search`）与 `surcharge_per_request`（`pricing.request`）——即 v1 wire 实际定价的全部附加字段（`price-snapshot.test.ts` "covers input, output, reasoning, image, audio, cache, video and surcharges"）；Go：MCP 工具执行按 `mcpcatalog` `CostPerExecution`（server+tool 键）、路由/嵌入成本单独计费（`routingembedcost_test.go` 3 用例）、A2A/PreMCP hook 每调用治理点齐备。枚举锚定 wire 字段与 hook 调用点而非工具名清单（符合 Resume hint）。未定价但会收费的供应商工具按 Q20 默认禁用，属 20.2 "可强制限额才启用" 范围。
- **AC2 surcharge 进价格快照，缺项 unknown 非 0**：✅ `price-snapshot.test.ts`（原生层 15/15）："dimensions the manifest does not price are unknown, never 0"、"an unreadable dimension can never be mistaken for free"；未知原因固定码 `price_dim_no_source`/`price_dim_unreadable`。
- **AC3 每次真实工具调用独立计费身份与归属**：✅ Go：`PostMCPHook` 为每次工具执行发 `UsageUpdate{RequestID, BillingNonce, Budgets, RateLimits}`（独立身份+归属，`main.go:1830`）；`dispatchcommitment_test.go` 5 用例（claim 先于 dispatch、重复 claim 拒绝、重启存活、并发单赢）；`accounting_test.go`（retry attempts each billed）。openbot：每次 admitted 调用一个 reservation+attemptId（06.7，见 #325 节）。
- **AC4 工具费用与模型费用数据模型可区分**：✅ 快照维度表 surcharge_* 与 token 维度分立；Go 结算映射 `ToolUsage.WebSearch.NumRequests → SurchargeWebSearch` 与 token usage 分列（`settlementoutbox_test.go:718-725`）。
- 上限包含附加费用（Implementation step 4）：✅ `reserve-bound-rounding.test.ts`（Bun 15/15）——surcharge 维度进 ceiling（"prices every dimension of the vocabulary, not only input and output"）、unknown 维度拒绝（"unknown is never a zero cost"，quantity 为 0 也拒）。

### 命令与输出摘要

```
bunx e2e run --config e2e.unit.config.ts server/tests/price-snapshot.test.ts → 15 pass
bun test ./server/tests/reserve-bound-rounding.test.ts                      → 15 pass
cd bifrost/plugins/governance && go test ./...（1.27.0 工具链直跑）          → ok  16.149s
cd bifrost/framework && go test ./jobaccounting/...                          → ok  0.875s
```

### 遗留（记录）

- 票面 Verification 的 `server/tests/tool-surcharge-pricing.test.ts` 不存在；等价证据在 price-snapshot / reserve-bound-rounding / governance Go 套件。
- 用户明细区分模型与附加费用是下游 20.3 的交付，本票仅数据模型可区分（已满足）。

## 本批改动文件

- `server/tests/payer-company-resolution.integration.test.ts`（+6 行，测试侧漂移修复，#287 节详述；未提交）
- `server/tests/recovery-unacked-replay.integration.test.ts`（上一批遗留 4 行，保留未动）

## 全批统一验证

- `bun run --filter server typecheck` → 通过（exit 0）。
- `bunx biome lint --error-on-warnings server/tests/payer-company-resolution.integration.test.ts` → 干净。
- DB 容器 `orca-all-bf027-pg`（5561）与新库 `openbot_enterprise_bf027` 均保留未删。
