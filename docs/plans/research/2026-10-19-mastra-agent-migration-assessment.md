# OpenBot Agent 执行框架迁移 Mastra：现状与改造清单

日期：2026-10-19。范围：当前 OpenBot 主仓库工作区的静态分析与 Mastra 官方文档核对；不是实施计划或批准的 Spec。未修改生产代码，未运行测试、数据库或线上验证。工作区已有其他未提交改动，结论针对读取时文件内容。

## 结论与建议边界

现有主执行框架是 CopilotKit Runtime 的 BuiltInAgent，加 OpenBot 自有运行治理、AG-UI 事件与多种业务入口。仓库已有 Mastra 会话存储及远程适配，不代表内置 Agent 已迁移。建议首期让 Mastra 接管模型与工具的执行循环，复用 OpenBot 的权限、工具执行、Run/Attempt、模型网关、结算与审计；保留当前聊天 UI 和 AG-UI 事件合同。

本文以“迁移内置 Agent 执行框架”为目标分析。若目标还包括彻底移除 CopilotKit 前端 SDK、替换 Computer/Craft 执行引擎、或迁移 OpenMuse 子模块内的 TanStack Agent，这些应另外定界，不能从主仓库迁移自动推导。

## 已核实的现状

- `server/src/copilot.ts:2136` 的 `builtInAgentConfiguration` 生成 CopilotKit 配置；`:2795` 的 `buildAgent` 构建 `BuiltInAgentWithSaneHistory`，该类继承 BuiltInAgent。其模型、工具、观察、附件和审批包装都需要移植。
- `server/src/enterprise/runs/runner.ts` 是 OpenBot 自有 DurableProductionRunner，仍继承 CopilotKit AgentRunner。`governed-execution.ts` 提供每次运行的受控 LanguageModelV3，接到现有 ModelGateway，而非简单的 provider 客户端。
- `server/src/mastra/tenant-storage.ts`、`contracts.ts`、`conversations.ts` 和企业 ConversationService 已包含 Mastra 存储、可信会话绑定、消息 intent/序列、租户 schema/角色隔离等代码。需复用和验证，不能重复建立第二套会话写入权威。
- `server/src/mastra/compatibility.ts` 有 Agent、AG-UI、workflow suspend/resume、Hono 和存储兼容探针；生产 `server/src` 的 Agent/Workflow 构造集中在该探针，不能将其作为生产切换已完成的证据。
- `agent-mastra/src/mastra/index.ts` 是独立远程 harness。`copilot.ts:2831` 当前对 remote_ag_ui / remote_mastra 返回 `REMOTE_RUN_BUDGET_UNVERIFIED`，已有远程桥接代码不意味着生产可执行。
- `server/src/index.ts:2779` 仍构造 routineIntelligence 和 IntelligenceAgentRunner；多个 headless 入口使用 createTurnRunner。`server/src/config.ts` 的 RuntimeCapabilities 仍要求 Intelligence 配置。
- `app/src/lib/copilot/provider.tsx`、`app/src/components/channels/channel-chat.tsx` 及 bot-tools、gallery-tools、skill-tools 使用 CopilotKit React SDK；AG-UI Message 也是聊天与语音层的共享类型。
- `server/package.json` 声明 @mastra/core 1.64.0、@mastra/memory 1.20.0、@mastra/pg 1.25.0、ai 6.0.264；根包声明 ai 7.0.140，agent-mastra 存在通配版本。以上是 manifest 声明，未验证实际安装解析版本。

## 文件级改造清单

