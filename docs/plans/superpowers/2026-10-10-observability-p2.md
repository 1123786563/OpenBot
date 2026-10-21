# 可观测性 P2（OTel traces 贯通）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一次请求（server → agent-bot/agent-computer/supervisor → 回调）在 Tempo 可见的连续 trace；trace_id 进入各进程日志；runtime-go 接续同一 trace。

**Architecture:** spike 已验证 Bun + OTel SDK 2.12 全链路可用（2026-10-10，9 项探针全过），走真 OTel 路线：`shared/trace.ts`（仅 @opentelemetry/api：传播+存取）+ 各进程 initTracing（SDK provider，spanProcessors 走构造参数——2.x 已移除 addSpanProcessor）。导出经 `OTEL_EXPORTER_OTLP_ENDPOINT`（复用 logs 既有语义），未配置则不挂 exporter 但照常产 span（traceparent 始终流通，`OPENBOT_TRACES=off` 总开关）。auto-instrumentation 不作依赖（Bun fetch 非 undici）。

**Tech Stack:** @opentelemetry/sdk-trace-node@^2.12、exporter-trace-otlp-http@^0.223、resources@^2.12、api@^1.9.1（shared 经根 package.json，P1 先例）、Hono 中间件、裸 Bun.serve 包装、runtime-go otel@v1.40（indirect 转直接）。

**Spec:** `docs/specs/superpowers/2026-10-10-observability-design.md` §3.2、§3.3、§5-P2、§6-P2

## Global Constraints

- 沿用 P1 全部约束：逐文件点名 `git add`（并行会话持续脏化 billing/enterprise/plugins/app.ts 等，派单前重查交集）、禁止 `git add -A`、Biome 规则、shared 相对导入深度（server/src 根=`../../shared`，telemetry/enterprise=`../../../shared`，agent-*/supervisor/worker 根级=`../../shared`）。
- **版本对齐**：traces 用 SDK 2.x 新线（sdk-trace-node@^2.12）；现有 logs 栈（sdk-logs@0.221 旧线）原样不动，两栈共享 `@opentelemetry/api@1.9.x` 单例。落地第一步在仓库 pin 的 bun（1.3.14）上复跑一遍 spike 式冒烟（spike 跑在系统 bun 1.4.2）。
- 导出失败必须非致命：exporter 连接失败只经 diag 记 ERROR，不影响请求路径；`OPENBOT_TRACES=off` 时进程完全不初始化 SDK（noop，传播仍走全局默认 W3C propagator）。
- span 命名约定：入站 `METHOD path`（如 `POST /ag-ui`）、出站 `CALL target path`（如 `CALL agent-bot /ag-ui`）；属性用 otel 语义约定 `http.request.method`/`url.path`/`http.response.status_code`。
- runtime-go 之外的所有改动都在 bun workspaces/独立 bun 项目内；Go 只动 runtime-go/ 与其 go.mod。
- 验证门禁：`bun test <目标文件>`、`cd server && bun run typecheck`、各服务自带测试；已知基线失败（tenancy 测试 DB、agent-bot 与 dev server 抢 3001、channel-activity.integration、billing/enterprise 并行脏文件的 typecheck 错误）不算新增。

---

### Task 1: shared/trace 帮手 + server 初始化模块（spike 转正）

**Files:**
- Create: `shared/trace.ts`（帮手 + 进程初始化，唯一实现路径）
- Create: `server/tests/trace.test.ts`（spike 模式自包含测试：本地假 collector）
- Modify: 根 `package.json`（@opentelemetry/api + SDK 三件套，shared 直接 import SDK——P1 pino 先例）+ `server/package.json`（同款声明，供 server 直接导入）+ `bun.lock`、`server/src/index.ts`（boot 调用）

