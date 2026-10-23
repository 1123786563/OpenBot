# B5-292 订阅归属与续期到账（10.3）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) — the dispatched worker executes every task itself with TDD. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 订阅记录在创建时按订单归属到个人账户，续期通知按同一归属幂等入账（每周期一次），回调/客户端无法改写归属，对账按归属账户比对。

**Architecture:** 归属唯一写入者是支付激活（payments service `activateOrder`），通过 `PaymentLagoFacade` 新增可选 `stampSubscriptionOwnership` 落库（owner pair + allowance 周期标记）；投影刷新（webhook/sync upsert）的冲突集合永远不含归属列。续期由 `subscription.*` webhook 触发 + 周期 sweep 兜底：检测 provider 周期越过 allowance 标记后，以 `plan-renewal:<externalSubscriptionId>:<periodStartISO>` 幂等键向订阅归属账户发放，随后前向推进标记。reconcile 的订阅存在性与 plan grant 检查改为按 owner pair / 归属账户匹配。

**Tech Stack:** Bun + TypeScript, Drizzle ORM, PostgreSQL（专用测试库），bun:test。

**Spec:** docs/specs/2026-10-14-bifrost-github-spec.md（AC14/AC19）；docs/specs/2026-10-14-bifrost-integration-design.md（Q27/Q23）；docs/adr/0004-company-team-tenancy.md；CONTEXT.md（Payer/Payment Order/Grant/Reconciliation）。

## Global Constraints

- 归属解析只在服务端：从持久化订单 `ownerPayerRef`（激活时 `resolveActivationOwnership`）取，webhook 载荷与请求体不携带任何归属字段。
- `unknown_owner` 隔离行永不解析为可计费账户（`payerKey` 拒绝，Q23 存量不自动归属）。
- `grantCredits` 是 credit_grants 唯一写入者；续期复用它，幂等键含周期标识，跨周期不得互相误判。
- allowance 标记只前进（`allowance_period_start` 单调递增），乱序投递不能回退。
- SQL 事务保证用真实 PostgreSQL 验证（TEST_DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5590/openbot_b5_292），不用内存 mock。
- 金额全程 ×100 缩放整数（CREDIT_SCALE）。
- 不 commit/push；不改票面 Write scope 之外文件。

## Review Focus

- 重复投递（同 event id 与不同 event id 同 body）不得二次发放 → 测试：同周期重复续期断言 grant 计数不变。
- 跨周期不得被同键误判（键必须含周期标识）→ 测试：P2 续期后 P3 再发新 grant。
- 归属改写路径：webhook 投影刷新、无 owner 的 `ensureSubscription`（admin sync 形状）→ 测试：改写后 owner 列不变。
- 对账不得跨账户聚合：A 账户的 live 订阅不能掩盖 B 账户 applied 订单缺订阅 → 测试：双人账户 reconcile 场景。
- 发放账户错位（grant 落在他人账户）→ 测试：`plan_grant_owner_mismatch` finding。

---

### Task 1: 激活写入订阅归属（AC1 前半 + 契约）

**Files:**
- Modify: `server/src/billing/store.ts`（新增 `stampSubscriptionOwnership`）
- Modify: `server/src/billing/types.ts`（BillingStore 增方法；新增 `SubscriptionOwnershipStamp` 类型）
- Modify: `server/src/billing/payments/service.ts`（PaymentLagoFacade 增可选 `stampSubscriptionOwnership`；activateOrder 在 grant 后、recordActivation(applied) 前调用）
- Modify: `server/src/index.ts`（payments 装配实现 facade 方法 → `createBillingStore(database).stampSubscriptionOwnership`）
- Test: `server/tests/subscription-ownership.integration.test.ts`（新建）

**Interfaces:**
- Consumes: `resolveActivationOwnership`（10.2 已交付，返回 order 含 ownerPayerRef）；`payerKey(ref)`（组 02）。
- Produces: `BillingStore.stampSubscriptionOwnership(input: { externalSubscriptionId: string; ownerPayerKind: PayerKind; ownerPayerId: string; allowancePeriodStart: Date; allowancePeriodEnd: Date }): Promise<void>`（insert-or-update；upsert 冲突集合只含 owner+allowance+updatedAt，绝不触碰 status/planCode；投影 upsert 永不携带归属列）。

- [ ] **Step 1: RED — 集成测试**：完整购买链（真实 payments service + fake 渠道 + 真实 billing service + fetch-stub Lago client）回调到账后断言 `billing_subscriptions` 行 `owner_payer_kind='personal'`、`owner_payer_id=<userId>`、allowance 周期=provider 周期，且 `credit_grants` 的 plan grant 落在 `openbot-personal-<userId>`（与订阅归属同账户）。
- [ ] **Step 2:** 运行 `TEST_DATABASE_URL=... bun test server/tests/subscription-ownership.integration.test.ts`，确认失败（owner 列为 NULL）。
- [ ] **Step 3: GREEN** — 实现上述接口与调用（stamp 失败 → activation 返回 pending 由 sweep 重试；duplicate/legacy 无 owner 不 stamp）。
- [ ] **Step 4:** 测试转绿。

