# B5-252 Reserve 服务身份认证 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为计费协议（Reserve/Status/Settle/Release）建立独立受信服务身份认证：只有受信网关（Bifrost 准入扩展）凭据可通过，Bot 凭据/用户会话/未认证/错误凭据一律拒绝，拒绝不泄露账户数据，每次调用（含失败）写入审计。

**Architecture:** 新模块 `server/src/billing/credit-service-auth.ts`，复用 04.2 bot-service-auth 的「vault 凭据 + 常数时间比较 + 统一拒绝」模式与 01.2 的「单一受信身份 + 封闭 keyId」模式，但使用独立的 vault kind（`credit_service`）与前缀（`obot_csvc_`），与 Bot 服务凭据、用户会话完全隔离。拒绝响应统一为一种 401 形状；区分原因只进审计行（`routines.dispatch_refused` 同款纪律）。

**Tech Stack:** TypeScript / Hono middleware / drizzle + PostgreSQL（共享 credentials vault）/ bun test。

**Spec:** docs/plans/tickets/bifrost-5/issues/06.1-reserve-service-authentication.md；父 Spec docs/specs/2026-10-14-bifrost-github-spec.md AC05；docs/specs/2026-10-14-bifrost-integration-design.md Q5/Q10；ADR 0003。

## Global Constraints

- 不复用 Bot 服务凭据（Ticket Resume hint）；独立 kind=credit_service / provider=bifrost / keyId=gateway。
- 未配置凭据必须拒绝（不回退、不放行）；拒绝响应字节统一，不泄露账户余额/Grant/账户存在性。
- 每次调用（含失败）审计：原因只写入 audit 行，不写入响应。
- 不自动提交/推送；git status 保持未提交。
- 专用测试库 openbot_b5_252（TEST_DATABASE_URL），绝不触碰 openbot live 库。
- 不启用网关能力；不挂载生产路由（Reserve 端点属 06.2，挂载属 06.2/07.1）。

## Review Focus

- Bot 有效凭据必须被拒（混用即提权）：真实 registry 签发的活跃 Bot 凭据打协议路由 → 401。
- 拒绝体形状固定：仅 `{error, code}`，断言不含 balance/grant/available/remaining 等字段。
- 未配置凭据时 401 而非 500（fail-closed，同 workerSharedSecret 模式）。
- 轮换后旧凭据下一次调用即失效（无缓存）。
- 审计行 reason 只在行内；响应不携带 reason。

## File Structure

- Create: `server/src/billing/credit-service-auth.ts` — 计费协议认证模块（全部生产代码）
- Create: `server/tests/credit-service-auth.test.ts` — 本票测试（票面 Verification 指定路径）
- Modify: `server/src/audit.ts` — 仅向 `auditEventTypes` 追加 `credit_service.called` / `credit_service.refused` 两个事件字面量（**已通过编排 ask 上报 coordinator 确认**；无运行时 CHECK 约束，但词表是类型层权威，仓库惯例每个功能集中注册）

## Interfaces

- Produces:
  - `mintCreditServiceSecret(): string` — `obot_csvc_<32B base64url>`
  - `CreditServiceIdentity = { kind: "credit_service"; provider: "bifrost"; keyId: "gateway" }`
  - `createCreditServiceAuthenticator(deps: { encryptionKey; credentialStore: CredentialStore & CredentialSecretReader }): (presented: string) => Promise<CreditServiceIdentity>` — 失败抛统一 `CreditServiceAuthFailureError`（含未配置）
  - `requireCreditService(deps: { authenticate; auditStore? }): MiddlewareHandler` — 统一 401 `{error, code: "credit_service_auth_failed"}`；每次尝试写审计（called/refused）
  - `creditProtocolRoutes(deps)` — fail-closed 路由工厂：未装依赖全路由 503 `credit_service_unavailable`；`GET /` 身份探针（04.2 同款）；预留 `endpoints?` 组合位给 06.2
  - `CreditServiceVariables` — `AppVariables & { creditService: CreditServiceIdentity }`

---

### Task 1: RED — 四类调用方拒绝 + 受信成功 + 审计断言

**Files:**
- Test: `server/tests/credit-service-auth.test.ts`

- [ ] **Step 1.1 写失败测试**（真 PostgreSQL，模式照抄 bot-service-auth.test.ts）：
  - 未认证（无 Authorization 头）→ 401、统一体、无账户字段、audit `credit_service.refused` 1 行 reason=missing-header
  - 错误凭据（形似但错误的 `obot_csvc_…`、垃圾 token）→ 同上 reason=mismatch
  - Bot 凭据（真实 registry 签发活跃 Bot secret）→ 401 同上（Bot 凭据非协议凭据）
  - 用户会话（requireUser stand-in 证明 cookie 已认证，同请求打协议路由）→ 401
  - 受信凭据 → 200 `{creditService}`、audit `credit_service.called` 绑定 method+path
  - 未配置凭据 → 401（非 500）
  - 轮换后旧凭据 → 401
  - 所有拒绝体断言：无 `balance|grant|available|remaining|customer` 字段、拒绝间字节一致
- [ ] **Step 1.2 跑测试确认 RED**：`bun test server/tests/credit-service-auth.test.ts` → 模块不存在编译失败/断言失败（预期原因）

### Task 2: GREEN — 最小实现

**Files:**
- Create: `server/src/billing/credit-service-auth.ts`
- Modify: `server/src/audit.ts`（两个事件字面量）

- [ ] **Step 2.1** audit.ts 追加 `credit_service.called` / `credit_service.refused`（附理由注释）
- [ ] **Step 2.2** 实现 mint/parse/authenticator/middleware/routes（签名见 Interfaces；常数时间比较 sha256 两侧同 bot auth；失败统一类；审计 reason 只进行内）
- [ ] **Step 2.3** 跑测试确认 GREEN：`bun test server/tests/credit-service-auth.test.ts`

### Task 3: 验证

- [ ] `cd server && bun run typecheck`
- [ ] `bunx biome lint --error-on-warnings server/src/billing/credit-service-auth.ts server/tests/credit-service-auth.test.ts server/src/audit.ts`
- [ ] 相关既有测试不回归：`bun test server/tests/bot-service-auth.test.ts server/tests/billing-credits-writer.integration.test.ts`
- [ ] 报告 `.omc/reports/b5-252.md`；git status 保持未提交
