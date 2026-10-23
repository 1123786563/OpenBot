# B5-217 (Bifrost 02.3) 受信公司 scope 解析公司 payer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development (RED→GREEN→REFACTOR) to implement task-by-task.

**Goal:** 公司工作台业务只解析到公司付款账户：`resolvePayerForCompanyContext(scope) → PayerRef(kind:"company", id:tenantId)`，只接受服务端受信 scope（`createScopeResolver` 签发、`assertTrustedScope` 验证）；请求体/查询参数/请求头中的 tenantId/companyId 不参与解析；scope 缺失或不受信时明确拒绝，绝不回退个人或部署账户；解析建户幂等且不产生任何余额。

**Architecture:** 在 #215 的 PayerRef 层与 #216/#218 的个人分支之上加"公司分支"模块 `payer-company.ts`。信任判定是结构性的：解析函数只消费 `PlatformScope`，并经 enterprise tenancy 的 `assertTrustedScope`（`issuedScopes` WeakSet，模块私有的签发标记）拒绝一切手工构造/复制克隆的 scope。账户解析走 `createPayerAccount`（幂等、双唯一索引竞速安全），公司账户缺失时显式创建空账户（映射行），不静默改用个人/部署账户。用量归属（workspaceId/principalId）仍由受信 scope 携带，付款账户固定为公司——预留/结算接线由 #219 消费本模块。

**Tech Stack:** TypeScript / Bun test / Drizzle ORM / PostgreSQL（专用测试库 openbot_b5_217）

**Spec:** docs/specs/2026-10-14-bifrost-github-spec.md（AC13）、docs/specs/2026-10-14-bifrost-integration-design.md、ADR 0002/0004、CONTEXT.md（Payer/Company Credit Account/Tenant/Workspace）

**BASE:** bab7c0b9b481d6563fdacb99fddf8af21f08c729（worktree b5-217，含 coordinator 同步的 #215/#216/#218 集成增量；未提交改动为基线一部分）

## Global Constraints

- 解析过程不产生余额/Grant（建户只是映射行，#215 保证，本票测试钉死）。
- 请求参数（body/query/header 的 tenantId/companyId/userId）结构上无法影响解析：函数只消费受信 scope。
- 非受信 scope（手工对象、克隆副本、null）一律 `company_scope_required` 拒绝，绝不回退个人/部署账户。
- SQL 事务保证用真库验证（TEST_DATABASE_URL=openbot_b5_217）；受信 scope 的铸录用 enterprise 测试同款 controlled directory database（仅铸 scope 标记，不替代计费 SQL）。
- 硬性禁止：git commit / push / stash；不改 Write scope 之外文件；不触碰其他 worktree。

## Review Focus

- 克隆 scope（`{...trusted}`）必须被拒（WeakSet 按对象身份）——下游无法用副本放松信任。
- 公司解析建户并发只留一行；出生账户无任何余额；已有余额在解析后不变。
- 拒绝路径在真库上不留下任何账户行（不建户、不回退）。

---

### Task 1: 公司解析纯函数 + 受信判定（RED→GREEN）

**Files:**
- Create: `server/src/billing/payer-company.ts`
- Test: `server/tests/payer-company-resolution.test.ts`

**Interfaces:**
- Consumes: `PlatformScope`（enterprise/contracts）、`assertTrustedScope`（enterprise/tenancy/store，受信签发标记）、`PayerRef`（#215）
- Produces:
  - `class CompanyScopeRequiredError extends Error`，`code === "company_scope_required"`，`reason: "missing" | "untrusted"`
  - `resolvePayerForCompanyContext(scope: PlatformScope): PayerRef` — 受信 scope → `{kind:"company", id:scope.tenantId}`；null/undefined → reason "missing"；非签发对象（含克隆）→ reason "untrusted"；不返回任何个人/部署 ref
  - `resolveCompanyPayerAccount(database, scope): Promise<PayerAccount>` — Task 2 实现

- [x] **Step 1 RED:** 写 `server/tests/payer-company-resolution.test.ts`：受信 scope（经 createScopeResolver + controlled directory db 铸出，同 runner-scope.test.ts 手法）解析 === company ref 且 payerKey === `openbot-company-<tenantId>`；伪造 query/header 的请求铸出的 scope 解析不变；`{...scope}` 克隆拒绝；手工全字段假 scope 拒绝；null/undefined 拒绝；同 scope 两次解析相等；错误携带稳定 code 且绝不返回 ref。
- [x] **Step 2:** 确认失败（模块不存在）。
- [x] **Step 3 GREEN:** 最小实现 `CompanyScopeRequiredError` + `resolvePayerForCompanyContext`（`resolveCompanyPayerAccount` 占位 throw）。
- [x] **Step 4:** 确认通过。

### Task 2: 公司账户幂等解析 + 零余额 + 拒绝不留痕（RED→GREEN，真库）

**Files:**
- Modify: `server/src/billing/payer-company.ts`（补 `resolveCompanyPayerAccount`）
- Test: `server/tests/payer-company-resolution.integration.test.ts`

**Interfaces:**
- Consumes: `createPayerAccount`（#215 幂等竞速安全）、`createDatabase/testDatabaseUrl/TEST_POOL`、`createCreditWriter`
- Produces: `resolveCompanyPayerAccount(database, scope) → PayerAccount`（重放与首建对调用者等价）

- [x] **Step 1 RED:** 真 PG 测试：两次解析同 scope → 同 account、`payer_accounts` 恰 1 行（kind='company'）；6 独立连接竞速 → 全部同一 account、1 行；出生账户 grants/ledger=0、availableBalance=0；预置 grant 后重放解析余额不变；拒绝路径（非受信 scope）调用后真库 0 行、不建个人/部署键账户。
- [x] **Step 2:** 确认失败。
- [x] **Step 3 GREEN:** `createPayerAccount(database, resolvePayerForCompanyContext(scope))`。
- [x] **Step 4:** 确认通过。

### Task 3: 验证与报告

- [x] `cd server && bun run typecheck` 通过。
- [x] `bun test tests/payer-company-resolution.test.ts tests/payer-company-resolution.integration.test.ts` 全绿（专用库）。
- [x] `bunx biome lint --error-on-warnings` 对变更文件通过。
- [x] 报告写入 `.omc/reports/b5-217.md`（AC 逐条证据、命令输出、遗留风险），git status 保持未提交。

## Verification

```bash
cd server
DATABASE_URL='postgres://openbot:openbot@localhost:5432/openbot_b5_217' bun scripts/migrate.ts  # 已执行（124 迁移/152 表）
bun test tests/payer-company-resolution.test.ts tests/payer-company-resolution.integration.test.ts
bun run typecheck
bunx biome lint --error-on-warnings src/billing/payer-company.ts tests/payer-company-resolution.test.ts tests/payer-company-resolution.integration.test.ts
```
