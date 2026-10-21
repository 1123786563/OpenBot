# B5-345 21.1 旧计费对象清单枚举 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 只读枚举旧计费体系全部实际对象（库、schema、表、行范围、对象ID、归属分类计数），产出 CleanupManifest 供 21.2/21.4 消费。

**Architecture:** 新模块 `server/src/billing/cleanup-manifest.ts`：`enumerateCleanupManifest(database)` 内部在 `SET TRANSACTION READ ONLY` 事务中运行全部查询（只读由数据库强制，而非约定），按表查询 information_schema 存在性、count、PK min/max、经 02.2 显式映射（`payer_accounts.kind`）的归属分类计数；无键表（订单/支付事件/webhook 事件）经代码中已文档化的关联链（`plan:<orderId>` 幂等键、`object_id = external_subscription_id`）归因，无法判定即归 `unmapped`/`unknown_owner` 并单列。测试在专用库（TEST_DATABASE_URL=openbot_b5_345）用混合 fixture 验证完整性、未知单列、只读。

**Tech Stack:** Bun test + drizzle-orm (bun-sql) + PostgreSQL 专用测试库。

**Spec:** docs/plans/tickets/bifrost-5/issues/21.1-cleanup-manifest-enumeration.md；父 Spec docs/specs/2026-10-14-bifrost-github-spec.md AC18；docs/specs/2026-10-14-bifrost-integration-design.md Q23/Q28/Q29；docs/adr/0004-company-team-tenancy.md。

## Global Constraints

- 枚举只读：模块自身在 `READ ONLY` 事务内执行，任何写入即抛错（AC：枚举过程只读）。
- 归属只经 02.2 显式映射（`payer_accounts`）与已文档化数据关联；禁止表名/前缀猜测；无法判定 → `unknown_owner`/`unmapped` 单列，不进可清理范围。
- 不修改 schema、不新增迁移；Write scope 仅 `server/src/billing/cleanup-manifest.ts` + `server/tests/cleanup-enumeration.integration.test.ts`。
- 测试仅用 TEST_DATABASE_URL（openbot_b5_345），禁止 openbot live 库；缺 URL 不回退（复用 `tests/support/database.ts`）。
- 公司账务历史（company 类）绝不因枚举被标记为可清理；枚举只是分类计数，不做清理决策（21.2 职责）。

## Review Focus

- 共享测试库非空：所有计数断言必须与测试自身实时 `count(*)` 对比（查询证据），不得假设空库。
- 归属 join 一对一性：`payer_accounts.external_customer_id` 唯一、`credit_grants.idempotency_key` 唯一，join 不产生行膨胀（计数守恒 sum(attribution)=rowCount 是不变式断言）。
- 未知归属三类不得混淆：显式 `unknown_owner` 隔离行 vs 无映射行（unmapped）都单列；绝不并入 personal/company。
- 只读验证必须有"咬合"对照：手动 READ ONLY 事务内写入必须抛错，证明只读测试非空转。
- webhook `object_id` 可空且可能匹配不到任何订阅 → unmapped，不得猜。

## Files

- Create: `server/src/billing/cleanup-manifest.ts`
- Test: `server/tests/cleanup-enumeration.integration.test.ts`

## Interfaces (Produces for 21.2/21.4)

```ts
export type PayerAttribution = "personal" | "company" | "legacy_deployment" | "unknown_owner" | "unmapped";
export type CleanupTableManifest = {
  table: string; schema: string; exists: boolean;
  rowCount: number;
  idRange: { min: string | null; max: string | null };
  attribution: { personal: number; company: number; legacyDeployment: number; unknownOwner: number; unmapped: number };
  attributionBasis: string;
};
export type CleanupCustomerEntry = { externalCustomerId: string; attribution: PayerAttribution; appearsIn: Record<string, number> };
export type CleanupManifest = {
  manifestVersion: 1; database: string; schema: string; generatedAt: string;
  tables: CleanupTableManifest[];          // 固定顺序
  customers: CleanupCustomerEntry[];       // 按 externalCustomerId 排序
  unknownOwners: CleanupCustomerEntry[];   // unknown_owner ∪ unmapped，单列
  reservationStatusCounts: Record<string, number>; // 在途责任证据（21.5 消费）
};
export function enumerateCleanupManifest(database: Database): Promise<CleanupManifest>;
```

枚举表集合（12，来自 schema 证据，非猜测）：billing_customers, payer_accounts, billing_subscriptions, billing_webhook_events, credit_grants, credit_ledger, credit_reservations, credit_reservation_allocations, credit_charge_remainders, payment_orders, payment_events, usage_outbox。

归因依据（判定依据写进 attributionBasis）：
- 带 `external_customer_id` 的 7 表：LEFT JOIN payer_accounts；无映射行 → unmapped。
- credit_reservation_allocations：经 reservation.external_customer_id。
- payment_orders：LEFT JOIN credit_grants ON idempotency_key = 'plan:' || orders.id（credits.ts 文档化的关联）→ payer kind；无关联 → unmapped。
- payment_events：经 order 同链。
- billing_webhook_events：LEFT JOIN billing_subscriptions ON external_subscription_id = object_id → payer kind；无匹配 → unmapped。
- payer_accounts：按 kind 直接分组（映射表本身）。

### Task 1: RED — 失败测试

- [ ] 写 `server/tests/cleanup-enumeration.integration.test.ts`：
  1. seeding：personal / company / legacy_deployment / unknown_owner / unmapped 五类键（run 后缀隔离）；legacy 键经 `createCreditWriter` 走真实 grant→reserve→settle（产出 reservation+allocation+ledger+remainder）；paid 订单 + `plan:<orderId>` grant 关联 + payment_event；订阅 + objectId 命中/不命中两类 webhook。
  2. 完整性断言：manifest.tables 集合恰为 12 表、全部 exists；每表 rowCount == 测试同时刻 count(*)；sum(attribution)==rowCount；customers 含全部 fixture 键且逐表计数正确；idRange 非空。
  3. 未知单列：unknownOwners 恰含 unknown 键与 unmapped 键；绝不出现 personal/company。
  4. 只读断言：(a) 对照组——手动 READ ONLY 事务内 INSERT 必须抛错；(b) 枚举前后全表行数快照相等；(c) 两次枚举 customers/tables 内容逐字节一致（确定性）。
  5. manifest.database == 'openbot_b5_345'、schema == 'public'（来自查询）。
- [ ] 运行 `TEST_DATABASE_URL=... bun test server/tests/cleanup-enumeration.integration.test.ts` → 期望 FAIL（模块不存在）。

### Task 2: GREEN — 枚举模块

- [ ] 实现 `enumerateCleanupManifest`：内部 `database.transaction` → `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY` → information_schema 存在性 + current_database/current_schema → 每表 count/PK range/归属分组 → customers 合并排序 → unknownOwners 派生 → reservation status 计数。
- [ ] 重跑测试 → 全绿；重复运行一致。

### Task 3: REFACTOR + 验证

- [ ] `bun run --filter server typecheck`；`bunx biome lint --error-on-warnings <changed files>`。
- [ ] import.meta.main 操作员入口（照 payer-legacy.ts 模式，process.stdout.write JSON，禁 console）。
- [ ] 报告 `.omc/reports/b5-345.md`。

## Verification

```bash
TEST_DATABASE_URL=postgres://openbot:...@localhost:5432/openbot_b5_345 bun test server/tests/cleanup-enumeration.integration.test.ts
cd server && bun run typecheck
bunx biome lint --error-on-warnings server/src/billing/cleanup-manifest.ts server/tests/cleanup-enumeration.integration.test.ts
```
