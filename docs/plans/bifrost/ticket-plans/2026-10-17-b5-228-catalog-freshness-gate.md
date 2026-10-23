# b5-228 / 03.6 目录新鲜度门禁 — Implementation Plan

BASE: 563fe88d（未提交集成层已含 03.4/#253/#254/#255 增量，勿 reset）。
接续上下文：前两次派发静默卡死；本次先盘点增量再续作，不重做。

## 现状盘点（2026-10-17，git status 对照四 AC）

已存在（前置票或前任进度，保留）：
- `server/src/billing/credit-reserve.ts` 第 5 步内联新鲜度谓词（读 `gatewayCatalogSyncState.lastSuccessfulSyncAt`，`ageMs > window` → `catalog_stale`；null → `catalog_never_synced`）；`CreditReserveEnvironment.catalogFreshnessWindowMs` 注入位；`DEFAULT_CATALOG_FRESHNESS_WINDOW_MS` 常量。
- `server/src/gateway/model-capability-filter.ts` 已留 `isCatalogFresh?: (ref: ModelRef) => boolean | Promise<boolean>` seam（03.6 交付后接线，本票 Write scope 不含该文件，只交付可一行适配的门禁工厂）。
- 既有测试 `reserve-revalidation.integration.test.ts` 已覆盖 16 分钟拒绝 / never_synced / 14 分钟放行（真实时钟，service 级）。

缺口（本票交付）：
1. **新鲜度门禁模块**：无独立模块；判定逻辑内联在 credit-reserve，非单真相。
2. **上限配置装配**：无 `BIFROST_CATALOG_FRESHNESS_WINDOW_MS` 解析函数（对照 catalog-sync 的 `gatewayCatalogSyncIntervalConfig` 模式）。
3. **assertCatalogFresh / isCatalogFresh seam**：无门禁工厂，可控时钟不可注入到门禁本体。
4. **票面指定测试文件** `server/tests/catalog-freshness-gate.test.ts` 不存在（可控时钟 14/15/16 三点、既有预留不重新定价、同步恢复放行）。

## 交付物

- 新文件 `server/src/gateway/catalog-freshness.ts`：
  - `DEFAULT_CATALOG_FRESHNESS_WINDOW_MS`（15 分钟，所有权移到本模块）
  - `BIFROST_CATALOG_FRESHNESS_WINDOW_MS_VARIABLE` + `catalogFreshnessWindowConfig(environment)`（非法值抛错，不静默回退）
  - `evaluateCatalogFreshness({ lastSuccessfulSyncAt, now, windowMs })` 纯核心（14/15/16 三点可测；边界为严格 `>`）
  - `assertCatalogFresh(handle, { modelRef, now, windowMs })` 门禁（handle 可为事务或库连接；verdict 封闭词汇 `catalog_never_synced`/`catalog_stale`，detail 命名受影响 modelRef，绝不说模型不存在）
  - `createCatalogFreshnessGate({ database, windowMs?, now? })` → `{ isCatalogFresh(modelRef, now?), assertCatalogFresh(modelRef, now?) }`（01.8 seam 一行适配位）
- `credit-reserve.ts` 准入集成点：第 5 步内联谓词替换为 `assertCatalogFresh(tx, …)` 调用（仍在准入事务内读取，保持"同步要么先提交要么等提交"的原子性契约）；`DEFAULT_CATALOG_FRESHNESS_WINDOW_MS` 改从门禁模块导入；拒绝 reason code 与 detail 键保持兼容（detail 增量附加 modelRef）。
- 测试 `server/tests/catalog-freshness-gate.test.ts`：纯核心三点、配置解析、门禁 DB 集成、service 级可控时钟三点、配置调整立即生效、既有预留不重新定价（锁定 v1 结算成功且 stale 期间可结算、新请求报 catalog_stale 而非 price_basis_not_found）、同步恢复放行（同实例免重启）。

## RED/GREEN 验证命令

```bash
DATABASE_URL 无关；全新库（5590 b5-verify-pg，禁 5432）：
  openbot_b5_228r3_fresh = postgres://openbot:openbot@localhost:5590/openbot_b5_228r3_fresh
# 建表：DATABASE_URL=<url> bun run server/scripts/migrate.ts（一次性，仅新库）
# RED：TEST_DATABASE_URL=<url> bun test ./server/tests/catalog-freshness-gate.test.ts
# GREEN：同上
# 回归：TEST_DATABASE_URL=<url> bun test ./server/tests/reserve-revalidation.integration.test.ts
# 类型/Lint：bun run --filter server typecheck；bunx biome lint --error-on-warnings <changed files>
```

## 边界纪律

只改：`catalog-freshness.ts`（新）、`credit-reserve.ts`（第 5 步集成点 + 常量导入）、新测试文件、票面 Checkpoint、本计划。不动 model-capability-filter.ts / index.ts / 迁移文件（无新迁移，0140 主仓库已有，本地勿造 ≥0141）。禁 commit/push/stash。
