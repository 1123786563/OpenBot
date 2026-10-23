# Bifrost 组 18 批量任务 — 实施方案（#333 → #334 → #335 → #336）

- 父 Spec：`docs/specs/2026-10-14-bifrost-github-spec.md`（#5，AC05/AC07/AC16）
- 执行工作区：`/Users/wuyongjun/orca/workspaces/OpenBot/bf16`（分支 `1123786563/bf16`，BASE `a789f6a4` = main@HEAD）
- 基线：17.x 未提交增量（async_jobs 0188 + triggers 0196 + details 0197，`server/src/billing/async-*.ts`）；开工快照 `.archive/runs/2026-10-21-bf16-batch18/checkpoints/baseline-status.txt`
- 运行证据：`.archive/runs/2026-10-21-bf16-batch18/`；验证环境 `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5566/bf16`（容器 `orca-w3-bf-pg`，wave3 共享容器，不停不删）
- 提交策略：无提交授权 — 未提交检查点，全部改动留在工作区

## DAG（按票序串行，每票内 RED → GREEN → 验证）

```text
18.1 #333 批量整体上限预留   depends_on: 17.x（已交付于基线）
18.2 #334 批量逐条归属结算   depends_on: 18.1
18.3 #335 部分成功结算       depends_on: 18.2
18.4 #336 部分取消不丢不重   depends_on: 18.2、18.3（分类语义）、17.7 取消语义（17.x 基线的 cancelled 终态）
```

## 复用的前置契约（读实现确认，不臆测）

- `computeReservationCeiling`（`server/src/billing/reserve-bound.ts`）返回 `exactScaledUnits` 精确有理数 —— 批量上限 = 逐条 exact 求和后**一次**向上取整，不逐条取整相加。
- `CreditReserveService.reserve`：准入（grant/bot 活跃、payer 服务端解析、cell 开放、目录新鲜、快照已知）全部先于幂等写入；同 key 同额 replay 回答同一 hold（`credits-writer.reserveCredits`）。多 cell 批量以「每个不同 cell 一次 reserve 调用（同一 submit key、同一整批 cap）」获得逐 cell 门禁级准入 + 恰好一个 hold；任一 cell 拒绝 → 释放已建 hold（`bound_refused` 证据）并整批拒绝。
- `credits-writer.settleReservation`：`lineDetail` 闭联合（`jobId`/image/speech 判别），detail 行与台账同一事务；`dimensionBreakdown` 要求成员精确和 == actual。18.2 增加 `batchId` 判别成员（逐条明细行 + Σ逐条 exact == 聚合 actual 断言）。
- `async-terminal.ts`（17.6）：终态结算形态 —— 锁定基版本定价、over-cap 审计、触发计数可观测。批量结算沿同一纪律。
- `credit-release.ts`（06.11）：释放必须携带 no-charge 证据，closed vocabulary；unknown 不释放。
- Bifrost 批量锚点（只读）：`bifrost/framework/jobaccounting/batch.go`（`BatchResultItem`、`custom_id`、`BatchRequestCounts`、`AccountBatchResults`）、`core/schemas/batch.go`（`Failed()`、result.type `succeeded/errored/expired/canceled`）。子模块零提交。

## 每票交付（文件级）

### 18.1 #333 — 整批预留上限 + 父子身份

- `server/drizzle/0198_batch_jobs.sql`：`batch_jobs`（batch_id `bj-` PK、submit key UNIQUE、grant/payer/版本、reservation FK、maximum_credits=整批 cap、item_count、state∈{submitted, dispatch_unconfirmed}+dispatch 形状 CHECK、provider_batch_id 可空）+ `batch_items`（item_id `bi-` PK、batch FK、custom_id 每批 UNIQUE、逐条 model cell、quantities jsonb、(batch_id,item_index) UNIQUE）。
- `server/src/db/schema/credit-reservations.ts`：`batchJobs`/`batchItems` 表定义（async 族同文件）。
- `server/src/billing/batch-submit.ts`：`computeBatchCap`（逐条基版本定价 → exact 求和 → 一次向上取整，纯函数）+ `createBatchSubmitService`（形状校验拒绝账户/公司域字段 → 幂等读 → 逐 cell 准入+reserve（同 key 同 cap）→ 拒绝路径释放 hold → batch+items 同事务落库 → 唯一提交键竞态收敛 → dispatch 一次；answer 丢失 → markUnknown，hold 全额占用）。结构上不存在追加预留路径。
- 测试 `server/tests/batch-reservation.integration.test.ts`：混合模型条目求和正确（exact 和一次取整）；余额不足整批拒绝且 provider spy=0；父子身份同一 payer/同一 hold；同 key replay 单 hold；禁止性字段拒绝。

