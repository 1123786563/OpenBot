# Web、桌面和Canonical移动客户端隔离 Implementation Plan

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

### Task 17: Web 公司/团队选择与统一请求缓存

**ID / Dependencies / Roles:** `T17` / T02, T03, T04 / implementer=`frontend_implementer`，validator=`frontend_validator`，独立 `reviewer`。

**Acceptance:** A3, A6, A10；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Modify: `app/src/lib/client.ts`。
- Modify: `app/src/lib/enterprise/tenant/queries.ts`。
- Modify: `app/src/lib/enterprise/tenant/mutations.ts`。
- Modify: `app/src/query-client.ts`。
- Modify: `app/src/locales/en/tenant.json`。
- Modify: `app/src/locales/zh-CN/tenant.json`。
- Modify: `app/src/routes/_authed.tsx`。
- Modify: `app/src/routes/_authed/_app.tsx`。
- Create: `app/src/lib/tenancy/selection.ts`。
- Create: `app/src/lib/tenancy/query-key.ts`。
- Create: `app/src/components/tenancy/WorkspaceSelector.tsx`。
- Create: `app/tests/multitenancy/selection.test.tsx`。
- Create: `app/tests/multitenancy/support.tsx`。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T17.md`、`checkpoints/T17/`。

**Interfaces:**
- Consumes: T02 已集成的 Interface 与同版本证据；T03 已集成的 Interface 与同版本证据；T04 已集成的 Interface 与同版本证据。
- Produces: `Selection = Readonly<{userId: string; tenantId: string; workspaceId: string; generation: number}>; scopeQueryKey(selection: Selection, feature: string, args?: unknown): readonly unknown[]; selectWorkspace(queryClient: QueryClient, next: Selection): Promise<void>`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `web-selection-1`：A1 请求在切到 A2/B 后返回，不显示旧内容；`web-selection-2`：多标签页各持请求选择，无模块全局可变当前团队；`web-selection-3`：第三方 URL、公开静态目录和认证端点不收到业务作用域 headers。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```typescript
test("web-selection: scope isolation", async () => {
  const r = await runClientIsolationScenario("web", "web-selection-1");
  expect(r.positiveControlPassed).toBe(true);
  expect(r.denied).toBe(true);
  expect(r.leakedRecords).toEqual([]);
  expect(r.forbiddenEffects).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**。`bun test app/tests/multitenancy/selection.test.tsx` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。延续现有公司 chooser/cache generation，增加团队选择、无资格空状态和 loading/error/revoked 状态。REST/SSE/WebSocket/上传下载签发统一附加选择；只给已审核同源业务路径发送 headers。每个公司业务缓存键包含 user/company/workspace；切换取消订阅、移除旧范围缓存并拒绝旧 generation 的返回。不能让未选择状态自动请求默认团队。 

- [ ] **Step 4: GREEN 与适用检查**。`bun test app/tests/multitenancy/selection.test.tsx` 预期全部行为/正向控制通过、关键 skipped=0。补所属前端 typecheck、相关既有测试及候选环境浏览器检查。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T17` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

### Task 18: Web Bot、会话、记忆与自动化工作流

**ID / Dependencies / Roles:** `T18` / T05, T06, T07, T08, T09, T10, T17 / implementer=`frontend_implementer`，validator=`frontend_validator`，独立 `reviewer`。

**Acceptance:** A2, A3, A4, A10, A11；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Modify: `app/src/lib/agents/` 下明细分配的文件。
- Modify: `app/src/lib/channels/` 下明细分配的文件。
- Modify: `app/src/lib/team-bots.ts`。
- Modify: `app/src/lib/memory.ts`。
- Modify: `app/src/lib/routines/` 下明细分配的文件。
- Modify: `app/src/lib/responsibilities.ts`。
- Modify: `app/src/lib/approvals.ts`。
- Modify: `app/src/lib/identity/` 下明细分配的文件。
- Modify: `app/src/routes/_authed/_app/bots.index.tsx`。
- Modify: `app/src/routes/_authed/_app/team-bots.tsx`。
- Modify: `app/src/routes/_authed/_app/memory.tsx`。
- Modify: `app/src/routes/_authed/_app/routines.tsx`。
- Modify: `app/src/routes/_authed/_app/responsibilities.tsx`。
- Create: `app/tests/multitenancy/workbench.test.tsx`。
- Create: `tests/e2e/multitenancy/workbench.e2e.ts`。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T18.md`、`checkpoints/T18/`。

**Interfaces:**
- Consumes: T05 已集成的 Interface 与同版本证据；T06 已集成的 Interface 与同版本证据；T07 已集成的 Interface 与同版本证据；T08 已集成的 Interface 与同版本证据；T09 已集成的 Interface 与同版本证据；T10 已集成的 Interface 与同版本证据；T17 已集成的 Interface 与同版本证据。
- Produces: `所有工作流消费 T17 Selection/scopeQueryKey；对外 DTO 沿原业务形状，新增归属字段来自服务端且不作为客户端授权凭据。`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `web-workbench-1`：从甲复制详情 URL 到乙，显示无权限/不存在且没有残留内容；`web-workbench-2`：新成员可在甲使用公共 Bot/KB，编辑按钮不错误开放；`web-workbench-3`：乐观更新失败与切换团队同时发生时不向新团队回滚旧数据。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```typescript
test("web-workbench: scope isolation", async () => {
  const r = await runClientIsolationScenario("web", "web-workbench-1");
  expect(r.positiveControlPassed).toBe(true);
  expect(r.denied).toBe(true);
  expect(r.leakedRecords).toEqual([]);
  expect(r.forbiddenEffects).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**。`bun test app/tests/multitenancy/workbench.test.tsx` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。覆盖 Bot详情/配置/共享/职责/电脑/审批页面、channel/group 创建与详情、技能、连接账号、记忆、定时任务、通知和个人设置。分别为每个查询/mutation/乐观更新绑定选择；删除撤权、切换后不复用路由中残留的旧对象。公共 Bot 使用入口与编辑入口按服务端能力分别展示，保持现有业务行为。 

- [ ] **Step 4: GREEN 与适用检查**。`bun test app/tests/multitenancy/workbench.test.tsx` 预期全部行为/正向控制通过、关键 skipped=0。补所属前端 typecheck、相关既有测试及候选环境浏览器检查。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T18` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

### Task 19: Web 创作、管理、知识、插件与计费工作流

**ID / Dependencies / Roles:** `T19` / T08, T09, T12, T15, T16, T17 / implementer=`frontend_implementer`，validator=`frontend_validator`，独立 `reviewer`。

**Acceptance:** A2, A4, A9, A10, A11, A13；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Modify: `app/src/lib/craft/` 下明细分配的文件。
- Modify: `app/src/lib/workshop/` 下明细分配的文件。
- Modify: `app/src/lib/knowledge.ts`。
- Modify: `app/src/lib/billing/` 下明细分配的文件。
- Modify: `app/src/lib/enterprise/` 下明细分配的文件。
- Modify: `app/src/routes/_authed/admin/` 下明细分配的文件。
- Modify: `app/src/routes/_authed/_app/craft/` 下明细分配的文件。
- Modify: `app/src/routes/share.$token.tsx`。
- Modify: `app/src/routes/_authed/settings/invoices.tsx`。
- Modify: `app/src/routes/_authed/settings/usage.tsx`。
- Create: `app/tests/multitenancy/admin-billing-craft.test.tsx`。
- Create: `tests/e2e/multitenancy/governance.e2e.ts`。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T19.md`、`checkpoints/T19/`。

**Interfaces:**
- Consumes: T08 已集成的 Interface 与同版本证据；T09 已集成的 Interface 与同版本证据；T12 已集成的 Interface 与同版本证据；T15 已集成的 Interface 与同版本证据；T16 已集成的 Interface 与同版本证据；T17 已集成的 Interface 与同版本证据。
- Produces: `消费 T17 Selection、T15 BillingAccount DTO 与 T16 管理授权；公司账务视图明确标示公司账户，个人模型账户视图明确标示个人账户。`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `web-governance-1`：同公司普通成员不能看到其他付款人的订单或 checkout资料；`web-governance-2`：分享撤销及切换团队后文件预览/运行流停止返回内容；`web-governance-3`：团队统计不显示个人 Bifrost 余额，余额不足不会提示改扣另一个账户。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```typescript
test("web-governance: scope isolation", async () => {
  const r = await runClientIsolationScenario("web", "web-governance-1");
  expect(r.positiveControlPassed).toBe(true);
  expect(r.denied).toBe(true);
  expect(r.leakedRecords).toEqual([]);
  expect(r.forbiddenEffects).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**。`bun test app/tests/multitenancy/admin-billing-craft.test.tsx` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。逐项接入 Craft/Workshop、分享、知识管理、插件技能组件、people/identity providers/credentials/learning/enterprise/audit、账单与用量查询。服务端财务/团队管理能力控制入口，不以旧 role=admin 直接展示跨范围内容。公开分享页要求设计规定的有效身份/受众，不保留匿名跨公司通道。团队用量视图只统计公司付款账户。 

- [ ] **Step 4: GREEN 与适用检查**。`bun test app/tests/multitenancy/admin-billing-craft.test.tsx` 预期全部行为/正向控制通过、关键 skipped=0。补所属前端 typecheck、相关既有测试及候选环境浏览器检查。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T19` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

### Task 20: 桌面原生组织上下文与凭据命名空间

**ID / Dependencies / Roles:** `T20` / T07, T15 / implementer=`backend_implementer`，validator=`backend_validator`，独立 `reviewer`。

**Acceptance:** A7, A10, A13；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Modify: `desktop/src-tauri/src/organization_auth.rs`。
- Modify: `desktop/src-tauri/src/provider_oauth.rs`。
- Modify: `desktop/src-tauri/src/main.rs`。
- Create: `desktop/src-tauri/src/company_context.rs`。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T20.md`、`checkpoints/T20/`。

**Interfaces:**
- Consumes: T07 已集成的 Interface 与同版本证据；T15 已集成的 Interface 与同版本证据。
- Produces: `CompanyContext { authority: String, user_id: String, tenant_id: String, workspace_id: String }; set_company_context(context: CompanyContext) -> Result<(), CompanyContextError>; clear_company_context() -> Result<(), CompanyContextError>`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `desktop-native-1`：不同 authority 的旧cookie或回调不能绑定新组织；`desktop-native-2`：clear_company_context 不删除个人模型授权；`desktop-native-3`：序列化 DTO/错误没有 token 或凭据正文。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```rust
#[test]
fn rejects_foreign_authority() {
    let r = test_company_context_case("foreign-authority");
    assert!(r.positive_control_passed);
    assert!(r.denied);
    assert!(r.leaked_secrets.is_empty());
}
```

- [ ] **Step 2: 运行 RED**。`cargo test --manifest-path desktop/src-tauri/Cargo.toml company_context` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。为组织连接增加冻结的 authority/用户/公司/团队上下文及独立凭据命名空间，Tauri command 只允许当前已验证组织连接；OAuth state 和恢复仍绑定发起 authority。个人 provider 连接保留独立空间，不转为公司付款方。退出/变更组织时清理公司媒体及订阅状态，不销毁用户其他公司或个人授权。公开给 T21 的 DTO 不包含 token/secret。 

- [ ] **Step 4: GREEN 与适用检查**。`cargo test --manifest-path desktop/src-tauri/Cargo.toml company_context` 预期全部行为/正向控制通过、关键 skipped=0。补 cargo check 与组织登录/OAuth 回归。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T20` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

### Task 21: 桌面公司连接、选择与本地状态隔离

**ID / Dependencies / Roles:** `T21` / T07, T15, T17, T20 / implementer=`frontend_implementer`，validator=`frontend_validator`，独立 `reviewer`。

**Acceptance:** A3, A7, A10, A13；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Modify: `desktop/src/` 下明细分配的文件。
- Create: `desktop/src/CompanySelection.test.tsx`。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T21.md`、`checkpoints/T21/`。

**Interfaces:**
- Consumes: T07 已集成的 Interface 与同版本证据；T15 已集成的 Interface 与同版本证据；T17 已集成的 Interface 与同版本证据；T20 已集成的 Interface 与同版本证据。
- Produces: `DesktopCompanySelection = Readonly<{authority: string; tenantId: string; workspaceId: string; userId: string}>；本地业务配置/凭据索引按该范围固定，个人模型授权使用独立命名空间。`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `desktop-selection-1`：换公司后不继续显示旧组织页面或复用旧组织 cookie；`desktop-selection-2`：过期个人模型授权不会转为公司模型消费；`desktop-selection-3`：OAuth 回调恢复原 authority/范围而非当前选择。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```typescript
test("desktop-selection: scope isolation", async () => {
  const r = await runClientIsolationScenario("desktop", "desktop-selection-1");
  expect(r.positiveControlPassed).toBe(true);
  expect(r.denied).toBe(true);
  expect(r.leakedRecords).toEqual([]);
  expect(r.forbiddenEffects).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**。`bun test desktop/src/CompanySelection.test.tsx` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。组织登录和 OAuth 恢复绑定 authority 与发起归属；选择公司团队后由嵌入工作台请求携带选择。组织连接切换/退出清理业务缓存和媒体，个人模型连接不自动作为公司业务凭据。消费 T20 的原生上下文 Interface，不改 Rust 业务代码。 

- [ ] **Step 4: GREEN 与适用检查**。`bun test desktop/src/CompanySelection.test.tsx` 预期全部行为/正向控制通过、关键 skipped=0。补所属前端 typecheck、相关既有测试及候选环境浏览器检查。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T21` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

### Task 22: Canonical OpenMuse Web/iOS/Android 选择与传输

**ID / Dependencies / Roles:** `T22` / T13, T14, T15, T17 / implementer=`frontend_implementer`，validator=`frontend_validator`，独立 `reviewer`。

**Acceptance:** A2, A3, A7, A10, A11, A13；正向业务可用，拒绝请求无内容与副作用。

**Files / Ownership:**
- Modify: `apps/openmuse`。
- Create: `apps/openmuse/apps/mobile/src/openbot/tenancy.ts`。
- Create: `apps/openmuse/apps/mobile/src/openbot/tenancy.test.ts`。
- Create: `apps/openmuse/apps/mobile/src/CompanyWorkspaceSelector.tsx`。
- Report/checkpoint: `docs/plans/2026-10-15-company-team-multitenancy/reports/T22.md`、`checkpoints/T22/`。

**Interfaces:**
- Consumes: T13 已集成的 Interface 与同版本证据；T14 已集成的 Interface 与同版本证据；T15 已集成的 Interface 与同版本证据；T17 已集成的 Interface 与同版本证据。
- Produces: `OpenMuseCompanySelection = Readonly<{authority: string; userId: string; tenantId: string; workspaceId: string; generation: number}>；所有业务 transport、runtime、media、deep link 与 stream 使用这一冻结选择。`；共同字段见 `interfaces.md`。域专用 Dependencies/Services/DTO 直接导出其真实 factory 类型，不由下游重复定义。
- Scenarios: `mobile-selection-1`：移动应用后台切到另团队再恢复不加载旧邮件/文件/任务；`mobile-selection-2`：深链接、PDF下载、computer stream 和 Copilot runtime均附正确选择；`mobile-selection-3`：Web/iOS/Android 退出登录清除业务缓存，个人付款账户不自动换成公司账户。每个场景包含有效自有访问控制与拒绝行为；完整名录由本任务 domain adapter 登记。

- [ ] **Step 1: 写本任务 RED 测试**。在上列 Test 文件实现三个具体场景，经实际业务 factory/受限数据库或实际客户端渲染观测结果。不得 mock 被测授权器，fixture 不能默认返回预设结果。T01 定义共同 fixture 和 coverage gate；其他任务实现自己的真实种子、factory 与测试场景。T17 定义客户端测试 helper，T20 原生 helper 在同一 Rust test module 内实现。

```typescript
test("mobile-selection: scope isolation", async () => {
  const r = await runClientIsolationScenario("openmuse", "mobile-selection-1");
  expect(r.positiveControlPassed).toBe(true);
  expect(r.denied).toBe(true);
  expect(r.leakedRecords).toEqual([]);
  expect(r.forbiddenEffects).toEqual([]);
});
```

- [ ] **Step 2: 运行 RED**。`bun test apps/openmuse/apps/mobile/src/openbot/tenancy.test.ts` 预期具体隔离断言失败或新 Interface 缺失，记录原因；环境加载失败不算 RED，先修测试装配或报告阻塞。

- [ ] **Step 3: 实现业务闭环**。先核对 submodule gitlink 46792335 与已集成的 canonical 来源 81d0d3a15a27b00e24b2bed6f8b24c5b4d5330b4：前者没有 apps/mobile/src/openbot 适配器，不能直接当完成集成。在任务专用子模块工作区从后者建立可审查基线，审查其相对原 gitlink 的变化，再接入选择/缓存/stream/media；不要修改外部主工作区或重新创建已删除的 apps/openmuse-mobile。用 TS/React Native 路由和表单保持既有功能，Web/iOS/Android 全部验证；主控记录 nested BASE/HEAD 或递归未提交检查点及最终 gitlink 集成要求。 

- [ ] **Step 4: GREEN 与适用检查**。`bun test apps/openmuse/apps/mobile/src/openbot/tenancy.test.ts` 预期全部行为/正向控制通过、关键 skipped=0。在子模块用自身锁文件执行 apps/mobile typecheck 和 Web/iOS/Android export；验收包括原生运行。 限制、缺配置及外部证据缺失写报告，exit 0 但全跳过不能通过。

- [ ] **Step 5: 自查并生成检查点**。保存任务前后 HEAD、staged/unstaged diff、完整 untracked 内容及 SHA-256，包含 SQL、snapshot、子模块及删除文件，生成任务增量 Review Package。无提交授权，禁止 git commit。确认范围与机密脱敏。

- [ ] **Step 6: 独立验证与 Review 放行**。主控派发只读 validator/reviewer，复用同版本证据并补缺项。真实 finding 由原专业实现者修复，验证/Review 绑定新 hash。验收、Spec compliance、code quality 均通过后标 `T22` verified；集成后才放行下游。失败不放宽规则或绕过依赖。

