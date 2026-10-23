# b5-240 / Bifrost 04.7 — 用户授权列表与单独撤销 — 实施计划

BASE: bab7c0b9（worktree b5-240，含前置票未提交集成改动）。专用测试库 `openbot_b5_240` @ localhost:5592（容器 b5-240-pg）。

## 消费契约（已读实际实现，非臆测）

- 04.5 `server/src/bot-services/access-grants.ts`：`AccessGrant`（grantId/userId/botId/externalIdentity/scope/status/createdAt/revokedAt）、`resolveForUser(grantId, userId)`（本票 seam：本人+active 才放行）、`accessGrantRoutes(requireUser, service)` 挂载 `/api/model-access`，注释明确"列表与撤销是后续票在同一挂载上的路由"。
- schema `server/src/db/schema/access-grants.ts`：撤销是状态非删除；`(status='revoked' AND revokedAt IS NOT NULL)` 由 check 约束保证。
- audit `recordAuditEvent(store, {eventType, targetType, targetId, actorUserId, payload})`；auditEventTypes 已含 model_access.*（需新增 `model_access.revoked`）。
- 前端：`app/src/lib/model-access/mutations.ts`（client 封装）、`app/src/routes/_authed/settings/model-access.tsx`（04.5 确认页，撤销区加在同页）。

## 设计

### 服务层（同模块 access-grants.ts）
- `listForUser(userId)`：查本人全部授权（含 revoked），JOIN botServices 取 displayName，createdAt desc。仅本人——where userId = session actor。
- `revokeForUser(grantId, userId)`：
  - 定位行：`grantId + userId` 都匹配（他人授权/不存在 → 同一 `AccessGrantUseError`，不泄露存在性）。
  - 已 revoked → 返回 `{grant, revoked:false}`，无写无审计（幂等 no-op）。
  - active → 事务内条件更新 `SET status='revoked', revoked_at=clock_timestamp() WHERE grant_id=? AND user_id=? AND status='active'`，返回 revoked 行；条件更新保证并发下恰一次翻转。之后写审计 `model_access.revoked`（fail-closed，与 confirm 同模式）。
  - 立即可见性：无缓存、直查 DB；`resolveForUser` 撤销后即拒绝（下游 05.3/05.7 直接受益）。
- 结算责任不受影响：只写 access_grants 一行，不触碰 credit_ledger/reservations。

### 路由（同一挂载，requireUser 之后）
- `GET /api/model-access/grants` → `{ grants: [{grantId, botId, botDisplayName, externalIdentity, scope, status, createdAt, revokedAt}] }`
- `POST /api/model-access/grants/:grantId/revoke` → 200 `{accessGrant, revoked}`；本人不存在/他人 → 404 `model_access_grant_refused`（统一拒绝，不区分"不存在"与"不是你的"）。无 session → 401（guard）。服务未装配 → 503 tagged（沿用现有）。

### 审计
- 新 audit event type `model_access.revoked`（audit.ts 闭集追加）。每次真实撤销恰一条；targetType=access_grant, targetId=grantId, actorUserId=撤销者本人。幂等重复撤销不产生新事件。

### 前端
- `mutations.ts`：`accessGrantsQueryOptions()`（GET）、`revokeAccessGrantMutationOptions(grantId)`（POST），成功后 invalidate grants 列表。
- `settings/model-access.tsx`：新增 "Your authorizations" 区块：列表（Bot 名、外部身份、状态 active/revoked、创建时间），active 行带 Revoke 按钮，撤销后立即显示 revoked。i18n en + zh-CN。

## RED → GREEN 顺序

1. RED `server/tests/access-grant-revoke.test.ts`（专用库集成测试，先写全并确认失败）：
   - 列表只见本人授权（他人 grant 不可见）
   - 撤销后状态立即 revoked（route + resolveForUser 下游可见）
   - 重复撤销幂等（同 grantId、revoked:false、无第二次审计）
   - 他人授权不可撤销（404 统一拒绝）
   - 审计记录恰一条、无明文敏感
   - 撤销不触碰 credit_ledger/reservations（结算责任不受影响）
   - 无 session 401；无服务 503
2. GREEN：audit type + 服务方法 + 路由。
3. RED `app/tests/user-authorizations-ui.test.tsx`：列表渲染、Revoke 请求发出、撤销后 UI 反映 revoked、错误路径。
4. GREEN：mutations + 页面 + i18n。
5. 验证：`bun test server/tests/access-grant-revoke.test.ts`、`bun test app/tests/user-authorizations-ui.test.tsx`、`cd server && bun run typecheck`、`bunx biome lint --error-on-warnings <changed>`、server 全量相关测试回归。

## Write scope（越界即停）

- server/src/bot-services/access-grants.ts、server/src/audit.ts（仅 event type 闭集追加一行）
- app/src/lib/model-access/mutations.ts、app/src/routes/_authed/settings/model-access.tsx
- app/src/locales/{en,zh-CN}/settings.json（modelAccess 键）
- server/tests/access-grant-revoke.test.ts、app/tests/user-authorizations-ui.test.tsx

## 检查点

（完成后填写：文件哈希清单 + 未提交说明）
