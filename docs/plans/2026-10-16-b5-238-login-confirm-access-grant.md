# Bifrost 04.5 登录确认并创建模型访问授权（#238 / b5-238）Implementation Plan

**Goal:** 已登录用户在确认页校验一次性绑定码、看清将授权的 Bot 与外部身份后，显式确认并创建唯一一条可撤销的 AccessGrant；绑定码本身或仅 Bot 认证不足以创建授权（AC03）。

**Architecture:** 新增 `access_grants` 表 + `server/src/bot-services/access-grants.ts`（service + 路由）。确认流程拆成两个显式步骤：`POST /api/model-access/binding-preview`（登录后校验码、展示 Bot+外部身份，不消费不创建）与 `POST /api/model-access/confirm`（登录用户显式确认，单事务内消费绑定码 + 幂等创建授权）。service 通过 `createBotServiceRegistry` 组合（复用 04.3 bindingCodes 挂载 seam，不改 createApp 尾参，避免破坏 identity-app-wiring.test.ts 的尾参算术）。

**Tech Stack:** Bun + Hono + Drizzle（PostgreSQL 专用测试库）、TanStack Router/Query 前端确认页。

**Spec:** docs/tickets/bifrost-5/issues/04.5-login-confirm-create-access-grant.md（票正文）+ docs/specs/2026-10-14-bifrost-integration-design.md（Q3/Q15/Q22）+ ADR 0002。

## Global Constraints

- 唯一权威：票正文 + 父 Spec + ADR 0002/0003/0004 + CONTEXT.md。
- SQL 原子性用专用 PostgreSQL 测试库（TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5590/openbot_b5_238，CREDIT_SCALE=100），skipped 不算通过。
- 禁止 git commit/push；新迁移 0127。
- server 与 app 各自 `bun x tsc --noEmit` 0 错误；`bunx biome lint --error-on-warnings` 改动文件通过。
- Write scope：授权模块与迁移、确认页与路由、对应测试（含 registry 组合点与 audit 事件词汇表的一行注册——授权模块自身的审计需求）。

## 决策记录（Why，not What）

1. **两步确认（AC03 核心）**：preview 不消费绑定码（只读校验），confirm 是独立的显式动作。不存在"提交码即建授权"的路径；请求体只接受 `{ bindingCode }`（zod strictObject），userId/externalIdentity 永远来自服务端会话与码本身，客户端伪造字段一律 400。
2. **消费与创建同事务**：confirm 在一个事务内 `SELECT ... FOR UPDATE` 锁 offer 行 → 校验 pending/未过期/Bot active → 幂等检查已有 active 授权 → 条件更新 `status='redeemed'` → 插入 grant（唯一索引冲突时读回已存在的孪生并返回）。同码并发双花被行锁 + 条件更新拒绝；异码并发确认由部分唯一索引收敛为一条。
3. **幂等键**：`(userId, botId, externalIdentity)` 部分唯一索引 `WHERE status='active'`。重复确认（新码）返回同一 grantId（created=false）；撤销后（04.7）再确认可建新行，历史保留。
4. **范围 scope**：确认流当前只产生 `'model-access'` 一个值（check 约束封闭集合），新范围需新迁移（功能准入）。
5. **不产生 Key/余额/Grant 积分**：confirm 只写 access_grants 一行 + bot_binding_offers.status 一改 + 审计一行；credentials/credit_grants/credit_ledger/credit_reservations 行数不变（测试断言）。
6. **组合 seam**：`createBotServiceRegistry` 增加 `modelAccess` service（与 bindingCodes 同模式），app.ts 在 `/api/model-access` 挂载用户侧路由（requireUser），service 缺席答 tagged 503 `model_access_unavailable`。
7. **审计**：`model_access.granted`（首次）/ `model_access.reconfirmed`（幂等命中），payload 携带 codeHash 摘要，绝不携带明文码；fail-closed（审计写失败则请求失败，重试语义与 identity unlink 相同并记录在案）。