### Task 2: 续期按归属幂等入账（AC1 后半 + AC2）

**Files:**
- Modify: `server/src/billing/store.ts`（新增 `advanceSubscriptionAllowance` 前向守卫、`readLiveOwnedSubscriptions`）
- Modify: `server/src/billing/types.ts`（BillingStore 方法；BillingService 增 `sweepRenewals`；createBillingService deps 增 `renewals?`）
- Modify: `server/src/billing/service.ts`（webhook `subscription.*` 应用成功后运行续期 pass；sweep 走 provider getSubscription 读周期）
- Modify: `server/src/billing/maintenance.ts`（`startBillingRenewalSweeps`，advisory lock key 4_192_007）
- Modify: `server/src/index.ts`（hoist creditWriter；装配 `renewals`：creditsFor 来自 planCatalog，grant 用 `plan-renewal:<subId>:<periodStartISO>` 键；启动 sweep）
- Test: `server/tests/subscription-ownership.integration.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 stamp/allowance 标记；`creditWriter.grantCredits`。
- Produces: `renewals.grantRenewal(input: { externalCustomerId; planCode; externalSubscriptionId; periodStart: Date; periodEnd: Date; totalCents: number }): Promise<{ inserted: boolean }>`；`BillingService.sweepRenewals(): Promise<void>`。

- [ ] **Step 1: RED** — 激活后投递签名 `subscription.updated`（provider 列表周期 P2>P1）：断言 owner 账户新增一条 `plan-renewal:<subId>:<P2start>` grant、allowance 推进到 P2；同 body 换 event id 重投 → grant 计数不变；再投 P3 → 新增 P3 grant（跨周期键不互相误判）。
- [ ] **Step 2:** 确认失败（无续期逻辑，无 grant）。
- [ ] **Step 3: GREEN** — 服务端续期 pass：owner 存在（`payerKey` 成功）且 `creditsFor>0` 且周期未覆盖 → grant →（inserted 或已存在）推进标记；无 owner/计划无积分 → 不入账（无 owner 记 warn），无积分计划仍推进标记。
- [ ] **Step 4:** 测试转绿；`bun test server/tests/billing-webhook.test.ts server/tests/billing-sync.test.ts` 不回归。

### Task 3: 归属不可改写（AC3 守卫测试）

**Files:**
- Test: `server/tests/subscription-ownership.integration.test.ts`（追加）

- [ ] **Step 1:** 守卫测试（钉住既有+新增的不变量）：激活后投递同订阅的签名 `subscription.updated`/`customer.updated` webhook → owner 列与 allowance 不变；以 admin sync 形状调用 `ensureSubscription`（无 owner）→ owner 列不变；`upsertSubscription` 投影写（含 insert 新行）不携带归属列。此组测试允许直接通过（不变量已由 Task 1/2 的写入路径唯一性保证），作为回归钉。
- [ ] **Step 2:** 全文件转绿。

### Task 4: 对账按归属账户比对（AC4）

**Files:**
- Modify: `server/src/billing/reconcile.ts`（PaidOrderRow 增 owner 列；plan grant 检查按 key+归属账户比对，新增 `plan_grant_owner_mismatch`；`applied_without_subscription` 按 owner pair 匹配 live 订阅，不再部署级聚合）
- Test: `server/tests/subscription-ownership.integration.test.ts`（追加）

**Interfaces:**
- Consumes: `payerKey`（纯函数）；Task 1 的 owner 列。
- Produces: reconcile findings 词汇新增 `plan_grant_owner_mismatch`（types.ts 的 code 联合若收窄需同步）。

- [ ] **Step 1: RED** — 直接 `createReconciler(database, deploymentKey, expectedPlanCredits)` 种两家账户：A（applied 订单 + live owned 订阅 + grant 落 A 账户）、B（applied 订单 + 无订阅 + grant 落错账户 C）。断言：B 的 `applied_without_subscription` 存在而 A 的不存在；B 的 `plan_grant_owner_mismatch` 存在；A 无相关 finding。当前实现下 A 的 live 订阅按部署键掩盖 B → 失败。
- [ ] **Step 2:** 确认失败。
- [ ] **Step 3: GREEN** — reconcile 改造；ownerless 遗留订单与 ownerless live 行互配（Q23 不自动归属）。
- [ ] **Step 4:** 测试转绿；`bun test server/tests/billing-reconcile.integration.test.ts server/tests/qa-batch3-reconcile.test.ts` 不回归。

### Task 5: 全量验证与报告

- [ ] `cd server && bun run typecheck`；`cd app && bun run typecheck`（app 未改动则确认通过）。
- [ ] `bunx biome lint --error-on-warnings <changed files>`。
- [ ] `TEST_DATABASE_URL=... bun test server/tests/subscription-ownership.integration.test.ts server/tests/billing-webhook.test.ts server/tests/billing-reconcile.integration.test.ts server/tests/payment-callback-ownership.integration.test.ts`。
- [ ] 写 `.omc/reports/b5-292.md`：变更清单、逐条 AC 证据、命令输出摘要、遗留风险。
