# B5-218 (Bifrost 02.4) 个人授权解析个人 payer 与越权拒绝 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 已认证用户只解析到本人个人付款账户（幂等创建、不产生余额）；积分读写入口不再接受调用方传入的 externalCustomerId；提交他人 userId 或裸 externalCustomerId 的请求被明确拒绝。

**Architecture:** 在 #215 交付的 PayerRef 层之上加"个人分支"解析模块 `payer-personal.ts`：`resolvePayerForPersonalUser` 只消费认证身份（伪造字段不在输入里，结构上无法影响解析）；`resolvePersonalPayerAccount` 经 `createPayerAccount` 幂等建户。读入口 `Credits` 的 `externalCustomerId?: string` 参数收敛为 `payer?: PayerRef`（裸字符串从此无法跨越 seam）；个人积分读取路由的切换留给 #220，本票读路由保持部署默认键，但对携带身份参数的查询做显式 400 拒绝（回归锁）。

**Tech Stack:** TypeScript / Bun test / Drizzle ORM / PostgreSQL（专用测试库 openbot_b5_218）

**Spec:** docs/specs/2026-10-14-bifrost-github-spec.md（AC01、AC13）、docs/specs/2026-10-14-bifrost-integration-design.md、ADR 0002/0004、docs/plans/2026-10-16-bifrost-5-dag.md（#218 ← #215，#219/#220 消费本票）

## Global Constraints

- 不产生余额/Grant：开户只是映射行（#215 已有保证，本票测试钉死）。
- 决不允许客户端指定付款账户；伪造公司ID/付款账户不改变解析结果。
- SQL 事务保证不得用内存 mock 替代；缺 TEST_DATABASE_URL 不回退开发库；skipped 不算通过。
- 硬性禁止：git commit / push / stash；不改 Write scope 之外的生产文件；不触碰其他 worktree。
- 本票只处理已登录用户；Bot 授权路径（04.5、05.3）只预留同一解析入口。

## Review Focus

- 越权请求必须"明确拒绝"而非空结果/静默忽略 → 路由边界 400 测试（integration）。
- 并发开户只能剩一行 → 6 条独立连接竞速，经 resolvePersonalPayerAccount（非直呼 createPayerAccount）。
- 解析纯函数不得写库、不得被扩展字段影响 → 传入携带 tenantId/externalCustomerId 的对象断言输出不变。
- 收敛后旧裸键调用点必须全部编译通过（typecheck 是验收命令）。

---

### Task 1: 个人解析纯函数（RED→GREEN）

**Files:**
- Create: `server/src/billing/payer-personal.ts`
- Test: `server/tests/payer-personal-resolution.test.ts`

**Interfaces:**
- Consumes: `PayerRef`（#215，`{kind, id}`）
- Produces:
  - `type PersonalUserIdentity = { id: string }`
  - `class PayerCrossAccountAccessError extends Error`，`code === "payer_cross_account_denied"`
  - `foreignAccountIdentityKeys: readonly string[]`（userId/externalCustomerId/payerId/accountId/companyId/tenantId）
  - `findForeignAccountIdentity(source: Record<string, unknown>): string | null` — 返回第一个出现的身份参数名
  - `resolvePayerForPersonalUser(user: PersonalUserIdentity): PayerRef` — 恒等 `{kind:"personal", id:user.id}`；id 非空且无首尾空白，否则 TypeError（与 payer.ts assertRef 同规则）
  - `resolvePersonalPayerAccount(database: Database, user: PersonalUserIdentity): Promise<PayerAccount>` — Task 2 实现

- [ ] **Step 1: 写失败测试** `server/tests/payer-personal-resolution.test.ts`：
  - 解析结果 === `{kind:"personal", id}`，且与 `payerKey(ref) === "openbot-personal-<id>"` 一致；
  - 传入额外携带 `tenantId/companyId/externalCustomerId/payerId` 的对象，解析结果不变（伪造不改变解析）；
  - 空 id / 空白 id / 带首尾空白的 id → TypeError；
  - 同一输入两次解析结果深度相等（确定性）；
  - `findForeignAccountIdentity({userId:"x"}) === "userId"`、`({externalCustomerId:"k"}) === "externalCustomerId"`、`({from:"1",page:"2"}) === null`；空串值也算命中（存在即拒绝）。

- [ ] **Step 2: 运行确认失败** — `bun test tests/payer-personal-resolution.test.ts` → 模块不存在编译错。
- [ ] **Step 3: 最小实现** `resolvePayerForPersonalUser`、`PayerCrossAccountAccessError`、`foreignAccountIdentityKeys`、`findForeignAccountIdentity`（`resolvePersonalPayerAccount` 先以 `throw new Error("Task 2")` 占位，本任务只测纯函数；PayerCrossAccountAccessError 在 Task 3 被路由检查使用）。
- [ ] **Step 4: 运行确认通过**（不写库的纯测试）。

### Task 2: 个人账户幂等解析 + 不产生余额（RED→GREEN，真库）

**Files:**
- Modify: `server/src/billing/payer-personal.ts`（补 `resolvePersonalPayerAccount`）
- Test: `server/tests/payer-personal-resolution.integration.test.ts`

