# OpenMuse、账务与治理隔离 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全部现有功能完成公司、团队及个人权限隔离后统一上线；公司工作台共用余额，Bifrost 个人余额保留。

**Architecture:** 复用现有 Tenant/Principal/Membership/Workspace、业务存储、授权和计费机制，新增团队成员与版本化公共资源规则。按请求/任务固定公司团队归属，受限数据库事务、外部状态、客户端缓存遵守一致权限；公司与个人付款账户分开路由。

**Tech Stack:** Bun/TypeScript、Hono、Drizzle/PostgreSQL RLS、React/TanStack Query、现有 Worker/Agent、Go Runtime、Tauri/Rust、OpenMuse Expo/React Native。使用现有锁定依赖。

**Spec:** `docs/specs/2026-10-14-company-team-multitenancy-design.md`（已批准 R1–R7/A1–A13）；ADR `docs/adr/0004-company-team-tenancy.md`（accepted），保留 ADR 0001–0003 各自路径保证。

## Global Constraints

- 公司之间隔离；同公司团队之间默认互不可见。
- 员工可以加入同一家公司的多个团队。
- 加入团队后自动获得团队公共 Bot、公共知识库使用权；个人会话、文件和凭据保留个人权限。
- 所有现有功能完成隔离后统一上线。实施允许分批，开放门槛统一。
- 公司工作台采用公司统一余额，团队分别统计用量。
- 外部 Bot 直连 Bifrost 保留已有个人余额机制，个人模型授权及独立撤销规则保留。
- 缺少作用域或依赖不可用时拒绝，不回退默认公司、第一个团队或另一付款账户。
- 不复制权威业务数据，不修改旧策略隐含语义；个人凭据、支付资料及管理动作不继承团队公共权限。
- 普通业务使用受限数据库角色与事务本地上下文，不跨网络等待持有数据库授权锁。
- 无提交、推送、合并、生产迁移及发布授权。若实施获准，使用未提交检查点，不执行 git commit。
- 默认串行；validator/reviewer 只读，Spec compliance 与 code quality 分别报告。

## Review Focus

1. 多公司用户切换时，OAuth、已创建任务与费用仍属于原始范围——T07/T10/T15/T17–T22/T26。
2. 团队公共 Bot 不泄露发布者或其他调用人的凭据、个人会话、浏览器状态——T05/T07/T11/T18/T26。
3. 公司管理员、SCIM、删除恢复不误删其他公司资格、不自动读取个人内容——T02/T14/T16/T26。
4. 旧 REST/Copilot/mobile、分享、计数、检索、下载、事件流不成为旁路——T01/T06/T09/T12/T25/T26。
5. 公司/个人账户在重放、并发、未知结算、余额不足时不切换或重复授额——T15/T24/T26。

---

执行顺序见 [总计划](00-master.md)/[DAG](dag-ledger.md)，共同类型见 [Interface](interfaces.md)。计划审阅并选择执行方法后才执行。所有路径相对工作区 `/Users/wuyongjun/orca/workspaces/OpenBot/company-team-multitenancy`。T22 是独立 Git 子模块，必须递归检查点、单独审查。文件明细见 `surface-inventory.json`；目录范围排除已显式分给其他任务的文件。

### Task 13: OpenMuse 个人任务、文件、文档与个人域

**ID / Dependencies / Roles:** `T13` / T06, T09, T10, T11, T12 / implementer=`backend_implementer`，validator=`backend_validator`，独立 `reviewer`。

