# Mastra 官方能力研究：OpenBot Agent 迁移边界

读取日期：2026-10-19（Asia/Shanghai）。

## 版本与证据范围

- 官方文档页面按当前 `@mastra/core` 文档线阅读；官方 Releases 页面在本次读取时展示 `@mastra/core@1.71.0` 的变更，因此以 1.71.x 作为版本线索，而不是把它当作已锁定的 OpenBot 依赖版本：[Mastra Releases](https://github.com/mastra-ai/mastra/releases)。
- 证据优先使用 `mastra.ai` 官方文档和 `mastra-ai/mastra` 官方仓库；页面内容会随最新版本更新。未在本次研究中核实 OpenBot 当前依赖、Mastra 的确切 npm 解析版本、各存储适配器在目标部署环境中的可用性，以及 OpenBot 现有事件协议与 Mastra chunk 的一一对应关系。

## 已验证能力

### 1. Agent 模型接入与自定义网关

**事实：** Mastra `Agent` 支持 `provider/model` 字符串模型路由（例如 `openai/gpt-5-mini`），并按 provider 查找环境变量；同时官方 MCP/Agent 示例仍展示可传入 AI SDK language model/provider 对象。Mastra 的 Agent API 对 AI SDK v5/v6/v7 做兼容封装。[Get started](https://mastra.ai/docs)、[Using Tools with Agents](https://mastra.ai/docs/agents/mcp-guide)、[AI SDK v7 support](https://mastra.ai/blog/ai-sdk-v7-support)

**事实：** Mastra Gateway 是 OpenAI-compatible HTTP API，可通过替换 `baseURL` 接入任意兼容 OpenAI Chat Completions 的 agent stack；请求模型名使用 `provider/model` 风格，且可通过 `x-thread-id`、`x-resource-id` 传递持久记忆标识。[Gateway quickstart](https://gateway.mastra.ai/docs)、[Gateway overview](https://mastra.ai/ai-gateway)

**迁移含义（推断）：** 如果 OpenBot 已有统一模型网关，优先保留网关边界，并让 Mastra Agent 使用兼容的 language model 或 OpenAI-compatible endpoint；不要仅因使用 Mastra 就把 provider 密钥和路由逻辑散落到每个 Agent。具体 provider 特性（工具调用、结构化输出、reasoning）需按目标 provider 单独验证。

### 2. `stream()`、`textStream`、`fullStream` 与协议转换

**事实：** `Agent.stream()` 返回 Mastra model output；`textStream` 是增量文本，`text`、`steps`、`finishReason`、`usage` 是完成后解析的结果，结构化输出时还有 `objectStream`/`object`。[Streaming guide](https://mastra.ai/docs/guides/streaming)

**事实：** `fullStream` 可通过异步迭代读取所有事件 chunk；官方示例显示 chunk 带 `type`，并可包含 `from` 与 `payload`。工具挂起、工具调用等控制事件因此不应被当成普通文本增量处理。[Streaming guide](https://mastra.ai/docs/guides/streaming)、[Human-in-the-loop](https://mastra.ai/docs/agents/human-in-the-loop)

**事实：** `@mastra/ai-sdk` 提供 `toAISdkStream()`、`toAISdkMessages()`，并支持按 AI SDK 版本转换；官方路由处理器包括 `handleChatStream()`、`handleWorkflowStream()` 和 `handleNetworkStream()`。[Streaming guide](https://mastra.ai/docs/guides/streaming)

**迁移含义（推断）：** OpenBot 的现有 SSE/WebSocket 消费者应先建立 Mastra chunk 到现有事件类型的适配层，至少区分文本、步骤、工具调用、挂起、错误和完成事件；不能只转发 `textStream` 后再期待恢复 HITL 或工具状态。事件字段须以安装版本的 `MastraModelOutput`/stream reference 做契约测试。

### 3. Tools 与 MCP

**事实：** Mastra tool 具有 schema、执行器和可选上下文；Agent 通过 `tools` 注册。`@mastra/mcp` 的 `MCPClient` 可连接 URL 或 stdio MCP server 并列出工具；Mastra 也能用 `MCPServer` 把 tools、agents 和 resources 暴露给 MCP 客户端。[Using Tools with Agents](https://mastra.ai/docs/agents/mcp-guide)、[@mastra/mcp README](https://github.com/mastra-ai/mastra/blob/main/packages/mcp/README.md)

**事实：** `@mastra/connect` 可按 provider 注入平台工具，支持 provider allowlist 和 tool allowlist；部分 provider 的工具运行时来自托管 MCP server。[Connect tools](https://mastra.ai/docs/mastra-platform/connect/tools)

**迁移含义（推断）：** OpenBot 的内部工具可逐个包装为 Mastra tool，外部集成优先评估 MCP；工具授权、凭据注入和租户过滤仍需由 OpenBot 服务端控制，不能把“工具已发现”当成“工具已获准调用”。

### 4. Memory、thread、resourceId 与多租户边界

**事实：** Mastra memory 调用可用 `memory: { resource, thread }`；`resource` 是稳定用户/实体标识，`thread` 隔离会话。每个 thread 有不可变的 owner `resourceId`；复用同一 thread 给不同 owner 会报错。[Memory overview](https://mastra.ai/docs/memory/overview)

**事实：** Mastra 还支持 scopes（如 `org:acme`、`resource:user-123`、`thread:conversation-123`）。`resource`/`thread` 作用域来自服务端可信上下文；文档明确指出客户端不能在请求 body 中直接设置 scopes，且 scope 冲突会抛错。其他 scopes 会传给 tools/processors，但 resource/thread scopes 不会传给嵌套 agent。[Memory overview](https://mastra.ai/docs/memory/overview)

**事实：** 直接调用多个 agent 时，相同 `resourceId`/`threadId` 可共享记忆；supervisor delegation 默认给子 agent 新 thread，并以父 resource 加 agent 名生成稳定 resource ID。[Memory overview](https://mastra.ai/docs/memory/overview)

**迁移建议（推断）：** 将 OpenBot 的租户/用户身份映射到服务端生成的 resource 与 org scope，将会话映射到 thread；禁止客户端任意选择跨租户 resource/thread。若需要跨 agent 共享上下文，应显式定义共享 resource 的边界，并为每个租户建立存储隔离/授权查询策略。Mastra 的 scope 机制是上下文标识，不等同于完整的数据库行级安全策略。

### 5. HITL：Agent 工具挂起/恢复

**事实：** tool 的 `execute` 可以调用 `context.agent.suspend()`，并用 `suspendSchema` 描述返回给用户的挂起信息、`resumeSchema` 描述恢复输入；流会发出 `tool-call-suspended`，可用 `resumeStream()` 恢复。[Human-in-the-loop](https://mastra.ai/docs/agents/human-in-the-loop)

**事实：** 自动恢复需要 memory、同一 resource/thread 标识和 `resumeSchema`；也可以手动通过 `resumeStream()`/审批 API 由 webhook 或按钮触发。[Human-in-the-loop](https://mastra.ai/docs/agents/human-in-the-loop)

**迁移含义（推断）：** OpenBot 若已有审批队列，应把 runId、toolCallId、resourceId、threadId 和 resume payload 作为持久化关联键；不要只依赖一次 HTTP 请求生命周期。

### 6. Workflow suspend/resume、snapshot 与 durability

**事实：** Workflow 在 step 中 `suspend()` 后，Mastra 会暂停执行、捕获完整可序列化 snapshot、写入配置的 storage，并可通过 `resume()` 从暂停点继续；snapshot 包含继续执行所需的上下文和剩余重试次数。[Workflow snapshots](https://mastra.ai/en/reference/workflows/snapshots)

**事实：** 普通 `Agent` 的 `generate()`/`stream()` 适合短生命周期、请求范围调用。官方把 durable agent 定义为将 agentic loop 包装在 workflow 中，使运行状态持久化、支持断线重连和进程重启后的恢复；durable agent 是 beta，且 crash recovery 默认不会自动重试仍为 `running` 的孤儿 run，需要后续 re-drive/recover。[Durable agents](https://mastra.ai/docs/harness/durable-agents)

**边界结论：** Workflow snapshot/suspend-resume 的 durability 是 workflow 执行语义；不能据此声称所有普通 Agent 调用天然 durable。只有使用 durable agent（或显式 workflow/外部执行器）并配置相应 storage/recovery，才具备文档所述的长运行、断线和恢复能力。[Durable agents](https://mastra.ai/docs/harness/durable-agents)

### 7. Storage 与 observability

**事实：** Mastra observability 覆盖 agent run、workflow step、tool call 和 model interaction；可记录 span、日志、token/成本指标和 feedback，并通过 storage exporter 或 OpenTelemetry-compatible exporter 输出。[Observability overview](https://mastra.ai/docs/observability/overview)

**事实：** storage 的 observability domain 决定哪些信号持久化及哪些查询可用；不同后端的 traces、logs、metrics 支持不同，metrics 需要 analytics-capable store。官方建议可用 composite storage 把 observability 路由到独立后端。[Observability overview](https://mastra.ai/docs/observability/overview)、[Metric queries](https://mastra.ai/reference/observability/metrics/queries)

**迁移建议（推断）：** 迁移时把业务状态/会话 memory、workflow snapshots、observability signals 分开评估存储与保留期；不要假设“配置了 storage”就等于所有 metrics/query API 都可用。生产环境还需明确 trace 中 prompt、tool args 和输出的脱敏策略；官方提供 `SensitiveDataFilter` 示例。[Observability overview](https://mastra.ai/docs/observability/overview)

## 精简迁移注意事项

1. 先冻结 OpenBot 的现有流协议和恢复语义，再做 Mastra chunk adapter；`textStream` 与 `fullStream` 的职责不同。
2. 先决定调用级别：短请求用普通 Agent；需要断线重连、跨请求或崩溃恢复时评估 durable agent/workflow，并准备持久化 storage 与 recovery 运维。
3. 将租户身份在服务端映射为 resource/thread/org scope；不要让客户端决定跨租户 scope，也不要把 scope 当作数据库授权替代品。
4. MCP/tools 只解决工具描述与调用接入；凭据、allowlist、审批和租户授权仍需 OpenBot 的服务端策略。
5. 对模型网关保留单一适配边界；Mastra Gateway 是可选的 OpenAI-compatible 路径，不代表自定义 provider 的全部能力已被验证。
6. 为 workflow snapshot、memory、observability 分别设计数据保留、加密/脱敏、隔离与恢复演练；不要把 observability 后端能力默认外推到所有 storage adapter。

## 未核实项

- 未读取 OpenBot 当前 agent、SSE/WebSocket、memory、任务队列、数据库和多租户实现，因此本文没有给出文件级改造清单。
- 未在 OpenBot 的实际依赖锁文件中验证应安装的 Mastra 包及确切版本。
- 未验证 Mastra Gateway 在 OpenBot 目标网络、区域、合规和延迟约束下是否适用。
- 未验证目标 provider 对工具调用、structured output、streaming、reasoning 和错误重试的完整兼容性。
- 官方文档与仓库会随版本变化；实施前应锁定具体 `@mastra/*` 版本，并重新核对对应 tag 的 API reference 与 changelog。
