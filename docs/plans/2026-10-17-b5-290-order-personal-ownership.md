# B5-290 订单记录所属用户（10.1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (本会话内联执行) with superpowers:test-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每张支付订单创建即绑定服务端解析的个人 PayerRef 归属；读取作用域按归属过滤；存量订单按 02.2 显式映射标注，无法确定者隔离为 unknown_owner。

**Architecture:** 订单表加可空归属列对（kind+id 配对 CHECK），记录类型暴露 `ownerPayerRef: PayerRef | null`；下单路径由路由用 `resolvePayerForPersonalUser(auth actor)` 服务端解析归属（请求体 strictObject 拒绝任何身份字段）；`PaymentOrderReadScope` 从 `{actorId}`（createdBy 过滤）收敛为 `{actorPayerRef}`（归属列过滤）；存量标注为幂等 write-once 模块，镜像 payer-legacy.ts 的纪律。

**Tech Stack:** Bun + Hono + drizzle-orm + PostgreSQL（专用测试库 openbot_b5_290v @ b5-verify-pg:5590）。

**Spec:** docs/plans/tickets/bifrost-5/issues/10.1-order-personal-ownership.md；父 Spec docs/specs/2026-10-14-bifrost-integration-design.md（Q27、AC14）；ADR 0004；CONTEXT.md（Payment Order：发起人是审计身份，不必等于付款主体）。

## Global Constraints

- 禁止 git commit / push / stash；未提交检查点收尾。
- 禁止触碰 5432 主库 openbot；只用 openbot_b5_290v（b5-verify-pg:5590）。
- Write scope 仅限：订单模型与下单路径归属接线、订单读取作用域、对应测试（含迁移与 drizzle meta）。
- 不 rewrire 激活/发放到账（那是 10.2）；不改 requireAdmin 购买门槛；不改部署级单 pending 订阅约束。
- provider fake 仅为测试；skipped 测试不算通过。
- 归属不猜测：显式映射之外一律 unknown_owner 隔离，write-once 不重分类。

## Review Focus

- 伪造身份参数（body 带 `userId`/`externalCustomerId`）→ 400 且不产生订单；归属只来自 session actor。（Task 4 路由测试）
- 他主 pending 订单：另一人的重放/换渠道请求不得返回或取消他人订单，只能 409。（Task 3 服务测试）
- 隔离行（unknown_owner / legacy_deployment / 未标注 NULL）对个人 scope 读取永不可见。（Task 2 集成测试）
- 标注重跑幂等：第二次运行零改动，已隔离者即使映射后出现也不重分类。（Task 5 集成测试）
- 部署级 pending 唯一索引在新代码下仍保证并发一单。（既有 store 测试回归）

---

### Task 1: Schema + 迁移（订单归属列）

**Files:**
- Modify: `server/src/db/schema/payment.ts`（paymentOrders 两列 + CHECK + 索引）
- Generate: `server/drizzle/0129_payment_order_owner.sql` + `server/drizzle/meta/0129_snapshot.json` + `server/drizzle/meta/_journal.json`（drizzle-kit generate）

**Interfaces:**
- Produces: 列 `owner_payer_kind text NULL`（CHECK IN ('personal','company','legacy_deployment','unknown_owner')）、`owner_payer_id text NULL`、CHECK `(owner_payer_kind IS NULL) = (owner_payer_id IS NULL)`、索引 `payment_orders_owner_idx` on (owner_payer_id, owner_payer_kind)。
- 类型词汇复用 `PayerKind`（billing/payer.ts，schema 已有 type-only import 先例：db/schema/billing.ts:12）。

- [ ] **Step 1: 编辑 schema/payment.ts**：paymentOrders 增加 `ownerPayerKind: text("owner_payer_kind").$type<PayerKind>()`、`ownerPayerId: text("owner_payer_id")`，加 check `payment_orders_owner_pair_check`、`payment_orders_owner_kind_check` 与索引。
- [ ] **Step 2: 生成迁移**：`cd server && TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5590/openbot_b5_290v bunx drizzle-kit generate --name payment_order_owner`；核对 SQL 只含上述列/约束/索引。
- [ ] **Step 3: 应用迁移到专用库**：`DATABASE_URL=postgres://openbot:openbot@localhost:5590/openbot_b5_290v bun scripts/migrate.ts` → `{"status":"ok"}`。

### Task 2: RED — 归属集成测试 `server/tests/order-ownership.integration.test.ts`

**Files:**
- Create: `server/tests/order-ownership.integration.test.ts`

**Interfaces:**
- Consumes: `createPaymentStore`（新签名 `insertOrder({ ownerPayerRef: PayerRef, createdBy, ... })`）、`attributeLegacyOrderOwnership(db, { legacyDeploymentId })`（Task 5）、`createPayerAccount`/`payerKey`（payer.ts）。
- 测试用 `randomUUID` 前缀隔离数据，afterAll 清理（模式同 payment-store.integration.test.ts）。

