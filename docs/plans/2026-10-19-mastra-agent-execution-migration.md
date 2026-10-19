# OpenBot Mastra Agent Execution Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本文仅为计划交付，不授权启动实施。

**Goal:** 将 OpenBot 内置 Bot 的交互与后台执行迁移到 Mastra，保持权限、计费、工具、审批、会话和前端行为，并取消基础运行对 CopilotKit Intelligence 服务的强制依赖。

**Architecture:** OpenBot 是身份、授权、Run/Attempt、预算、工具执行、审批及事件日志的权威；Mastra 是模型与工具循环的执行框架。保留 CopilotKit SSE/React 和 AG-UI 作为现有客户端适配，使用单个 Mastra 执行适配器服务网页和后台入口。会话继续由 OpenBot ConversationService 管理写入与授权，复用现有 Mastra 租户存储；可选学习服务独立装配。

**Tech Stack:** TypeScript、Bun、Hono、Mastra、AI SDK LanguageModelV3、AG-UI、CopilotKit SSE/React、Drizzle/PostgreSQL、tester-army e2e、OpenTelemetry/Opik。

**Spec:** 需求依据是本会话“现有 agent 框架改成 mastra”的迁移分析及“编写详细改造计划”的请求，和 `docs/research/2026-10-19-mastra-agent-migration-assessment.md`。这不是已批准实施 Spec；下述 D01–D08 是本计划的明确建议，实施前由 Task 0 固化为批准范围。相关约束见根 `CONTEXT.md`、ADR 0001–0006、0008、0009 和 `docs/specs/2026-10-15-hindsight-personal-memory-design.md`。长任务草案不作为批准需求。

## Global Constraints

- 当前只写计划，不运行实现、不创建 Issue、不提交、不推送、不修改数据库、不部署。未执行基线测试，不能将本计划当作通过证据。
- 计划工作区：`/Users/wuyongjun/trea/OpenBot`，规划 BASE：`1dc117b65dbb958e73d6c1a0a4a6ee6fa0f48717`，读取分支 `main`；现有 drizzle snapshot 与其他任务未跟踪文件保持原样。
- 本次是串行文档规划，按 `docs/agents/worktrees.md` 在现有工作区保存。实施前使用 using-git-worktrees 核验/建立执行工作区；显式复制并校验本计划、DAG、研究记录及批准 Spec 的哈希。规划 BASE 不自动成为实施 BASE。
- 首次实施先重读 Git 与 Ledger；已有任务按代码和相同哈希的验证证据复用，不重派历史已完成任务。旧计划的状态不能外推到当前版本。
- 默认按 DAG 串行 SDD；backend_implementer 实现后端，frontend_implementer 仅负责必要前端适配；对应 validator 只读验证，独立 reviewer 同时检查 Spec 和质量。
- 无本地提交授权时使用完整未提交检查点：HEAD、staged/unstaged patch、新增/删除文件内容与 SHA256、命令、退出码、报告路径。禁止空 BASE..HEAD 代替实际增量 Review，禁止共享 stash。
- 不绕过 OpenBot ModelGateway、grant/policy/approval/audit，不向客户端暴露 route、capability、provider key 或存储凭据。API 积分与订阅模型分别保持原付款语义。
- 范围标识由可信服务端解析，包含公司、团队、本人及逻辑 Bot；Mastra resource/thread/requestContext 不是访问控制替代品。遵守 ADR 0004/0006 的撤权及范围隔离。
- 个人长期记忆继续遵守 ADR 0005；不启用第二套自动记忆权威，不实现新的 Hindsight 提取/推理产品范围。ADR 0009 已移除 KB，本迁移不恢复 KB。
- ADR 0008：测试入口统一 e2e；native/driven 分区、标题稳定、实际用例数、独立产物目录和环境证据均须对账。禁止将零用例或全部 skip 记为 PASS。
- 数据库测试仅使用执行前核实的独立一次性 fixture；不自动使用开发/生产 DATABASE_URL，不启动或重置共享服务。不具备 fixture 时数据库验收保持 unverified。
- 不自动删除旧数据/表/卷、不迁移 OpenMuse 子模块内部 TanStack Agent、不替换 Craft/Computer 自身执行引擎、不开放现有受限 remote Agent。

## Review Focus

1. 并发两人使用同一逻辑 Bot：角色、凭据、memory、tool grant、附件与学习快照不串用；Task 2/3/4/7 的并发及撤权用例覆盖。
2. Mastra 多步、重试或额外模型调用：没有一次绕过预算/输出封顶，未知用量不释放或假结算；Task 1/5 的调用计数和坏帧用例覆盖。
3. 审批挂起、两次点击、进程重启：批准绑定准确操作，恢复不重复执行，不以 RUN_FINISHED 误判成功；Task 6/8/13 覆盖。
4. 传输断连、lease 过期和跨实例 stop：断连与产品取消分离，失去 owner 的实例不能发布成功或继续外部操作；Task 3/8/9/13 覆盖。
5. 新旧历史、附件和暂停记录在切换时混合：单写入者、可重入导入、无法证明归属的记录隔离，回滚不丢新消息；Task 4/11/13 覆盖。

---

## 1. 范围决定与验收合同

| 决定 | 本计划采用的建议 | 验收要求 |
| --- | --- | --- |
| D01 执行框架 | Mastra 接管内置 Agent 循环；OpenBot 保留运行权威 | 所有本轮入口都经过相同受控执行器，生产不再构建 BuiltInAgent |
| D02 客户端 | 保留 CopilotKit React/SSE 与 AG-UI | 文本、工具、附件、activity、state、审批、停止与重连保持可观察行为 |
| D03 历史 | ConversationService 单写入，Mastra Memory 不自动再存一份 | 任意重试一条输入只生成一个 intent/消息，历史不丢 parts 与调用关联 |
| D04 审批 | OpenBot 审批决定权 + Mastra 受控恢复 | 精确绑定 scope/run/attempt/toolCallId/参数摘要；撤权后拒绝恢复 |
| D05 生命周期 | 第一版使用普通 Agent + 显式暂停恢复；OpenBot lease/事件日志权威 | 不声称任意模型中途崩溃可续算；坏帧、崩溃及未知外部效果进入可诊断状态，不自动重放写操作 |
| D06 学习 | 保留可选 Intelligence 学习适配器及已有功能；执行/历史不再依赖其 runner | 学习未启用无需该服务启动；启用时维持快照校验、撤销与原失败语义，不静默关闭学习 |
| D07 个人记忆 | OpenBot 管审核和授权；使用既有符合 ADR 的召回路径 | 不召回候选；不把只有 Intelligence 的旧记忆自动迁为已确认；Hindsight 后端若未就绪用已确认本地记录 |
| D08 切换 | 先验证，随后在授权维护窗口停准入、排空、迁移、单写切换 | 无新旧双写；在途暂停记录有处理清单；上线/外部配置修改需另行授权 |

