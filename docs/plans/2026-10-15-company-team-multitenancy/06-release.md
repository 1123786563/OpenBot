# 观测、迁移、装配与全功能验收 Implementation Plan

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

### Task 23: 日志、Trace、使用量与外部观测出口

**ID / Dependencies / Roles:** `T23` / T11, T14, T15, T16 / implementer=`backend_implementer`，validator=`backend_validator`，独立 `reviewer`。

**Acceptance:** A1, A2, A8, A9, A13；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Modify: `server/src/telemetry/` 下明细分配的文件。
- Modify: `shared/logger.ts`。
- Modify: `server/src/desktop-telemetry.ts`。
- Modify: `server/src/db/schema/enterprise-run-events.ts`。
- Create: `server/tests/multitenancy/telemetry.test.ts`。
- Create: `server/tests/multitenancy/support/domains/telemetry.ts`。
- Create: `server/drizzle/0125_mt_trace_ownership.sql`，更新生成 snapshot/journal。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T23.md`、`checkpoints/T23/`。

**Interfaces:**
- Consumes: T11 已集成的 Interface 与同版本证据；T14 已集成的 Interface 与同版本证据；T15 已集成的 Interface 与同版本证据；T16 已集成的 Interface 与同版本证据。
- Produces: `attachBusinessTrace(context: TraceBusinessContext): TraceAttributes; authorizeTraceExport(scope: Scope, filter: TraceExportFilter): Promise<TraceExportAccess>`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `telemetry-1`：另一公司 trace ID 或导出过滤器不返回业务正文；`telemetry-2`：未知或缺作用域事件不能自动归入默认公司；`telemetry-3`：个人 Bifrost 事件不计公司账务，敏感 Key 不出现在日志。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```typescript
test("telemetry: scope isolation", async () => {
  const r = await runIsolationScenario("telemetry", "telemetry-1");
  expect(r.positiveControlPassed).toBe(true);
  expect(r.denied).toBe(true);
  expect(r.leakedRecords).toEqual([]);
  expect(r.forbiddenEffects).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**。`bun test server/tests/multitenancy/telemetry.test.ts` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。Trace/日志/用量事件携带真实公司团队/个人付款账户归属；服务 token、cookie、OAuth、个人Key和凭据正文继续脱敏。共享观测后端的公司查询/export/trace链接仍需授权，不把部署级 dashboard直接给普通租户。未落地 Opik/Bifrost 新功能不在本计划重做，实际启用的集成必须提交隔离与账户路由证据，不能以 planned 配置当已验证。 通过 T01 工具生成 T23 迁移，核对编号 0125，生成 snapshot，DDL/RLS 一起验证。基线变更导致编号冲突时先调整分配，不手改已应用迁移或手写 metadata。

- [ ] **Step 4: GREEN 与适用检查**。`bun test server/tests/multitenancy/telemetry.test.ts` 预期全部行为/正向控制通过、关键 skipped=0。补 server typecheck，企业合同改动含 typecheck:enterprise，及相关既有测试。Go/Python/Worker 在各自隔离环境跑现有检查。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T23` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

### Task 24: 历史回填、跨库迁移与安全回退

**ID / Dependencies / Roles:** `T24` / T05, T06, T07, T08, T09, T10, T11, T12, T13, T14, T15, T16, T23 / implementer=`backend_implementer`，validator=`backend_validator`，独立 `reviewer`。

**Acceptance:** A1, A2, A6, A12, A13；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Modify: `server/scripts/migrate.ts`。
- Modify: `server/src/production-entry.ts`。
- Modify: `docker/compose/services.yml`。
- Modify: `docker/compose/kb.yml`。
- Create: `server/scripts/multitenancy/backfill.ts`。
- Create: `server/scripts/multitenancy/check-readiness.ts`。
- Create: `server/tests/multitenancy/migration.test.ts`。
- Create: `docs/operations/company-team-multitenancy-cutover.md`。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T24.md`、`checkpoints/T24/`。

**Interfaces:**
- Consumes: T05 已集成的 Interface 与同版本证据；T06 已集成的 Interface 与同版本证据；T07 已集成的 Interface 与同版本证据；T08 已集成的 Interface 与同版本证据；T09 已集成的 Interface 与同版本证据；T10 已集成的 Interface 与同版本证据；T11 已集成的 Interface 与同版本证据；T12 已集成的 Interface 与同版本证据；T13 已集成的 Interface 与同版本证据；T14 已集成的 Interface 与同版本证据；T15 已集成的 Interface 与同版本证据；T16 已集成的 Interface 与同版本证据；T23 已集成的 Interface 与同版本证据。
- Produces: `buildBackfillManifest(input: LegacyDeploymentIdentity): Promise<BackfillManifest>; applyBackfill(manifest: BackfillManifest, mode: 'dry-run' | 'apply'): Promise<BackfillResult>; checkMultitenancyReadiness(input: ReadinessInput): Promise<ReadinessReport>`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `migration-1`：dry-run不改DB，重复apply不重复余额或权限；`migration-2`：跨库中途失败可恢复，未归属记录使ready=false；`migration-3`：恢复演练不重新开放未加租户隔离的旧入口。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```typescript
test("migration: scope isolation", async () => {
  const r = await runIsolationScenario("migration", "migration-1");
  expect(r.positiveControlPassed).toBe(true);
  expect(r.denied).toBe(true);
  expect(r.leakedRecords).toEqual([]);
  expect(r.forbiddenEffects).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**。`bun test server/tests/multitenancy/migration.test.ts` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。按实际清单建原有公司/默认团队，保持历史私人授权。根记录归属后按复合关联回填子记录；主DB与KB独立记录进度及一致性，不能宣称跨库单事务。历史部署余额只迁一次到原有公司，已存在个人余额保留。无法唯一归属数据出清单并阻断启用；外部文件/thread/browser/向量等迁移同样记录。工具默认 dry-run，apply 必须显式提供核验 manifest；计划阶段不执行生产迁移。文档写冻结写入、备份恢复、失败隔离及不可回退单租户旧版本的步骤。 

- [ ] **Step 4: GREEN 与适用检查**。`bun test server/tests/multitenancy/migration.test.ts` 预期全部行为/正向控制通过、关键 skipped=0。补 server typecheck，企业合同改动含 typecheck:enterprise，及相关既有测试。Go/Python/Worker 在各自隔离环境跑现有检查。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T24` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

### Task 25: 主入口、Enterprise 与全客户端装配闭合

**ID / Dependencies / Roles:** `T25` / T02, T03, T04, T05, T06, T07, T08, T09, T10, T11, T12, T13, T14, T15, T16, T23, T24 / implementer=`backend_implementer`，validator=`backend_validator`，独立 `reviewer`。

**Acceptance:** A1, A2, A5, A6, A8, A11；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Modify: `server/src/app.ts`。
- Modify: `server/src/index.ts`。
- Modify: `server/src/enterprise/app.ts`。
- Modify: `server/src/enterprise/bootstrap.ts`。
- Modify: `server/src/enterprise/index.ts`。
- Modify: `server/src/production-entry.ts`。
- Modify: `charts/openbot/values.yaml`。
- Create: `server/src/tenancy/assembly.ts`。
- Create: `server/tests/multitenancy/assembly.test.ts`。
- Create: `server/tests/multitenancy/support/domains/assembly.ts`。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T25.md`、`checkpoints/T25/`。

**Interfaces:**
- Consumes: T02 已集成的 Interface 与同版本证据；T03 已集成的 Interface 与同版本证据；T04 已集成的 Interface 与同版本证据；T05 已集成的 Interface 与同版本证据；T06 已集成的 Interface 与同版本证据；T07 已集成的 Interface 与同版本证据；T08 已集成的 Interface 与同版本证据；T09 已集成的 Interface 与同版本证据；T10 已集成的 Interface 与同版本证据；T11 已集成的 Interface 与同版本证据；T12 已集成的 Interface 与同版本证据；T13 已集成的 Interface 与同版本证据；T14 已集成的 Interface 与同版本证据；T15 已集成的 Interface 与同版本证据；T16 已集成的 Interface 与同版本证据；T23 已集成的 Interface 与同版本证据；T24 已集成的 Interface 与同版本证据。
- Produces: `createScopedAssembly(deps: ScopedAssemblyDependencies): ScopedAssembly; ScopedAssembly.forRequest(context: CompanyRequestContext): ScopedBusinessServices; listRegisteredIsolationSurfaces(): readonly RegisteredIsolationSurface[]`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `assembly-1`：真实全量装配 route registry 无未分类端点，动态/disabled endpoints也有明确归属；`assembly-2`：直接调用旧REST/Copilot/mobile/internal路径不能绕过授权；`assembly-3`：单租户兼容正常，多租户缺context没有任何default fallback。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```typescript
test("assembly: scope isolation", async () => {
  const r = await runIsolationScenario("assembly", "assembly-1");
  expect(r.positiveControlPassed).toBe(true);
  expect(r.denied).toBe(true);
  expect(r.leakedRecords).toEqual([]);
  expect(r.forbiddenEffects).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**。`bun test server/tests/multitenancy/assembly.test.ts` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。在每种 HTTP/内部/stream入口从已认证身份建立上下文并使用已验证 scoped factories；保持 API 路径及 DTO 能力兼容，不能只隔离 enterprise/v1。全局登录/健康/静态目录、机器回调及个人Bifrost路径分别显式登记。多租户启动调用readiness拒绝漏项、单用户绕过和不安全DB角色；配置及 Worker组装不保留启动时默认公司。普通业务事务不跨外部网络等待。 

- [ ] **Step 4: GREEN 与适用检查**。`bun test server/tests/multitenancy/assembly.test.ts` 预期全部行为/正向控制通过、关键 skipped=0。补 server typecheck，企业合同改动含 typecheck:enterprise，及相关既有测试。Go/Python/Worker 在各自隔离环境跑现有检查。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T25` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

### Task 26: 全功能正向/越权验收、独立审查与统一上线证据

**ID / Dependencies / Roles:** `T26` / T18, T19, T21, T22, T25, T20 / implementer=`backend_implementer`，validator=`backend_validator`，独立 `reviewer`。

**Acceptance:** A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Modify: `scripts/test-ci.ts`。
- Modify: `e2e.config.ts`。
- Create: `server/tests/multitenancy/full-coverage.test.ts`。
- Create: `e2e.multitenancy.config.ts`。
- Create: `scripts/multitenancy-acceptance.ts`。
- Create: `docs/plans/2026-10-15-company-team-multitenancy/release-evidence.md`。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T26.md`、`checkpoints/T26/`。

**Interfaces:**
- Consumes: T18 已集成的 Interface 与同版本证据；T19 已集成的 Interface 与同版本证据；T21 已集成的 Interface 与同版本证据；T22 已集成的 Interface 与同版本证据；T25 已集成的 Interface 与同版本证据；T20 已集成的 Interface 与同版本证据。
- Produces: `runMultitenancyAcceptance(input: AcceptanceEnvironment): Promise<AcceptanceReport>；报告引用同一检查点hash、全部注册入口、业务正向及拒绝结果、跳过项与外部服务证据。`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `full-coverage-1`：任一功能正向失败、越权成功、skipped关键场景或缺外部证据使release=false；`full-coverage-2`：同一检查点的全部验证、独立Review和完整OCR范围一致；`full-coverage-3`：共享端口、原开发数据库和root .env未被验收脚本使用。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```typescript
test("full-coverage: scope isolation", async () => {
  const r = await runIsolationScenario("full-coverage", "full-coverage-1");
  expect(r.positiveControlPassed).toBe(true);
  expect(r.denied).toBe(true);
  expect(r.leakedRecords).toEqual([]);
  expect(r.forbiddenEffects).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**。`bun test server/tests/multitenancy/full-coverage.test.ts` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。建立独立测试端口/数据库/外部命名空间，所有验收按真实注册清单执行。Agent实现测试入口后由独立前后端验证者运行与补齐证据，再由reviewer审查，主控OCR覆盖原始BASE至交付HEAD及workspace；子模块单独OCR覆盖全部实际交付差异。critical/high/medium修复走新编号SDD计划。全节点verified、无真实阻塞项后形成上线候选包；生产apply/部署/发布仍需用户授权，不能在验收脚本中自动执行。 

- [ ] **Step 4: GREEN 与适用检查**。`bun test server/tests/multitenancy/full-coverage.test.ts` 预期全部行为/正向控制通过、关键 skipped=0。补 server typecheck，企业合同改动含 typecheck:enterprise，及相关既有测试。Go/Python/Worker 在各自隔离环境跑现有检查。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T26` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

