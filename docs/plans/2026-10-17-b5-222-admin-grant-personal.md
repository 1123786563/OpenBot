# B5-222 管理员发放到指定个人账户 (02.8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans / test-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 管理员向指定个人账户发放积分：幂等（同一请求重复提交只入账一次）、有审计（操作者 + 解析出的目标账户 + 额度 + 原因 + 时间）、目标账户来自服务端解析（只收 `userId`，拒绝裸 `externalCustomerId`）、非管理员拒绝、甲乙互不可见对方余额；并在管理员界面提供发放入口（成功结果与失败原因可见）。

**Architecture:** 现有部署级发放路由 `POST /api/admin/billing/credits/grants`（`createBillingAdminRoutes`）固定打部署键且刻意无键（两按两发）。本票在其旁新增 `POST /api/admin/billing/credits/personal-grants`：入参 `userId` → 校验用户存在（404）→ `resolvePersonalPayerAccount`（02.4）解析个人账户 → 生成幂等键 → `grantCredits` → 审计 `billing.credits.personal_granted`。UI 在新页 `/admin/billing` 挂发放表单组件；用户页（02.7）无需改动即可见新 Grant（集成测试端到端验证缝合点）。

**Tech Stack:** Hono + zod + drizzle（server）；React + TanStack Query + i18next（app）；bun:test + 真实 PostgreSQL（`openbot_b5_222`）+ happy-dom。

**Spec:** 票 `docs/tickets/bifrost-5/issues/02.8-admin-grant-to-personal-account.md`（AC14/AC19）；父 Spec `docs/specs/2026-10-14-bifrost-integration-design.md`（Q27：发放归属个人，不采用客户端随意指定的用户 ID → 但管理员发放的目标用户本身就是业务入参，账户键仍由服务端从 userId 解析，绝不收 externalCustomerId）；ADR 0002/0003/0004；CONTEXT.md。

## Global Constraints

- 硬性禁止：git commit / push / stash；越界改动；触碰 live `openbot` 库。
- 专用测试库 `TEST_DATABASE_URL=<DATABASE_URL 换库名为 openbot_b5_222>`（已 createdb + migrated）；缺它测试直接抛错，不回退。
- 发放幂等键规则（本票交付契约）：
  - 请求带 `idempotencyKey`（1..200）→ 落库键 `admin-personal:explicit:<key>`；
  - 不带 → 派生键 `admin-personal:derived:<sha256(actorId|userId|source|totalCents|expiresAt 原文|reason)取40hex>`——同一操作者对同一请求载荷重复提交（无键）收敛为一次发放；缺省过期时间以首次请求为准。
  - `credit_grants.idempotency_key` 唯一索引是幂等权威；重放返回 `inserted:false` 与原 grant。
- 审计事件 `billing.credits.personal_granted`：targetType `billing`、targetId=grantId、actorUserId=操作者；payload：目标 userId、解析出的 payerAccountId 与 externalCustomerId、source、totalCents、reason?、idempotency（explicit|derived）、inserted。不写任何凭据明文（AC19）。
- 用户页可见性：发放后 `/api/billing/credits/summary|grants`（02.6 契约、02.7 页面）即显示新 Grant，无 app 查询层改动。

## Review Focus

- 目标账户必须来自解析：入参 schema 为 `z.strictObject`（裸 `externalCustomerId` 等未知键 400）；`externalCustomerId` 只能出自 `resolvePersonalPayerAccount` 返回值 — 集成测试断言 writer 收到的键 === `payerKey({kind:"personal",id:userId})`。
- 幂等：同键重放 1 行 grant、余额不变；无键同载荷重放同样收敛 — 两条都要有测试。
- 越权：member actor → 403 且零写入（grant/audit 都没有）。
- 审计：每次成功发放恰好一行，含操作者与解析账户。
- 隔离：甲乙各 10 分后，乙的 summary/grants 只含乙；乙带 `?userId=甲` 查询 → 400（02.6 边界）；乙 reserve 超其自身余额被拒（不能透支甲）。
- 部署级记录不动：发放后部署键 grants/balance 不变。
- UI：提交体只含 userId 等票面字段；失败渲染服务端错误句（role=alert）；重试复用同一幂等键；新表单会话换新键。

---

### Task 1: RED — 服务端失败测试

**Files:** Create `server/tests/admin-credit-grant.integration.test.ts`

- [ ] 真实库 + `createBillingAdminRoutes({...,database,creditWriter})` + `createBillingCreditRoutes` 挂同一 Hono；甲/乙为真实 `users` 行（route 将校验存在性）；`recordingAudit` 形状照抄 billing-routes.test.ts（但审计走真 `createAuditStore`? — 用 recording store 断 payload，另用一条查询 `audit_events` 表的断言验证"可查询"）。
- [ ] 用例：见 Review Focus（幂等×2、越权、裸 externalCustomerId 400、审计、甲乙隔离、部署键不动、404 未知用户、503 无 writer）。
- [ ] Run: `TEST_DATABASE_URL=… bun test server/tests/admin-credit-grant.integration.test.ts` → FAIL（路由不存在 404）。

### Task 2: GREEN — 路由与审计

**Files:** Modify `server/src/billing/routes.ts`、`server/src/audit.ts`（事件类型）、`server/src/app.ts`（billing 类型 + 透传 database）、`server/src/index.ts`（billing 字面量加 database）。

- [ ] 实现见 Architecture；错误语义：400 形状错 / 403 非管理员 / 404 用户不存在 / 503 未配置或冲突回退。
- [ ] Run: 同上 → GREEN；`bun run --filter server typecheck` 过。

### Task 3: RED→GREEN — 管理员 UI

**Files:** Create `app/src/components/billing/admin-credit-grant.tsx`、`app/src/routes/_authed/admin/billing.tsx`；Modify `app/src/routes/_authed/admin/index.tsx`（SECTIONS overview.access 加入口）、`app/src/components/admin/admin-sidebar.tsx`（sidebar.access 加链接）、`app/src/locales/{zh-CN,en}/admin.json`；Create `app/tests/admin-credit-grant-ui.test.tsx`；`routeTree.gen.ts` 随构建再生成。

- [ ] 测试先行：表单渲染、提交体契约（无 externalCustomerId；totalCents=积分×100）、成功面板、失败 alert、重试复用幂等键。
- [ ] Run: `bun test app/tests/admin-credit-grant-ui.test.tsx` → GREEN。

### Task 4: REFACTOR + 全量验证

- [ ] `cd server && bun run typecheck`；`cd app && bun run typecheck`（或 build 触发 routeTree 再生成）。
- [ ] `bunx biome lint --error-on-warnings <changed files>`。
- [ ] 重跑两票测试 + 既有 `billing-routes.test.ts`、`payer-personal-resolution.integration.test.ts`（邻接回归）。
- [ ] 报告 `​.omc/reports/b5-222.md`：AC 证据、检查点哈希、遗留。