完全删除 CopilotKit 所有依赖、替换自动学习服务、Mastra durable agent/workflow 调度、开放 remote_mastra、OpenMuse 内部框架迁移均不在 D01–D08。它们需要独立设计，不能作为本计划默认附加工作。

## 2. 事实来源与当前缺口

- 内置执行：`server/src/copilot.ts` 的 builtInAgentConfiguration / buildAgent / BuiltInAgentWithSaneHistory；实际仍为 CopilotKit BuiltInAgent。
- 治理：`enterprise/runs/runner.ts`、`governed-execution.ts`、`models/ai-sdk-v3-gateway-adapter.ts`。复用，不重建预算台账。
- 存储：`mastra/tenant-storage.ts`、`conversations.ts` 与 `enterprise/conversations/service.ts`。已有实现不等于完整历史及数据库验收已通过。
- 后台：`routines/run-turn.ts`、`index.ts` 的 createTurnRunner 调用及 routineIntelligence 历史读取仍依赖 Intelligence。
- 学习：`learning/runtime.ts` 使用 `@copilotkit/runtime/internal/learned-skills`，快照/归档/撤销能力有实际依赖，不能以 Mastra skills 名称相似推断可替换。
- 仅确认 `CheckpointService/RecoveryService` 声明存在，没有据此认定持久恢复实现可用；Task 6 必须验证实际存储。
- 旧 `docs/plans/2026-10-13-mastra-orca-continuation.md` 引用的 `docs/superpowers/specs/2026-10-11-mastra-intelligence-only-design.md` 在规划读取时缺失。Task 0 登记此缺口；不能静默沿用其“已批准”标签扩大本计划范围。
- 当前 manifest 声明 `@mastra/core=1.64.0`、`@mastra/client-js=1.43.0`、`@mastra/memory=1.20.0`、`@mastra/pg=1.25.0`、`@mastra/hono=1.5.0`、`@ag-ui/mastra=1.1.6`、server `ai=6.0.264`。根目录为另一 AI SDK 主版本。Task 1 核实 lockfile 与实际解析，不直接使用最新文档 API。

官方参考与读取日期见 `docs/research/2026-10-19-mastra-official-capabilities.md`。Agent HITL、流协议和 durable 特性以实际锁定版本探针为准。

## 3. 文件职责与共同接口

新增文件均在 `server/src/mastra/`，避免把整个 copilot.ts 搬成另一个巨型文件：

| 文件 | 职责 | 生产者 |
| --- | --- | --- |
| execution-contracts.ts | 内部输入、可信恢复引用、执行 binding 类型 | T2 |
| instructions.ts / tools.ts / execution.ts | 指令组合、受控工具包装、一次 Agent 执行 | T2 |
| stream-events.ts / ag-ui-agent.ts | pinned Mastra chunk 归一化与 AbstractAgent 兼容 | T3 |
| message-parts.ts / conversation-runtime.ts | 完整消息转换、授权历史加载、幂等写入 | T4 |
| governed-agent.ts | 注入既有受控模型，确保全部调用受治理 | T5 |
| continuation-store.ts / approvals.ts | 持久挂起、准确审批绑定及一次恢复 claim | T6 |
| context.ts | 个人记忆、技能快照与运行前上下文加载 | T7 |
| headless.ts | 后台入口到同一受控 Runner 的适配 | T9 |
| legacy-import.ts / cutover.ts | 受控旧历史导入、写入者切换和回滚门 | T11 |

不新增公开 Agent 协议；内部类型复用现有 BaseEvent、RunAgentInput、PlatformScope、GrantedTool、RunnerRequestLease 和 GovernedModelRequest。

建议的内部 Interface（T2 冻结名称，后续任务不自行改名）：

```ts
interface ExecutionBinding {
  readonly scope: PlatformScope;
  readonly botId: string;
  readonly runId: string;       // OpenBot 身份
  readonly attemptId: string;
  readonly generation: number;
  readonly executionKey: string; // 服务端生成，与 Mastra runId 建立映射
}
interface ResumeRef {
  readonly continuationId: string;
  readonly revision: number;
}
interface ExecutionRequest {
  readonly binding: ExecutionBinding;
  readonly input: RunAgentInput; // history 已由 T4 从服务端重建
  readonly instructions: string;
  readonly tools: readonly GrantedTool[];
  readonly governedModel: GovernedModelRequest;
  readonly resume?: ResumeRef; // 服务端查出的引用，不能直接信任 forwardedProps
  readonly signal: AbortSignal;
}
type ExecuteMastra = (request: ExecutionRequest) => Observable<BaseEvent>;
```

`ExecuteMastra` 是 T2 定义、T3 提供事件适配、T5 完成受控模型验证、T6 增加恢复、T7 增加上下文的同一模块；这些是先后完善同一真实替换点，不另加泛化多框架抽象。每次调用/订阅只创建一个执行实例，多人并发不共享可变 instructions/tools/model/历史。

恢复数据存储采用 OpenBot 控制的 continuation envelope，包含 `schemaVersion=1`、engine、锁定包版本指纹、binding、toolCallId、参数摘要、快照/受保护引用、revision、claim 与终态。不得保存 AbortSignal、函数或明文 provider key；实际 Mastra 恢复载荷按 T1 验证的版本序列化，无法跨进程重建时不得放行 T6。

## 4. 验证命令与证据规范

以下命令均从执行工作区根目录运行，`<task-id>` 在执行 Brief 中替换成实际编号；每轮 RED/GREEN 使用不同输出目录。

```bash
# 原生收集路径：用每个 Task 指定的测试文件替换末尾文件参数
E2E_UNIT_SCOPE=server E2E_UNIT_OUTPUT=.e2e/mastra-T02-green bunx e2e run --config e2e.unit.config.ts server/tests/mastra-execution.test.ts

# Bun 驱动路径：先从清单读取包含目标文件的真实 group.name，再设置 E2E_BUN_ONLY
E2E_UNIT_SCOPE=tests E2E_BUN_ONLY=server/tests E2E_UNIT_OUTPUT=.e2e/mastra-T02-driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts

node scripts/e2e-coverage-audit.mjs
bun run --cwd server typecheck
bun run --cwd app typecheck
git diff --check
```

