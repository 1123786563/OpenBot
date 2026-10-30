# T04 All Runtime Services Access Only Through OpenBot Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Project execution rules determine actual dispatch and authorization.

**Goal:** OpenShell 模式下 computer、OpenCode HTTP/SSE、WebSocket 与编码预览都只能通过 OpenBot 的已鉴权转发访问，底层 URL、重放凭据或改写的 `x-openbot-*` 头不能绕过用户与执行归属校验。

**Architecture:** OpenBot 路由继续解析用户会话，并新增一个服务器侧 runtime access gate：它以 `canUseBot` 加服务器拥有的完整执行归属作决定，再解析 T02/T03 的内网服务端点。所有出站转发共用同一个头部清洗与注入模块；SSE/WS 升级在 commit 前完成判定，预览不再暴露或直连沙箱端口。底层服务只允许 OpenBot 集成服务访问，真实 Kubernetes 拓扑用集群内外注入证明没有公开直连入口。

**Tech Stack:** TypeScript/Bun、Hono、Bun WebSocket upgrade、tester-army `e2e`、OpenShell/Kubernetes/NetworkPolicy、T02/T03 的真实 computer 与 coding sandbox 适配器。

**Spec:** [OpenShell Sandbox Spec](../../specs/2026-10-30-openshell-sandbox.md) A02、A04 与 D7、D13、D21–D23（另以 D19–D20 约束不改旧模式）；[ADR 0013](../../adr/0013-openshell-sandbox-substrate.md)；[ADR 0006](../../adr/0006-logical-private-bot-scoped-execution.md)；[ticket breakdown T04](ticket-breakdown.md#t04--所有运行服务只能经-openbot-鉴权访问)。GitHub Issue [#738](https://github.com/1123786563/OpenBot/issues/738)，状态 OPEN、`ready-for-agent`，真实 Blocked by [#736](https://github.com/1123786563/OpenBot/issues/736) 与 [#737](https://github.com/1123786563/OpenBot/issues/737)。本计划与 Issue 均不是实施授权。

## Global Constraints

- 实施前 rescan #736/#737、本 Issue、T02/T03 实际代码与验收证据；#736/#737 未在同一源树验证通过则 T04 保持 blocked，不用 mock 代替。
- computer、OpenCode HTTP/SSE、WebSocket、预览全部经 OpenBot 校验用户与 Bot 归属；不得留下可绕过的底层公开入口（D21）。入站认证、头部传递、长流和断线必须实测。
- 执行归属是 `tenantId + workspaceId + botId + environment + generation`；同租户不同 workspace、同逻辑 Bot 跨业务范围、不同 Bot 均不得复用可变服务或地址（ADR 0006、D7、D22）。
- 归属、代际与服务目标只能由服务器受信 resolver 产生；请求头、body、query 中的 `x-openbot-*`、底层 URL、token、端口对授权决策不可信。转发前删除客户端副本，最后注入服务器事实。
- 捕获或重放的底层 URL/header/token 不能从集群外或非 OpenBot Pod 访问成功；底层 URL 不进入浏览器响应、日志或错误消息。
- 工作负载与普通用户不持有 OpenShell/Kubernetes 控制面凭据；T04 只传每个运行服务的最小内网凭据，且该凭据不是控制面凭据（D13、D23）。
- 仅 OpenShell 分支收紧；`shared`、`docker`、既有 `sandbox` 与本地 compose 的行为和端口发布不因本票改变（D19–D20）。
- T02/T03 的隔离、策略或服务不可用时，T04 返回明确的 403/404/503 拒绝或不可用状态，不得自动降级、唤醒或换用其他沙箱。
- 本票为完整档：独立行为验收、Spec/质量 Review、适用 OCR 必须覆盖最终授权增量；命令、版本、源树/checkpoint、用例数、失败与 skip 原因归档到 `.archive/runs/<run-key>/verification/`。能力未证实即 blocked。

## Review Focus

1. 拿到 sandbox 直连 URL 的未授权用户绕过 OpenBot：授权链路必须拒绝，集群外直连必须不可达；Task 3 `direct_bottom_urls_are_unreachable_without_openbot` 钉住。
2. 伪造或重放 `x-openbot-*` 头冒充他方 Bot：入站副本先删除，服务器只信 resolver，出站最后注入；Task 1 `runtime_access_ignores_client_ownership_headers_and_foreign_bot` 钉住。
3. SSE/WS 升级请求绕过普通 Hono middleware：升级必须在 `server.upgrade` 前手工鉴权，并进入 inventory tripwire；Task 2 `serve_upgrade_inventory_fails_on_an_unregistered_runtime_socket` 钉住。
4. 预览 iframe 泄漏平台 cookie、preview pass 或底层地址，或让跨源 WS 获益：Task 2 `openshell_preview_never_exposes_or_accepts_direct_sandbox_urls` 钉住。
5. 同团队但不同 workspace 的 Bot 复用同一底层服务地址或代际：授权与目标解析按完整 scope 区分；Task 1 单元测试与 Task 3 `same_url_refuses_foreign_user_other_bot_and_other_workspace` 钉住。

## File map and dependency contract

- **Owned authority:** Create `server/src/openshell/runtime-access.ts` — the sole user/Bot/full-scope decision and T02/T03 endpoint-resolution seam.
- **Owned forwarding:** Create `server/src/openshell/runtime-proxy.ts` — one header sanitizer, HTTP/SSE streaming proxy, and WS target-header builder for all runtime services.
- **Owned live acceptance:** Create `scripts/openshell-service-access-acceptance.ts` and `tests/openshell/service-access.e2e.test.ts`; modify `charts/openbot/templates/networkpolicy.yaml` only in the OpenShell branch, and inspect `charts/openbot/templates/ingress.yaml`/`httproute.yaml` so only the OpenBot server is a public backend.
- **Integrate:** Modify `server/src/computer/routes.ts`, `stream-auth.ts`, `gateway.ts` and `server/src/http-server.ts`; modify the T03 coding route/client seams at `server/src/codesandbox/routes.ts`, `client.ts`, `gateway.ts`, plus the actual OpenShell coding provider; modify `server/src/craft/routes.ts`, `sandbox-gateway.ts`, `opencode/serve-client.ts`, `opencode/event-bus.ts`, `preview.ts`, `preview-origin.ts`, `preview-ticket.ts`, `preview-pass.ts`, and `webapp-proxy.ts` as needed to call the owned seams.
- **Reference, not ownership:** `agent-sandbox/src/proxy.ts`, `ws-passthrough.ts`, `sse.ts`, `devserver.ts`, `upstream.ts`, `webapp.ts`, `env.ts` and `server/src/computer/target.ts` define current behavior. Modify an agent-sandbox file only when T03's actual OpenShell adapter still consumes it and the change is required to enforce generation-bound service auth; do not turn the shared container into the OpenShell authority.
- **Consume T02:** `OpenShellScope = { tenantId: string; workspaceId: string; botId: string; environment: "computer" | "coding"; generation: string }`, T02's server-side `scopeFor(botId): Promise<OpenShellScope | null>`, and `ComputerProvider.locate(botId): Promise<string>` only through `ComputerGateway`/T02 provider. If T02's verified names differ, add a thin adapter at the T04 seam; do not create a second scope resolver.
- **Consume T03:** require the verified coding provider to expose `ensureCodingSandbox(scope: OpenShellScope): Promise<{ baseUrl: string; token: string; generation: string }>`, plus an HTTP/SSE-capable preview endpoint and a WS passthrough endpoint. This is the T04 semantic contract; reconcile exact T03 names at rescan without weakening it.
- **Produce for T08:** `RuntimeAccessGate.authorize(...)` and `forwardRuntimeRequest(..., onActivity?: (input: { actorId: string; execution: OpenShellExecution; transport: "http" | "sse" | "websocket"; observedAt: Date }) => void)` expose transport-level observations without deciding which observation is meaningful. T08 owns idle/activity policy.
- **Produce for T12:** the same gate and `stripUntrustedRuntimeHeaders(...)` let file transfer authorize both environments under one actor/scope and build clean outbound requests. T04 does not create a file-transfer API.
- **Produce for T16:** `runServiceAccessAcceptance(input: { cluster: OpenShellClusterBinding; actors: ServiceAcceptanceActors; archiveRoot: string; now?: () => number }): Promise<ServiceAccessAcceptanceReport>` is the reusable live evidence entry.

Current verified seams that constrain the implementation:

- `createComputerRoutes` already applies `routes.use("/:botId/*", requireUser, ... canUseBot(...))`; the named control, secret, human-input, and page-frame routes therefore extend that gate instead of creating a second public router.
- `createStreamAuthorizer` performs the manual computer WS session/Bot checks before `http-server.ts` calls `server.upgrade`. Its inward socket currently carries only `x-openbot-computer-token`; T04 must also carry server-owned execution facts and never the caller's headers.
- `createCodeSandboxRoutes` already has `app.use("*", requireUser)` plus `canUseBot` on runs/reset; craft routes have `requireUser` and existing session ownership. T04 adds the OpenShell full-scope/generation decision without weakening these guards.
- `createProxyHandler` authenticates `x-sandbox-token`, then requires `x-openbot-bot-id` and `parseExecutionScope`; `/preview/ws` is allow-listed and upgraded only after those checks. These headers remain valid only on the server-to-sandbox leg after T04 sanitizes inbound copies.
- `webappUpstreamHost` currently derives a direct sandbox hostname for reserved preview ports, and `stripRequestHeaders` removes the sandbox token/Bot id but not the whole `x-openbot-*` family. OpenShell mode must replace the direct-port route with T03's authenticated service target and close both header gaps.
- `applyExecutionScopeHeaders` is the one server-side helper that injects ownership last; T04 may compose it, but must not call `parseExecutionScope` on an inbound browser request to decide ownership. `server/src/web-bot-auth.ts` signs outbound browser traffic and is not a user-session authority.

The exact shared types are:

```ts
type OpenShellExecution = Readonly<{
  tenantId: string;
  workspaceId: string;
  botId: string;
  environment: "computer" | "coding";
  generation: string;
}>;

type RuntimeService = "computer" | "opencode" | "preview";

type RuntimeAccessGate = {
  authorize(input: {
    actor: Pick<AuthenticatedActor, "id" | "role">;
    botId: string;
    environment: OpenShellExecution["environment"];
    service: RuntimeService;
  }): Promise<
    | { kind: "allow"; execution: OpenShellExecution; endpoint: { baseUrl: string; token: string } }
    | { kind: "refuse"; status: 401 | 403 | 404 | 503; message: string }
  >;
};
```

`RuntimeAccessGate` is constructed only in server assembly. Its `executionFor` and `endpointFor` dependencies are server-owned and generation-aware; no route may pass request headers or a user-supplied URL into them.

---

### Task 1: Unified user, Bot, and execution-scope authority

**Files:** Create `server/src/openshell/runtime-access.ts`; modify `server/src/assembly/runtime.ts`, `server/src/assembly/http.ts`, `server/src/computer/routes.ts`, `server/src/codesandbox/routes.ts`, `server/src/craft/routes.ts`; create `server/tests/openshell-runtime-access.test.ts`; modify `server/tests/computer-routes.test.ts`, `server/tests/codesandbox-routes.test.ts`, `server/tests/craft-routes-assembly.test.ts`.

**Interfaces:** Produce `createRuntimeAccessGate(deps: { canUseBot: BotAccessCheck; executionFor(input: { actor: Pick<AuthenticatedActor, "id" | "role">; botId: string; environment: OpenShellExecution["environment"] }): Promise<OpenShellExecution | null>; endpointFor(execution: OpenShellExecution, service: RuntimeService): Promise<{ baseUrl: string; token: string } | null> }): RuntimeAccessGate`. Authorization order is actor/Bot admission, full server-owned execution resolution, then endpoint resolution; missing/foreign ownership answers the same neutral 404 as an unknown Bot, and an unavailable endpoint answers 503 only after admission.

- [ ] **Step 1: Write failing tests.** Add exactly seven named cases to `openshell-runtime-access.test.ts`: authorized computer, authorized coding, foreign user, foreign Bot, same tenant/different workspace, missing/incomplete generation, and `runtime_access_ignores_client_ownership_headers_and_foreign_bot`. Extend existing route tests so `/api/computers/:botId/control`, `/control/secret`, `/human/secret`, `/page-frame/:toolCallId`, `/api/codesandbox/runs`, and a craft OpenCode route invoke the gate before any T02/T03 resolver. The forged-header case supplies `x-openbot-bot-id`, `x-openbot-tenant-id`, `x-openbot-workspace-id`, generation, URL, and token, then asserts none changes the decision or is forwarded.
- [ ] **Step 2: Run RED.** Run `E2E_UNIT_OUTPUT=.e2e/<run-key>/T04-task1-red e2e run --config e2e.unit.config.ts server/tests/openshell-runtime-access.test.ts server/tests/computer-routes.test.ts server/tests/codesandbox-routes.test.ts server/tests/craft-routes-assembly.test.ts`. Expected: the seven new authority cases fail for the missing gate and the named existing route files expose the missing invocation; the report records total collected tests, no silent file loss, and zero unexplained skips.
- [ ] **Step 3: Implement the minimal gate and assembly.** Add the type and gate, resolve scope only from T02/T03/server ownership facts, and preserve existing `requireUser` plus Bot checks as defense in depth. Existing non-OpenShell modes keep their current resolvers and behavior; OpenShell branches fail closed when either dependency returns null. Do not dial a sandbox while resolving authorization.
- [ ] **Step 4: Run GREEN.** Repeat with `E2E_UNIT_OUTPUT=.e2e/<run-key>/T04-task1-green ...` and the same files. Expected: all seven new cases plus named route assertions pass; collected count is RED count plus no lost files, skip count is zero or each skip has a named environment reason; run `bun run --cwd server typecheck`.
- [ ] **Step 5: Commit only the authorized Task 1 increment** with a message identifying OpenShell runtime access authority.

### Task 2: HTTP, SSE, WebSocket, and preview through one authorized forwarder

**Files:** Create `server/src/openshell/runtime-proxy.ts`; modify `server/src/computer/stream-auth.ts`, `server/src/http-server.ts`, `server/src/craft/webapp-proxy.ts`, `server/src/craft/preview.ts`, the T03 coding client/provider seams listed in the file map, and `server/scripts/multitenancy/inventory.ts` only if a new upgrade family needs registration; create `server/tests/openshell-runtime-proxy.test.ts`; modify `server/tests/stream-auth.test.ts`, `server/tests/craft-preview-socket.test.ts`, `server/tests/workshop-preview.test.ts`, `server/tests/craft-webapp-proxy.test.ts`, `server/tests/multitenancy/inventory.test.ts`, `agent-sandbox/tests/proxy.test.ts`, and `agent-sandbox/tests/sse.test.ts`.

**Interfaces:** Produce `stripUntrustedRuntimeHeaders(headers: Headers, cookiePolicy?: "strip-all" | "app-only"): Headers` (remove every `x-openbot-*`, authorization, platform cookie/pass, sandbox/computer token, forwarded, and upgrade-control header; `app-only` may retain only the preview app's sanitized own cookies), `runtimeOutboundHeaders(input: { endpoint: { token: string }; execution: OpenShellExecution; inbound: Headers; protocol: "http" | "sse" | "websocket"; cookiePolicy?: "strip-all" | "app-only" }): Headers`, `forwardRuntimeRequest(input: { actor: Pick<AuthenticatedActor, "id" | "role">; endpoint: { baseUrl: string; token: string }; execution: OpenShellExecution; request: Request; targetPath: string; targetQuery: string | null; cookiePolicy?: "strip-all" | "app-only"; onActivity?: (input: { actorId: string; execution: OpenShellExecution; transport: "http" | "sse" | "websocket"; observedAt: Date }) => void }): Promise<Response>`, and `runtimeWebSocketTarget(input: { endpoint: { baseUrl: string; token: string }; execution: OpenShellExecution; path: string; query: string; subprotocol: string | null }): { url: string; headers: Headers }`. SSE must stream without buffering, propagate caller disconnect to the upstream, preserve event content-type/keepalive behavior, and use an idle—not wall-clock—timeout. WS authorization and target headers must be complete before `server.upgrade` commits.

- [ ] **Step 1: Write failing proxy and route tests.** Add four named cases: `openshell_computer_stream_injects_trusted_scope_and_strips_client_ownership_headers`, `openshell_opencode_sse_and_preview_ws_use_one_authorized_forwarder`, `openshell_preview_never_exposes_or_accepts_direct_sandbox_urls`, and `serve_upgrade_inventory_fails_on_an_unregistered_runtime_socket`. Cover long SSE frames, cancel/disconnect, reconnect, WS Origin/subprotocol, preview pass/ticket redemption, generated-app cookie isolation, and refusal before any upstream dial. Assert preview responses and logs contain no sandbox host, reserved port, service token, preview pass, or platform cookie.
- [ ] **Step 2: Run RED.** Run `E2E_UNIT_OUTPUT=.e2e/<run-key>/T04-task2-red e2e run --config e2e.unit.config.ts server/tests/openshell-runtime-proxy.test.ts server/tests/stream-auth.test.ts server/tests/craft-preview-socket.test.ts server/tests/workshop-preview.test.ts server/tests/craft-webapp-proxy.test.ts server/tests/multitenancy/inventory.test.ts`; then run `E2E_UNIT_OUTPUT=.e2e/<run-key>/T04-task2-agent-proxy-red E2E_BUN_ONLY=agent-sandbox/tests/proxy.test.ts e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` and `E2E_UNIT_OUTPUT=.e2e/<run-key>/T04-task2-agent-sse-red E2E_BUN_ONLY=agent-sandbox/tests/sse.test.ts e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`. Expected: four new cases fail on missing unified forwarding/topology; existing relevant cases remain collected; reports show total counts, zero unexplained skips, and no environment failure misread as pass.
- [ ] **Step 3: Implement minimal forwarding.** Integrate Task 1's gate before endpoint resolution. Computer stream decisions carry the trusted execution and inward headers; OpenCode HTTP/SSE and preview share `forwardRuntimeRequest`; preview HTTP and WS use T03's authenticated proxy rather than `host:reserved-port`. Keep legacy/shared preview behavior behind its existing mode branches. Update the serve-upgrade inventory tripwire for every new runtime upgrade branch.
- [ ] **Step 4: Run GREEN.** Repeat the native command with `T04-task2-green`, the proxy group with `T04-task2-agent-proxy-green`, and the SSE group with `T04-task2-agent-sse-green`, then run the Task 1 suite. Expected: all four named cases pass; SSE bytes survive chunk/flush and cancellation, WS handshake is refused before commit on auth failure, no direct URL leak remains, Bun-driven groups report their member cases, and skip count is zero or fully explained; run `bun run --cwd server typecheck`.
- [ ] **Step 5: Commit only the authorized Task 2 increment** with a message identifying authenticated runtime forwarding.

### Task 3: Selected-stack live proof that no public bottom entrance exists

**Files:** Create `scripts/openshell-service-access-acceptance.ts`, `tests/openshell/service-access.e2e.test.ts`, and `tests/openshell/chart-access.test.ts`; modify `charts/openbot/templates/networkpolicy.yaml` only for the OpenShell mode. Do not change `charts/openbot/templates/ingress.yaml` or `httproute.yaml` unless inspection shows a non-OpenBot backend; if changed, the diff must remain OpenShell-conditional.

**Interfaces:** Produce `runServiceAccessAcceptance(input: { cluster: OpenShellClusterBinding; actors: ServiceAcceptanceActors; archiveRoot: string; now?: () => number }): Promise<ServiceAccessAcceptanceReport>`. `OpenShellClusterBinding` names the immutable OpenShell/controller/CNI/storage versions, image digests, kube context/namespace, source checkpoint, and service revisions. `ServiceAcceptanceActors` contains owner, unauthorized signed-in user, other-Bot owner, and same-team/other-workspace owner. `ServiceAccessAcceptanceReport` is `{ pass: boolean; checks: Array<{ id: string; outcome: "pass" | "fail" | "blocked"; evidence: string }>; testedUrls: Array<{ surface: RuntimeService; origin: "outside" | "cluster-pod"; reachableAsOpenBot: boolean }>; versions: OpenShellClusterBinding }`.

- [ ] **Step 1: Bind versions and prove resource ownership.** Before creating anything, rescan T01–T03 evidence and record selected versions/digests, source manifest/commit/dirty checkpoint, cluster identity, namespace, labels, run ID, and every existing Service/Ingress/HTTPRoute/EndpointSlice/published port. Create only isolated test tenant/workspace/Bot resources with this run's labels; if ownership is ambiguous, stop blocked rather than reusing or deleting resources.
- [ ] **Step 2: Write failing chart and live tests.** `chart_has_no_public_runtime_backend` must render legacy, existing sandbox, and OpenShell values and assert public Ingress/HTTPRoute backends select only the OpenBot server, OpenShell bottom ingress allows only the integration service, and legacy manifests are unchanged. `same_url_refuses_foreign_user_other_bot_and_other_workspace` must drive authorized computer HTTP, OpenCode HTTP, SSE, computer WS, preview WS, and preview HTTP through OpenBot; then repeat the same URLs and captured headers as each unauthorized actor and assert neutral refusal with no upstream activity. `direct_bottom_urls_are_unreachable_without_openbot` must collect every URL returned by T02/T03 locators plus all discovered computer/coding/preview Services and ports, then attempt them from outside the cluster and from an unprivileged non-OpenBot Pod in-cluster using original request, replayed request, forged `x-openbot-*`, and captured token. Assert all non-OpenBot attempts fail before application data, and inspect Pod specs/mounts/env for control-plane credentials.
- [ ] **Step 3: Run RED.** Run `E2E_UNIT_OUTPUT=.e2e/<run-key>/T04-task3-red e2e run --config e2e.unit.config.ts tests/openshell/chart-access.test.ts tests/openshell/service-access.e2e.test.ts`. Expected: at least one chart or live topology assertion fails, or the live case is blocked with connection/version/ownership evidence while the chart case records its actual render verdict. A missing cluster is an environment `blocked`, never a pass or unexplained skip.
- [ ] **Step 4: Apply the minimal OpenShell-only topology fix only where RED found a gap.** Restrict bottom Service ingress to the OpenBot integration service Pod selector/ports, deny non-OpenBot ingress in the OpenShell NetworkPolicy branch, and ensure public Ingress/HTTPRoute backends select only the OpenBot server. Re-render old and OpenShell values and assert the old deployment manifests are unchanged except harmless metadata. If the chart is already restrictive, keep it unchanged and rely on live evidence. If OpenShell/CNI cannot express the required denial, leave T04 blocked; do not substitute an application-only mock.
- [ ] **Step 5: Run GREEN and regression.** Repeat the RED command with `E2E_UNIT_OUTPUT=.e2e/<run-key>/T04-task3-green`; run `helm lint charts/openbot` plus `helm template` for legacy, existing sandbox, and OpenShell values; then run Task 1, Task 2 native, both agent-sandbox driven commands, and `bun run --cwd server typecheck`. Expected: every authorized surface works; every foreign/direct attempt is refused or unreachable; actual collected counts and all skip/blocked reasons are recorded; no unrelated old-mode diff.
- [ ] **Step 6: Independent acceptance, Review, OCR, archive, and commit.** An independent session must separately report behavior, Spec mapping, and quality review; then run applicable OCR over the final authorized code increment. Store commands, exit codes, reports, rendered manifests, version/digest bindings, source checkpoint, discovered URL list, direct-attempt evidence, Pod credential inspection, review, and OCR under `.archive/runs/<run-key>/verification/`. Sanitize credentials and raw traces. Resolve every valid medium-or-higher finding, then commit only the authorized Task 3 increment.

## Independent acceptance

| 验收条件 | T04 映射 | 门槛 |
| --- | --- | --- |
| #738 AC1：授权用户 HTTP、SSE、WebSocket、预览可用 | Task 2 `openshell_opencode_sse_and_preview_ws_use_one_authorized_forwarder`、computer stream case；Task 3 live `same_url_refuses_foreign_user_other_bot_and_other_workspace` | 真实 OpenBot 入口和选定集群均通过；不得以直连底层 URL 代替 |
| #738 AC2：同一 URL 对未授权用户、其他 Bot、其他团队拒绝 | Task 1 authority/route cases；Task 3 unauthorized/other-Bot/other-workspace live case | 单元与实测都要求中性拒绝且无 upstream 活动 |
| #738 AC3：无可直连公开底层入口 | Task 3 `direct_bottom_urls_are_unreachable_without_openbot` | 必须含集群外与非 OpenBot 集群内 Pod 注入；渲染/配置文本不足以通过 |
| A02：同 Bot 两类环境独立 | Task 1 endpoint key 含 environment/generation；物理独立性继承 T02/T03 验收 | #736/#737 同源树通过是前置门槛 |
| A02：跨 Bot、跨团队、跨实际业务范围的文件/网络/管理访问拒绝 | Task 1/3 覆盖服务 URL、身份头与执行归属；文件/网络/管理动作的专用边界分别继承 T02/T03/T05/T09/T10 | T04 不重复实现那些域，但不得重新打开其边界 |
| A02：无工作负载控制面凭据 | Task 3 Pod spec/mount/env 检查 | 发现控制面 token/secret 挂载即 blocked |
| A02：策略或隔离失效不执行 | Task 1 dependency null/endpoint unavailable fail-closed；物理 fail-stop 继承 T02/T03 | 不自动换沙箱或降级 |
| A04：HTTP、SSE、WS、预览均鉴权且无裸入口 | Task 2 四个协议/预览 cases；Task 3 live 注入 | 每个升级在 commit 前判定，inventory tripwire 覆盖 |
| A04：长流、刷新、断线、认证头、超时可用 | Task 2 stream/cancel/reconnect/header cases；Task 3 真实链路 | SSE 使用 idle timeout，不用固定总时长误判健康长流 |
| A04：有效访问防闲置、轮询不续期、主动重开唤醒 | T08 消费 T04 `onActivity` 观察并定义有效活动 | T04 不得把所有字节/轮询当作有效活动而提前通过 A04 |

**Blocked gates:** #736 and #737 must be closed/verified in the same source tree; T02/T03 selected versions and service contracts must match; isolated live cluster/resources must be owned; all relevant e2e reports must have real case counts and no unexplained skip; independent behavior acceptance, Review, applicable OCR, and CI/delivery gates must pass for the final SHA. Any gap keeps #738 open/blocked rather than weakening D21.