**Interfaces:**
- Consumes: `createPayerAccount`（#215：幂等、竞速安全、`unknown_owner` 拒绝）、`createDatabase/testDatabaseUrl/TEST_POOL`（tests/support）
- Produces: `resolvePersonalPayerAccount(database, user) → PayerAccount`（`inserted` 不外泄：重放与首建对调用者等价）

- [ ] **Step 1: 写失败测试** `server/tests/payer-personal-resolution.integration.test.ts`（沿用 #215 的 teardown/连接纪律，键按 run 前缀清理 payer_accounts + billing_customers）：
  - 两次 `resolvePersonalPayerAccount` 同一用户 → 同一 `account.id`，`payer_accounts` 该主体恰 1 行；
  - 6 条独立连接（`createDatabase(testDatabaseUrl(), {max:1})`）并发解析同一用户 → 全部回答同一 account，`inserted` 恰一次（直查 `resolvePayerAccount` 行数=1）；
  - 解析后 `credit_grants`/`credit_ledger` 对该键计数均为 0，`createCreditWriter(database).availableBalance(key) === 0`；
  - 解析不写库纯函数版：`resolvePayerForPersonalUser` 在无库环境可调用（已在 Task 1 覆盖，此处不重复）。
- [ ] **Step 2: 运行确认失败**（`resolvePersonalPayerAccount` 未实现）。
- [ ] **Step 3: 实现** — `createPayerAccount(database, resolvePayerForPersonalUser(user))` 并返回 `account`。
- [ ] **Step 4: 运行确认通过。**

### Task 3: 读入口参数收敛 + 越权显式拒绝（RED→GREEN）

**Files:**
- Modify: `server/src/billing/credits.ts`（签名收敛）
- Modify: `server/src/billing/routes.ts`（credit 读路由挂身份参数拒绝中间件）
- Test: `server/tests/payer-personal-resolution.integration.test.ts`（路由边界拒绝）
- 机械更新调用点（签名变更的必然结果，报告中逐项列出）：
  - `server/tests/billing-credits-summary.integration.test.ts`、`server/tests/billing-credits-consumption.integration.test.ts`（键移入构造参数 `externalCustomerKey`，调用改无参）
  - `server/tests/payer-account.integration.test.ts`（显式键改传 alice/bob 的 `PayerRef`）
  - `server/tests/payer-legacy-mapping.integration.test.ts`（构造已带键，删去显式第二参）

**Interfaces:**
- Consumes: `payerKey`（#215）
- Produces: `Credits.summary(payer?: PayerRef)` / `grants(payer?: PayerRef)` / `consumption(window, payer?: PayerRef)` — 省略 = 部署自身键（行为不变，#220 再切个人键）；裸字符串从此类型不可表达。credit 读路由对 query 中任一 `foreignAccountIdentityKeys` 命中 → 400 `{error}`，先 requireUser 后本检查。

- [ ] **Step 1: 写失败测试**（加入 integration 文件）：
  - 真库 + 真 `createCredits`（部署键）+ 真 `createBillingCreditRoutes` + stub requireUser：`GET /credits/summary?userId=<他人>`、`?externalCustomerId=<裸键>`、`?payerId=...`、`?tenantId=...` → 400，且 body.error 非空（明确拒绝，非空结果）；
  - 合法 query（from/to/page）不受影响 → 200；
  - 未认证（requireUser 拒绝）仍是 401（401 先于 400）；
  - 模块级：`credits.grants(<PayerRef>)` 无法传裸字符串（typecheck 层面，不在运行时断言）。
- [ ] **Step 2: 运行确认失败**（400 检查不存在时他人 userId 请求返回 200）。
- [ ] **Step 3: 实现** — credits.ts `keyOf(payer?) = payer ? payerKey(payer) : externalCustomerKey`；routes.ts `createBillingCreditRoutes` 在 `requireUser` 后挂中间件，命中 `findForeignAccountIdentity(context.req.query())` 即 400 `{ error: "Credits are resolved from the signed-in user; account identifiers are not accepted." }`。
- [ ] **Step 4: 机械更新上述 4 个测试文件调用点，跑全部相关测试至绿。**

### Task 4: 写入口拒绝回归锁 + 全量验证

**Files:**
- Test: `server/tests/billing-routes.test.ts`（仅新增一条测试：管理员发放 body 携带 `externalCustomerId` → 400，钉死 strictObject 已有语义）

- [ ] **Step 1: 新增测试**（沿用该文件现有 admin harness）→ 确认通过（已有行为，回归锁）。
- [ ] **Step 2: 全量验证**
  ```bash
  TEST_DATABASE_URL=... bun test tests/payer-personal-resolution.test.ts tests/payer-personal-resolution.integration.test.ts
  TEST_DATABASE_URL=... bun test tests/payer-ref.test.ts tests/payer-account.integration.test.ts tests/payer-legacy-mapping.integration.test.ts tests/billing-credits.test.ts tests/billing-credits-summary.integration.test.ts tests/billing-credits-consumption.integration.test.ts tests/billing-routes.test.ts
  bun run typecheck
  bunx biome lint --error-on-warnings <changed files>
  ```
- [ ] **Step 3: 写报告 `.omx/.../b5-218.md`（.omc/reports/b5-218.md），git status 保持未提交。**
