# T01 OpenShell Kubernetes 底座安全启动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Project execution rules determine actual dispatch and authorization.

**Goal:** 管理员选择 OpenShell 部署模式后，在测试团队范围安全创建、访问、停止一个探针沙箱，并看到真实能力状态。

**Architecture:** `server/src/computer/provider.ts` 保持 `ComputerProvider` 用户入口，新增 OpenShell 底层适配器；部署选择同时传给后续编码适配器，不能在此票宣称编码已接通。chart 只为选定模式装配控制面、controller、服务凭据和默认拒绝网络条件，启动前以真实探针确认执行约束。

**Tech Stack:** TypeScript/Bun、Helm、Kubernetes、选定版本的 OpenShell/controller/CNI/存储；具体版本和 API 均为先验技术门槛。

**Spec:** `docs/specs/2026-10-30-openshell-sandbox.md`（A01、A02、A06），`docs/adr/0013-openshell-sandbox-substrate.md`；Ticket 草案 `docs/plans/2026-10-30-openshell-sandbox/ticket-breakdown.md#t01--openshell-kubernetes-底座安全启动`。

**Issue:** 已发布为正式子 Issue [#735](https://github.com/1123786563/OpenBot/issues/735)（父 Spec [#734](https://github.com/1123786563/OpenBot/issues/734)，标签 `ready-for-agent`，Blocked by 无）。`ready-for-agent` 与父子关系都不构成实施授权；实施前须按 `.agents/rules/issue-delivery.md` 重新摄取 #735 正文、验收、关系与批准事实源的有效版本。

## Global Constraints

- 仅 Kubernetes 新增部署选择；旧模式和既有数据不自动改动（D3、D6、D19）。
- 每团队工作空间一个底层工作空间；完整执行归属含 tenant、workspace、Bot、环境、代际（D7、D22）。
- 策略、隔离、凭据或生效回执不可信即拒绝启动，不放宽默认拒绝（D4、D11、D13）。
- OpenShell 能力、版本、controller/CRD、CNI、storage、kernel 和服务账号权限必须实测；本计划不声称已有支持。
- 实施前重读批准事实源与 Issue 状态；本票属于完整档，保存独立验收、Review、适用 OCR 证据于 `.archive/runs/`。

## Review Focus

- CNI 不实施 NetworkPolicy：探针必须拒绝新执行，并终止已受影响探针；Task 2 覆盖。
- scope 缺一项或跨团队碰撞：不创建沙箱；Task 1 覆盖。
- OpenShell 控制凭据被挂载进工作负载：探针失败并阻断就绪；Task 2 覆盖。
- 策略下发返回成功但未生效：目的地址仍被拒绝且模式显示未验证；Task 2 覆盖。
- 旧 Helm 模式因新值变动失效：渲染与旧 provider 回归；Task 3 覆盖。

---

### Task 1: 固定能力基线与部署选择合同

**Files:** Modify `server/src/config.ts` (`ComputerConfig`/`computerConfig`); modify `server/src/computer/provider.ts` (`createComputerProvider`, `IsolationDescription`); create `server/src/computer/openshell.ts`; test `server/tests/computer-provider.test.ts`; test `server/tests/computer-sandbox.test.ts`。

**Interfaces:** `OpenShellScope = { tenantId: string; workspaceId: string; botId: string; environment: "computer" | "coding"; generation: string }`；`createOpenShellComputerProvider(options: OpenShellProviderOptions): ComputerProvider`。`ComputerProvider` 现有 `locate/status/stop/reset/list/sessionOf` 签名不变。`OpenShellProviderOptions` 必须包含受限管理 client、`scopeFor(botId): Promise<OpenShellScope | null>`、已验证能力报告；不可从请求头直接构造 scope。

- [ ] **Step 1: 技术门槛。** 在隔离测试集群锁定 OpenShell 发布版本及镜像 digest、所需 controller/CRD、CNI、存储、kernel 和 service account RBAC，逐项记录实际命令、版本、能力、失败与来源到本轮 `.archive/runs/<run-key>/verification/`。任何必要 API/隔离能力缺失即标 `blocked`，不猜 endpoint 或资源字段；再据实定 `OpenShellProviderOptions` 的管理 client 方法。
- [ ] **Step 2: RED。** 在 `server/tests/computer-provider.test.ts` 增加 `openshell_selection_requires_complete_scope_and_verified_capabilities`：OpenShell 模式缺 scope、缺能力、tenant/workspace 相同但 Bot 不同均不得共用 identity；旧 `sandbox/shared/docker` 分支仍选择原 provider。执行 `E2E_UNIT_OUTPUT=.e2e/t01/red e2e run --config e2e.unit.config.ts server/tests/computer-provider.test.ts`，确认新增用例因尚无选择/类型失败。
- [ ] **Step 3: GREEN。** 配置单一 `OPENBOT_SANDBOX_SUBSTRATE=openshell` 选择，拒绝半配置；给 `createComputerProvider` 新分支和 `createOpenShellComputerProvider` 最小实现。映射 identity 时使用可信完整 scope 和环境类型，不用裸 `botId` 作唯一键。执行同一 e2e 命令到 `.e2e/t01/green`，新增用例通过。
- [ ] **Step 4: 验证。** `cd server && bun run typecheck`；用 `git diff --check` 查空白。计划/实现将版本和适用能力报告留为明确配置事实，不写推测默认值。

### Task 2: fail-closed 探针生命周期

**Files:** Modify `server/src/computer/openshell.ts`; create `server/tests/openshell-computer-provider.test.ts`; create `scripts/openshell-foundation-acceptance.ts`。

**Interfaces:** `createOpenShellComputerProvider` 实现 `locate`（确保/启动后返回内网地址）、`status`（只读）、`stop`（停止计算）、`reset`（仅 computer，后续 T06 扩展）、`list`、`sessionOf`；管理 client 必须暴露策略生效回执与隔离状态查询，签名以 Task 1 的已验证 API 固定。

- [ ] **Step 1: RED。** 用 fake 管理 client 测 `locate` 在策略未生效、隔离告警、控制凭据可见、未授权目的可达时拒绝；`status` 不触发启动；跨 scope 的 `stop/reset` 拒绝。运行 `E2E_UNIT_OUTPUT=.e2e/t01/driver-red e2e run --config e2e.unit.config.ts server/tests/openshell-computer-provider.test.ts`，确认新测试红。
- [ ] **Step 2: GREEN。** 实现最小 provider 和错误翻译；`locate` 只有在真实策略/隔离证据确认后可返回 URL，失败关闭受影响沙箱并返回明确不可用状态。运行相同套件到 `.e2e/t01/driver-green`，确认通过。
- [ ] **Step 3: 实测。** `scripts/openshell-foundation-acceptance.ts` 以测试专用 team/Bot/namespace 创建、访问、停止探针；注入跨 workspace、无授权网络、CNI 不生效、凭据读取和策略假阳性，逐项断言实际拒绝/停止。测试脚本先验证集群身份和本轮资源 owner，失败不清理他人资源。通过标准入口运行并归档原始报告；未实测不能给 A02/A06 通过。

### Task 3: Helm 装配及管理员可见状态

**Files:** Modify `charts/openbot/values.yaml`, `charts/openbot/templates/computer/sandbox-rbac.yaml`, `charts/openbot/templates/computer/sandbox-template.yaml`, `charts/openbot/templates/networkpolicy.yaml`, `charts/openbot/README.md`; modify `server/src/computer/deployment-routes.ts`; modify `app/src/routes/_authed/admin/computers.tsx`; test `server/tests/computer-fleet-route.test.ts`。

**Interfaces:** 管理员状态沿用 `deployment-routes.ts` 对外路由，添加 `substrate: "legacy" | "openshell"` 与 `verifiedCapabilities`（只列有当前实测回执者）；不得将配置值当能力证明。chart OpenShell 模式只绑定集成服务最小控制权限，不把 service account token 挂进工作负载。

- [ ] **Step 1: RED。** 为管理员响应写 OpenShell 未验证/已验证状态断言；渲染测试断言旧默认值和 `computers.mode: sandbox` 仍原样。执行 `E2E_UNIT_OUTPUT=.e2e/t01/admin-red e2e run --config e2e.unit.config.ts server/tests/computer-fleet-route.test.ts`，确认新断言红。
- [ ] **Step 2: GREEN。** 接入部署状态与 UI，依据实测版本渲染 chart 资源和隔离 NetworkPolicy；无明确 OpenShell 模式时维持现有模板输出。运行同一套件到 `.e2e/t01/admin-green`。
- [ ] **Step 3: 验收。** `helm lint charts/openbot`；`helm template openbot charts/openbot` 对比旧基线；OpenShell values 使用真实测试集群参数渲染并执行 Task 2 探针。完整独立行为验收、Spec/质量 Review 和 OCR 依仓库完整档执行；阻塞项不以 mock 通过替代。