第二条示例按 server/tests 选择组，可能覆盖多组；窄跑前必须从 `docs/verification/e2e-bun-suites.json` 的 groups[].files 反查准确 name，不能把文件路径直接假设为 group.name。新增测试优先使用 `tests/support/e2e-compat.ts`，只因已证明的 Bun 运行时/加载器原因才进入 driven。分区变更由实际审计生成，不能手改排除掩盖收集失败。

每个 Task 对自己的测试清单执行上述适用路径，记录实际收集文件、用例数、skip 原因和报告 JSON；只有 GREEN 完整且 validator/reviewer 通过后才标 verified。静态检查使用 `bunx biome check` 加本任务明确文件路径，不执行全仓自动格式化。新写代码触发其他文件类型错误时必须定位增量，不将新错误归为基线。

## 5. Task 0：冻结范围、工作区与实施基线

**依赖：** 无；状态 ready（仅指可准备，当前未执行）。**角色：** 主控；架构冲突交 architect；审核 reviewer。

**Files:** Create `docs/specs/2026-10-19-mastra-agent-execution-migration-design.md`；实施时在本计划同名目录下写 `ledger.md`、`acceptance.md`、`entrypoints.md`、`baseline.json`。保护所有业务源文件。

**Consumes:** 本计划 D01–D08、研究记录、根 CONTEXT 与适用 ADR、当前 Git。**Produces:** 明确标记状态的 Spec、实际执行 BASE/工作区、验收映射、入口清单、提交策略及基线报告。

- [ ] 逐项检查 D01–D08 与用户期望；将本计划建议转成明确的设计决定。只有实际获得范围批准才写 approved；否则保持 draft，不派发实现。
- [ ] 核对现有适合的执行工作区与 Ledger；使用 using-git-worktrees、遵守 docs/agents/worktrees.md，不搬走原工作区无关脏改动。显式复制本次未提交文档并核对 SHA256。
- [ ] 保存 Git HEAD、tracked diff、任务涉及的 untracked 内容与哈希；列出缺失旧 Spec 和已有不确定验证，记录不受影响范围。
- [ ] 重扫入口：网页/群聊、语音、routines、responsibilities、delivery、handoff/reaper、approval continuation、wake-up、主仓库 OpenMuse task 装配，以及 history/summary/附件授权读取。每个入口注明身份、scope、预算来源、锁、历史和回调位置。
- [ ] 按 ADR 0008 运行最小现有 copilot、runner-production、mastra-compatibility、routine-run-turn 和 approvals-native 基线；把可重复产品失败与有连接证据的环境阻塞分开记录。
- [ ] Freeze：记录基线检查点。既有审批状态、完整消息、学习合同若与计划冲突，修改设计及对应任务后再继续，不默认删除功能。

**验收/失败处理：** 执行者能从文档恢复范围、BASE 和入口；任何未解决的实质需求冲突停在该受影响任务之前。只编写本计划不要求现在实施 Task 0。

## 6. Task 1：锁定可用 Mastra 版本与恢复能力

**依赖：** T0。**角色：** backend_implementer / backend_validator / reviewer。

**Files:** Modify `server/src/mastra/compatibility.ts`、`server/tests/enterprise/mastra-compatibility.test.ts`；必要时只修改 `server/package.json` 与根 `bun.lock`，不升级前端或根 AI SDK 主版本。Create `server/tests/mastra-agent-resume-process.test.ts`。

**Consumes:** 实际解析依赖、LanguageModelV3、既有兼容探针。**Produces:** `probeMastraCompatibility()` 扩展报告 `toolLoop`、`agentSuspendResume`、`fullStreamShapes`、`languageModelVersion` 与精确包版本指纹，供 T2–T6 使用。

- [ ] RED：增加 `tool_loop_has_one_call_and_final_answer`、`custom_v3_model_is_used_for_every_step`、`agent_resume_in_fresh_process`，断言工具只执行一次、暂停后无完成、另一进程恢复得到答案。
- [ ] 运行新测试，保留真实失败原因；不能用同一进程 InMemoryStore 的 Workflow 测试代替 Agent 持久恢复。
- [ ] 首先验证 manifest 现有固定版本组；以 fake provider 和独立 fixture 采集完整 chunk，覆盖文本、工具参数增量、工具结果、错误和暂停；禁用 SDK retry/fallback/后台标题及自动记忆模型调用。
- [ ] 若锁定组不支持必要能力，停止 T2–T6，提交带官方 tag/API 证据和通过同一探针的最小精确版本变更修订；不把最新文档直接写成已安装 API。恢复测试无 fixture 时保持 unverified。
- [ ] GREEN：报告真实包解析、Node/Bun 与 Zod/AI SDK peer 关系；冻结脱敏 chunk fixtures 和恢复证据，独立 Review 后放行。

**验收/失败处理：** 能用实际锁定版本完成受控多步和跨进程审批恢复；缺一项不能以普通对话探针 PASS 代替。

## 7. Task 2：实现最小受控工具执行闭环

**依赖：** T1。**角色：** backend_implementer / backend_validator / reviewer。

**Files:** Create `server/src/mastra/execution-contracts.ts`、`instructions.ts`、`tools.ts`、`execution.ts`；Create `server/tests/mastra-execution.test.ts`、`mastra-tools.test.ts`。现有 `plugins/tools.ts` 与 `selection.ts` 先作只读复用。

**Consumes:** 上述 ExecutionRequest、现有 GrantedTool、T1 锁定 Agent/tool API。**Produces:** `buildInstructions(parts: readonly string[]): string`、`createMastraTools(tools: readonly GrantedTool[]): Record<string, Tool>`（Tool 从锁定 Mastra 版本导入）；内部 Agent stream 由 T3 转成 ExecuteMastra。

- [ ] RED：`granted_tool_executes_once` 断言所选工具收到原参数且只有一次 execute；`ungranted_tool_is_absent`；`two_bindings_do_not_share_tools_or_prompt`；`vendor_error_remains_untrusted`。
- [ ] 运行新套件，预期新模块缺失/行为未实现；保存 RED。
- [ ] 实现一次执行实例的构建：组合现有角色、standing instructions、PROVENANCE_GUIDANCE、UNTRUSTED_GUIDANCE、工具/Computer/学习指引；不让客户端 context 覆盖可信角色。
- [ ] 将 GrantedTool 的 schema/execute 包装成 Mastra tool，保留 initiator 与 call ID；执行继续进入原 grant/policy/audit 路径。不挂载未经授权的原始 MCPClient tools，不改 vendor error/拒绝标记。
- [ ] 初始保留现有工具循环上限 8；超过上限必须有真实 finish reason，不能伪造完整成功答案。运行取消在模型和工具开始前检查 AbortSignal。
- [ ] GREEN + self-review + freeze；选工具失败时保持现有 fallback/审计语义，不能扩大授权。

