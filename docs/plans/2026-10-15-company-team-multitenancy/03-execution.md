# 知识、自动化、电脑及创作隔离 Implementation Plan

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

### Task 9: 知识、记忆、研究和学习

**ID / Dependencies / Roles:** `T09` / T06, T08 / implementer=`backend_implementer`，validator=`backend_validator`，独立 `reviewer`。

**Acceptance:** A1, A2, A4, A8；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Modify: `server/src/kb/` 下明细分配的文件。
- Modify: `server/src/knowledge/` 下明细分配的文件。
- Modify: `server/src/memory/` 下明细分配的文件。
- Modify: `server/src/learning/` 下明细分配的文件。
- Modify: `server/src/demonstrations/` 下明细分配的文件。
- Modify: `server/src/db/schema/memory.ts`。
- Modify: `server/src/db/schema/learning.ts`。
- Modify: `server/src/db/schema/demonstrations.ts`。
- Modify: `server/src/kb/db/schema.ts`。
- Create: `server/tests/multitenancy/knowledge-memory.test.ts`。
- Create: `server/tests/multitenancy/support/domains/knowledge-memory.ts`。
- Create: `server/drizzle/0117_mt_knowledge_memory.sql`，更新生成 snapshot/journal。KB 独立迁移：`server/drizzle-kb/0001_mt_workspace_knowledge.sql`。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T09.md`、`checkpoints/T09/`。

**Interfaces:**
- Consumes: T06 已集成的 Interface 与同版本证据；T08 已集成的 Interface 与同版本证据。
- Produces: `resolveKnowledgeAccess(context: CompanyRequestContext, requestedKbIds: readonly string[]): Promise<KnowledgeAccess>; retrieveScopedKnowledge(context: CompanyRequestContext, query: KnowledgeQuery): Promise<KnowledgeResult>`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `knowledge-memory-1`：非团队 KB 的候选内容不进入 re-ranker/model 的请求；`knowledge-memory-2`：公共 KB 新成员可检索，但不可上传/删除；`knowledge-memory-3`：同团队另一人的个人记忆、研究来源和学习上下文不可读。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```typescript
test("knowledge-memory: scope isolation", async () => {
  const r = await runIsolationScenario("knowledge-memory", "knowledge-memory-1");
  expect(r.positiveControlPassed).toBe(true);
  expect(r.denied).toBe(true);
  expect(r.leakedRecords).toEqual([]);
  expect(r.forbiddenEffects).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**。`bun test server/tests/multitenancy/knowledge-memory.test.ts` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。KB 独立数据库内加 Workspace 归属与受限查询；跨库不声称有 PostgreSQL FK，由调用时授权与同步版本保证关联。检索端在候选返回、重排和模型前限制 KB/文档集合，不把公司范围 kbScope=[] Key 直接当团队授权。导入/重解析任务、原文件、chunk/revision、个人记忆来源、学习容器和演示保持作用域；学习外部服务不得将客户内容放入共同容器。 通过 T01 工具生成 T09 迁移，核对编号 0117，生成 snapshot，DDL/RLS 一起验证。基线变更导致编号冲突时先调整分配，不手改已应用迁移或手写 metadata。

- [ ] **Step 4: GREEN 与适用检查**。`bun test server/tests/multitenancy/knowledge-memory.test.ts` 预期全部行为/正向控制通过、关键 skipped=0。补 server typecheck，企业合同改动含 typecheck:enterprise，及相关既有测试。Go/Python/Worker 在各自隔离环境跑现有检查。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T09` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

### Task 10: 职责、计划、定时任务与主动执行

**ID / Dependencies / Roles:** `T10` / T06, T08 / implementer=`backend_implementer`，validator=`backend_validator`，独立 `reviewer`。

**Acceptance:** A2, A5, A8；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Modify: `server/src/responsibilities/` 下明细分配的文件。
- Modify: `server/src/routines/` 下明细分配的文件。
- Modify: `server/src/proactive/` 下明细分配的文件。
- Modify: `server/src/work/` 下明细分配的文件。
- Modify: `worker/src/` 下明细分配的文件。
- Modify: `server/src/db/schema/responsibilities.ts`。
- Modify: `server/src/db/schema/coworker.ts`。
- Modify: `server/src/db/schema/proactive.ts`。
- Modify: `server/src/db/schema/work.ts`。
- Modify: `server/scripts/fire-routines.ts`。
- Create: `server/src/tenancy/execution-context.ts`。
- Create: `server/tests/multitenancy/jobs.test.ts`。
- Create: `server/tests/multitenancy/support/domains/jobs.ts`。
- Create: `server/drizzle/0118_mt_jobs.sql`，更新生成 snapshot/journal。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T10.md`、`checkpoints/T10/`。

**Interfaces:**
- Consumes: T06 已集成的 Interface 与同版本证据；T08 已集成的 Interface 与同版本证据。
- Produces: `loadExecutionContext(tx: TxClient, jobId: string): Promise<ExecutionContext>; revalidateExecutionAction(context: ExecutionContext, resourceId: string, action: ResourceAction): Promise<void>`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `jobs-1`：成员撤销后已有任务在下一敏感动作停止；`jobs-2`：队列消息篡改 tenant_id 不改变 job 的持久归属；`jobs-3`：用户切换团队后旧任务的结果、配置和用量仍属于原团队。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```typescript
test("jobs: scope isolation", async () => {
  const r = await runIsolationScenario("jobs", "jobs-1");
  expect(r.positiveControlPassed).toBe(true);
  expect(r.denied).toBe(true);
  expect(r.leakedRecords).toEqual([]);
  expect(r.forbiddenEffects).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**。`bun test server/tests/multitenancy/jobs.test.ts` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。任务/运行/触发/租约固定原公司团队、业务发起主体和配置版本；全局扫描仅有调度权限，每项执行重建业务 Scope/资格。机器认证不伪造 dev-local-user，也不将序列化 Scope 当可信对象。认领、重试、人工取消、定时任务、邮件/GitHub/Webhook 入站和主动建议均通过固定归属；网络调用前后分开事务，不能持锁等待外部 API。 通过 T01 工具生成 T10 迁移，核对编号 0118，生成 snapshot，DDL/RLS 一起验证。基线变更导致编号冲突时先调整分配，不手改已应用迁移或手写 metadata。

- [ ] **Step 4: GREEN 与适用检查**。`bun test server/tests/multitenancy/jobs.test.ts` 预期全部行为/正向控制通过、关键 skipped=0。补 server typecheck，企业合同改动含 typecheck:enterprise，及相关既有测试。Go/Python/Worker 在各自隔离环境跑现有检查。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T10` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

### Task 11: 电脑、沙箱、Agent 与 Runtime 执行隔离

**ID / Dependencies / Roles:** `T11` / T05, T07, T08, T10 / implementer=`backend_implementer`，validator=`backend_validator`，独立 `reviewer`。

**Acceptance:** A1, A2, A5, A8；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Modify: `server/src/computer/` 下明细分配的文件。
- Modify: `server/src/codesandbox/` 下明细分配的文件。
- Modify: `server/src/sandbox/` 下明细分配的文件。
- Modify: `server/src/enterprise/runtime/` 下明细分配的文件。
- Modify: `supervisor/src/` 下明细分配的文件。
- Modify: `agent-computer/src/` 下明细分配的文件。
- Modify: `agent-sandbox/src/` 下明细分配的文件。
- Modify: `runtime-go/` 下明细分配的文件。
- Modify: `server/src/enterprise/runs/` 下明细分配的文件。
- Modify: `server/src/db/schema/computer.ts`。
- Modify: `server/src/db/schema/code-runs.ts`。
- Modify: `server/src/db/schema/sandbox-instances.ts`。
- Modify: `shared/agent-authorisation.ts`。
- Modify: `server/scripts/cull-idle-computers.ts`。
- Modify: `server/src/db/schema/enterprise-runs.ts`。
- Create: `shared/execution-ownership.ts`。
- Create: `server/tests/multitenancy/execution.test.ts`。
- Create: `server/tests/multitenancy/support/domains/execution.ts`。
- Create: `server/drizzle/0119_mt_execution.sql`，更新生成 snapshot/journal。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T11.md`、`checkpoints/T11/`。

**Interfaces:**
- Consumes: T05 已集成的 Interface 与同版本证据；T07 已集成的 Interface 与同版本证据；T08 已集成的 Interface 与同版本证据；T10 已集成的 Interface 与同版本证据。
- Produces: `ExecutionOwnership = Readonly<{tenantId: string; workspaceId: string; principalId: string; runId: string}>; verifyExecutionOwnership(input: unknown, verifier: ExecutionOwnershipVerifier): Promise<ExecutionOwnership>`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `execution-1`：公司 B 的 screen/action/cancel 请求不能影响 A 的运行；`execution-2`：前一使用者登录状态不会出现在下一个使用者的共享 Bot 电脑；`execution-3`：回调重放、无归属请求和撤销的执行能力被拒绝。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```typescript
test("execution: scope isolation", async () => {
  const r = await runIsolationScenario("execution", "execution-1");
  expect(r.positiveControlPassed).toBe(true);
  expect(r.denied).toBe(true);
  expect(r.leakedRecords).toEqual([]);
  expect(r.forbiddenEffects).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**。`bun test server/tests/multitenancy/execution.test.ts` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。扩展现有服务认证/受限能力和回调，使执行、屏幕、人工接管、快照、shell、文件、cancel/reset/cull 固定业务归属；服务 token 不直接授予任意公司数据。状态化公共 Bot 为不同使用者分开个人 browser profile/workspace 或验证无状态复用后回收，不共享登录态。所有现有 agent-* 适配器消费同一已验证执行归属；不能因框架不同忽略授权。保持已批准执行上界/审批和机密脱敏。 通过 T01 工具生成 T11 迁移，核对编号 0119，生成 snapshot，DDL/RLS 一起验证。基线变更导致编号冲突时先调整分配，不手改已应用迁移或手写 metadata。

- [ ] **Step 4: GREEN 与适用检查**。`bun test server/tests/multitenancy/execution.test.ts` 预期全部行为/正向控制通过、关键 skipped=0。补 server typecheck，企业合同改动含 typecheck:enterprise，及相关既有测试。Go/Python/Worker 在各自隔离环境跑现有检查。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T11` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

### Task 12: Craft、Workshop、产物与分享

**ID / Dependencies / Roles:** `T12` / T06, T08, T10, T11 / implementer=`backend_implementer`，validator=`backend_validator`，独立 `reviewer`。

**Acceptance:** A1, A2, A4, A5, A8；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Modify: `server/src/craft/` 下明细分配的文件。
- Modify: `server/src/workshop/` 下明细分配的文件。
- Modify: `server/src/db/schema/craft.ts`。
- Modify: `server/src/db/schema/workshop.ts`。
- Modify: `server/scripts/fire-workshop-schedules.ts`。
- Create: `server/tests/multitenancy/craft-workshop.test.ts`。
- Create: `server/tests/multitenancy/support/domains/craft-workshop.ts`。
- Create: `server/drizzle/0120_mt_craft_workshop.sql`，更新生成 snapshot/journal。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T12.md`、`checkpoints/T12/`。

**Interfaces:**
- Consumes: T06 已集成的 Interface 与同版本证据；T08 已集成的 Interface 与同版本证据；T10 已集成的 Interface 与同版本证据；T11 已集成的 Interface 与同版本证据。
- Produces: `resolveArtifactAccess(context: CompanyRequestContext, artifactId: string): Promise<ArtifactAccess>; resolveShareAccess(token: string, verifiedUserId: string): Promise<ShareAccess>`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `craft-workshop-1`：另一公司的分享 token/产物 ID 不可读；`craft-workshop-2`：同团队未授权个人 Craft 会话不可读；`craft-workshop-3`：撤销分享后访问和下载签发失败，旧链接的有效窗口符合明示约束。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```typescript
test("craft-workshop: scope isolation", async () => {
  const r = await runIsolationScenario("craft-workshop", "craft-workshop-1");
  expect(r.positiveControlPassed).toBe(true);
  expect(r.denied).toBe(true);
  expect(r.leakedRecords).toEqual([]);
  expect(r.forbiddenEffects).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**。`bun test server/tests/multitenancy/craft-workshop.test.ts` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。会话、turn、消息、快照、计划任务、子任务、应用连接、产物、对象存储和 sandbox 关联加作用域。匿名公开端点改为本设计内有效分享授权，默认同团队，显式同公司跨团队分享验证受众；分享 token 不成为跨公司公开能力。签名下载在签发与代理访问点校验，撤销停止后续签发/访问，避免把长有效期不可撤销直链当已撤销。 通过 T01 工具生成 T12 迁移，核对编号 0120，生成 snapshot，DDL/RLS 一起验证。基线变更导致编号冲突时先调整分配，不手改已应用迁移或手写 metadata。

- [ ] **Step 4: GREEN 与适用检查**。`bun test server/tests/multitenancy/craft-workshop.test.ts` 预期全部行为/正向控制通过、关键 skipped=0。补 server typecheck，企业合同改动含 typecheck:enterprise，及相关既有测试。Go/Python/Worker 在各自隔离环境跑现有检查。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T12` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