- [ ] **Step 1: 写失败测试**（覆盖三条 AC 的 store/标注层证据）：
  1. `insertOrder 无 ownerPayerRef 拒绝`（TypeError，不落行）
  2. `insertOrder 拒绝 unknown_owner / 空白 id / unknown kind`
  3. `归属 verbatim 存储（kind+id）且 createdBy 独立保留`
  4. `readOrder/readLatestLiveOrder/listOrdersInWindow 按 actorPayerRef 过滤：本人可见、他人 null、隔离行（legacy_deployment/unknown_owner/NULL）对个人 scope 不可见、无 scope 内部读可见`
  5. `存量标注：无映射 → unknown_owner(键)；显式 legacy_deployment 映射 → verbatim 归属；重复运行幂等（第二次零改动）；已标注者不被后续重分类`
  6. `countOrdersInWindow 与 list 同过滤`
- [ ] **Step 2: 运行验证 RED**：`cd server && TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5590/openbot_b5_290v CREDIT_SCALE=100 bun test tests/order-ownership.integration.test.ts` → 编译期/断言期 FAIL（insertOrder 尚无 ownerPayerRef、attributeLegacyOrderOwnership 不存在）。

### Task 3: GREEN — store/service/routes 归属接线

**Files:**
- Modify: `server/src/billing/payments/types.ts`（PaymentOrder/Record 加 `ownerPayerRef: PayerRef | null`；`PaymentOrderReadScope = { actorPayerRef: PayerRef }`；insertOrder 输入 `ownerPayerRef: PayerRef` 必填；`readPendingOrder` 加 `owner?: PayerRef`）
- Modify: `server/src/billing/payments/store.ts`（insertOrder 写归属并校验；ownerScopeCondition 改按归属列；readPendingOrder 归属过滤）
- Modify: `server/src/billing/payments/service.ts`（createPurchase 输入 `ownerPayerRef` 必填；PurchaseRefusal 加 `missing-owner`；重放按 owner；他主 pending → pending-purchase 409 拒绝，不取消他人订单）
- Modify: `server/src/billing/payments/routes.ts`（POST /purchases 用 `resolvePayerForPersonalUser(context.var.actor)` 解析 ownerPayerRef；onError 映射 missing-owner → 400）
- Modify: `server/src/billing/routes.ts`（billingReadScopeOf → `{ actorPayerRef: resolvePayerForPersonalUser(context.var.actor) }`）
- Create: `server/src/billing/payments/legacy-owner.ts`（attributeLegacyOrderOwnership + 报告类型 + import.meta.main 操作员入口）
- Test（既有测试跟随契约更新）: `payment-service.test.ts`（memory store/调用点补 ownerPayerRef；新增缺归属拒绝、他主 pending 不取消不重放两组）、`payment-routes.test.ts`（scope 双打更新；新增：伪造 userId body → 400 且 createPurchase 未被调用；合法请求捕获 ownerPayerRef=personal:actor.id）、`payment-store.integration.test.ts`（orderInput 补 ownerPayerRef）、`billing-statements.test.ts`（scope 双打更新）

**Interfaces:**
- Consumes: `PayerRef`/`PayerKind`（payer.ts）、`resolvePayerForPersonalUser`（payer-personal.ts）、`deploymentExternalCustomerId`（billing/service.ts）。
- Produces（下游 10.2 依赖）: `PaymentOrder.ownerPayerRef`；`PurchaseRefusal "missing-owner"`；`attributeLegacyOrderOwnership(db, { legacyDeploymentId }) => LegacyOrderOwnershipReport { scannedUnowned, attributedFromMapping, quarantinedUnknownOwner, alreadyAttributed, outcomes[] }`。

语义钉死：
- store.insertOrder：ownerPayerRef 缺失/畸形/unknown_owner/空白 id → TypeError（service 层先给业务拒绝，store 是最后防线）；`createdBy` 审计位照旧。
- service.createPurchase：入口先验证 owner（缺失/畸形/unknown_owner → `PurchaseError({reason:"missing-owner"})`）；`readPendingOrder(plan, provider, owner)` 归属内重放；`readPendingPurchase()` 命中他主订单 → 409 pending-purchase（绝不 cancel/返回他人订单）。
- scope 过滤：`owner_payer_kind = ref.kind AND owner_payer_id = ref.id`；`ownerPayerRef` 为 null 的行在任何 scope 下不可见。

- [ ] **Step 1: 依次实现 types → store → legacy-owner → service → routes → billing/routes**，每步跑 Task 2 的测试观察进度。
- [ ] **Step 2: GREEN 验证**：`TEST_DATABASE_URL=... CREDIT_SCALE=100 bun test tests/order-ownership.integration.test.ts tests/payment-store.integration.test.ts tests/payment-service.test.ts tests/payment-routes.test.ts tests/billing-statements.test.ts` 全绿。

### Task 4: 全量回归 + typecheck + lint

- [ ] **Step 1:** `cd server && bun run typecheck`。
- [ ] **Step 2:** `cd server && TEST_DATABASE_URL=... CREDIT_SCALE=100 bun test`（整个 server 套件）。
- [ ] **Step 3:** `cd app && bun run typecheck`（app 未改，验证无涟漪）。
- [ ] **Step 4:** `bunx biome lint --error-on-warnings <changed files>`。

### Task 5: 报告与检查点

- [ ] 写 `.omc/reports/b5-290.md`：变更文件清单、逐条 AC 证据、命令输出摘要、遗留/风险（10.2 到账接线、存量标注操作顺序）。
- [ ] 记录未提交检查点：`git status --short` + 关键文件 sha256 清单入报告。