**验收/失败处理：** 一个 fake model + 一个真实包装的只读工具能闭环；并发隔离及错误包装通过。T3 前不得接生产 Runner。

## 8. Task 3：Mastra 流到现有 AG-UI 的完整适配

**依赖：** T2。**角色：** backend_implementer / backend_validator / reviewer。

**Files:** Create `server/src/mastra/stream-events.ts`、`ag-ui-agent.ts`；Modify `execution.ts`；Create `server/tests/mastra-stream-events.test.ts`、`mastra-ag-ui-agent.test.ts`。

**Consumes:** T1 chunk fixtures、T2 execution、BaseEvent/RunAgentInput。**Produces:** `ExecuteMastra`、`createMastraAgUiAgent(execute: ExecuteMastra, binding: ExecutionBinding): AbstractAgent`。adapter clone 保留同一依赖但不复制活跃 subscription。

- [ ] RED：`text_chunks_normalize_to_content`、`split_tool_args_preserve_call_id`、`suspension_has_no_success_terminal`、`error_never_becomes_success`、`clone_keeps_binding_and_abort`、`unknown_control_chunk_rejects`。
- [ ] 运行，预期 adapter 未实现；保存 RED。
- [ ] 实现 RUN_STARTED、TEXT_MESSAGE_START/CONTENT/END、TOOL_CALL_START/ARGS/END/RESULT、必要 state/activity snapshot 和项目自定义 waiting 事件映射；保留稳定 message/call ID 及原 JSON 参数。
- [ ] 区分 Mastra engine 完成、OpenBot 产品完成和传输结束。流自然结束缺终态视为失败；未知可能改变控制流的 chunk 拒绝，不静默丢弃；非控制诊断 chunk 列入允许表。
- [ ] 处理 unsubscribe/AbortSignal 和 clone；传输 adapter 不直接 cancel 业务 Run。客户端工具调用交给已有 frontend-tool 机制，不能在服务端伪造执行结果；后续 T6/T8 完成恢复。
- [ ] GREEN：重放 T1 fixtures 和乱序/重复/损坏 chunk；冻结各事件转换表、RxJS teardown 行为与实际用例数。

**验收/失败处理：** 所有现有 UI 必需事件有确定映射；不只转发 textStream。未知控制语义阻塞接线而非丢掉事件。

## 9. Task 4：完整消息、附件与单写会话存储

**依赖：** T3。**角色：** backend_implementer / backend_validator / reviewer。

**Files:** Create `server/src/mastra/message-parts.ts`、`conversation-runtime.ts`；Modify `server/src/mastra/conversations.ts`、`enterprise/conversations/service.ts`、`mastra-intent-reconciler.ts`；必要时扩展 `enterprise/contracts.ts` 的内部消息接口，保留公开 MessageDTO 兼容。Create `server/tests/mastra-message-parts.test.ts`、`enterprise/mastra-conversation-runtime.integration.test.ts`。

**Consumes:** ConversationService.resolveMastraBinding、TenantMastraStorage、既有 intents/seq、附件 loader。**Produces:** `loadExecutionInput(scope: PlatformScope, input: RunAgentInput): Promise<RunAgentInput>`；`persistExecutionMessages(binding: ExecutionBinding, messages: readonly Message[]): Promise<void>`，Message 为 AG-UI 类型；记录引擎消息 ID 到稳定 OpenBot 消息身份。

- [ ] RED：`tool_pairs_roundtrip`、`attachment_scope_checked_before_bytes`、`same_input_key_one_intent`、`retry_assistant_output_does_not_duplicate`、`candidate_seq_not_visible_until_finalized`、`other_resource_cannot_read_thread`。
- [ ] 运行原生/驱动适用路径；DB case 必须在一次性 fixture，缺少时登记阻塞而非 pass。
- [ ] 用完整 parts 加 metadata 保存文本、图片/文件引用、tool-call/result、activity 和审批关联；读取投影与模型上下文转换分开，不把现有 text-only DTO 当完整历史。
- [ ] 复用现有消息 intent/锁/恢复机制；关闭 Mastra 对同一会话的自动 append，以 ConversationService 为单写入路径。若 Agent 恢复强制要求 SDK storage，使用受控 snapshot 存储，不复制自动聊天写入。
- [ ] 保留 sanitizeSeededHistory 和 inlineAttachments 的实际行为；历史来自服务端，不接受客户端伪造旧 system/tool result。存储失效时停止本轮，不把空历史当作新会话执行。
- [ ] GREEN：分页、重试、pending intent 修复、同线程并发和跨租户数据库角色隔离通过；冻结数据库与完整消息证据。

**验收/失败处理：** 重读能恢复完整对话关系，输入/输出幂等，附件授权不弱化。分布式写入没有原子性时使用持久 intent/reconcile，不宣称跨系统事务。

## 10. Task 5：将所有 Mastra 模型步骤接入既有预算与结算

**依赖：** T4。**角色：** backend_implementer / backend_validator / reviewer。

**Files:** Create `server/src/mastra/governed-agent.ts`；Modify `execution.ts`、`server/src/agents/plan-model.ts`；仅在兼容需要时修改 `enterprise/runs/governed-execution.ts` 和 `enterprise/models/ai-sdk-v3-gateway-adapter.ts`。Create `server/tests/mastra-governed-execution.test.ts`；复用 `enterprise/ai-sdk-v3-gateway-adapter.test.ts`。

**Consumes:** GovernedModelRequest、T2/T3 执行器、现有每调用 capability 与结算。**Produces:** `executeGovernedMastra: ExecuteMastra`；PlanModel 类型直接依赖已验证的 AI SDK v3 model contract，不再依赖 BuiltInAgentClassicConfig。

