# Bifrost 04.6 伪造身份与仅服务认证的拒绝路径（#239 / b5-239）Implementation Plan

**Goal:** 四类越权路径全部拒绝且不泄露他人数据：伪造 userId/email、仅凭 Bot 服务认证申请用户凭据、跨 Bot 复用授权、已撤销授权重用。产出统一的越权拒绝语义与拒绝路径回归测试集合（供 22.1 全入口核查引用）。

**Architecture:** 入口核查结论——组 04 全部授权/凭据入口已挂正确守卫：`/api/model-access/*`（requireUser + zod strictObject，userId 永远来自会话）、`/api/bot-service/*`（requireBotService）、`/api/admin/bot-services/*`（requireUser + requireAdmin）。缺的是「授权使用」这一 seam：grant 被下游消费（05.3 发 Key、05.7 撤销拒绝、06.2 重校验）时必须经过的统一校验入口。本票在 `access-grants.ts` 上补 `resolveForBot` / `resolveForUser`（幂等拒绝：unknown/revoked/跨 Bot/跨用户/禁用 Bot 一个类一个说法），不改任何 HTTP 成功行为。

**Tech Stack:** Bun + Hono + Drizzle（专用 PostgreSQL 测试库）。

**Spec:** docs/tickets/bifrost-5/issues/04.6-impersonation-refusal-paths.md + 父 Spec AC03 + ADR 0002 + CONTEXT.md。

## Global Constraints

- 唯一权威：票正文 + 父 Spec docs/specs/2026-10-14-bifrost-integration-design.md（Q3/Q15/Q22）+ ADR 0002/0003/0004 + CONTEXT.md。
- 专用测试库 `TEST_DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5591/openbot_b5_239`（docker `b5-239-pg`），绝不触 live openbot 库；skipped 不算通过。
- 禁止 git commit/push/stash；不新增 HTTP 成功行为（Resume hint）；不改 04.7 的撤销路由（那是它的票）。
- Write scope：授权校验入口与拒绝语义（`server/src/bot-services/access-grants.ts`）+ 拒绝路径测试集合（`server/tests/authorization-impersonation.test.ts`）。计划文件与 `.omc/reports/b5-239.md` 为流程产物。

## 决策记录（Why，not What）

1. **入口核查（步骤 1）**：可申请授权或凭据的入口 = model-access preview/confirm（用户会话）、bot-service whoami/binding-codes（服务认证）、admin bot-services 注册/凭据（管理员）、admin gateway credential（管理员，01.2 已有测试）。无任何入口从请求体取 userId/email 参与授权判定（zod strictObject 全部拒绝多余字段）；HTTP 层无生产代码改动需求，以回归测试钉死。
2. **拒绝 seam 放 service 层**：「跨 Bot 复用」「已撤销重用」的拒绝语义必须先于 05.3 存在，否则发 Key 会各写各的校验。`resolveForBot(grantId, identity)` / `resolveForUser(grantId, userId)` 是授权校验入口：identity/userId 只接受已认证主体（BotServiceIdentity / 会话用户），grantId 只作为定位符。不挂 HTTP 路由——暴露「用授权」的入口是 05.3 的成功行为，本票只交拒绝语义。
3. **一个类一个说法**：`AccessGrantUseError`（code `model_access_grant_refused`）覆盖 unknown/revoked/跨 Bot/跨用户/禁用 Bot 全部情形——调用方与响应都无法区分「不存在」「已撤销」「不是你的」，不泄露存在性（与 04.2 authenticator、04.5 AccessGrantCodeError 同一沉默纪律）。
4. **禁用 Bot 也拒绝**：resolveForBot 对 registry 做实时读（与 confirm 事务内同纪律），Bot 被禁用后授权立即不可用（Q15：服务身份与用户授权必须同时有效）。
5. **已撤销 ≠ 可复活**：schema 的 check 约束保证 status/revokedAt 一致；confirm 的幂等只命中 active 行，撤销后再确认产生新 grantId 新行（04.5 已设计），测试钉死「新行 ≠ 复用旧行」。撤销动作本身是 04.7 的路由，本票测试直接置库（schema 已支持 revoked）。
6. **入口清单覆盖测试**：按 app.ts 的挂载方式组合组 04 路由，用 Hono `app.routes` 枚举全部已挂载路径，对每条路径验证未认证 → 401、非管理员 → 403。新入口若漏挂守卫会被枚举发现——这就是 22.1 引用的回归清单。
7. **不泄露他人数据断言**：所有拒绝响应体逐一 `toEqual` 已知 tagged 形状（响应只能是 `{error, code}`），并断言不含他人 userId/email/externalIdentity/grantId/displayName。

## Files

- Modify: `server/src/bot-services/access-grants.ts`（AccessGrantUseError、resolveForBot、resolveForUser）
- Create: `server/tests/authorization-impersonation.test.ts`（拒绝路径回归集合）
- Create: `.omc/reports/b5-239.md`（报告，流程产物）

## Tasks（RED→GREEN→REFACTOR）

### Task 1: 拒绝路径测试集合（RED）
`server/tests/authorization-impersonation.test.ts`，真实 requireUser（fake session header）+ 真实 registry（含 credentials）+ 真实 DB：
1. 伪造身份：body 携带他人 userId/email/externalIdentity → 400 tagged，码未消费、无新行；query 串伪造 userId 不改变归属。
2. 仅服务认证：Bot secret 打 model-access 路由 → 401；打 admin 凭据路由 → 401；whoami 响应仅 `{botService:{botId,status}}`；binding-code 签发响应不含任何用户凭据字段；无会话持码确认 → 401。
3. 跨 Bot：resolveForBot(grantA, BotB) / unknown grantId / 禁用 Bot → 同一 AccessGrantUseError；正确 Bot → 返回；拒绝不改行。
4. 已撤销：置 revoked 后 resolveForBot/resolveForUser 均 → 同一拒绝；撤销后新码确认产生新 grantId（旧行不复用）。
5. 用户侧：resolveForUser 他人 grant → 同一拒绝（不泄露存在性）；本人 → 返回。
6. 不泄露：全部拒绝响应体精确匹配已知形状且不含他人标识。
7. 入口清单：组合路由后枚举 app.routes，逐条验证未认证 401 / 非管理员 403。

验证命令（RED 预期：resolveForBot/resolveForUser 不存在而失败；HTTP 部分通过即钉住现状）：
`cd server && TEST_DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5591/openbot_b5_239 bun test tests/authorization-impersonation.test.ts`

### Task 2: 授权校验入口（GREEN）
`access-grants.ts` 加 `AccessGrantUseError` + service 两个 resolve 方法（严格参数校验、实时 registry 读、uniform 拒绝）。跑 Task 1 全绿。

### Task 3: 全量验证
- `cd server && bun run typecheck`
- 相邻回归：`tests/access-grant.integration.test.ts`、`tests/bot-service-auth.test.ts`、`tests/binding-code-issuance.test.ts`、`tests/bot-service-routes.test.ts`、`tests/bot-service-credential-routes.test.ts`、`tests/identity-app-wiring.test.ts`
- `bunx biome lint --error-on-warnings` 改动文件
- 报告 `.omc/reports/b5-239.md`
