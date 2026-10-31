# T03 每 Bot 独立编码沙箱 OpenCode 会话 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Repository authorization and review rules govern execution.

**Goal:** 一个完整执行归属中的 Bot 在独立 OpenShell 编码沙箱内完成真实 OpenCode 会话、文件写入和事件流，且其他 Bot、团队或业务范围不能访问其进程与文件。

**Architecture:** 保留 `agent-sandbox` 作为编码沙箱内 OpenCode 的受控代理，但 OpenShell 模式下不再由一个共享容器按目录区分 Bot；T03 的 coding adapter 为每个完整 scope 启动独立沙箱，并向现有 `SandboxClient`/`CodeRunGateway` 提供内部连接。OpenBot 路由继续是用户入口，底层 URL 和控制面凭据不进入浏览器或响应。

**Tech Stack:** TypeScript/Bun、OpenCode `1.18.7` 基线、现有 `agent-sandbox` 代理、OpenShell Kubernetes driver、Helm、tester-army `e2e`。

**Spec:** [Spec v1 A01](../../specs/2026-10-30-openshell-sandbox.md#a01-部署与工作负载)、[A02](../../specs/2026-10-30-openshell-sandbox.md#a02-隔离与归属)、[A04](../../specs/2026-10-30-openshell-sandbox.md#a04-预览和入口)，相关决定 [D2](../../specs/2026-10-30-openshell-sandbox.md#d2)、[D3](../../specs/2026-10-30-openshell-sandbox.md#d3)、[D4](../../specs/2026-10-30-openshell-sandbox.md#d4)、[D7](../../specs/2026-10-30-openshell-sandbox.md#d7)、[D13](../../specs/2026-10-30-openshell-sandbox.md#d13)、[D19](../../specs/2026-10-30-openshell-sandbox.md#d19)、[D20](../../specs/2026-10-30-openshell-sandbox.md#d20)、[D21](../../specs/2026-10-30-openshell-sandbox.md#d21)、[D22](../../specs/2026-10-30-openshell-sandbox.md#d22)、[D23](../../specs/2026-10-30-openshell-sandbox.md#d23)；[ADR 0013](../../adr/0013-openshell-sandbox-substrate.md)、[ADR 0006](../../adr/0006-logical-private-bot-scoped-execution.md)；[T03 ticket](ticket-breakdown.md#t03--每-bot-独立编码沙箱完成一次-opencode-会话)。GitHub Issue [#737](https://github.com/1123786563/OpenBot/issues/737)，真实 Blocked by [#735](https://github.com/1123786563/OpenBot/issues/735)。

## Global Constraints

- 本计划、ticket 草案和 `ready-for-agent` 都不是实施授权；实施前重读 Issue #737/#735 当前状态、批准 Spec/ADR 和本计划。
- #735 必须已按 T01 验证，且其实际 driver、选定 OpenShell/controller/CRD/CNI/storage 版本、镜像 digest 和能力回执已进入本工作区；只用当前源码里的未验证计划文本不能开工。
- 完整执行归属是 `tenantId + workspaceId + botId + environment + generation`（ADR 0006、D7、D22）；裸 `botId` 不能作为缓存、沙箱、卷或 URL 键。
- computer 与 coding 是两个独立沙箱身份和存储；编码进程不得挂载或读取 `/profiles`、浏览器 cookie、登录状态或 computer control 文件（D7、D13）。
- OpenShell 仅是 Kubernetes 新增部署选择；旧 shared agent-sandbox、computer shared/docker/sandbox 模式行为和既有数据不变（D3、D19、D20）。
- OpenCode 的 HTTP/SSE 长流、flush、`text/event-stream`/cache/connection 头、鉴权头和断线恢复必须在真实链路实测；官方“支持自定义镜像”或 mock 策略 setter 不构成验收。
- T01 实际 driver 方法名和 OpenShell coding adapter 文件名以执行时已验证合同为准；若与本计划端口名不同，只做语义等价映射并记录，不得改变隔离边界。
- 任何 OpenShell/OpenCode/隔离/SSE 能力未证实即 T03 blocked；不得放宽默认拒绝、共享目录、seccomp、网络策略或沙箱身份换通过。
- 完整档需要独立行为验收、Spec/质量 Review 和适用 OCR；证据、原始输出清单和版本绑定归 `.archive/runs/<run-key>/verification/`。

## Review Focus

- 同一逻辑 Bot ID 出现在另一个 tenant/workspace 时读到他人工作文件或复用他人沙箱：Task 2 `openshell_coding_maps_full_scope_and_rejects_foreign_or_stale_identity`、Task 3 `live_cross_bot_and_team_coding_access_is_refused` 钉住。
- SSE 断线重连后事件重复或丢失但被当作通过：Task 3 `live_sse_long_stream_flush_reconnect_and_headers_survive` 以持久 seq 和 `Last-Event-ID` 对账钉住。
- 编码沙箱经共享卷、hostPath 或挂载命名空间读到 computer `/profiles`：Task 3 `live_coding_sandbox_cannot_read_computer_profile` 同时检查文件访问与实际 mounts 钉住。
- 旧 generation 的 sandbox URL/handle 被新会话复用：Task 2 `openshell_coding_maps_full_scope_and_rejects_foreign_or_stale_identity` 与 Task 3 generation rotation 注入钉住。
- 只 mock policy/driver setter 或只断言配置文本就宣称隔离：Task 2 先钉 scope/generation 合同，Task 3 必须用真实 OpenShell、真实 OpenCode 进程、真实文件与失败注入证明。

## File map and dependency contract

- T03 owns: `server/src/codesandbox/routes.ts` 与 `server/src/workshop/routes.ts`/`orchestrator.ts`（可信 scope 进入两个 coding gateway factory）、`server/src/codesandbox/openshell-provider.ts`、`server/src/assembly/runtime.ts` 的 OpenShell coding 装配分支、`charts/openbot/templates/codesandbox/openshell-coding-template.yaml`、`charts/openbot/values.yaml` 中挂在 T01 统一 substrate 选择下的 coding workload 参数、`scripts/lib/e2e-manifest.mjs` 的 live suite 登记、`scripts/openshell-coding-acceptance.ts`、`server/tests/codesandbox-client.test.ts`、`server/tests/codesandbox-routes.test.ts`、`server/tests/workshop-routes.test.ts`、`server/tests/openshell-coding-provider.test.ts`、`server/tests/openshell-coding-live.test.ts`。
- T03 does not own: `agent-sandbox/src/bot-runtimes.ts`、`proxy.ts`、`sse.ts`、`events.ts`、`upstream.ts`、`env.ts`、`opencode-config.ts`、`snapshot.ts`、`webapp.ts`、`ws-passthrough.ts` 的共享模式语义。它们是编码镜像/代理行为参考；若 live 验收要求修改，先确认不会改变旧模式并纳入本票 Review。
- Consumes T01: `OpenShellScope = { tenantId: string; workspaceId: string; botId: string; environment: "computer" | "coding"; generation: string }`；`OpenShellRuntimeDriver` 是包含 `ensureRunning(scope: OpenShellScope): Promise<{ sandboxId: string; url: string; generation: string }>`、`status(scope: OpenShellScope): Promise<{ state: "running" | "stopped" | "starting" | "unreachable"; generation?: string }>`、`stop(scope: OpenShellScope): Promise<{ wasRunning: boolean }>` 的结构端口，并提供隔离/策略能力回执和最小管理凭据。T01 已实现方法名不同时，执行时确认并映射到本合同。
- Consumes current code: `SandboxClientOptions.executionScope?: { readonly tenantId: string; readonly workspaceId: string }`；`SandboxClient` 现有 `createSession(title: string): Promise<string>`、`sendMessage(sessionId: string, text: string, options: SandboxSendMessageOptions): Promise<SandboxRunResult>`、`listFiles(): Promise<string[]>`、`readFile(path: string, maxBytes: number): Promise<{ path: string; size: number; content: string; truncated: boolean }>`、`writeFile(path: string, content: string): Promise<{ path: string; size: number }>`、`resetWorkspace(): Promise<void>`、`abortSession(sessionId: string): Promise<void>`、`subscribeEvents(onEvent: (event: TranslatedEvent) => void): Promise<{ stop(): void }>`；`CodeRunGateway.startStreaming(task: string, opts?: CodeRunStreamOptions): Promise<StreamingRun>`。
- Produces for T04/T07/T08/T10: `CodingSandboxTarget = { tenantId: string; workspaceId: string; botId: string; environment: "coding" }`；`CodingSandboxScope = CodingSandboxTarget & { generation: string }`；`CodingSandboxConnection = { baseUrl: string; token: string; scope: CodingSandboxScope }`；`OpenShellCodingProvider = { ensureRunning(target: CodingSandboxTarget): Promise<CodingSandboxConnection>; status(target: CodingSandboxTarget): Promise<{ state: "running" | "stopped" | "starting" | "unreachable"; generation: string | null }>; stop(target: CodingSandboxTarget): Promise<{ wasRunning: boolean }>; noteActivity(input: { target: CodingSandboxTarget; source: "task" | "event_stream" | "preview"; occurredAt: Date }): void; networkTarget(target: CodingSandboxTarget): Promise<{ substrate: "openshell"; tenantId: string; workspaceId: string; botId: string; environment: "coding"; sandboxId: string; generation: string } | null> }`。T04 只能经 OpenBot route 消费 `ensureRunning` 的 internal connection；T07 消费 status/ensureRunning/stop；T08 消费 preview `noteActivity` 和 ensureRunning；T10 消费 `networkTarget`。

---

### Task 1: Pass trusted execution ownership through both coding routes

**Files:** Modify `server/src/codesandbox/routes.ts`, `server/src/workshop/routes.ts`, `server/src/workshop/orchestrator.ts`; test `server/tests/codesandbox-routes.test.ts`, `server/tests/workshop-routes.test.ts`, `server/tests/codesandbox-client.test.ts`.

**Interfaces:** Produce `CodeRunExecutionScope = { readonly tenantId: string; readonly workspaceId: string }`, `CodeRunGatewayFactory = (context: { botId: string; ownerUserId: string; executionScope?: CodeRunExecutionScope }) => CodeRunGateway`, `TurnOrchestratorOptions.gatewayFor = (input: { botId: string; ownerUserId: string; executionScope?: CodeRunExecutionScope }) => CodeRunGateway`, and `createCodeSandboxRoutes(requireUser, canUseBot, factory, options?: { substrate: "legacy" | "openshell"; resolveExecutionScope?: (input: { actor: AuthenticatedActor; botId: string; request: Request }) => Promise<CodeRunExecutionScope | null> })`. Workshop route construction receives the same resolver type and passes scope into `orchestrator.enqueue`. The resolver treats request selectors as hints only and verifies actor membership/Bot ownership server-side. OpenShell mode requires a resolver; legacy mode omits it and preserves today's factory behavior.

- [ ] **Step 1: Write failing and baseline tests.** Add `openshell_route_passes_trusted_execution_scope_to_gateway_factory`（`/api/codesandbox/runs` 与 workshop turn 的 factory/orchestrator context 均含 scope）、`openshell_route_refuses_missing_or_foreign_execution_scope_before_gateway`（resolver null、Bot 无权、跨团队均 403 且 gateway/orchestrator 不被调用）、`client_carries_execution_scope_on_all_verbs_and_sse`（token/Bot/tenant/workspace 头覆盖 request 与 `subscribeEvents`）。第三个用例锁当前 `SandboxClientOptions.executionScope` 行为，作为回归基线。
- [ ] **Step 2: RED.** Run `E2E_UNIT_OUTPUT=.e2e/<run-key>/T03-task1-red e2e run --config e2e.unit.config.ts server/tests/codesandbox-routes.test.ts server/tests/workshop-routes.test.ts server/tests/codesandbox-client.test.ts`. Expected: 3 个新增用例被收集，前 2 个因 route/orchestrator options/context 不存在而失败，第 3 个基线应通过；无未解释 skip。
- [ ] **Step 3: Implement the route contract.** Add optional substrate/resolver options only. OpenShell 缺 resolver 启动装配即拒绝；resolver 在 `canUseBot` 之后、gateway factory/orchestrator 之前调用，null 不默认部署级 scope，也不采信请求体身份。legacy 分支不新增 header 或拒绝。
- [ ] **Step 4: GREEN.** Rerun the same command with output `.e2e/<run-key>/T03-task1-green`; expected 3 个新增用例全部通过、既有 route/client/workshop 用例无回归、无未解释 skip。Run `bun run --cwd server typecheck`.
- [ ] **Step 5: Commit.** Commit only `server/src/codesandbox/routes.ts`, `server/src/workshop/routes.ts`, `server/src/workshop/orchestrator.ts`, and the three test files after task diff review.

### Task 2: Scope-bound OpenShell coding provider

**Files:** Create `server/src/codesandbox/openshell-provider.ts`; modify `server/src/assembly/runtime.ts`; test `server/tests/openshell-coding-provider.test.ts`; regression tests `server/tests/codesandbox-routes.test.ts`, `server/tests/workshop-routes.test.ts`.

**Interfaces:** Consume Task 1's route contract and T01's verified driver. Produce `createOpenShellCodingProvider(options: { driver: OpenShellRuntimeDriver; tokenFor(scope: CodingSandboxScope): Promise<string>; capabilities: { isolation: { verified: true; receipt: string }; networkPolicy: { state: "loaded"; receipt: string; generation: string } } }): OpenShellCodingProvider`. The provider launches the existing `agent-sandbox` entrypoint in a coding-specific OpenShell sandbox, waits for `/health`, and returns a connection only after T01 isolation/policy receipts are current.

- [ ] **Step 1: Write failing tests.** Add `openshell_coding_maps_full_scope_and_rejects_foreign_or_stale_identity`（同 Bot 跨 tenant/workspace 生成不同 sandbox identity；缺任一 scope 字段、stale generation handle、foreign URL 均在 driver/文件访问前拒绝）、`openshell_coding_provider_wires_gateway_without_changing_legacy_mode`（OpenShell 使用 Task 1 resolver/provider，legacy `AGENT_SANDBOX_URL` 仍构造原 client）、`openshell_coding_activity_and_network_target_are_generation_bound`（task/event_stream activity 只更新当前 generation；`networkTarget` 含 coding environment 与 generation，不唤醒沙箱）。
-- [ ] **Step 2: RED.** Run `E2E_UNIT_OUTPUT=.e2e/<run-key>/T03-task2-red e2e run --config e2e.unit.config.ts server/tests/openshell-coding-provider.test.ts server/tests/codesandbox-routes.test.ts server/tests/workshop-routes.test.ts`. Expected: 3 个新增用例因 provider 模块/装配缺失失败；route/workshop 回归不应失败；无未解释 skip。
- [ ] **Step 3: Implement the provider and runtime branch.** Map `CodingSandboxTarget` to T01 `OpenShellScope` with `environment:"coding"`；缓存键含五元组；并发 ensure 合并到同一 generation；stale handle/connection 拒绝；`noteActivity` 不启动沙箱；OpenShell 分支才调用 provider，并同时接入 `/api/codesandbox` factory 与 workshop `gatewayFor`。代理镜像继续运行现有 `agent-sandbox` command，不挂载 computer profile、OpenShell 管理凭据或 Kubernetes token。
- [ ] **Step 4: GREEN.** Rerun with `.e2e/<run-key>/T03-task2-green`; expected 3 个新增用例和 route/workshop 回归全部通过、无未解释 skip。Run `bun run --cwd server typecheck` and inspect the diff for any accidental shared-mode behavior change.
- [ ] **Step 5: Commit.** Commit only this task's provider, runtime wiring, and tests after review.

### Task 3: Real OpenShell + OpenCode acceptance and deployment binding

**Files:** Create `server/tests/openshell-coding-live.test.ts`; create `scripts/openshell-coding-acceptance.ts`; modify `scripts/lib/e2e-manifest.mjs` to register the live suite; create `charts/openbot/templates/codesandbox/openshell-coding-template.yaml`; modify `charts/openbot/values.yaml`; modify `charts/openbot/README.md` only for the new coding values.

**Interfaces:** Consume `OpenShellCodingProvider`, `createSandboxClient`, authenticated `POST /api/workshop/:channelId/turns` plus `GET /api/workshop/:channelId/events`, and `CodeRunGateway.startStreaming`. The live suite is excluded by default through `LIVE_SUITES` and selected explicitly with `OPENBOT_LIVE_API=1`; it must fail preflight rather than silently skip when cluster/image/version inputs are absent.

- [ ] **Step 1: Write the live failing test.** Add four cases: `live_opencode_session_writes_scope_owned_file_and_streams_events`、`live_sse_long_stream_flush_reconnect_and_headers_survive`、`live_cross_bot_and_team_coding_access_is_refused`、`live_coding_sandbox_cannot_read_computer_profile`. Assertions cover real session/file/event outcome, OpenBot SSE `id/event/data` and `Last-Event-ID` catch-up without duplicate/missing seq, required headers and 401/403 on corruption/drop, two foreign scopes, generation rotation, actual profile/mount inaccessibility, and no OpenShell/Kubernetes control credential in coding env or mounts.
- [ ] **Step 2: RED.** Run `OPENBOT_LIVE_API=1 E2E_UNIT_OUTPUT=.e2e/<run-key>/T03-task3-red e2e run --config e2e.unit.config.ts server/tests/openshell-coding-live.test.ts`. Expected: 4 个用例均被收集并失败于缺失 coding workload/deployment binding 或真实行为；无环境性 skip。记录实际失败原因，不得用 fake driver 替代。
- [ ] **Step 3: Implement the selected-stack chart binding.** Add the OpenShell coding template using the image digest built from the tested `agent-sandbox` tree（记录 base image digest、`opencode-ai@1.18.7`、Bun runtime、OpenShell/controller/CRD/CNI/storage versions）。Template renders only from T01's deployment-wide OpenShell selection, exposes no public service route, and mounts only coding workspace/config volumes.
- [ ] **Step 4: Implement the live harness.** Preflight verifies isolated namespace/resource owner, T01 capability receipts, image digest, source checkpoint, model endpoint, no computer/control mounts or credentials, then executes through OpenBot routes. Failure injections cover SSE client disconnect/reconnect, wrong/dropped headers, foreign Bot/team, stale generation URL, profile read, and missing isolation/policy receipt fail-closed.
- [ ] **Step 5: GREEN.** Rerun with `.e2e/<run-key>/T03-task3-green`; expected 4 个 live 用例全部通过、0 个未解释 skip。Rerun Task 1/2 focused commands against the final tree, plus `bun run --cwd server typecheck` and `helm lint charts/openbot`.
- [ ] **Step 6: Archive evidence.** Save commands/env identity（不含秘密）、exit codes、collected/failed/skipped counts、OpenCode output/events、file hashes、sandbox/volume/mount/generation receipts、failure injection results、teardown inspection, and output manifest/hash to `.archive/runs/<run-key>/verification/`. A mock-only result cannot satisfy this step.
- [ ] **Step 7: Independent gates and commit.** Perform independent behavior acceptance, Spec/quality Review, and applicable OCR over the final product/test increment. Resolve all critical/high/medium findings, then commit only authorized T03 files; do not push or write to GitHub.

## Independent acceptance

- Issue #737 “创建会话、写文件与接收事件流成功” → Task 3 `live_opencode_session_writes_scope_owned_file_and_streams_events`；A01 的“编码工作负载实际接入选定 Kubernetes 底座”同时成立。
- Issue #737 “HTTP/SSE 长流、断线与头部行为可用” → Task 3 `live_sse_long_stream_flush_reconnect_and_headers_survive`；对应 A04 的 HTTP/SSE、鉴权头、长流 flush、断线 catch-up 部分。
- Issue #737 “跨 Bot 与团队访问被拒绝” → Task 2 `openshell_coding_maps_full_scope_and_rejects_foreign_or_stale_identity` 与 Task 3 `live_cross_bot_and_team_coding_access_is_refused`；对应 A02 文件/进程/身份隔离。
- Issue #737 “编码进程无法读取 computer 的登录资料” → Task 3 `live_coding_sandbox_cannot_read_computer_profile`；对应 A02 的两类环境独立、无共享可写存储、无控制面凭据。该用例证明 profile 路径与挂载隔离，不冒充 T02 的 Chromium 登录能力验收。
- A01 boundary: Task 1/2 证明 legacy 行为不变；Task 3 证明 OpenShell coding 实际可用；模式/能力展示沿用 T01，T03 只把 coding capability 从未验证改为有 live 回执的已验证。A01 的 computer 半边仍以 T02 为准，T03 不把父 Spec A01 整体标为通过。
- A04 boundary: T03 不宣称 WebSocket、preview 入口、有效预览活动或闲置唤醒完成；这些归 T04/T08。T03 的 A04 通过范围仅限 OpenCode HTTP/SSE 链路。
- A02 boundary: T03 只证明 coding 文件/进程/身份、两类环境存储分离、无控制面凭据和 T01 回执失效时 fail-closed；完整网络授权/撤销和所有服务入口旁路归 T04/T10/T16。
- Blocked gates: #735 未验证、T01 driver/版本未进入本树、coding 镜像 digest 或 OpenCode 版本不可绑定、真实集群/模型链路不可用、OpenShell 无法运行 agent-sandbox/OpenCode、长流或断线恢复失败、跨归属/Profile 隔离失败、控制面凭据可见、策略或隔离回执缺失、mock-only 验收、独立 Review/OCR 未完成，任一项存在时 Issue #737 保持 blocked/unverified。