**Interfaces:**
- Produces（shared/trace.ts）:
  - `extractRequestContext(request: { headers: Headers }): Context`（propagation.extract，carrier 从 Headers 读）
  - `injectTraceHeaders(headers: Record<string,string>): Record<string,string>`（propagation.inject 到普通对象）
  - `currentTraceId(): string | undefined`（trace.getSpan(context.active())，无效 span 返回 undefined）
  - `initProcessTracing(name: string, env: { OTEL_EXPORTER_OTLP_ENDPOINT?: string; OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?: string; OPENBOT_TRACES?: string }): void`——`OPENBOT_TRACES=off` 直接 return；否则注册 NodeTracerProvider（`resourceFromAttributes({"service.name": name})`），endpoint（取值顺序沿用 otel.ts:152-155）存在时挂 `BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint + "/v1/traces" }))`。幂等（重复调用只生效一次）。
  - `shutdownTracing(): Promise<void>`（测试与进程退出用）。
- server/src/index.ts 在 boot 早期（telemetry/otel.ts 初始化附近）调用 `initProcessTracing("server", env)`。

- [ ] **Step 1: 安装依赖**

```bash
cd /Users/wuyongjun/trea/OpenBot && bun add @opentelemetry/api@^1.9.1 @opentelemetry/sdk-trace-node@^2.12.0 @opentelemetry/exporter-trace-otlp-http@^0.223.0 @opentelemetry/resources@^2.12.0
cd server && bun add @opentelemetry/api@^1.9.1 @opentelemetry/sdk-trace-node@^2.12.0 @opentelemetry/exporter-trace-otlp-http@^0.223.0 @opentelemetry/resources@^2.12.0
```

记录实际解析版本。**随即跑一遍冒烟**：用 `bun -e` 构造 NodeTracerProvider 并打印 prototype 自身属性含 getTracer/forceFlush（复现 spike 的 API 形状确认，在 pin 的 bun 1.3.14 上）。

- [ ] **Step 2: 写失败测试** `server/tests/trace.test.ts`

测试骨架 = spike（/tmp/otel-spike/spike.ts）的测试化：本地 `Bun.serve` 假 collector 收 `POST /v1/traces` 计数；`initTracing({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:<port>" }, { name: "trace-test" })`；用裸 Hono 应用挂 `extractRequestContext` 式中间件（Task 2 才产正式中间件，这里直接用 `tracer.startSpan` + `context.with` 断言）：

```ts
import { describe, expect, test } from "bun:test";
// 用例 1：远端父上下文——带 traceparent 的入站解析后 span.traceId === 头里的 traceId
// 用例 2：子 span 出站注入——injectTraceHeaders 产出的 traceparent 与当前 trace 同 id
// 用例 3：无入站头时自根生成，32 位十六进制
// 用例 4：forceFlush 后假 collector 收到 ≥1 次 POST /v1/traces 且字节数 > 0
// 用例 5：OPENBOT_TRACES=off 时 initTracing 直接返回，currentTraceId() 为 undefined
// 用例 6：不配 endpoint 时 provider 注册成功、span 照常产生、collector 零请求
```

每个用例给独立 service.name 与独立端口（14318+偏移），用例间 `provider.shutdown()` 防串扰（initTracing 需暴露 `shutdownTracing(): Promise<void>` 供测试与进程退出调用——加入 Produces）。

- [ ] **Step 3: 跑测试确认失败**（模块不存在）→ **Step 4: 实现 shared/trace.ts**（帮手 + initProcessTracing/shutdownTracing，模式照 spike.ts，除 spanProcessors 改构造参数；init 幂等）→ **Step 5: 测试转绿**（6 用例全过）→ **Step 6: `cd server && bun run typecheck`** → **Step 7: Commit**

```bash
git add shared/trace.ts server/src/telemetry/trace.ts server/tests/trace.test.ts server/src/index.ts package.json server/package.json bun.lock
git commit -m "feat(observability): otel trace context helpers and server trace init"
```

---

### Task 2: server 入站 trace 中间件 + 日志带 trace_id

**Files:**
- Create: `server/src/telemetry/trace-middleware.ts`
- Modify: `server/src/app.ts:522-523`（tracking 注册旁）、`server/src/telemetry/request-tracking.ts`（requestScopedLogger 扩展）
- Test: `server/tests/trace-middleware.test.ts`