| 领域 | 主要入口 | 所需改造与验收重点 |
| --- | --- | --- |
| Agent 装配与执行 | copilot.ts；agents/agent-resolver.ts；agents/plan-model.ts | 用 Mastra Agent 装配 instructions、模型、动态 tools；保留角色、用户指令、来源说明、不可信内容包装、Computer 指引、工具筛选和 learned skills。验证多步调用、取消、请求间隔离、克隆/实例状态。移除 PlanModel 对 BuiltInAgentClassicConfig 类型的耦合。 |
| 模型与计费 | enterprise/runs/governed-execution.ts；enterprise/models/ai-sdk-v3-gateway-adapter.ts；copilot.ts 的 meteredModel | 复用受控 LanguageModel 边界；逐次模型调用保留 capability、聚合运行预算、输出上限、取消和未知用量处理。显式检查 Mastra 自动重试、fallback、额外模型调用是否同样经过治理。API 积分和订阅 harness 的付款路径继续分别处理。 |
| 工具与连接 | plugins/tools.ts、selection.ts、mcp.ts；computer/headless-tools.ts；host-access/tools.ts | GrantedTool 包装为 Mastra tool，适配 schema、toolCallId、结果和异常。仍经 OpenBot grant、policy、approval、audit 执行；不能将原始 MCP 工具直接挂载后绕过既有执行器。保留运行时权限复核与撤权。 |
| 事件与传输 | enterprise/runs/runner.ts、events.ts；copilot.ts | 建立 Mastra fullStream 到现有 AG-UI BaseEvent 的适配。覆盖文本、reasoning、工具参数增量、结果、activity/state、挂起、错误与结束；建立 OpenBot Run/Attempt 与 Mastra runId 的可信映射。保留持久化后发布、游标重放、精确取消及 lease fencing。 |
| 会话与消息 | mastra/conversations.ts；enterprise/conversations/service.ts；agents/history-sanitize.ts | 接通 Mastra 执行时的历史加载和写入权威；防止 Mastra 自动 memory 与 intent 写入重复保存。保留附件、多模态、tool-call/result、审批 metadata 和稳定顺序，验证翻页、重试、刷新与重连。当前 DTO 含文本投影，不能凭已有存储推断完整消息已贯通。 |
| 审批与问答恢复 | approvals/native-context.ts、question-resume.ts、execute.ts；agents/handoff-tool.ts | 将当前 AG-UI 捕获与 HeadlessToolSuspension 映射到 Mastra 审批/挂起接口或自有 continuation；持久化全部恢复关联键。审批仍绑定身份、范围、工具与参数，恢复时复核权限；挂起不能记为成功，重复恢复不能重复产生外部效果。 |
| 无浏览器执行与委派 | routines/run-turn.ts；index.ts 的 routine/responsibility/delivery/handoff/wake-up/OpenMuse task 装配 | 将 Intelligence runner、socket、history 和锁调用迁到同一受控执行入口。保留调度去重、交接深度、私有分享审批与结果回传；不可只迁聊天入口。Mastra subagent 默认上下文行为须按现有业务委派合同适配。 |
| 记忆与学习 | memory/tools.ts、intelligence.ts；learning/runtime.ts、remote.ts、settings.ts | 将 AG-UI middleware 和 Intelligence 客户端依赖改成执行前上下文加载、受控 tools 或 processors。对话历史可用 Mastra Memory；个人长期记忆遵守 ADR 0005：OpenBot 权威审核/授权，Hindsight 检索，禁止未审核记忆自动跨会话召回。学习产物继续受范围、启用、撤销与来源约束。 |
| 观测和评测 | ai-observability/wiring.ts、run-lifecycle.ts、tool-steps.ts、execution-runner.ts | 将 Mastra hooks/spans 对齐现有 Run、model invocation、tool step，避免双重 trace/计费；保留授权、脱敏和删除约束。离线 generateText 评测入口单独确认是否需要统一执行语义，不能为了移除包而盲目重写。 |
| 配置、部署与版本 | config.ts；index.ts；server/package.json；agent-mastra/package.json；Compose/安装与健康检查 | 去掉生产 boot 对 Intelligence 的硬性要求前，迁完其所有活跃消费者。锁定 Mastra/AI SDK/Zod/AG-UI 组合，验证 Bun 与 Hono 集成、存储 provisioning、连接池和关闭顺序。远程 harness 是额外部署选择，不是本地执行迁移的必需前提。 |

## 推荐执行结构与顺序

目标调用关系：业务入口 → OpenBot 身份/会话/预算准入 → OpenBot Run/Attempt → Mastra 执行适配 → 受控模型网关和工具执行器 → 现有事件日志/AG-UI/界面。

1. 冻结现有行为合同和实例化一个最小 Mastra Agent：受控模型、一个只读工具、完整流适配；验证多步、预算耗尽、取消和未知用量。
2. 接通消息完整 parts、附件、审批挂起/恢复、Computer、handoff、记忆与学习；先使单一交互闭环成立。
3. 将定时任务、职责、投递、委派、唤醒等入口迁到同一执行服务；每个入口复用同一权限、预算、历史和恢复合同。
4. 按明确边界切换会话写入者，处理既有 Intelligence 历史和暂停中的 continuation；切换前排空或转换在途运行，定义可验证的回滚方案。
5. 完成无 Intelligence 的启动/运行验收，再删除旧 runner、配置和部署依赖。若需要移除前端 CopilotKit SDK，作为单独阶段替换 provider/hooks、前端工具、HITL 和重连状态。

长任务可评估 Mastra Workflow/durable agent，但应另立决策：不能让 Mastra 与 OpenBot 同时成为 Run 状态权威。普通 Agent 的 stream 并不自动提供跨进程任务恢复，持久化 checkpoint 也不自动解决外部工具幂等。

## 必须保留的约束与资料缺口

- ADR 0004/0006 与 CONTEXT.md：公司、团队、本人、逻辑 Bot 范围仍由 OpenBot 确定；resource/thread/context 标识不能替代授权和数据库隔离。
- ADR 0005：个人长期记忆的审核与 Hindsight 边界不能随框架替换静默改变。
- `docs/specs/2026-10-16-long-running-task-lifecycle-spec.md` 是评审草案，不能视为已经批准的长任务实现需求。
- `docs/plans/mastra/intelligence/2026-10-13-mastra-orca-continuation.md` 描述的是 Intelligence 迁移，明确保留 OpenBot Agent 执行；本次“执行引擎迁移”比该历史计划范围更大。该计划引用的 `docs/specs/superpowers/2026-10-11-mastra-intelligence-only-design.md` 在本工作区缺失，未核验原批准 Spec。不能从历史计划推断当前所有任务状态。
- 既有数据库隔离、重启和多实例验收是否已经通过，本次没有核验；仅确认相关实现存在。

## 官方依据

Mastra 能力与版本边界见配套 [官方能力研究](2026-10-19-mastra-official-capabilities.md)。当前文档可能新于本仓库声明版本，实施前以锁定版本代码/文档做兼容探针。

- [Agent overview](https://mastra.ai/docs/agents/overview)：Agent 和工具执行循环。
- [Streaming](https://mastra.ai/docs/guides/streaming)：fullStream、结果与协议转换。
- [Human-in-the-loop](https://mastra.ai/docs/agents/human-in-the-loop)：审批、挂起、恢复及 storage snapshot 要求。
- [Memory overview](https://mastra.ai/docs/memory/overview)：会话与 resource/thread 边界。
- [Durable agents](https://mastra.ai/docs/harness/durable-agents)：普通调用与持久执行的差别，beta 和恢复限制。
- [Observability](https://mastra.ai/docs/observability/overview)：事件、span 与存储能力边界。
