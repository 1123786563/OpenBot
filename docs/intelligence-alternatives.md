# Intelligence 替换方案调研：自托管替代 CopilotKit Intelligence 云端

调研日期：2026-10-10。只采信一手资料（官方文档、GitHub 源码/API、npm 元数据、本地 node_modules 实际安装的 1.77.0 产物）。每条关键结论标注来源；**【源码确认】** 指直接读过代码/包产物，**【文档声称】** 指官方文档表述。

## 1. 背景：OpenBot 对 Intelligence 云端的依赖面

OpenBot server 依赖 `@copilotkit/runtime` 1.77.0（v2 API），`server/src/copilot.ts` 以 `new CopilotRuntime({ intelligence, licenseToken })` 强制 Intelligence 模式（源码确认：`server/src/copilot.ts:2287-2288`；头注释 "There is no SSE branch. Intelligence is a requirement of the product"）。云端承担六件事：

| # | 依赖 | copilot.ts 调用点 | 性质 |
|---|------|------------------|------|
| 1 | 持久线程存储 | `getOrCreateThread` / `getThreadMessages`（:2356, :2431） | 存储层 |
| 2 | 每会话运行锁 | `ɵacquireThreadLock` / `ɵrenewThreadLock` / `ɵcleanupThreadLock`（:2360, :2399, :2410），TTL 120s，冲突 409 | 并发控制 |
| 3 | Gateway WebSocket（浏览器↔server 事件流） | `intelligence.gatewayWsUrl`（:2251） | 传输层 |
| 4 | Runner WebSocket（server/runner 驱动、bot 间 handoff） | `ɵgetRunnerWsUrl` / `ɵgetRunnerAuthToken`（:2333-2334） | 传输层 |
| 5 | 许可/entitlements | `licenseToken`、`getRuntimeEntitlements` | 商业层 |
| 6 | 用户身份投影 + learning 容器 | `identifyUser`、`getLearningContainerId`（:2249-2260） | 多租户/学习 |

## 2. 方案一（重点）：CopilotKit OSS runtime 自身的非云端模式 —— **存在，且是 1.77.0 的正式能力**

### 2.1 结论