- [ ] RED：`two_steps_issue_distinct_capabilities`；总预算 100、首步实际消耗 70 后次步 capability 至多 30；`budget_402_no_retry`；`malformed_usage_no_clean_finish`；`client_route_override_inert`；`subscription_never_falls_back_from_credit_refusal`。
- [ ] 运行 RED，保存真实 provider/network/capability 计数。
- [ ] 只注入服务端 governedModel；明确设置 maxRetries=0 和输出上限，不启用 Mastra provider 默认直连、fallback、自动摘要/标题/embedding。额外模型功能要另获预算，首版关闭这些隐式调用。
- [ ] 复用 existing adapter 的剩余预算计算、confirmUsage/markUnknown、取消传播与 route rebind，保留入场时锁定的付款方式。不能用 Mastra 最终 usage 覆盖 gateway 权威结算。
- [ ] 订阅 harness 用原 PlanModel 合同做单独兼容测试，维持 subscription 标记；方案若无法证明订阅路径安全，不默认为 API key 路径，登记该入口阻塞。
- [ ] GREEN：新套件 + 既有 adapter、route、output-ceiling、copilot-usage-meter/workbench-gateway-routing；冻结每步调用与失败路径证据。

**验收/失败处理：** 全部模型调用受控，未知用量不能产生产品成功；不删除既有受控模型实现来迁就框架默认行为。

## 11. Task 6：持久审批、前端工具与准确恢复

**依赖：** T5。**角色：** backend_implementer / backend_validator / reviewer。

**Files:** Create `mastra/continuation-store.ts`、`mastra/approvals.ts`、`server/src/db/schema/mastra-execution-continuations.ts`；Modify `mastra/execution.ts`、`approvals/native-context.ts`、`approvals/question-resume.ts`、`approvals/execute.ts`、schema 导出。Create `server/tests/mastra-approvals.test.ts`、`enterprise/mastra-continuations.integration.test.ts`。Drizzle SQL/journal 用实际生成的下一个编号，生成文件名记录在 Brief，不预占当前多人修改的编号。

**Consumes:** T1 可跨进程恢复 API、T3 waiting 事件、既有 ApprovalService/政策、ExecutionBinding/ResumeRef。**Produces:** `saveContinuation(binding, payload): Promise<ResumeRef>`、`claimContinuation(scope, ref, decision): Promise<ClaimedContinuation>`、`finishContinuation(claim, outcome): Promise<void>`；payload/decision/claim 类型定义在 execution-contracts.ts，JSON schema v1 校验，claim 为服务端不可伪造对象。

- [ ] RED：`approval_matches_exact_tool_and_args`、`two_resumers_only_one_claim`、`revoked_source_blocks_resume`、`new_process_can_resume`、`frontend_tool_waits_without_fake_result`、`unknown_external_effect_is_not_replayed`。
- [ ] 测 RED；确认当前只有 Checkpoint 类型声明时明确失败，不用内存 Map 伪造 durable。
- [ ] 新表按 tenant/workspace/principal/bot/run/attempt/generation 绑定，保存引擎版本指纹与保护后的恢复内容；RLS、非特权 runtime role、CAS revision 和并发 claim 必须数据库实测。引擎 snapshot 若在 Mastra storage，用受限租户存储并保存可信引用。
- [ ] 将 OpenBot 已批准决定转换为 pinned Mastra resume 输入；每次恢复重核 membership/ACL、工具授权、参数摘要和 attempt owner。审批与引擎跨存储写入采用 intent/reconcile，不把两个写操作当一事务。
- [ ] 拒绝、过期、撤权保持现有产品语义；已执行 receipt 不再次调用外部工具，未知状态停待处置。保存快照失败前不发布可恢复 waiting；挂起绝不调用 Run.complete。
- [ ] GREEN：新恢复套件 + approvals-native、headless-tools、approval/question/handoff 既有测试；演练进程退出和两个实例同时恢复，冻结 Review Package。

**验收/失败处理：** 可持久恢复，重复点击不重复执行，无法证明归属/版本兼容的旧记录隔离并给出原因。不自动升级/恢复未知格式快照。

## 12. Task 7：保留个人记忆与学习功能的上下文装配

**依赖：** T6。**角色：** backend_implementer / backend_validator / reviewer。

**Files:** Create `mastra/context.ts`、`learning/provider.ts`、`learning/intelligence-provider.ts`；Modify `memory/tools.ts`、`learning/runtime.ts`、`mastra/execution.ts`。必要时修改 `memory/ingestion.ts` 关闭旧 Intelligence 写入/召回，保持 ADR 0005 约定。Create `server/tests/mastra-context.test.ts`、`learning-provider.test.ts`；复用 learning-runtime/learning-settings 测试。

**Consumes:** LoadPersonalMemory、AcquireLearnedSkills、现有已审核本地记忆与学习 archive verifier。**Produces:** `prepareExecutionContext(binding: ExecutionBinding, signal: AbortSignal): Promise<{instructions: readonly string[]; tools: readonly GrantedTool[]}>`；`LearningProvider` 只包含现有 acquire/inspect 行为，不新增自动学习算法。

- [ ] RED：`unreviewed_memory_never_enters_prompt`、`source_revocation_blocks_recall`、`two_users_no_context_leak`、`one_learning_snapshot_per_outer_invocation`、`resume_uses_bound_snapshot_with_current_revocation_check`、`learning_disabled_does_not_construct_intelligence_client`。
- [ ] 运行 RED，记录现有记忆/学习合同的失败与已存在功能。
- [ ] 将现有 Middleware 需要的上下文在执行前加载，记忆工具仍调用 OpenBot store/ingestion；Hindsight 不可用时只使用当前有权访问的已确认本地记录，不能新增未审核回退。
- [ ] 将 archive 校验、快照刷新、撤销和缓存策略封装到可选 IntelligenceLearningProvider；仍复用当前锁定 learned-skills 实现，不能用一个空 skills 列表代替服务故障。
- [ ] 保留技能工具名、catalog、加载/读文件、启用/禁用和 Inspector 行为。保留既有失败策略并暴露 delivery status；恢复用原内容快照且重新检查撤销，不把一个审批恢复变成全新技能选择。
- [ ] GREEN：记忆、学习及新上下文套件，证明未启用学习时基础执行不访问 Intelligence；冻结跨范围和撤权证据。

**验收/失败处理：** 不丢已有学习能力，不引入未批准的 Mastra 自动长期记忆。若既有记忆实现与 ADR 冲突，修正受影响召回合同并独立审查，不以迁移名义扩大 Hindsight 功能。

## 13. Task 8：接通网页与同一 OpenBot Runner

**依赖：** T7。**角色：** backend_implementer / backend_validator / reviewer。

**Files:** Modify `copilot.ts`、`agents/agent-resolver.ts`、`enterprise/runs/runner.ts`、`index.ts`；Create `server/tests/mastra-browser-runner.test.ts`；Modify `server/tests/enterprise/runner-production.test.ts` 及必要 copilot 行为断言。