**Acceptance:** A1, A2, A4, A5, A8；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Modify: `server/src/openmuse-files/` 下明细分配的文件。
- Modify: `server/src/openmuse-documents/` 下明细分配的文件。
- Modify: `server/src/openmuse-tasks/` 下明细分配的文件。
- Modify: `server/src/openmuse-personal/` 下明细分配的文件。
- Modify: `server/src/openmuse-finance/` 下明细分配的文件。
- Modify: `server/src/db/schema/openmuse.ts`。
- Modify: `server/src/agents/openmuse-template-store.ts`。
- Create: `server/tests/multitenancy/openmuse-personal.test.ts`。
- Create: `server/tests/multitenancy/support/domains/openmuse-personal.ts`。
- Create: `server/drizzle/0121_mt_openmuse_personal.sql`，更新生成 snapshot/journal。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T13.md`、`checkpoints/T13/`。

**Interfaces:**
- Consumes: T06 已集成的 Interface 与同版本证据；T09 已集成的 Interface 与同版本证据；T10 已集成的 Interface 与同版本证据；T11 已集成的 Interface 与同版本证据；T12 已集成的 Interface 与同版本证据。
- Produces: `createScopedOpenMusePersonal(context: CompanyRequestContext, deps: OpenMusePersonalDependencies): ScopedOpenMusePersonalServices`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `openmuse-personal-1`：同一用户在公司 A/B 的任务与个人 Bot 分开；`openmuse-personal-2`：PDF transfer 不能指向别的团队 computer workspace；`openmuse-personal-3`：团队其他用户不可读个人财务 artifacts、goals 或文件。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```typescript
test("openmuse-personal: scope isolation", async () => {
  const r = await runIsolationScenario("openmuse-personal", "openmuse-personal-1");
  expect(r.positiveControlPassed).toBe(true);
  expect(r.denied).toBe(true);
  expect(r.leakedRecords).toEqual([]);
  expect(r.forbiddenEffects).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**。`bun test server/tests/multitenancy/openmuse-personal.test.ts` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。私有 OpenMuse Bot 改为按公司团队用户幂等创建，模板应用不抹掉用户字段。Tasks/plans/monitors/leases、Files/PDF inspection/fill/transfer、goals/ideas/memories 和 finance artifacts 按作用域保持个人权限。只 user_id 的旧根记录补公司团队关联；不同公司同用户不能共享任务锁、个人工作区和财务文件。已有精确动作提案、确认和取消行为保留。 通过 T01 工具生成 T13 迁移，核对编号 0121，生成 snapshot，DDL/RLS 一起验证。基线变更导致编号冲突时先调整分配，不手改已应用迁移或手写 metadata。

- [ ] **Step 4: GREEN 与适用检查**。`bun test server/tests/multitenancy/openmuse-personal.test.ts` 预期全部行为/正向控制通过、关键 skipped=0。补 server typecheck，企业合同改动含 typecheck:enterprise，及相关既有测试。Go/Python/Worker 在各自隔离环境跑现有检查。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T13` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

### Task 14: OpenMuse 邮件日历、通知、操作与删除恢复

**ID / Dependencies / Roles:** `T14` / T07, T08, T10, T13 / implementer=`backend_implementer`，validator=`backend_validator`，独立 `reviewer`。

**Acceptance:** A1, A2, A5, A7, A8；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Modify: `server/src/openmuse-connectors/` 下明细分配的文件。
- Modify: `server/src/openmuse-mail/` 下明细分配的文件。
- Modify: `server/src/openmuse-calendar/` 下明细分配的文件。
- Modify: `server/src/openmuse-reviewed-actions/` 下明细分配的文件。
- Modify: `server/src/openmuse-notifications/` 下明细分配的文件。
- Modify: `server/src/openmuse-activity/` 下明细分配的文件。
- Modify: `server/src/openmuse-ops/` 下明细分配的文件。
- Modify: `server/src/openmuse-deletion/` 下明细分配的文件。
- Modify: `server/src/mobile-bff/` 下明细分配的文件。
- Modify: `server/src/delivery/` 下明细分配的文件。
- Modify: `server/src/voice/` 下明细分配的文件。
- Modify: `server/src/dictation/` 下明细分配的文件。
- Modify: `server/src/db/schema/openmuse-deletion.ts`。
- Modify: `server/src/db/schema/openmuse.ts`（T13之后串行补连接、动作及通知字段）。
- Modify: `server/src/db/schema/delivery.ts`。
- Modify: `server/src/db/schema/voice.ts`。
- Create: `server/tests/multitenancy/openmuse-connectors-deletion.test.ts`。
- Create: `server/tests/multitenancy/support/domains/openmuse-connectors-deletion.ts`。
- Create: `server/drizzle/0122_mt_openmuse_connections.sql`，更新生成 snapshot/journal。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T14.md`、`checkpoints/T14/`。

**Interfaces:**
- Consumes: T07 已集成的 Interface 与同版本证据；T08 已集成的 Interface 与同版本证据；T10 已集成的 Interface 与同版本证据；T13 已集成的 Interface 与同版本证据。
- Produces: `createScopedOpenMuseConnections(context: CompanyRequestContext, deps: OpenMuseConnectionDependencies): ScopedOpenMuseConnectionServices; buildCompanyDeletionManifest(scope: Scope, principalId: string): Promise<CompanyDeletionManifest>`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `openmuse-connectors-deletion-1`：公司 A 删除/恢复不影响该用户 B 的数据和个人 Bifrost 账户；`openmuse-connectors-deletion-2`：共享推送设备接收通知时仍按接收者当前有效资格限制正文；`openmuse-connectors-deletion-3`：改变 reviewed-action 的连接/团队不能复用原批准或产生外部写入。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```typescript
test("openmuse-connectors-deletion: scope isolation", async () => {
  const r = await runIsolationScenario("openmuse-connectors-deletion", "openmuse-connectors-deletion-1");
  expect(r.positiveControlPassed).toBe(true);
  expect(r.denied).toBe(true);
  expect(r.leakedRecords).toEqual([]);
  expect(r.forbiddenEffects).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**。`bun test server/tests/multitenancy/openmuse-connectors-deletion.test.ts` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。每个 Google/OAuth connection、mail/calendar action、reviewed proposal/receipt、activity/feed、通知及语音调用绑定公司团队用户。模板/移动聚合接口只返回当前范围。删除 API 区分退出公司/清理公司数据与独立全局账号删除；公司管理员不能触发全局身份删除。purge/retention/restore 包含归属、发起权限和不可伪造 manifest，不能仅凭 user_id 扫所有公司的外部文件或凭据；受控全局用户删除是明确独立授权操作。 通过 T01 工具生成 T14 迁移，核对编号 0122，生成 snapshot，DDL/RLS 一起验证。基线变更导致编号冲突时先调整分配，不手改已应用迁移或手写 metadata。

- [ ] **Step 4: GREEN 与适用检查**。`bun test server/tests/multitenancy/openmuse-connectors-deletion.test.ts` 预期全部行为/正向控制通过、关键 skipped=0。补 server typecheck，企业合同改动含 typecheck:enterprise，及相关既有测试。Go/Python/Worker 在各自隔离环境跑现有检查。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T14` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

### Task 15: 公司钱包、团队用量与个人付款账户分离

**ID / Dependencies / Roles:** `T15` / T04, T06, T10, T11, T13, T14 / implementer=`backend_implementer`，validator=`backend_validator`，独立 `reviewer`。

**Acceptance:** A7, A9, A12, A13；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Modify: `server/src/billing/` 下明细分配的文件。
- Modify: `server/src/db/schema/billing.ts`。
- Modify: `server/src/db/schema/credits.ts`。
- Modify: `server/src/db/schema/credit-reservations.ts`。
- Modify: `server/src/db/schema/payment.ts`。
- Modify: `server/src/db/schema/usage-outbox.ts`。
- Modify: `server/src/usage-origin.ts`。
- Modify: `server/src/copilot.ts`。
- Modify: `server/src/enterprise/models/`。
- Create: `server/src/billing/account-scope.ts`。
- Create: `server/tests/multitenancy/billing-accounts.test.ts`。
- Create: `server/tests/multitenancy/support/domains/billing-accounts.ts`。
- Create: `server/drizzle/0123_mt_billing_accounts.sql`，更新生成 snapshot/journal。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T15.md`、`checkpoints/T15/`。

**Interfaces:**
- Consumes: T04 已集成的 Interface 与同版本证据；T06 已集成的 Interface 与同版本证据；T10 已集成的 Interface 与同版本证据；T11 已集成的 Interface 与同版本证据；T13 已集成的 Interface 与同版本证据；T14 已集成的 Interface 与同版本证据。
- Produces: `resolveCompanyBillingAccount(tx: TxClient, scope: Scope): Promise<CompanyBillingAccount>; assertBillingAccountBinding(tx: TxClient, account: BillingAccount, occurrence: UsageOccurrence): Promise<void>`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `billing-accounts-1`：A 两团队并发预扣不能超过同一公司容量；B 公司余额不受影响；`billing-accounts-2`：个人 Key 或同一个 idempotencyKey 重放不能结算到公司账户；`billing-accounts-3`：个人付款订单对同公司普通成员不可见，公司用量总计与团队及公司级项目一致。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```typescript
test("billing-accounts: scope isolation", async () => {
  const r = await runIsolationScenario("billing-accounts", "billing-accounts-1");
  expect(r.positiveControlPassed).toBe(true);
  expect(r.denied).toBe(true);
  expect(r.leakedRecords).toEqual([]);
  expect(r.forbiddenEffects).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**。`bun test server/tests/multitenancy/billing-accounts.test.ts` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。公司映射到唯一计费 Customer，新增 company/personal 账户类型及稳定 ID 约束；公司调用固定 workspace/principal/Bot/run 归属。保留金额尺度、CreditWriter 原子事务、价格依据、预扣/结算/释放/尾差和幂等键语义。订单付款人可见性保留，公司财务读取必须管理授权。支付 callback/订阅激活/outbox/reconcile 从原记录解析账户。Bifrost 个人路径保留 ADR0002/0003，不新建未批准网关功能；现存或实际启用集成的个人 Key 不能指定公司账户，不足无自动回退。 通过 T01 工具生成 T15 迁移，核对编号 0123，生成 snapshot，DDL/RLS 一起验证。基线变更导致编号冲突时先调整分配，不手改已应用迁移或手写 metadata。

- [ ] **Step 4: GREEN 与适用检查**。`bun test server/tests/multitenancy/billing-accounts.test.ts` 预期全部行为/正向控制通过、关键 skipped=0。补 server typecheck，企业合同改动含 typecheck:enterprise，及相关既有测试。Go/Python/Worker 在各自隔离环境跑现有检查。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T15` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

### Task 16: 公司/团队管理、路由政策与审计

**ID / Dependencies / Roles:** `T16` / T02, T03, T04, T07, T08, T15 / implementer=`backend_implementer`，validator=`backend_validator`，独立 `reviewer`。

**Acceptance:** A1, A2, A5, A7, A9；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Modify: `server/src/admin/` 下明细分配的文件。
- Modify: `server/src/people/` 下明细分配的文件。
- Modify: `server/src/routing/` 下明细分配的文件。
- Modify: `server/src/db/schema/admin.ts`。
- Modify: `server/src/audit.ts`。
- Modify: `server/src/audit-retention.ts`。
- Modify: `server/src/user-preferences.ts`。
- Modify: `server/src/user-preferences-routes.ts`。
- Create: `server/tests/multitenancy/admin-audit.test.ts`。
- Create: `server/tests/multitenancy/support/domains/admin-audit.ts`。
- Create: `server/drizzle/0124_mt_admin_audit.sql`，更新生成 snapshot/journal。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T16.md`、`checkpoints/T16/`。

**Interfaces:**
- Consumes: T02 已集成的 Interface 与同版本证据；T03 已集成的 Interface 与同版本证据；T04 已集成的 Interface 与同版本证据；T07 已集成的 Interface 与同版本证据；T08 已集成的 Interface 与同版本证据；T15 已集成的 Interface 与同版本证据。
- Produces: `requireCompanyManagement(tx: TxClient, scope: Scope, operation: CompanyManagementAction): Promise<void>; listScopedAudit(context: CompanyRequestContext, filter: AuditFilter): Promise<AuditPage>`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `admin-audit-1`：公司管理员不能管理其他公司成员或读取未授权内容；`admin-audit-2`：公司审计列表/count/export 不含另一公司信息；`admin-audit-3`：全局 offboard 操作与公司成员暂停不混用。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```typescript
test("admin-audit: scope isolation", async () => {
  const r = await runIsolationScenario("admin-audit", "admin-audit-1");
  expect(r.positiveControlPassed).toBe(true);
  expect(r.denied).toBe(true);
  expect(r.leakedRecords).toEqual([]);
  expect(r.forbiddenEffects).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**。`bun test server/tests/multitenancy/admin-audit.test.ts` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。旧部署 admin 与公司/团队管理动作分开。people promote/demote/offboard、network/capability/model routing、模板、审计、计费管理按公司授权；团队管理只管理本团队，不能凭 admin flag 读取任意业务内容。全局身份审计及平台静态能力配置保持独立权限。纯 UI 语言/主题可全局个人偏好，业务模型、提示词、默认资源和策略必须按归属保存。 通过 T01 工具生成 T16 迁移，核对编号 0124，生成 snapshot，DDL/RLS 一起验证。基线变更导致编号冲突时先调整分配，不手改已应用迁移或手写 metadata。

- [ ] **Step 4: GREEN 与适用检查**。`bun test server/tests/multitenancy/admin-audit.test.ts` 预期全部行为/正向控制通过、关键 skipped=0。补 server typecheck，企业合同改动含 typecheck:enterprise，及相关既有测试。Go/Python/Worker 在各自隔离环境跑现有检查。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T16` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