`@copilotkit/runtime`（MIT，[GitHub 仓库 license API](https://github.com/CopilotKit/CopilotKit) 与本地 `server/node_modules/@copilotkit/runtime/package.json` 均确认 `license: MIT`）在**不传 `intelligence` 时就是自托管 SSE 模式**，v1.77.0 中该模式不是残留而是三类一等公民之一：

【源码确认】`dist/v2/runtime/core/runtime.d.mts`：

- `CopilotRuntimeOptions = CopilotSseRuntimeOptions | CopilotIntelligenceRuntimeOptions`（:222）；`mode` 由 `intelligence` 是否存在推断（`CopilotRuntime` 是 shim，:396-419）。
- `CopilotSseRuntimeOptions`（:182-189）：`runner?: AgentRunner`、`intelligence?: undefined`、`channels?: undefined` —— SSE 模式有**可插拔 runner**，且类型上禁止传 intelligence。
- `CopilotSseRuntime`（:314-318）：`readonly mode: "sse"`。

【源码确认】请求分发 `dist/v2/runtime/handlers/handle-run.mjs`：

```ts
if (isIntelligenceRuntime(runtime)) return handleIntelligenceRun({...});
return handleSseRun({...});   // handlers/sse/run.mjs
```

`handlers/sse/run.mjs` / `handlers/sse/connect.mjs`：SSE 模式直接把 `runtime.runner.run(...)` / `runner.connect(...)`（rxjs `Observable<BaseEvent>`，即 AG-UI 事件）以 `text/event-stream` 流式返回，带 keep-alive 注释（`sseKeepAliveIntervalSeconds`，默认 15s）。**无 WebSocket、无云网关。**

### 2.2 AgentRunner 抽象：补齐持久化的官方接缝

【源码确认】`dist/v2/runtime/runner/agent-runner.d.mts:49-55`：

```ts
declare abstract class AgentRunner {
  abstract run(request: AgentRunnerRunRequest): Observable<BaseEvent>;
  abstract connect(request: AgentRunnerConnectRequest): Observable<BaseEvent>;
  abstract isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean>;
  abstract stop(request: AgentRunnerStopRequest): Promise<boolean | undefined>;
}
```

配套导出 `LocalThreadEndpointRunner`（:40-47）：实现 `ɵsupportsLocalThreadEndpoints: true` + `listThreads() / getThreadMessages() / getThreadEvents() / getThreadState() / clearThreads()` 后，runtime 会**在本地服务这些线程 REST 路由**。

【源码确认】线程 REST 路由在 SSE 模式下可用：`core/fetch-handler.mjs` 的 `dispatchRoute` 处理 `threads/list|messages|events|state|update|archive|clear`，`handlers/intelligence/threads.mjs:63,84,191,240` 对每个 handler 判断 `supportsLocalThreadEndpoints(runtime.runner)` —— 本地 runner 存在则读 runner，否则才走 Intelligence 云。`handlers/get-runtime-info.mjs:128`：`hasRestThreadBackend = isIntelligenceRuntime(runtime) || supportsLocalThreadEndpoints(runtime.runner)`，`/info` 据此向前端宣告线程端点。

【源码确认】自带参考实现 `InMemoryAgentRunner`（`dist/v2/runtime/runner/in-memory.d.mts`）：进程内 LRU 线程存储（`maxThreads/maxRunsPerThread/maxBytes`），其 `InMemoryThread` 注释明言 "Shape matches CopilotKit Intelligence's ThreadRecord so the same HTTP response envelope can be used for both backends"；`onConcurrentRun: "throw" | "supersede"` 提供**进程内单 run-per-thread** 并发控制（throw 即同线程二次 run 报 "Thread already running"）。局限：**不持久化**，进程重启即失。

### 2.3 并发锁在 SSE 模式下的形态

【源码确认】`lockTtlSeconds / lockKeyPrefix / lockHeartbeatIntervalSeconds` 只存在于 `CopilotIntelligenceRuntimeBaseOptions`（runtime.d.mts:190-210）——锁的实现是 Intelligence 运行时+其云端/Redis 的职责，SSE 运行时层没有锁概念。SSE 模式的等价物是 **runner 内部的并发控制**（InMemoryAgentRunner 的 `onConcurrentRun`；自定义 runner 自行实现）。前端对 409 的处理是现成的：`@copilotkit/core` 1.77.0 在 run 收到 409 时抛 `AgentThreadLockedError`（core dist index.mjs:482）。

### 2.4 前端 1.77.0 兼容性：无需重写

【源码确认】`@copilotkit/core` 1.77.0（前端依赖链）：

- 客户端默认 `runtimeMode = RUNTIME_MODE_SSE`（index.mjs:917 `config.runtimeMode ?? RUNTIME_MODE_SSE`）。
- 运行时模式由 `/info` 协商：`this.runtimeMode = runtimeInfoResponse.mode ?? RUNTIME_MODE_SSE`（:2341）；agent 侧 `adoptRuntimeMode(runtimeInfo.mode ?? RUNTIME_MODE_SSE, runtimeInfo.intelligence)`（:1882），注释明言 "an env-var change or a rollback can flip `intelligence` → `sse`"（:928）。
- 只有 `/info` 报告 `mode: "intelligence"` 且带 `intelligence.wsUrl` 元数据时客户端才走 WebSocket delegate（:1289, :1386）；否则一律 fetch + SSE。
- 线程恢复走 runtime 自身 REST：`_threadEndpoints` 来自 `/info`（:2344）。

即：**后端切到 SSE 模式后，`CopilotKitProvider`、`useCoAgent`、generative UI middleware、A2UI 均无需改动**——`openGenerativeUI`/`a2ui`/`mcpApps` 是 `BaseCopilotRuntimeOptions` 上的普通配置项（runtime.d.mts:36-54），不挂 license。【文档声称】[Open source vs Intelligence](https://docs.copilotkit.ai/concepts/oss-vs-enterprise) 同样声明 generative UI 原语、A2UI、自有持久化属 OSS/MIT 能力，且**只有 TypeScript runtime 能脱离 Intelligence 独立运行**（Python/Go/Ruby/.NET runtime 均要求 Intelligence）。

### 2.5 许可验证机制（确认可以不删 token 也能跑，但应删）

【源码确认】`@copilotkit/license-verifier` 0.5.0（MIT）是**离线 Ed25519 签名校验**，公钥构建期烘焙，无网络调用。不传 token 时 `createLicenseChecker` 返回 `{valid: false, license: null, error: null, warningSeverity: "info"}`——不报错，只是"无授权特性"。runtime 中 `licenseChecker` 只影响 `/info` 的 `licenseStatus` 字段（get-runtime-info.mjs:9-18）。即删掉 `licenseToken` 后 runtime 行为正常，entitlements（第 5 项依赖）按预期**整体删除而非替换**。

### 2.6 SSE 模式明确丢失的能力（迁移代价清单）

【源码确认】以下仅在 Intelligence 运行时存在：

- `threads/subscribe`（跨设备线程实时同步）：`handlers/intelligence/threads.mjs:111` 第一行 `requireIntelligenceRuntime(runtime)`，SSE 模式不可用。
- `generateThreadNames`（自动线程命名）、Channels（Slack/Teams 入站）、learning 容器 / learned skills（OpenBot 的 `RemoteLearnedSkillsMiddleware`、`createLearningRuntime` 均建立在 `CopilotKitIntelligence` 客户端上）、跨进程 runner WebSocket（第 4 项：bot 间 handoff 递送）。
- 锁的跨进程 TTL 版本（第 2 项的多实例形态）。

OpenBot 需自行决定：handoff 改为进程内事件转发（`runner.connect()` 本就为此设计）或自建；learning 需要本地重实现或砍掉；跨设备实时同步降级为"刷新拉取"（threads/messages REST 仍在）。

### 2.7 v1 时代的 runtimeInstances/SSE 模式现状

v1（GraphQL `/copilotkit` 端点）仍由 v1 入口委托给 v2 运行时（runtime.d.mts:122-128 注释 "Set by the deprecated v1 entrypoint, which delegates every request to this runtime"）。v2 的 SSE 模式是当前正道，v1 路径已弃用。【源码确认】

## 3. 方案二：AG-UI 协议（作为自建网关的协议基座）

- License：MIT（[ag-ui-protocol/ag-ui](https://github.com/ag-ui-protocol/ag-ui) GitHub API 确认；本地 `@ag-ui/client` 1.0.1 `package.json` 亦为 MIT）。
- 传输层定义：**协议本身传输无关**，README 原文 "Works with any event transport (SSE, WebSockets, webhooks, etc.)"，官方参考实现是 HTTP（POST + SSE 响应流）+ 默认 connector；约 16 种标准事件类型。【文档声称 + 源码确认】本地 `@ag-ui/client` dist 中含 `text/event-stream` 处理。
- 自建 gateway 可行性：OpenBot 的 Bot 已是 AG-UI `AbstractAgent`（`BuiltInAgent` / `HttpAgent` / `@ag-ui/mastra` 适配），SSE 模式下 runtime 在**进程内**驱动 agent（经 AgentRunner），浏览器↔server 走 SSE——不需要任何外部 gateway。若未来确需 WS（如移动端弱网），自建 WS 桥在协议层面合法，但 v1.77.0 的客户端在 SSE 模式下不消费 wsUrl，**性价比低，不建议**。
- 结论：AG-UI 是"替换 Intelligence gateway"这件事的协议地基，而 CopilotKit OSS runtime 已把它实现完毕；单独引入 AG-UI 不构成独立方案。

## 4. 方案三：Mastra（Apache-2.0）

- License：**Apache-2.0**（2025-07-09 官宣从 ELv2 改为 Apache 2.0：[mastra.ai](https://mastra.ai) 官网公告；本地 `@mastra/core` 1.64.0、`@mastra/client-js` 1.43.0 `package.json` 均 `Apache-2.0`；npm `@mastra/pg` 1.30.0 `Apache-2.0`）。GitHub 仓库显示 NOASSERTION（自定义文件），但发布包均为 Apache-2.0。
- 线程/记忆/存储【源码确认，读本地 `@mastra/client-js` dist】：Server REST 面含 `GET/POST /api/memory/threads`、`threads/:id/messages`、`threads/:id/clone`、`threads/:id/working-memory`、`threads/subscribe`、`threads/abort`、`/api/agents/:id/stream`（含 stream-transforms / stream-legacy）。存储走 `@mastra/pg`（Postgres adapter）或 LibSQL；`resourceId` 即按用户隔离的资源空间，与"按用户隔离线程"对齐。
- 自托管：`mastra dev`（:4111）暴露 Studio + REST；`@mastra/server` 可嵌入自有服务。【文档声称：[Mastra CLI 参考](https://mastra.ai/en/reference/cli)】
- 作为 Intelligence 替代的评估：**能承担"持久线程 + 流式"两件事**（Postgres 存储、AG-UI 流），无任何 license/entitlement 层。但它替换的是"运行时+存储"整体：OpenBot 的 CopilotKit `BuiltInAgent`（AI SDK 工具、审批、headless tools）需要迁到 Mastra Agent 模型；前端侧 `@ag-ui/mastra` 适配器保证 AG-UI 状态同步可用，但 CopilotKit generative UI 中间件、A2UI 自动接线是 runtime 侧能力，需要重做。OpenBot 已有 `remote_mastra` 接入（agent-mastra），说明 Mastra 路线可增量试点，但作为**全局** Intelligence 替代属于"换后端框架"级别工程，不是低成本路径。

## 5. 方案四：LangGraph（库 MIT / 服务器 Elastic-2.0）

- License（一手核实）：
  - `langchain-ai/langgraph`（Python，43k stars）与 `langchain-ai/langgraphjs`：**MIT**（GitHub API）。
  - **Agent Server（`langgraph dev` 背后的 `langgraph-api`）：Elastic-2.0 且闭源** —— PyPI [langgraph-api 0.16.0](https://pypi.org/project/langgraph-api/) 元数据 `license: Elastic-2.0`；MIT 的 langgraph 仓库内**没有** `libs/langgraph-api` 源码目录（GitHub API 404）。ELv2 允许在自己产品内自托管（仅禁止将其作为托管服务转售）。
- 线程/运行模型【文档声称】：[LangChain 官方文档](https://docs.langchain.com/oss/langgraph/local-server) —— `langgraph dev` 内存模式（自定义 checkpointer 会被忽略，历史已知问题）；`langgraph up`/自托管 standalone Agent Server 可挂外部 Postgres + Redis 持久化 threads/runs/checkpoints；本地 server 文档要求 LangSmith API key（免费注册）。threads/runs API 与托管版一致（LangGraph SDK）。
- 评估：threads/runs/流式 API 在功能上确实是 Intelligence "线程存储 + 运行模型"的对等物，且 checkpoint 体系（`@langgraph/checkpoint-postgres`）成熟。但对 OpenBot 是**整栈换血**：前端从 CopilotKitProvider 换成 LangGraph SDK + 自写 UI 状态层（丢 generative UI middleware/A2UI 现成件），server 从 TS CopilotKit 栈换 Python（或 TS lib + ELv2 server）。OpenBot 已有 `agent-langgraph-agui`（AG-UI 桥）说明 LangGraph 可以作为**计算引擎**留在 AG-UI 协议后面，这比让它顶替 Intelligence 合理得多。ELv2 对商业分发也比 MIT 敏感。

## 6. 其他候选简评

| 候选 | License（一手核实） | 简评 |
|------|--------------------|------|
| **Agno** | Apache-2.0（[agno-agi/agno](https://github.com/agno-agi/agno) GitHub API） | Python AgentOS 自带 REST/存储（Postgres），但语言栈不符（OpenBot server 是 TS），需 AG-UI 桥且前端能力重建。不推荐。 |
| **Vercel AI SDK（`ai` 包）** | Apache-2.0（npm `ai@7.0.137`） | 不是平台而是流式原语：`streamText`/UI message stream + 自选持久层。线程、锁、按用户隔离全部自建在 OpenBot 现有 drizzle+Postgres 上——控制力最大、工程量也最大，且前端必须弃用 CopilotKitProvider（或用其 AG-UI 桥）。仅当决定彻底去 CopilotKit 化时考虑。 |
| **assistant-ui** | MIT（[assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui)） | 前端聊天组件库（有 LangGraph runtime 适配），是 CopilotKit 前端的替代品而非 Intelligence 的替代品；换它等于前端重写。 |
| **LlamaIndex Server** | MIT（[run-llama/llama_index](https://github.com/run-llama/llama_index)） | Python 生态的部署/对话服务，同 Agno/LangGraph 的语言栈问题。不匹配。 |
| **Temporal** | MIT（[temporalio/temporal](https://github.com/temporalio/temporal)） | durable execution；signal + workflow serializer/mutex 可严谨实现"单会话单写者"，且天然持久化。但它是执行基底不是 agent 协议层——只解决第 2 项（锁/运行模型），第 1/3 项（线程 REST、传输）仍要自己接 AG-UI。作为自定义 AgentRunner 的**内部实现**可选，作为独立替代方案过重。 |
| **Trigger.dev** | Apache-2.0（[triggerdotdev/trigger.dev](https://github.com/triggerdotdev/trigger.dev)） | 后台任务/队列/并发控制，角色同 Temporal 但偏作业编排；对长驻对话流式不友好。不推荐。 |
| **Liveblocks** | SDK npm `@liveblocks/react@3.24.3` 为 Apache-2.0，但产品本体是**云服务**（GitHub [liveblocks/liveblocks](https://github.com/liveblocks/liveblocks) NOASSERTION） | 实时协同层（presence/storage/通知）。引入它=再加一个云依赖，且它不运行 agent。与"去云端"目标相反。 |
| **PartyKit** | MIT（[partykit/partykit](https://github.com/partykit/partykit)） | 自托管边缘 WS 运行时，理论上可当自建 gateway，但 AG-UI SSE 已覆盖传输需求，v1.77 客户端 SSE 模式不消费 WS。无必要。 |

## 7. CopilotKit Intelligence 的封闭性与定价（替换动机佐证）

- 【文档声称】[Open source vs Intelligence](https://docs.copilotkit.ai/concepts/oss-vs-enterprise)：Intelligence 是**独立商业条款**的后端服务（"CopilotKit Intelligence and Showcase have separate terms"），OSS SDK/runtime 为 MIT。自托管 Intelligence 是 [K8s Helm / AWS ECS 交付的专有组件](https://docs.copilotkit.ai/intelligence/self-hosting)：app-api(:4201) + app-frontend(:8080) + realtime-gateway(:4401, WS) + Postgres≥14 + Redis≥7 + OIDC IdP，需 "Team self-hosted plan or a custom Enterprise plan" + license key（K8s Secret 注入 `COPILOTKIT_LICENSE_TOKEN`）。
- 【文档声称】[定价页](https://www.copilotkit.ai/pricing)：Developer 免费（**线程保留 3 天**、最多 200 线程）、Pro $39/月、Team $100/席/月（≤5 席，含数据库自托管）、Enterprise 议价；Analytics 与 Self-Learning 为 Enterprise 专属。对自托管产品而言 3 天线程保留是硬伤，构成本调研的直接动机。

## 8. 对比表

| 评估基准 | ①CopilotKit OSS runtime（SSE 模式 + 自定义 Postgres AgentRunner） | ②自托管 Intelligence（付费） | ③Mastra server | ④LangGraph 自托管 server | ⑤Vercel AI SDK 全自建 |
|---|---|---|---|---|---|
| 线程持久化（Postgres） | 需自写 runner（对接口已定义：`LocalThreadEndpointRunner`）；表结构自定，可复用 drizzle | 云件自带（Postgres≥14 由你提供） | `@mastra/pg` 现成 | ELv2 server + 外部 Postgres/Redis | 全自建 |
| 单会话单 run 锁 | 进程内 `onConcurrentRun` 现成；多实例需在 runner 内加 Postgres advisory lock/TTL（409 语义前端已处理） | 云端 Redis 锁现成 | 无内建强锁，需自加 | server 内 runs 串行化（单 deployment 内） | 全自建 |
| 浏览器↔server 流式 | **SSE 内建，零工作** | WS（realtime-gateway） | SSE（`/stream`） | SSE（runs stream） | 自建（SDK 有 UI stream） |
| 许可/entitlements | **整体删除**（OSS 无此依赖；license-verifier 离线校验，无 token 亦正常）【源码确认】 | 需付费 license key | 无 | ELv2 约束（可自托管、禁转售 SaaS） | 无 |
| 按用户隔离线程 | `identifyUser` 迁入自定义 runner 的 scope 字段（查询单位） | `identifyUser` 现成 | `resourceId` 现成 | thread metadata 自管 | 全自建 |
| 前端 1.77.0 兼容 | **无需重写**（`/info` 协商自动切 SSE 模式）【源码确认】 | 无需重写 | AG-UI 桥可用，generative UI/A2UI 接线需重做 | 前端重写 | 前端重写 |
| License/自托管条款 | MIT | 专有，付费计划 | Apache-2.0 | 库 MIT / server ELv2 闭源 | Apache-2.0 |
| 丢失的 Intelligence 特有功能 | threads/subscribe 实时同步、Channels、learning、自动线程命名（见 §2.6） | 无丢失 | 对应物部分存在（working-memory、subscribe） | checkpoint 体系更强，但非 CopilotKit 语义 | 全部自建 |
| 相对工程量 | **小-中**（1 个 runner + handoff 改造 + learning 决策） | 零代码（花钱 + K8s/Redis/OIDC 运维） | 中-大 | 大 | 最大 |

## 9. 推荐路径

### 首选：留在 CopilotKit OSS，切 SSE 模式，自写一个 Postgres 版 `AgentRunner`

证据充分（§2 全部为 1.77.0 源码确认）：v2 的 SSE 分支是正式能力而非残留，`intelligence` 是可选依赖，前端 `/info` 协商使切换对 1.77.0 前端透明。需要补的三块对应现成件：

1. **线程存储**（唯一实质工程）：实现 `AgentRunner` + `LocalThreadEndpointRunner`（`ɵsupportsLocalThreadEndpoints: true`），底层建 `threads / runs / thread_events / thread_messages` 表挂现有 drizzle+Postgres。可直接 fork `InMemoryAgentRunner`（其导出与 Intelligence `ThreadRecord` 同形，响应封套兼容）改为落库；跑事件流经 `run()` 的 `Observable<BaseEvent>` 转存。量级：约 1-2 周单人。
2. **单会话单 run 锁**：单实例部署直接用 runner 内 `onConcurrentRun: "throw"`（现成）；多实例在自定义 runner 的 `run()` 入口加 `pg_advisory_lock(threadId)` 或 TTL 行锁，冲突返回 409（前端 `AgentThreadLockedError` 处理已在）。量级：2-3 天。
3. **传输**：零工作（SSE 内建）。bot 间 handoff 原走 runner WS（依赖面第 4 项），改为进程内经 `runner.connect()` / OpenBot 内部事件总线递送；跨设备实时同步（threads/subscribe）降级为 REST 拉取，或后续用 OpenBot 自有 WS 补。

配套删除：`licenseToken`、`getRuntimeEntitlements`、`intelligence` 配置整块（copilot.ts:2247-2288）；`RemoteLearnedSkillsMiddleware`/learning 容器需本地化或砍掉（产品决策项）。保留 `identifyUser` 的语义，把它变成自定义 runner 的 scope 参数。

### 备选 A：付费自托管 Intelligence

零代码改动（`apiUrl`/`gatewayWsUrl` 指向自建实例），但要 Team self-hosted 或 Enterprise 计划的 license key，且运维栈不小（K8s Helm、Postgres、Redis、OIDC、cert-manager），核心组件仍闭源。适合"要 Intelligence 全部功能且能付费"的路线。

### 备选 B：Mastra server 承担线程 + 流式（Apache-2.0）

对 `remote_mastra` 的 Bot 增量自然；作为全量替代则要把 CopilotKit 原生 Bot 迁到 Mastra Agent 并重接 generative UI/A2UI，仅当团队想整体转向 Mastra 时选它。LangGraph 因服务器 ELv2 闭源 + 语言栈 + 前端重写，不建议作为 Intelligence 替代（其合理位置是 AG-UI 后面的计算引擎，OpenBot 已有 agent-langgraph-agui）。

## 10. 主要来源

一手源码（本地 node_modules，包版本 1.77.0 / 0.5.0 / 1.64.0 / 1.43.0 / @ag-ui 1.0.1）：
- `server/node_modules/@copilotkit/runtime/dist/v2/runtime/core/runtime.d.mts`（CopilotSseRuntime/CopilotIntelligenceRuntime/mode 推断/锁选项归属）
- `server/node_modules/@copilotkit/runtime/dist/v2/runtime/handlers/handle-run.mjs`、`handlers/sse/{run,connect}.mjs`（SSE 分支）
- `server/node_modules/@copilotkit/runtime/dist/v2/runtime/runner/agent-runner.d.mts`、`runner/in-memory.d.mts`（AgentRunner 抽象、LocalThreadEndpointRunner、onConcurrentRun）
- `server/node_modules/@copilotkit/runtime/dist/v2/runtime/core/fetch-handler.mjs`、`handlers/intelligence/threads.mjs`、`handlers/get-runtime-info.mjs`（线程 REST 路由与 /info 协商）
- `node_modules/.bun/@copilotkit+core@1.77.0*/dist/index.mjs`（前端默认 SSE、模式协商、409→AgentThreadLockedError）
- `node_modules/.bun/@copilotkit+license-verifier@0.5.0/dist/index.mjs`（离线 Ed25519、空 token 行为）
- `server/node_modules/@mastra/client-js/dist/index.js`（Mastra Server REST 面）

GitHub/npm/官方文档：
- [CopilotKit/CopilotKit](https://github.com/CopilotKit/CopilotKit)（MIT）、[ag-ui-protocol/ag-ui](https://github.com/ag-ui-protocol/ag-ui)（MIT，README 传输无关表述）
- [Open source vs Intelligence](https://docs.copilotkit.ai/concepts/oss-vs-enterprise)、[Self-host CopilotKit Intelligence](https://docs.copilotkit.ai/intelligence/self-hosting)、[Intelligence 架构](https://docs.copilotkit.ai/intelligence/overview)、[定价](https://www.copilotkit.ai/pricing)
- [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph)（MIT）、[PyPI langgraph-api](https://pypi.org/project/langgraph-api/)（Elastic-2.0）、[LangGraph 本地/自托管 server 文档](https://docs.langchain.com/oss/langgraph/local-server)
- [mastra.ai（Apache 2.0 公告）](https://mastra.ai)、[Mastra CLI/server 参考](https://mastra.ai/en/reference/cli)、npm `@mastra/pg@1.30.0`
- [vercel/ai](https://github.com/vercel/ai)（npm `ai@7.x` Apache-2.0）、[assistant-ui](https://github.com/assistant-ui/assistant-ui)（MIT）、[agno-agi/agno](https://github.com/agno-agi/agno)（Apache-2.0）、[run-llama/llama_index](https://github.com/run-llama/llama_index)（MIT）、[temporalio/temporal](https://github.com/temporalio/temporal)（MIT）、[triggerdotdev/trigger.dev](https://github.com/triggerdotdev/trigger.dev)（Apache-2.0）、[partykit/partykit](https://github.com/partykit/partykit)（MIT）、[liveblocks/liveblocks](https://github.com/liveblocks/liveblocks)（仓库 NOASSERTION，npm SDK Apache-2.0）