### 18.2 #334 — 逐条归属结算 + 两级明细

- `server/drizzle/0199_batch_settlement_details.sql`：`credit_batch_settlement_details`（item_id PK/UNIQUE、batch_id、ledger_id FK、逐条 model/capability/terminal_state/actual_usage jsonb/exact_cost jsonb）。
- schema 增表；`credits-writer.ts` 增 `BatchSettlementLineDetail`（`batchId` 判别，items[] 明细同事务写入，Σ逐条 exact == actual 断言）。
- `server/src/billing/batch-settlement.ts`：终态报告（逐条 usage）→ 每条按自身 cell×批次锁定版本定价 → Σ exact 一次 settle（requestId=batchId，title/model 如实）→ 未用余额随 settle 释放 → over-cap 审计（沿 17.6）；两级归因读取（按 batchId / 按 ledger 行）。
- 测试 `server/tests/batch-settlement.integration.test.ts`：3 条批量逐条金额正确、Σ ≤ cap、余额恢复、明细两级归因、同报告 replay 不重扣（reservation 栅栏）、不同 actual 拒绝。

### 18.3 #335 — 部分成功分类

- `server/drizzle/0200_batch_partial_states.sql`：`batch_item_outcomes`（item_id PK、classification∈{completed,failed_billable,not_dispatched,unknown}、provider 终态、evidence jsonb、reports 计数、时间戳）；`batch_jobs` state CHECK 扩 {partial,completed,failed} + 各类计数列 + settled_at。
- `server/src/billing/batch-partial.ts`：纯分类器 `classifyBatchItem`（succeeded+usage→completed；failed 且有 usage→failed_billable；缺结果+not_dispatched 证据→not_dispatched 释放；缺结果无证据→unknown 保持占用；`batch_gone` 等关闭证据）；部分结算 lane：分类落库 → 任一 unknown 则不结算（hold 保持）→ 无 unknown 时 Σ billable 一次 settle、非计费条目随 settle 释放 → 批状态 partial + 各类计数。
- 测试 `server/tests/batch-partial-success.integration.test.ts`：5 条=3 成功+1 已计费失败+1 未派发（有证据）→ 结算 4 条释放 1 条；1 条无证据未派发 → unknown 不释放不结算；状态与计数断言；「整体释放」负例。

### 18.4 #336 — 部分取消不丢不重 + 审计

- `server/drizzle/0201_batch_cancel_semantics.sql`：outcomes classification 增加 `cancelled`；batch state 增加 `cancelled`；cancelled_count 列。
- `server/src/billing/batch-cancel.ts`：条目级取消（`canceled`/取消报告 + 未计费证据 → 释放；已执行条目照常结算）；item_id 为幂等键（outcomes PK + 同 actual replay + reservation 单次 settle 双栅栏）；重复通知计数不重扣；`billing.batch_item_cancelled` 审计（证据随行）；视图读取区分 cancelled vs failed。组 18 缝合链测试：提交→混合（成功/已计费失败/未派发/取消）→结算→「不丢账」（Σ台账==Σ已执行 actual）与「不重扣」（重复通知后台账不变）双向断言。
- 测试 `server/tests/batch-partial-cancel.integration.test.ts`。

## 验证命令（每票 GREEN 后跑）

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5566/bf16 bun test server/tests/batch-<x>.integration.test.ts
cd server && bun run typecheck   # 或根目录 bun run --filter server typecheck
cd bifrost/framework/jobaccounting && go test ./...
bunx biome lint --error-on-warnings <changed files>
node scripts/e2e-add-driven.mjs server/tests/batch-<x>.integration.test.ts "wave3 bf16 18.x 套件"
node scripts/e2e-coverage-audit.mjs   # 新测试登记后 audit
```

迁移登记：`server/drizzle/meta/_journal.json` 追加 idx 198–201（沿 +1000 递增）。

## 风险与边界

- 批量跨模型 → 预留 hold 的 basis lock 只能锁一个 cell（锚点=首个不同 cell）；批次真定价基（批次版本×逐条 cell）在 batch 表，结算不用 hold 的 lock —— 在迁移与模块头注明。
- 基线已知红不修不报；bifrost 子模块只读（零提交）；`server/src/mastra/**`、`.archive/`（除本 run 目录新增证据）不动。
- 用户/管理员视图（18.3/18.4 的“视图”）按 17.x 先例交付服务端读取面（状态/计数/两级明细查询），app UI 不在本组 write scope。
