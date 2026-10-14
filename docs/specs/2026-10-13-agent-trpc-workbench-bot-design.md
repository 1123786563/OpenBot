# agent-trpc 工作台 Bot 接入设计

状态：待批准（2026-10-13）
关联：`docs/enterprise-runtime.md`（企业链路，本设计不动它）

## 背景与目标

`agent-trpc/` 目前只有企业执行面（`cmd/runtime`，三头认证 + 固定专家目录 + 受控工具）。
本设计把它以**工作台 Bot** 形态接入：与 `agent-bot` / `agent-langgraph` 同一份 AG-UI HTTP 合同，
用于验证 trpc-agent-go 作为工作台 Bot 的可行性，并可在工作台 UI 中注册、对话、测试。

## 范围

1. **新入口 `agent-trpc/cmd/bot/main.go`**（企业面零改动）：
   - `POST /ag-ui`：`x-openbot-agent-token` 头鉴权（常量时间比较，对齐 `shared/agent-authorisation.ts`），未带/错 token → 401
   - `GET /health`：JSON `{status, model}`
   - 二进制支持 `-healthcheck <url>` 自检模式（distroless 无 shell，compose healthcheck 用 exec 形式）
2. **Bot 模式装配**（新包 `agent-trpc/internal/bot/`）：
   - 复用 trpc-agent-go `aguiserver`，`WithPath("/ag-ui")`
   - `WithReasoningContentEnabled(false)`、`WithEventSourceMetadataEnabled(false)`（同企业面，不外泄思维链与内部元数据）
   - Bot 模式 resolver（**不复用** `internal/adapter`——它绑死 `identity.FromContext` 企业信封）：
     - user：从 `input.ThreadID` 派生（框架记账 key，无企业身份语义）
     - state：恒空（拒绝合并 client state，语义同企业面）
     - input hook：剥离 `forwardedProps`（run assertion 是部署能力凭证，模型不可读；与 agent-bot 不消费它的姿态一致）
   - 模型：OpenAI 兼容客户端，`OPENAI_BASE_URL`（缺省 OpenAI）+ `OPENAI_API_KEY` + `BOT_MODEL`（缺省读 `shared/model-providers.json` 的 `bots.agent-trpc` 行）
   - 工具：不注册任何自有工具；`input.tools` 由框架原生 external-tools 机制声明给模型，调用以 `TOOL_CALL_*` 事件上抛并结束 run（client-loop，与 agent-bot 相同）
3. **注册**：
   - `shared/model-providers.json` 增加 `"agent-trpc": { "provider": "openai", "model": "gpt-5.5" }`
   - `docker-compose.yml` 增加 `agent-trpc` 服务：build context 为仓库根（需 COPY `shared/model-providers.json`），`127.0.0.1:4204`，env 同其他 Bot（`MANAGED_AGENT_TOKEN`、`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`BOT_MODEL: ${AGENT_TRPC_MODEL:-gpt-5.5}`），healthcheck 走自检模式
   - 工作台侧：UI 注册 `http://localhost:4204/ag-ui`（remote_ag_ui，bring-your-own-agent 一等公民流程）
4. **Dockerfile**：新写 `agent-trpc/Dockerfile.bot`（多阶段，产出 bot 二进制；企业镜像的 `Dockerfile` 保持不动，见设计决定 D3）

## 非目标

- 不改 `cmd/runtime`、`internal/adapter`、`internal/server`、`internal/runtimeconfig`（企业候选及其安全不变量零改动）
- 不做 built_in seeding / `config.ts` 改动（方案二，验证通过后另立）
- 不做部署自有工具签名回调（`OPENBOT_TOOL_URL` / `AGENT_TOOL_TOKEN`）——工具执行留在 client-loop，与 agent-bot 同姿态
- 不暴露 reasoning content / event-source metadata
- 不做取消路由（`/cancel`）；工作台 Bot 的取消即断开 SSE，与 agent-bot 一致

## 设计决定

- **D1 独立入口而非改造 `cmd/runtime`**：企业面配置是"要么全配要么拒绝启动"的严格合同，混入 Bot 模式会稀释它；Bot 合同相反——env 驱动、缺省回退、健康即活。
- **D2 默认模型放 `bots.agent-trpc` 行**：与其他 13 个 Bot 同一事实源；Go 在启动时读该 JSON（镜像内路径 `/spec/model-providers.json`），`BOT_MODEL` env 覆盖。
- **D3 Dockerfile**：企业镜像保持 `Dockerfile` 不动（compose `go-runtime` 引用它）；Bot 镜像新文件 `Dockerfile.bot`，compose `agent-trpc` 服务 build context 指仓库根。
- **D4 token 比较用 `crypto/subtle.ConstantTimeCompare`**：与 TS 侧 `matchesToken` 同抗时序语义。

## 测试与验收

Go 单测（`internal/bot/` + `cmd/bot`）：
1. `/health` 200 且含 model 字段
2. `/ag-ui` 无 token / 错 token → 401
3. fake OpenAI 端点（SSE chunked）驱动：`RUN_STARTED` 首事件、终事件 `RUN_FINISHED`、文本消息事件序列合法
4. `input.tools` 声明透传：fake 端点断言收到的 tools 列表与请求一致
5. `forwardedProps` 不出现在发给模型的消息里

冒烟（`agent-trpc/testdata/` 或脚本）：
6. `go run ./cmd/bot` + fake 模型端点 + curl：完整 SSE 流断言

集成验收（手动）：
7. `docker compose up agent-trpc` → healthcheck 通过
8. 工作台 UI 注册 `http://localhost:4204/ag-ui` → 真实模型对话往返

完成标准：`cd agent-trpc && go test ./...` 全绿；上述 6/7/8 有证据（命令输出/截图）。

## 风险

- trpc-agent-go external tools 的事件细节（TOOL_CALL_ARGS 分片等）以冒烟实测为准，spec 不预设框架内部行为
- llmagent 的 instruction 为空时是否仍把 input 的 system 消息发给模型——由测试 3/5 的 fake 端点断言兜住；若有双 system 问题，修装配而非改框架
