# Implementation Plan — #250 (Bifrost 05.9 归属漂移处置与手工 Key 不接管)

Base: commit `3e8a6072` + 全部未提交集成层（#241–#249 等前置已在此工作区）。无提交授权 → 未提交检查点。

验证库：`postgres://openbot:openbot@localhost:5594/openbot_b5_250`（容器 b5-verify-pg2，全新库：CREATE DATABASE OWNER openbot → roles.sql → 全部迁移）。严禁 5432/5435/55432。
四件套导出：`TEST_DATABASE_URL` / `TEST_APP` / `TEST_RUNTIME` / `TEST_WRITER_DATABASE_URL`（本票验证实际消费 TEST_DATABASE_URL，其余 defensively 指向同一隔离库）。

## 消费契约（已读实际实现）

- `server/src/gateway/key-state-sync.ts`（#249）：每 key 单次远端读 `GET /api/governance/virtual-keys/{id}`；`GatewayKeyRemoteState` 目前只携带 `isActive`/`expiresAt`；一次事务内 flip + drift 行；单飞；last-good。
- `gateway_virtual_keys` 本地记录含 `gatewayCustomerId`（NOT NULL）、`expiresAt`（05.5 起非 null）。
- 网关侧 `TableVirtualKey`：`CustomerID/TeamID/BusinessUnitID` 互斥（归属），`AllowAllProviders` + `ProviderConfigs`（范围，deny-by-default），`ExpiresAt`（期限）。OpenBot 发行形态 = customer_id=映射客户、allow_all_providers=true、无 provider_configs、expires_at=mint+TTL。
- 发行（05.3）与续期（05.6）都先过 `resolveForBot`，之后 provision → 事务 mint。

## 设计（最小关键字段集：归属、范围、期限）

1. **漂移检测**（扩展 05.8 同步的既有 per-key 读，不增加远端请求）：远端 healthy key 的
   - 归属 ≠ 本地 `gateway_customer_id` → `gateway_key_owner_changed`
   - 范围：`allow_all_providers !== true` 或 `provider_configs` 非空 → `gateway_key_scope_changed`
   - 期限：远端 `expires_at` 与本地 `expires_at` 偏差 > 2s（防 JSON 重排版误报）→ `gateway_key_term_changed`
   字段漂移**不翻转** key status（裁决不是擦除）；availability 漂移（05.8 三码）优先且照旧 flip。
2. **暂停发放与续期**：`gateway_key_drift_events` 每事件记 grant；未处置事件存在 ⇒ 该 grant 的 issuance/refuse（`gateway_vk_grant_drift_paused`）与 renewal（`renewal_grant_drift_paused`）。检查放在 resolveForBot 之后、provision/mint 之前，经 `key-drift.ts` 的 `assertGatewayGrantNotDriftPaused(database, grantId)`（生产恒开，无静默回退）。
3. **一事一悬**：`(key_id, reason_code) WHERE disposed_at IS NULL` 部分唯一索引；重复观察不叠事件；处置后 mismatch 仍在 ⇒ 下轮 sync 新事件再暂停（自愈）。
4. **审计 + 告警**：新 audit 事件 `gateway.key_drift_detected`（sync 提交后逐新事件写；写失败仅记日志——drift 行本身是持久记录）、`gateway.key_drift_disposed`（admin 处置写）；sync 对新事件 `log.warn`。
5. **人工处置**（03.5 式 admin 面，`/api/admin/gateway/key-drift`）：GET 列表；POST `/:eventId/dispose` `{decision: 'accepted'|'key_revoked', note?}`；`key_revoked` 同时将本地 key 翻 `revoked`（guard active）。处置一次写入（guard `disposed_at IS NULL`），不可覆盖。
6. **手工 Key 不接管**：sync 只按本地 active 行的 id 逐个读 —— 手工 key 结构性不可见；测试断言零创建（无 key 行、无授权、无账户映射、无 ledger），未接管 key 的调用仍受准入约束留断言（07.x 落地）。

## 变更范围

- `server/drizzle/0145_gateway_key_drift_events.sql` + meta snapshot + journal
- `server/src/db/schema/gateway.ts`：`gatewayKeyDriftEvents`
- `server/src/gateway/key-drift.ts`（新）：reason codes、`compareKeyFields`、store、`GatewayKeyDriftPausedError`
- `server/src/gateway/key-state-sync.ts`：remote state 扩展、行选择扩展、字段漂移折叠进事务、outcome.driftEvents、auditStore 依赖、告警日志
- `server/src/audit.ts`：两个新事件类型
- `server/src/gateway/key-issuance.ts` / `key-renewal.ts`：暂停检查 + 新 reason code + 路由映射
- `server/src/gateway/admin-routes.ts`：处置面
- `server/src/index.ts`：scheduler 组装传 auditStore
- `server/tests/key-drift-handling.test.ts`（新，票面指定）

## TDD

- RED：先写 `server/tests/key-drift-handling.test.ts`（归属/范围/期限漂移 → 事件+暂停+告警；未受影响授权不误伤；一事一悬；处置 accepted/key_revoked + 幂等；零创建/手工 key 不接管；status 不被字段漂移翻转）→ 跑失败。
- GREEN：实现上述全部 → 测试绿。
- REFACTOR + 验证：`TEST_DATABASE_URL=$DB bun test ./tests/key-drift-handling.test.ts`；相邻回归 `./tests/key-state-sync.test.ts` `./tests/key-issuance.integration.test.ts` `./tests/key-renewal*.test.ts`；`bun run --filter server typecheck`；`bunx biome lint --error-on-warnings <changed>`；冒烟 `./tests/settle-idempotency.integration.test.ts` 29 绿。
