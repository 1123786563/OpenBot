# Bot、会话、连接和插件隔离 Implementation Plan

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

### Task 5: Bot 创建、发布、生命周期与专家安装

**ID / Dependencies / Roles:** `T05` / T04 / implementer=`backend_implementer`，validator=`backend_validator`，独立 `reviewer`。

**Acceptance:** A1, A2, A3, A4, A8；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Modify: `server/src/agents/` 下明细分配的文件。
- Modify: `server/src/team-bots/` 下明细分配的文件。
- Modify: `server/src/marketplace/` 下明细分配的文件。
- Modify: `server/src/db/schema/coworker.ts`。
- Modify: `server/src/db/schema/team-bots.ts`。
- Modify: `server/src/db/schema/marketplace.ts`。
- Modify: `server/src/db/schema/lifecycle.ts`。
- Modify: `server/src/db/schema/defaults.ts`。
- Modify: `server/src/db/schema/core.ts`。
- Create: `server/tests/multitenancy/bots.test.ts`。
- Create: `server/tests/multitenancy/support/domains/bots.ts`。
- Create: `server/drizzle/0113_mt_bots.sql`，更新生成 snapshot/journal。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T05.md`、`checkpoints/T05/`。

**Interfaces:**
- Consumes: T04 已集成的 Interface 与同版本证据。
- Produces: `createScopedAgentProfileStore(context: CompanyRequestContext, deps: ScopedAgentDependencies): AgentProfileStore; createScopedTeamBotServices(context: CompanyRequestContext, deps: ScopedTeamBotDependencies): ScopedTeamBotServices`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `bots-1`：团队公共 Bot 可运行而不能被普通成员编辑；`bots-2`：公司 A 删除/重置同 ID 参数不能影响公司 B；`bots-3`：同一公共 Bot 的两名使用者没有共同个人凭据或浏览器登录态。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```typescript
test("bots: scope isolation", async () => {
  const r = await runIsolationScenario("bots", "bots-1");
  expect(r.positiveControlPassed).toBe(true);
  expect(r.denied).toBe(true);
  expect(r.leakedRecords).toEqual([]);
  expect(r.forbiddenEffects).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**。`bun test server/tests/multitenancy/bots.test.ts` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。Bot/Profile、偏好、发布、受众、分配、同意及安装回执建立同公司/团队关联。原 public 仅经明确迁移/发布进入 Workspace 公共范围；公共 Bot 使用者的会话与个人连接不绑定为创建者身份。复制、隐藏、重置、删除、模板更新及远端回调分别授权。硬删除/账号清理用公司作用域，不能仅凭 ownerUserId 删除该用户其他公司的 Bot。 通过 T01 工具生成 T05 迁移，核对编号 0113，生成 snapshot，DDL/RLS 一起验证。基线变更导致编号冲突时先调整分配，不手改已应用迁移或手写 metadata。

- [ ] **Step 4: GREEN 与适用检查**。`bun test server/tests/multitenancy/bots.test.ts` 预期全部行为/正向控制通过、关键 skipped=0。补 server typecheck，企业合同改动含 typecheck:enterprise，及相关既有测试。Go/Python/Worker 在各自隔离环境跑现有检查。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T05` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

### Task 6: 会话、群聊、历史线程与附件

**ID / Dependencies / Roles:** `T06` / T05 / implementer=`backend_implementer`，validator=`backend_validator`，独立 `reviewer`。

**Acceptance:** A1, A2, A3, A4, A8；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Modify: `server/src/channels/` 下明细分配的文件。
- Modify: `server/src/activity/` 下明细分配的文件。
- Modify: `server/src/enterprise/conversations/` 下明细分配的文件。
- Modify: `server/src/db/schema/core.ts`。
- Modify: `server/src/db/schema/group.ts`。
- Modify: `server/src/db/schema/enterprise-conversations.ts`。
- Modify: `server/src/intelligence-client.ts`。
- Modify: `server/src/user-instructions.ts`。
- Create: `server/tests/multitenancy/conversations.test.ts`。
- Create: `server/tests/multitenancy/support/domains/conversations.ts`。
- Create: `server/drizzle/0114_mt_conversations.sql`，更新生成 snapshot/journal。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T06.md`、`checkpoints/T06/`。

**Interfaces:**
- Consumes: T05 已集成的 Interface 与同版本证据。
- Produces: `createScopedChannelStore(context: CompanyRequestContext, deps: ScopedChannelDependencies): ChannelStore; authorizeAttachmentInTx(tx: TxClient, context: CompanyRequestContext, attachmentId: string, action: 'read' | 'write'): Promise<AttachmentAccess>`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `conversations-1`：另一团队游标、附件 ID 或 thread ID 无法泄露历史；`conversations-2`：同团队另一用户不能读私人会话；有明确群席位才可参与；`conversations-3`：撤权后新订阅和下载签发拒绝，在途流停止输出新内容。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```typescript
test("conversations: scope isolation", async () => {
  const r = await runIsolationScenario("conversations", "conversations-1");
  expect(r.positiveControlPassed).toBe(true);
  expect(r.denied).toBe(true);
  expect(r.leakedRecords).toEqual([]);
  expect(r.forbiddenEffects).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**。`bun test server/tests/multitenancy/conversations.test.ts` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。频道、成员、Bot 席位、群消息、附件和外部 thread mapping 保持同公司及受约束团队归属。列表/计数/分页游标、详情、重命名、归档、消息写入、历史 replay 和 socket/SSE 都校验权限。公共 Bot 不把个人会话公开。附件暂存上传、绑定、下载签发和 cull 追溯上传上下文；底层 thread ID 包含公司归属但仍需授权。 通过 T01 工具生成 T06 迁移，核对编号 0114，生成 snapshot，DDL/RLS 一起验证。基线变更导致编号冲突时先调整分配，不手改已应用迁移或手写 metadata。

- [ ] **Step 4: GREEN 与适用检查**。`bun test server/tests/multitenancy/conversations.test.ts` 预期全部行为/正向控制通过、关键 skipped=0。补 server typecheck，企业合同改动含 typecheck:enterprise，及相关既有测试。Go/Python/Worker 在各自隔离环境跑现有检查。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T06` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

### Task 7: 登录、连接凭据、OAuth、SSO/SCIM

**ID / Dependencies / Roles:** `T07` / T04, T06 / implementer=`backend_implementer`，validator=`backend_validator`，独立 `reviewer`。

**Acceptance:** A1, A2, A5, A7, A8；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Modify: `server/src/auth/` 下明细分配的文件。
- Modify: `server/src/identity/` 下明细分配的文件。
- Modify: `server/src/passwords/` 下明细分配的文件。
- Modify: `server/src/credentials.ts`。
- Modify: `server/src/provider-oauth.ts`。
- Modify: `server/src/provider-oauth-lock.ts`。
- Modify: `server/src/google-oauth-transport.ts`。
- Modify: `server/src/db/schema/identity.ts`。
- Modify: `server/src/db/schema/passwords.ts`。
- Modify: `server/src/db/schema/scim.ts`。
- Modify: `server/src/db/schema/core.ts`。
- Create: `server/src/tenancy/credential-access.ts`。
- Create: `server/tests/multitenancy/credentials.test.ts`。
- Create: `server/tests/multitenancy/support/domains/credentials.ts`。
- Create: `server/drizzle/0115_mt_identity_credentials.sql`，更新生成 snapshot/journal。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T07.md`、`checkpoints/T07/`。

**Interfaces:**
- Consumes: T04 已集成的 Interface 与同版本证据；T06 已集成的 Interface 与同版本证据。
- Produces: `resolveCredentialForUse(context: CompanyRequestContext, credentialId: string, purpose: CredentialPurpose): Promise<ScopedCredentialLease>; verifyConnectorCallback(state: string): Promise<ConnectorCallbackContext>`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `credentials-1`：在公司 A 发起 OAuth 后切换公司 B，回调仍绑定 A；`credentials-2`：同一个用户从 A 离职后仍能进入 B，B 的凭据不被 retire；`credentials-3`：公共 Bot 使用者不能获取发布者个人保存的登录。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```typescript
test("credentials: scope isolation", async () => {
  const r = await runIsolationScenario("credentials", "credentials-1");
  expect(r.positiveControlPassed).toBe(true);
  expect(r.denied).toBe(true);
  expect(r.leakedRecords).toEqual([]);
  expect(r.forbiddenEffects).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**。`bun test server/tests/multitenancy/credentials.test.ts` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。身份登录仍全局；公司 SSO/SCIM 配置、连接身份、凭据、站点登录和 refresh lock 按真实归属建关联。服务器 OAuth state 固定公司/团队/用户/连接目的；回调不用当前 selector 改归属。SCIM 离职仅撤销对应公司成员和资源资格。凭据可用不等于可读明文；个人凭据不因团队公共 Bot 自动共享，取用 lease 固定用途/作用域且可撤销。 通过 T01 工具生成 T07 迁移，核对编号 0115，生成 snapshot，DDL/RLS 一起验证。基线变更导致编号冲突时先调整分配，不手改已应用迁移或手写 metadata。

- [ ] **Step 4: GREEN 与适用检查**。`bun test server/tests/multitenancy/credentials.test.ts` 预期全部行为/正向控制通过、关键 skipped=0。补 server typecheck，企业合同改动含 typecheck:enterprise，及相关既有测试。Go/Python/Worker 在各自隔离环境跑现有检查。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T07` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

### Task 8: 插件、技能、组件与共享账号审批

**ID / Dependencies / Roles:** `T08` / T05, T07 / implementer=`backend_implementer`，validator=`backend_validator`，独立 `reviewer`。

**Acceptance:** A1, A2, A4, A5, A8；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Modify: `server/src/plugins/` 下明细分配的文件。
- Modify: `server/src/components/` 下明细分配的文件。
- Modify: `server/src/approvals/` 下明细分配的文件。
- Modify: `server/src/host-access/` 下明细分配的文件。
- Modify: `server/src/db/schema/plugins.ts`。
- Modify: `server/src/db/schema/components.ts`。
- Modify: `server/src/db/schema/approvals.ts`。
- Modify: `server/src/db/schema/shared-use.ts`。
- Create: `server/tests/multitenancy/plugins-approvals.test.ts`。
- Create: `server/tests/multitenancy/support/domains/plugins-approvals.ts`。
- Create: `server/drizzle/0116_mt_plugins_approvals.sql`，更新生成 snapshot/journal。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T08.md`、`checkpoints/T08/`。

**Interfaces:**
- Consumes: T05 已集成的 Interface 与同版本证据；T07 已集成的 Interface 与同版本证据。
- Produces: `createScopedPluginServices(context: CompanyRequestContext, deps: ScopedPluginDependencies): ScopedPluginServices; authorizeReviewedAction(tx: TxClient, context: CompanyRequestContext, approvalId: string): Promise<ReviewedActionAccess>`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `plugins-approvals-1`：另一个团队相同工具名不能借用安装或共享账号批准；`plugins-approvals-2`：个人技能/组件编辑权不因团队可使用而放宽；`plugins-approvals-3`：已审批写操作改变目标、参数或团队必须拒绝旧批准。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```typescript
test("plugins-approvals: scope isolation", async () => {
  const r = await runIsolationScenario("plugins-approvals", "plugins-approvals-1");
  expect(r.positiveControlPassed).toBe(true);
  expect(r.denied).toBe(true);
  expect(r.leakedRecords).toEqual([]);
  expect(r.forbiddenEffects).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**。`bun test server/tests/multitenancy/plugins-approvals.test.ts` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。MCP/Composio/OpenConnector 安装、连接、工具 Grant、技能与组件发布、组件函数、审批设置/规则和共享账号请求按公司/团队归属。公共目录可全局只读，安装及调用不可全局。工具调用重新验证当前用户的连接与 Bot Grant；审批锁定对象、参数摘要和归属，不允许修改团队后复用旧批准；现有危险动作审批行为保持。 通过 T01 工具生成 T08 迁移，核对编号 0116，生成 snapshot，DDL/RLS 一起验证。基线变更导致编号冲突时先调整分配，不手改已应用迁移或手写 metadata。

- [ ] **Step 4: GREEN 与适用检查**。`bun test server/tests/multitenancy/plugins-approvals.test.ts` 预期全部行为/正向控制通过、关键 skipped=0。补 server typecheck，企业合同改动含 typecheck:enterprise，及相关既有测试。Go/Python/Worker 在各自隔离环境跑现有检查。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T08` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