**Consumes:** ExecuteMastra、T4 历史、T6 continuation、原 Runner admission/lease/events/settlement。**Produces:** 原 ActorAgentResolver 对内置 Bot 返回 MastraAgUiAgent；CopilotSseRuntime 对外协议保持兼容。执行引擎选择只能服务端配置，不能由客户端 forwardedProps 指定。

- [ ] RED：`authorized_browser_run_uses_mastra`、`forged_run_and_model_ignored`、`event_append_failure_prevents_success`、`suspended_run_not_completed`、`stale_attempt_cannot_complete`、`disconnect_does_not_product_cancel`。
- [ ] 通过真实挂载 Hono/Copilot SSE handler 运行 RED，不只测试 mock resolver。
- [ ] 将 buildAgent 的内置路径替换为新适配器；保留 roster/definitionFacts、选工具、handoff 和附件授权。旧 BuiltInAgent 暂留为未启用代码，等 T14 最后删除。
- [ ] Runner 在准入并获 lease 后注入唯一 binding/受控 model；按现有 persist-before-publish 写入事件，要求结算干净且输出持久化成功后才 complete。挂起进入 waiting/suspended，保持既有 stop/resume fencing。
- [ ] 分离网络订阅与运行 owner；断连按原产品合同保留可重连的执行或明确可恢复检查点，不能既宣称继续运行又在 teardown 无条件中止它。需要的内部 detach/reattach 在本任务实现并测量。
- [ ] GREEN：网页运行、租约、事件、scope、copilot、附件与审批回归；DB 双实例用例未通过前不切生产。

**验收/失败处理：** 网页入口完整闭环且仍受同一 RunService 治理；remote source 继续原有 fail-closed，不借本任务开放。

## 14. Task 9：统一定时、职责和投递的后台执行

**依赖：** T8。**角色：** backend_implementer / backend_validator / reviewer。

**Files:** Create `mastra/headless.ts`；Modify `routines/run-turn.ts`、`routines/runner.ts`、`index.ts` 中 routine/responsibility/delivery/wake-up/OpenMuse task 装配；只在调用签名需要时改相应 runner。Create `server/tests/mastra-headless.test.ts`；复用 routine-run-turn/routine-runner/openmuse-task-runner/workshop-headless 套件。

**Consumes:** 同一受控 Runner 与服务端可信任务身份。**Produces:** `createGovernedTurnRunner(deps)` 满足现有 createTurnRunner 返回的可观察合同；后台 scope 通过可信目录/业务归属重建，不能从 ownerUserId 猜默认公司团队。

- [ ] RED：`schedule_runs_without_intelligence_socket`、`revoked_owner_refused_before_model`、`duplicate_firing_one_run`、`headless_has_explicit_budget`、`saved_conversation_matches_browser_history`、`lost_lease_stops_new_tool_calls`。
- [ ] 运行 RED，保存现有各任务的结果/错误合同。
- [ ] 逐入口替换 IntelligenceLike/RunnerLike、thread lock、历史读取和原 createTurnRunner 装配；复用 OpenBot request lease、heartbeat 和持久事件。新增后台准入只接服务端预算策略，不假造 HTTP 请求/session 或管理员身份。
- [ ] 每个计划触发/职责/投递的预算由已有锁定配置或显式 Task 合同提供；缺少预算拒绝并显示配置原因，不能填无限或隐式默认值以跑通。
- [ ] 对齐 headless Computer/gallery/frontend-only tools：可服务端执行的走受控执行器，需要人参与的持久挂起；不因没有浏览器跳过审批或返回假结果。
- [ ] GREEN：对入口清单逐条勾选，证明所有本任务消费者不再调用 Intelligence runner/socket/history；验证调度重复、取消和重启后状态，不声称任意中途 LLM 可续算。

**验收/失败处理：** 所有本任务后台入口与网页使用同一引擎和历史；无法证明 scope/预算的历史任务隔离，不转换成全局运行。

## 15. Task 10：迁移 Bot 交接、审批续跑与历史旁路读取

**依赖：** T9。**角色：** backend_implementer / backend_validator / reviewer。

**Files:** Modify `agents/handoff-runner.ts`、`handoff-delivery.ts`、`handoff-tool.ts`、`index.ts` 的 handoff/reaper、approvalContinuationRunner、summary/history 读取装配；必要时改 `channels/thread-status.ts`、`summary.ts`、`attachments.ts` 的后端访问器。Create `server/tests/mastra-handoff.test.ts`；复用 handoff 系列、approvals-native、channel 附件与历史测试。

**Consumes:** T6 恢复、T9 headless、actor-authorized roster 与现有交接签名/深度。**Produces:** 原交接/私有分享合同由同一执行器实现；entrypoints.md 中所有旁路消费者有明确归属。

- [ ] RED：`handoff_target_reauthorized`、`private_share_waits_for_exact_approval`、`depth_limit_preserved`、`reaper_does_not_duplicate_reply`、`approval_continuation_uses_mastra`、`history_reader_observes_finalized_parts`。
- [ ] 运行 RED，记录当前 handoff channel/thread 关系；不把 Mastra 默认子 Agent resource/thread 规则当业务授权。
- [ ] 将交接执行与重试接到同一受控 turn；保留每个目标的身份和 scope，禁止复制父 Agent 全部 tools/用户记忆给子 Agent。
- [ ] 将审批续跑、机器人返回结果读取、摘要/搜索/语音历史使用同一授权 repository；保留稳定 thread/channel mapping 标识，不能仅因表名含 intelligence 删除仍在使用的映射数据。
- [ ] 重扫 `routineIntelligence`、`IntelligenceAgentRunner`、`ɵacquireThreadLock`、`getThreadMessages`，每个残留只能属于批准的只读导入或可选学习；生产旁路归零。
- [ ] GREEN：交接 end-to-end、审批和频道旁路回归，冻结完整入口表与拒绝案例。

**验收/失败处理：** 无遗漏的活跃旧执行路径，跨 Bot 分享与深度限制保持；失败回传不伪装成目标已完成。

## 16. Task 11：旧会话、在途审批与安全切换回滚

**依赖：** T10。**角色：** backend_implementer / backend_validator / reviewer。

**Files:** Create `mastra/legacy-import.ts`、`mastra/cutover.ts`、`server/scripts/mastra-agent-cutover.ts`；Modify `enterprise/conversations/service.ts` 中受控 backend 转换；Create `server/tests/mastra-cutover.test.ts`、`enterprise/mastra-import.integration.test.ts`。新增状态表如确需使用，只限本任务 ledger/cursor/映射，先更新 Brief 与迁移所有权。