**Interfaces:**
- Consumes: Task 1 `extractRequestContext`/`currentTraceId`；P1 `requestScopedLogger`。
- Produces: `createTraceMiddleware(): MiddlewareHandler<{ Variables: RequestTrackingVariables }>`——`extractRequestContext(c.req)` 取远端上下文，`tracer.startSpan(\`${method} ${path}\`, {}, remoteCtx)`，`context.with` 包 `next`，结束后设 `http.response.status_code` 属性并 end；请求内 `currentTraceId()` 返回 32 位 id。`requestScopedLogger` 扩展：child 绑定加 `trace_id: currentTraceId()`（有才加）。access log 行自然带 trace_id。
- 注册顺序（app.ts）：`app.use("*", tracking.requestId)` 之后、`app.use("/api/*", tracking.accessLog)` 之前插 `app.use("*", traceMiddleware)`——accessLog 的 trace_id 才有值。

- [ ] **Step 1: 写失败测试**（mini Hono app 模式同 P1 request-tracking.test.ts：/api/work 带 traceparent → 响应 200；access log 行含 `trace_id` 且等于入站 trace id；无头时 trace_id 为 32 位十六进制）→ **Step 2: 红** → **Step 3: 实现**（中间件 + requestScopedLogger 两行扩展）→ **Step 4: 绿 + `bun test server/tests/request-tracking.test.ts server/tests/trace-middleware.test.ts`（P1 用例不回归）** → **Step 5: typecheck** → **Step 6: Commit**

```bash
git add server/src/telemetry/trace-middleware.ts server/src/telemetry/request-tracking.ts server/src/app.ts server/tests/trace-middleware.test.ts
git commit -m "feat(observability): inbound trace spans on the main app; trace_id in request logs"
```

---

### Task 3: server 出站 traceparent 注入（tracedFetch 接线）

**Files:**
- Modify: `server/src/agents/endpoint.ts:296`（doFetch 前 inject）、`server/src/agents/connection-test.ts:152`、`server/src/computer/client.ts:208`（request() 的 headers 拼接处）、`server/src/computer/supervisor.ts:81`（call()）
- Test: `server/tests/trace-outbound.test.ts`

**Interfaces:**
- Consumes: Task 1 `injectTraceHeaders`、`currentTraceId`。
- Produces: 四个出站点统一模式——拼 headers 前调用 `injectTraceHeaders(headers)`；`connection-test.ts` 复用 `createAgentFetch` 的话只需改 endpoint.ts 一处（读代码确认 connection-test 是否走同一 doFetch 路径，是则不重复改）。

- [ ] **Step 1: 写失败测试**：起本地 Bun.serve 假 agent（收 POST 记 headers）；在活动 span 内调 createAgentFetch 指向假 agent → 断言请求头含 `traceparent` 且其 traceId === 当前 span 的 traceId；无活动 span 时无 traceparent 头（或含自根——按 inject 语义定为：无 span 则不注入，测试钉住该选择）。→ **Step 2: 红** → **Step 3: 四处接线** → **Step 4: 绿 + 相关既有测试（agent-callback-token、agent-test-connection-headers 等 agent/computer 套件）不回归** → **Step 5: typecheck** → **Step 6: Commit**

```bash
git add server/src/agents/endpoint.ts server/src/agents/connection-test.ts server/src/computer/client.ts server/src/computer/supervisor.ts server/tests/trace-outbound.test.ts
git commit -m "feat(observability): inject traceparent on server outbound calls"
```

---

### Task 4: Bun 服务接续（agent-bot / agent-computer / supervisor）

