# B5-216 存量 externalCustomerId 显式映射 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native, inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 credit_grants / credit_ledger 中出现的每个存量 externalCustomerId 经显式规则归入 legacy_deployment 付款账户或标记 unknown_owner 隔离，幂等、不复制余额、不删除旧记录。

**Architecture:** 新增付款账户模块内的幂等映射程序（`payer-legacy.ts`）：枚举 Grant∪Ledger 的 distinct key，跳过已有 payer_accounts 映射的 key（幂等锚点），把能由**正向派生 + 身份核验**（claimed deployment ids、enterprise_tenants 目录）解释的 key 归入 legacy_deployment 账户，其余一律 unknown_owner 隔离（payerId = key 自身）。只 INSERT，从不 UPDATE/DELETE 旧记录，从不触碰金额列。

**Tech Stack:** Bun + drizzle-orm + PostgreSQL（专用测试库 openbot_b5_216）。

**Spec:** 票 b5-216（#216）+ docs/specs/2026-10-14-bifrost-integration-design.md（AC13/AC18）+ ADR 0002/0004 + CONTEXT.md。

## Global Constraints

- 禁止字符串前缀/命名猜测账户类型；归类只允许"已知身份正向派生 key 后精确匹配"。
- 旧记录不删除、余额不复制不分摊到个人或公司账户。
- unknown_owner 隔离：可审计读取，不可被任何新消费路径解析（payerKey 拒绝该 kind，#215 已实现）。
- 迁移重复执行结果一致；不新增映射、不改写已有归类。
- 缺 TEST_DATABASE_URL 不跑集成测试、不回退开发库；不 git commit/push/stash。

## Review Focus

- 带部署前缀但身份不存在的 key（`openbot-deployment-<ghost>`）→ 必须隔离，不得因前缀归入部署账户。测试：`a deployment-prefixed key naming no known identity is quarantined, not attributed`。
- 同一 key 既有 grant 又有 ledger → 枚举用 UNION 去重，一次归类。测试：报告 scanned 恰等于 fixture 去重 key 数。
- 仅存在于 ledger 的 key（无 grant）→ 仍被枚举并归类。测试：ledger-only fixture。
- 迁移中途失败 → per-key try/catch 计入 unprocessed，不阻断其余 key；重跑补齐。
- 已有映射（如 #215 createPayerAccount 建的账户）→ 永不改写。测试：pre-mapped fixture 归 alreadyMapped 且行不变。

## Files

- Create: `server/src/billing/payer-legacy.ts` — 映射程序 + 报告 + `import.meta.main` 操作员脚本入口。
- Create: `server/tests/payer-legacy-mapping.integration.test.ts` — 集成测试（票面 Verification 指定文件名）。
- 不需要 drizzle schema 迁移文件：0122 的 payer_accounts 已承载全部所需结构（两种唯一索引 + kind CHECK 已含 unknown_owner/legacy_deployment）。

## Interfaces

- Consumes（#215 已交付，已读实现）：
  - `payerKey(ref: PayerRef): string`（refuses unknown_owner）
  - `readPayerAccountForKey(database, key): Promise<PayerAccount | null>`
  - `readPayerAccount(database, ref): Promise<PayerAccount | null>`
  - `deploymentExternalCustomerId(tenantId: string): string`（service.ts）
  - `createCreditWriter(database)`：grantCredits / availableBalance（公开边界造数与验证）
- Produces：
  ```ts
  type LegacyMappingReport = {
    scannedKeys: number;
    alreadyMapped: number;
    legacyDeploymentMapped: number;
    unknownOwnerQuarantined: number;
    unprocessed: number;
    outcomes: LegacyMappingOutcome[]; // per-key audit detail
  };
  mapLegacyExternalCustomerIds(
    database: Database,
    options: { claimedDeploymentIds: readonly string[] },
  ): Promise<LegacyMappingReport>
  ```
  隔离行形状：`payer_accounts(kind='unknown_owner', payer_id=<key>, external_customer_id=<key>)`。

### Task 1: RED — 混合 fixture 集成测试

- [ ] 写 `server/tests/payer-legacy-mapping.integration.test.ts`（fixture：claimed 部署键、目录租户键、pre-mapped 键、垃圾键、ledger-only 键），断言报告计数、映射行、余额/发放行原值不变、幂等二跑、隔离语义、前缀不算身份。
- [ ] 运行 `TEST_DATABASE_URL=... bun test tests/payer-legacy-mapping.integration.test.ts` → 期望 FAIL（模块不存在）。

### Task 2: GREEN — 实现 payer-legacy.ts

- [ ] 实现 `mapLegacyExternalCustomerIds`：枚举 UNION → 逐 key（已排序）→ 已映射跳过 → 身份派生匹配归 legacy_deployment → 否则 unknown_owner 隔离 → per-key 错误入 unprocessed。
- [ ] 重跑测试 → 期望 PASS。

### Task 3: REFACTOR + 验证

- [ ] 注释纪律对齐 payer.ts；`bun run --filter server typecheck`；`bunx biome lint --error-on-warnings <changed files>`；回归 `bun test tests/payer-account.integration.test.ts tests/payer-ref.test.ts`。
- [ ] 报告写 `.omc/reports/b5-216.md`，git status 保持未提交。