**Consumes:** 旧服务只读历史、已证明 tenant/principal/channel binding、T4 完整转换与 T6 envelope。**Produces:** CLI 固定命令 `inspect` / `dry-run` / `apply` / `verify` / `rollback`；每条生成脱敏 manifest、源游标、数量/摘要、跳过原因和写入者状态；无默认写操作。

- [ ] RED：`dry_run_writes_nothing`、`rerun_import_is_idempotent`、`ambiguous_owner_is_quarantined`、`tool_and_attachment_links_survive`、`switch_rejects_live_writer`、`rollback_preserves_new_history`。
- [ ] 运行 RED，独立 fixture 注入导入中断、重复页和分页边界。
- [ ] 实现只读盘点/全量分页与稳定源 ID，导入受控 staging，逐消息摘要与调用引用校验；禁止把未审核或仅存 Intelligence 的记忆混入聊天/长期记忆迁移。
- [ ] 在途记录分类：已终结只读；可证明兼容的暂停转换 envelope 后演练；无法转换的旧暂停由旧恢复路径排空，或显示明确受控失败供本人重新发起，不能自动重放外部写操作。存在未处置项不放行其切换范围。
- [ ] apply 要求停止该范围新准入、确认无旧 writer/租约、验证导入再原子切 backend/engine 版本。迁移期间不维持两个可写权威；旧记录保留只读，不 drop 表。
- [ ] rollback 先停新准入并排空；有 Mastra 新消息/快照时保留 Mastra 历史权威并回退兼容应用版本，不直接把 backend 指回旧库。需要旧 engine 恢复时必须有转换证明，否则停在维护状态，禁止丢弃新数据。
- [ ] GREEN：中断恢复、分页、权限、在途清单和双写拒绝全部有证据；脚本本次只交付并 dry-run，不执行生产 apply。

**验收/失败处理：** 脚本可审查、可重入、默认只读，回滚边界真实；无法转换的状态有显式处置和阻断，不假称无损回滚。

## 17. Task 12：客户端兼容与可诊断状态

**依赖：** T11。**角色：** frontend_implementer / frontend_validator / reviewer。

**Files:** 按实测需要 Modify `app/src/components/channels/channel-chat.tsx`、`app/src/lib/copilot/approval-tools.tsx`、`handoff-resume.ts`、`thread-messages.ts`、`stopped-turn.ts`；Create `app/tests/mastra-runtime-compat.test.tsx`。后端协议已满足时只补真实行为验证，不无故修改 UI。

**Consumes:** 现有 AG-UI、T3 waiting/终态、T6 恢复引用和 T11 迁移状态。**Produces:** 当前聊天客户端对 Mastra 的兼容行为，保留 provider/hooks 与组件设计。

- [ ] RED：`partial_text_and_tool_result_render_once`、`refresh_waiting_approval_can_resume`、`stop_targets_current_run`、`reconnect_does_not_duplicate_answer`、`incompatible_legacy_pause_has_clear_next_action`。
- [ ] 运行 native/driven 对应 App 测试，区分 UI 已兼容与需要改动的具体行为；不为了 RED 修改正确的 UI。
- [ ] 仅修实际缺口，移除对 Intelligence 特有状态的假设；继续使用服务端授权/幂等键，不在浏览器持有模型凭据或构造可信 scope。
- [ ] 真实浏览器验证文本/工具/附件/审批/拒绝/停止/断线重连/刷新恢复；确认键盘操作和状态反馈可访问，语音 archive 与聊天一致。
- [ ] GREEN：新套件 + channel-chat、approval-tools、thread-messages、channel-history-refresh、voice-transcript；保存截图/浏览器日志并冻结。

**验收/失败处理：** 原 UI 功能保留，用户能识别等待、失败与已停止；没有必需变更则记录验证通过的原实现，不制造无效重构。

## 18. Task 13：无 Intelligence 基础运行、观测与跨实例验收

**依赖：** T12。**角色：** backend_implementer / backend_validator；UI 证据复用 T12；reviewer。

**Files:** Modify `config.ts`、`index.ts`、`ai-observability/wiring.ts`、`run-lifecycle.ts`、`tool-steps.ts`；需要时修改 `scripts/self-hosted-learning.ts` 的可选服务说明；Create `server/tests/mastra-runtime-config.test.ts`、`mastra-observability.test.ts`、`enterprise/mastra-runtime.integration.test.ts`。实际部署配置仅改 T0 清单中有执行装配的文件，先在 Brief 列出精确路径；不假设存在 intelligence compose 文件。

**Consumes:** T8–T12 已审查实现；D06 可选学习配置。**Produces:** 基础运行只要求 OpenBot 自有已验证 capabilities 与模型/存储配置；学习配置独立解析；观测事件具备统一 run/model/tool 身份。

- [ ] RED：`boot_without_intelligence_when_learning_disabled`、`configured_learning_unavailable_is_visible`、`one_model_span_and_one_settlement`、`two_instances_fence_old_owner`、`cross_tenant_snapshot_denied`、`restart_preserves_waiting_state`。
- [ ] 运行 RED；基础启动使用隔离进程与测试依赖，不启动真实监听的开发实例占用既有端口。
- [ ] 将 RuntimeCapabilities 从强制 intelligence 模式改为经过 boot verification 的 OpenBot/Mastra 能力；缺目录/数据/模型能力明确启动失败，不能回退到宽松内存 runner。可选学习/旧导入 reader 不在模块 import 时创建客户端。
- [ ] 将 Mastra model/tool/run 事件接入现有观测 observer，避免双重记录与成本累加；日志不记录 capability、provider key、未授权 prompt/工具内容。旧内容保留/删除政策继续生效。
- [ ] 独立 fixture 双实例：A 运行、B stop/恢复；强制 lease 过期；审批后重启；数据库/RLS 跨公司/团队/用户拒绝；模型坏帧、事件写失败、存储失效。对每个场景核对 Run、消息、工具 receipt 和用量事实。
- [ ] GREEN：新/既有 runner、model、approval、scope、observability 集成通过；验证实际 token/费用记录相符，无任何 skipped 必需验收。缺环境则本任务不 verified。

**验收/失败处理：** 无 Intelligence 服务能完成基础交互和后台执行；保留已启用学习能力的诚实状态；有真实跨实例与重启证据。

## 19. Task 14：移除旧内置执行路径、独立审查和交付

**依赖：** T13。**角色：** backend_implementer 清理；backend_validator 验证；主控统一独立 reviewer 与 OCR。不由实现者批准自己。

