# 公司团队基础与统一授权 Implementation Plan

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

执行顺序见 [总计划](00-master.md)/[DAG](../../../.archive/runs/legacy-plans/2026-10-15-company-team-multitenancy/dag-ledger.md)，共同类型见 [Interface](interfaces.md)。计划审阅并选择执行方法后才执行。所有路径相对工作区 `/Users/wuyongjun/orca/workspaces/OpenBot/company-team-multitenancy`。T22 是独立 Git 子模块，必须递归检查点、单独审查。文件明细见 `.archive/runs/legacy-plans/2026-10-15-company-team-multitenancy/surface-inventory.json`；目录范围排除已显式分给其他任务的文件。

### Task 1: 全入口清单、隔离夹具与安全迁移工具

**ID / Dependencies / Roles:** `T01` / 无 / implementer=`backend_implementer`，validator=`backend_validator`，独立 `reviewer`。

**Acceptance:** A6, A11；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Read: `server/src/app.ts`。
- Read: `server/src/enterprise/app.ts`。
- Read: `server/scripts/enterprise-test-db.ts`。
- Read: `server/tests/support/database.ts`。
- Read: `scripts/test-ci.ts`。
- Create: `server/scripts/multitenancy/inventory.ts`。
- Create: `server/scripts/multitenancy/migrate-test.ts`。
- Create: `server/tests/multitenancy/support/fixture.ts`。
- Create: `server/tests/multitenancy/support/scenarios.ts`。
- Create: `server/tests/multitenancy/inventory.test.ts`。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T01.md`、`checkpoints/T01/`。

**Interfaces:**
- Consumes: 批准 Spec、ADR、BASE、实际 route/store factories。
- Produces: `createIsolationFixture(domain: IsolationDomain): Promise<IsolationFixture>; inspectIsolationCoverage(root: string): Promise<CoverageInventory>`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `inventory-1`：新加的未分类路由使 coverage gate 失败，不能被通配规则吞掉；`inventory-2`：非测试数据库 URL 在启动迁移子进程之前被拒绝；`inventory-3`：有效自有访问实际成功，缺公司上下文拒绝；连接池复用不带出上次上下文。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```typescript
test("inventory: scope isolation", async () => {
  const r = await runIsolationScenario("inventory", "inventory-1");
  expect(r.positiveControlPassed).toBe(true);
  expect(r.denied).toBe(true);
  expect(r.leakedRecords).toEqual([]);
  expect(r.forbiddenEffects).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**。`bun test server/tests/multitenancy/inventory.test.ts` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。提取真实 createApp/createEnterpriseApp 注册表与静态候选，包含动态/条件路由、所有后台程序和 schema。定义三团队、两公司、多团队用户、另一同团队用户、管理员和机器身份夹具；使用实际受限 PostgreSQL 角色及真实业务 factory，不能以模拟授权器替代。迁移工具只接受枚举 Task ID 与 generate/migrate 命令，只读取 TEST_DATABASE_URL/TEST_KB_DATABASE_URL，拒绝生产库及隐式 .env；为每个业务任务生成固定名字的迁移并校验编号。 

- [ ] **Step 4: GREEN 与适用检查**。`bun test server/tests/multitenancy/inventory.test.ts` 预期全部行为/正向控制通过、关键 skipped=0。补 server typecheck，企业合同改动含 typecheck:enterprise，及相关既有测试。Go/Python/Worker 在各自隔离环境跑现有检查。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T01` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

### Task 2: 公司/团队成员开通、选择与撤权

**ID / Dependencies / Roles:** `T02` / T01 / implementer=`backend_implementer`，validator=`backend_validator`，独立 `reviewer`。

**Acceptance:** A1, A2, A3, A5, A6；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Modify: `server/src/enterprise/tenancy/` 下明细分配的文件。
- Modify: `server/src/db/schema/enterprise-tenancy.ts`。
- Modify: `server/src/db/schema/index.ts`。
- Modify: `server/src/enterprise/contracts.ts`。
- Modify: `shared/enterprise/contracts.ts`。
- Modify: `server/src/auth/guards.ts`。
- Create: `server/src/tenancy/contracts.ts`。
- Create: `server/src/tenancy/workspaces.ts`。
- Create: `server/src/tenancy/routes.ts`。
- Create: `server/tests/multitenancy/memberships.test.ts`。
- Create: `server/drizzle/0110_mt_workspaces.sql`，更新生成 snapshot/journal。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T02.md`、`checkpoints/T02/`。

**Interfaces:**
- Consumes: T01 已集成的 Interface 与同版本证据。
- Produces: `withWorkspace<T>(database: Database, scope: Scope, workspaceId: string, fn: (tx: TxClient, member: WorkspaceMember) => Promise<T>): Promise<T>; resolveCompanyRequest(directory: Directory, userId: string, headers: Headers): Promise<CompanyRequestContext>`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `memberships-1`：只属甲用户进入乙拒绝；甲乙成员分别进入两团队成功；`memberships-2`：撤销公司资格同时拒绝各团队，其他公司的资格仍有效；`memberships-3`：数据库拒绝另一公司 Workspace/Principal 的成员关联。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```typescript
test("memberships: scope isolation", async () => {
  const r = await runIsolationScenario("memberships", "memberships-1");
  expect(r.positiveControlPassed).toBe(true);
  expect(r.denied).toBe(true);
  expect(r.leakedRecords).toEqual([]);
  expect(r.forbiddenEffects).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**。`bun test server/tests/multitenancy/memberships.test.ts` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。新增复合 Workspace Membership（role=workspace_admin/member、status=active/suspended、epoch 正整数），复用公司 Membership；定义公司及团队列表/管理入口。公司 Scope 仍只能经 resolveScope 签发。x-openbot-tenant 与 x-openbot-workspace 仅作选择；无 selector 不回退默认公司。公司管理员可管理本公司的团队名单但不由此获得业务内容。团队变更沿 tenant→principal→membership→workspace→workspace-membership 顺序锁定、更新版本并写审计。 通过 T01 工具生成 T02 迁移，核对编号 0110，生成 snapshot，DDL/RLS 一起验证。基线变更导致编号冲突时先调整分配，不手改已应用迁移或手写 metadata。

- [ ] **Step 4: GREEN 与适用检查**。`bun test server/tests/multitenancy/memberships.test.ts` 预期全部行为/正向控制通过、关键 skipped=0。补 server typecheck，企业合同改动含 typecheck:enterprise，及相关既有测试。Go/Python/Worker 在各自隔离环境跑现有检查。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T02` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

### Task 3: 团队公共资源授权与旧接口作用域适配

**ID / Dependencies / Roles:** `T03` / T02 / implementer=`backend_implementer`，validator=`backend_validator`，独立 `reviewer`。

**Acceptance:** A1, A2, A4, A5, A6；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Modify: `server/src/enterprise/authz/` 下明细分配的文件。
- Modify: `server/src/enterprise/contracts.ts`。
- Modify: `server/src/db/schema/enterprise-authz.ts`。
- Modify: `server/src/enterprise/tenancy/provision.ts`。
- Create: `server/src/tenancy/authorization.ts`。
- Create: `server/src/tenancy/scoped-domain.ts`。
- Create: `server/tests/multitenancy/resource-policy.test.ts`。
- Create: `server/drizzle/0111_mt_resource_policy.sql`，更新生成 snapshot/journal。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T03.md`、`checkpoints/T03/`。

**Interfaces:**
- Consumes: T02 已集成的 Interface 与同版本证据。
- Produces: `requireResourceAccessInTx(tx: TxClient, scope: Scope, resourceId: string, action: ResourceAction, selectedWorkspaceId?: string): Promise<ResourceAccess>; bindScopedDomain<T>(context: CompanyRequestContext, factory: (context: CompanyRequestContext) => T): T`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `resource-policy-1`：新成员无个人 Grant 能使用公共资源，不能编辑或读取别人个人内容；`resource-policy-2`：相同资源 ID、旧 public、跨团队 explicit share 分别遵守归属与受众规则；`resource-policy-3`：旧策略租户不因新规则获得权限；撤销后续动作立即失败。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```typescript
test("resource-policy: scope isolation", async () => {
  const r = await runIsolationScenario("resource-policy", "resource-policy-1");
  expect(r.positiveControlPassed).toBe(true);
  expect(r.denied).toBe(true);
  expect(r.leakedRecords).toEqual([]);
  expect(r.forbiddenEffects).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**。`bun test server/tests/multitenancy/resource-policy.test.ts` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。资源增加 visibility=private/workspace；新 workspace-v1 策略支持 read/run/write/delete/share/manage，旧策略原义保留。团队公共 Bot 仅开放 read/run，公共 KB 仅开放 read；编辑与删除不继承。个人资源检查所有权或明确授权；同公司显式分享独立验证受众、动作、有效期，跨公司 Grant 永远拒绝。集中计算授权事实与复合关系，在事务内重验团队；scoped-domain 只绑定不可变请求上下文，不持有跨网络调用事务，也不保留全局当前租户。 通过 T01 工具生成 T03 迁移，核对编号 0111，生成 snapshot，DDL/RLS 一起验证。基线变更导致编号冲突时先调整分配，不手改已应用迁移或手写 metadata。

- [ ] **Step 4: GREEN 与适用检查**。`bun test server/tests/multitenancy/resource-policy.test.ts` 预期全部行为/正向控制通过、关键 skipped=0。补 server typecheck，企业合同改动含 typecheck:enterprise，及相关既有测试。Go/Python/Worker 在各自隔离环境跑现有检查。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T03` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

### Task 4: 公司运行配置与租户包装配

**ID / Dependencies / Roles:** `T04` / T03 / implementer=`backend_implementer`，validator=`backend_validator`，独立 `reviewer`。

**Acceptance:** A1, A6, A8；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Modify: `server/src/config.ts`。
- Modify: `server/src/tenant-package.ts`。
- Modify: `server/src/channels/thread-identity.ts`。
- Modify: `server/src/enterprise/config.ts`。
- Create: `server/src/tenancy/runtime-config.ts`。
- Create: `server/src/db/schema/company-runtime.ts`。
- Create: `server/tests/multitenancy/runtime-config.test.ts`。
- Create: `server/drizzle/0112_mt_runtime_config.sql`，更新生成 snapshot/journal。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T04.md`、`checkpoints/T04/`。

**Interfaces:**
- Consumes: T03 已集成的 Interface 与同版本证据。
- Produces: `createCompanyRuntimeResolver(deps: CompanyRuntimeDependencies): CompanyRuntimeResolver; CompanyRuntimeResolver.resolve(scope: Scope, workspaceId?: string): Promise<CompanyRuntimeConfig>`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `runtime-config-1`：两公司相同 Bot 名称使用各自配置、线程和凭据引用；`runtime-config-2`：运行期间切换选择不改变已创建任务配置及付款归属；`runtime-config-3`：未分类业务入口或 dev actor 使多租户启动拒绝。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```typescript
test("runtime-config: scope isolation", async () => {
  const r = await runIsolationScenario("runtime-config", "runtime-config-1");
  expect(r.positiveControlPassed).toBe(true);
  expect(r.denied).toBe(true);
  expect(r.leakedRecords).toEqual([]);
  expect(r.forbiddenEffects).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**。`bun test server/tests/multitenancy/runtime-config.test.ts` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。新增 OPENBOT_MULTITENANT 布尔模式，true 时拒绝单用户/开发 actor 并要求覆盖清单完整；公司运行配置保存套餐映射、租户包版本和模型/凭据引用。模板、网络连接池及部署密钥继续共享，业务模型、线程标识、默认 Bot/技能按公司团队解析；团队覆盖只收窄公司政策。缓存键包含公司、团队、配置版本；不得在 resolve 时读取任意环境变量或泄露凭据值。保留单租户部署兼容行为，但多租户模式无旧默认回退。 通过 T01 工具生成 T04 迁移，核对编号 0112，生成 snapshot，DDL/RLS 一起验证。基线变更导致编号冲突时先调整分配，不手改已应用迁移或手写 metadata。

- [ ] **Step 4: GREEN 与适用检查**。`bun test server/tests/multitenancy/runtime-config.test.ts` 预期全部行为/正向控制通过、关键 skipped=0。补 server typecheck，企业合同改动含 typecheck:enterprise，及相关既有测试。Go/Python/Worker 在各自隔离环境跑现有检查。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T04` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