**Files:**
- Modify: `agent-bot/package.json`、`agent-computer/package.json`、`supervisor/package.json`（各加 sdk-trace-node/exporter/resources/api 同版本——三服务独立 bun 项目且容器内构建，不能依赖根 node_modules 上溯解析，必须各自声明）
- Modify: `agent-bot/src/index.ts:244`（serve 的 fetch 外包 `withTraceFetch`：extract + startSpan + try/finally end + trace_id 进其 JSON 日志）、`agent-computer/src/index.ts:646`（同型包装，注意 websocket 路径不包，只包 fetch 分支）、`supervisor/src/index.ts:99-107`（Hono `app.use("*")` 中间件，Bearer 校验中间件之前）
- Test: 各服务现有测试风格下为 withTraceFetch/Hono 中间件写单测（假 traceparent → 子进程日志/响应头可观测 trace_id；无头 → 自根）

- [ ] **Step 1: shared/trace.ts 加 `withTraceFetch(handler)`（裸 serve 包装器：`(request) => handler(request)` 外起 span，命名 `METHOD path`），单测先行（initProcessTracing 已在 Task 1 落地，此处只加包装器）** → **Step 2: 三服务接线**（各自安装依赖 + boot 调 `initProcessTracing("<service>", env)` + 包装/中间件；worker 无 HTTP 入站本轮不涉及）→ **Step 3: 各服务测试 + `bun test worker`** → **Step 4: Commit**（按服务分 2 个提交：shared+依赖一个、三服务接线一个）

---

### Task 5: runtime-go 接续

**Files:**
- Modify: `runtime-go/go.mod`（otel v1.40、sdk、otlp trace http 从 indirect 转直接）
- Create: `runtime-go/internal/server/trace.go`（`func TraceMiddleware(next http.Handler) http.Handler`：propagation 从 request header extract、起 span、`context.WithSpan`、响应后 end；OTLP exporter 按 `OTEL_EXPORTER_OTLP_ENDPOINT` 初始化，main.go 启动时装载）
- Modify: `runtime-go/cmd/runtime/main.go:151`（middleware 链最外层加 trace）、callback client 出站注入（`internal/` callback.Client 的 HTTP transport 或请求构造处 inject）

- [ ] **Step 1: `go get go.opentelemetry.io/otel/...` 固定版本 + go mod tidy** → **Step 2: trace.go + 单测（httptest：入站 traceparent → recorder span 断言父子；出站注入断言头）** → **Step 3: main.go 装配** → **Step 4: `cd runtime-go && go build ./... && go test ./internal/server/...`** → **Step 5: Commit**（`git add runtime-go/`）

---

### Task 6: 文档与配置收尾

**Files:**
- Modify: `reference/observability.md`（"Later phases" 里 traces 移入正文：span 命名约定、trace_id 日志字段、OTEL_EXPORTER_OTLP_ENDPOINT 语义、OPENBOT_TRACES=off 开关、当前无 Tempo 时导出失败的预期行为）
- Modify: `.env.example`（`OTEL_EXPORTER_OTLP_ENDPOINT` 条目旁注释补 `/v1/traces` 用途与 `OPENBOT_TRACES` 开关）

- [ ] **Step 1: 文档** → **Step 2: 全分支门禁**（`bunx biome lint --error-on-warnings server/src worker/src shared supervisor/src agent-bot/src agent-computer/src`、`cd server && bun run typecheck`、`bun test server/tests shared/ worker/`）→ **Step 3: Commit**

```bash
git add reference/observability.md .env.example
git commit -m "docs: trace conventions for the P2 phase"
```

---

## 验收对照（spec §6-P2）

| 验收项 | 落点 |
|---|---|
| spike 结论有据 | 已完成（2026-10-10 PASS，9 探针；SDK 2.x API 变更已记录） |
| 跨 server→agent-bot→computer 请求在 Tempo 呈现连续 trace | Task 2/3/4（Tempo 本体在 P3；本阶段用 Task 1 假 collector 集成测试钉住导出，P3 起栈后对真 Tempo 复验） |
| 降级路径不需要 | spike 通过，无降级 |
| trace_id 进日志 | Task 2（server）、Task 4（三服务） |
| runtime-go 接续 | Task 5 |