**Files:** Modify `copilot.ts`、必要 `agents/plan-model.ts`、server 依赖与配置说明、`docs/enterprise-runtime.md`；Create `docs/verification/2026-10-19-mastra-agent-migration.md`。不删除 React/SSE 必需的 @copilotkit 包、可选学习适配器、历史映射表和远程 harness。

**Consumes:** T0 入口清单与所有 frozen checkpoints。**Produces:** 完整交付 diff、验证摘要、有效问题零阻塞的独立/OCR 报告、可审核维护窗口手册。

- [ ] 先验证没有 production callsite 依赖旧 BuiltInAgent，再删除其配置、SaneHistory 子类与旧模型包装的不可达部分；保留共用网关/observer，不能按类名成片删除仍需能力。
- [ ] `rg` 审计 BuiltInAgent、IntelligenceAgentRunner、routineIntelligence、ɵ thread lock、CopilotKitIntelligence 和直接模型调用；将每个残留归入可选学习、只读导入、保留客户端或批准独立用途，记录真实路径和理由。静态零匹配不能代替行为验证。
- [ ] 运行受影响后端与前端回归、类型检查、scoped Biome、构建、coverage audit、diff 检查；复用相同哈希有效证据，只补缺项。最终发布前运行仓库要求的 test:ci，记录失败/环境证据，不隐去基线失败。
- [ ] 主控派发全范围独立 Spec/quality Review，之后按 open-code-review 技能直接执行 OCR、始终 `--audience agent`：未提交用 workspace；混合提交同时覆盖实际原始 BASE..HEAD。报告独立编号，核对 skipped 文件/超时/预算/覆盖，不能只看 exit 0。
- [ ] 有效 critical/high/medium 进入编号修复 DAG/计划，经 SDD 修复、针对验证和 reviewer 复审，再对完整交付范围重新 OCR。同一问题两轮无进展用 systematic-debugging 升级诊断，不重复盲修。
- [ ] 归档所有验收、快照哈希、测试报告、Review/OCR 与 ruling、迁移 dry-run、限制和维护操作。依 finishing-a-development-branch 收尾，仅执行已授权的集成动作，不默认提交/推送/生产 apply。

**验收/失败处理：** 所有计划内节点 verified、必要测试判定充分、独立 Review 和 OCR 完整覆盖通过，才能称迁移实现完成。生产切换为另行授权操作；学习服务完全替换仍不在本范围。

## 20. 共享文件与接口预检

| 共享项 | 写入顺序 | 放行条件 |
| --- | --- | --- |
| execution-contracts / execution.ts | T2 → T3 → T5 → T6 → T7 | 每次接口变更同步消费者、更新 checkpoint；下游只消费 reviewed 版本 |
| ConversationService / schema | T4 → T6 → T11 | 完整 parts 与序列合同先冻结，再新增恢复/迁移；生成 SQL 前检查他人迁移和真实下一个编号 |
| copilot.ts / resolver | T8 → T14 | 旧路径到 T13 证据齐全后删除；T8 不同时做无关巨型拆分 |
| index.ts | T8 → T9 → T10 → T13 | 串行装配；每轮重扫 T0 入口清单；禁止其他 Task 越权编辑 |
| learning/runtime | T7 → T13 | 核心执行迁移不删除可选学习；保留 SDK archive 校验和撤销能力 |
| model adapter / PlanModel | T5 后冻结 | T8/9 只注入，不另实现第二套预算/订阅路由 |
| 前端事件合同 | T3/T6 定义 → T8 实装 → T12 验证 | 提前给 T12 提供 frozen fixtures；前端不猜引擎内部 chunk |
| 测试报告/数据库/端口 | 各 Task 独立输出；DB 串行 | 不共用报告目录与 reset，不使用共享开发 fixture |

## 21. 验收映射、里程碑与停止条件

| 验收 | Tasks | 可审查证据 |
| --- | --- | --- |
| Mastra 真实执行、工具/指令一致 | T1–T3、T8 | 解析包版本、fake provider 调用、完整事件、挂载 handler 行为 |
| 预算、结算、订阅隔离 | T5、T8、T9 | 每步 capability/usage、坏帧/402、付款路径断言 |
| 消息、附件、范围隔离 | T4、T11、T13 | parts roundtrip、intent/seq、RLS、导入逐项摘要 |
| 审批、前端工具、准确恢复 | T6、T8、T10、T12、T13 | CAS/receipt、跨进程/实例、UI 恢复 |
| 个人记忆与学习不回退 | T7、T13 | 候选排除、来源撤权、archive/revocation、可选服务故障行为 |
| 所有后台入口迁移 | T9、T10 | entrypoints 清单逐项、身份/预算、无旧 socket |
| 原客户端兼容 | T3、T12 | AG-UI fixtures、浏览器截图、语音/聊天一致 |
| 可切换、可诊断、回滚不丢数据 | T11、T13 | dry-run、在途清单、停止准入、writer fence、回滚演练 |
| 可交付与审查 | T14 | scoped/full 检查、独立 Review、OCR 完整报告、最终 diff |

里程碑：M0=T0/T1 方案与兼容就绪；M1=T2–T8 网页闭环；M2=T9/T10 所有后台入口贯通；M3=T11–T13 数据/客户端/无强制 Intelligence 验收；M4=T14 可审查交付。M1/M2 是阶段证据，不代表可以提前删除旧依赖或生产上线。

以下条件停止受影响下游：锁定版本不能跨进程恢复；身份/预算来源不明确；必要数据库场景未判；新增有效安全/一致性 finding；历史或快照不可转换且未处置；新旧 writer 无法隔离。可继续不依赖该阻塞的文档或只读核查，但不能将 blocked 节点标 verified。

## 22. 自查与当前状态

- 需求覆盖：D01–D08 均有上表任务和验收；完全替换学习、durable 长任务及去前端 SDK 明确排除，避免隐性功能削减。
- Interface 一致：ExecutionBinding、ResumeRef、ExecutionRequest、ExecuteMastra 只在 T2 定义；T3–T10 复用。Mastra 原生类型/API 以 T1 pinned probe 为先决条件，不把最新参考 API 当当前可用。
- Review Focus 五项均有任务及具体测试名；共享文件只允许串行写入。
- DAG：见同目录 `2026-10-19-mastra-agent-execution-migration-dag.md`；共 15 节点 T0–T14，线性依赖无环，默认不并行实现。
- 本次计划交付没有执行任何 Task、测试或审批，也没有取得生产变更授权；节点状态保持计划态。