## Files

- Create: `server/src/db/schema/access-grants.ts`（表定义）
- Create: `server/drizzle/0127_access_grants.sql` + `server/drizzle/meta/0127_snapshot.json` + journal 追加（drizzle-kit generate 产出）
- Create: `server/src/bot-services/access-grants.ts`（AccessGrant 类型、service、路由）
- Modify: `server/src/db/schema/index.ts`（导出新表）
- Modify: `server/src/bot-services/registry.ts`（组合 modelAccess）
- Modify: `server/src/app.ts`（挂载 /api/model-access）
- Modify: `server/src/index.ts`（无需改：registry 工厂内部组合）→ 预期不改
- Modify: `server/src/audit.ts`（词汇表加 2 个事件类型）
- Create: `server/tests/access-grant.integration.test.ts`
- Create: `app/src/lib/model-access/mutations.ts`
- Create: `app/src/routes/_authed/settings/model-access.tsx`
- Modify: `app/src/components/settings/settings-sidebar.tsx`（导航项）
- Modify: `app/src/locales/en/settings.json`、`app/src/locales/zh-CN/settings.json`
- Modify: `app/src/routeTree.gen.ts`（构建时再生）

## Tasks（RED→GREEN→REFACTOR）

### Task 1: 集成测试（RED）
`server/tests/access-grant.integration.test.ts`，真实 requireUser（createRequireUser + header 会话 fake）。用例：
1. 未登录：preview/confirm → 401，无授权行，offer 仍 pending。
2. preview：返回 bot{botId,displayName}+externalIdentity+scope+expiresAt，不建行、不消费码；cache-control no-store。
3. confirm：消费码+建行，字段全断言（grantId/userId/botId/externalIdentity/scope/status/createdAt/revokedAt=null），offer → redeemed。
4. 伪造字段请求体（userId/externalIdentity）→ 400，无行。
5. 同码重放 → 400 uniform（model_access_invalid_code），仍 1 行。
6. 幂等：新码再确认 → 同 grantId、created=false、仍 1 条 active。
7. 异码并发（同 user/bot/identity）→ 两个都成功同一 grantId，1 行。
8. 过期/伪造/禁用 Bot 的码 → uniform 400，无行；不同用户各持各码 → 各自授权；同用户同 Bot 不同外部身份 → 两条 active（幂等键即此三元组）。
9. Key/余额/Grant 积分不变：credentials、credit_grants、credit_ledger、credit_reservations 行数前后相等。
10. schema 约束：重复 active → 23505 命名索引；status/revokedAt 组合 → 23514；坏 scope → 23514。
11. 审计：granted + reconfirmed 事件、payload 无明文码。
12. service 缺席 → 503 tagged。

验证命令：`cd server && TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5590/openbot_b5_238 CREDIT_SCALE=100 bun test tests/access-grant.integration.test.ts`（预期：模块不存在而失败）。

### Task 2: schema + 迁移（GREEN 之一）
`access_grants` 表 + 0127 迁移 + schema/index 导出；`bun run db:generate` 产出后人工核快照；对测试库跑 migrate。

### Task 3: service + 路由 + 组合（GREEN 主体）
`access-grants.ts`（preview/confirm/错误类型/路由）、audit 词汇、registry.modelAccess、app.ts 挂载。跑 Task 1 命令全绿。

### Task 4: 前端确认页
mutations + model-access.tsx（输入码 → 预览卡片 → 确认按钮 → 结果展示 grantId/status）+ 侧边栏 + 双语言文案；`bun run --cwd app typecheck`（先 `generate:app-config`）+ 构建/路由树再生。

### Task 5: 全量验证
- `cd server && bun x tsc --noEmit`
- 目标测试 + 相邻回归：binding-code-issuance、bot-service-*、identity-app-wiring、payer-* 相关
- `bunx biome lint --error-on-warnings` 改动文件
- 报告 `.omc/reports/b5-238.md`
