# 实施、派发与上下文

编写实施计划、派发、实现、修复或恢复任务时读取。凡以 Issue 为依据，先完成[只读摄取](issue-delivery.md)；实施授权才启动完整流水线。纯文档修订或满足下述低风险条件的小范围配置可由当前 Agent 在已核对基线的合适工作区直接完成，按风险独立审查，不强制创建 Issue 或启动 SDD/Orca Run。

“小范围配置”仅指单一模块内可逆、无运行行为/数据/权限/发布影响的展示或开发便利配置，先列文件和风险。CI、身份权限、安全、隔离、部署、数据迁移、依赖/运行链路及本身改变工程放行门禁的配置不适用此例外；它们即使只有一行，也须计划、独立验证/Review 和完整 OCR，是否创建 Issue 仍依用户范围。授权、验证、审查或交付语义的规则文档与执行配置采用同一门禁；规则修订可在已核对基线的当前工作区执行，不因此强制创建 Issue 或启动代码实施派发。排版、错字和不改语义的链接修订走轻量文档路径。一次性例外必须绑定授权引用、Run、条款范围和失效条件，不以“本次”使未来自动继承。

## 计划与工作区

Superpowers 负责 HOW / EXECUTE：`writing-plans`、`using-git-worktrees`、`subagent-driven-development`、`test-driven-development`、`systematic-debugging`、任务 Review、验证及 `finishing-a-development-branch`。按当前可用技能执行；非 Orca 使用 SDD，Orca 使用[监督式流程](orchestration.md)承载执行，不同时运行两套派发器。SDD 工具目录、活动 Ledger 与归档的映射按 [artifacts.md](artifacts.md)。

能力预检在写计划/派发前执行：核对当前技能目录、可读 SKILL.md、版本及所需工具的实际入口，不把历史目录或命令名当作可用证据。缺失的强制技能先按其名称搜索；仍缺时记录 `capability_blocked`（技能、受阻阶段、已完成只读准备、恢复条件），不得声称已执行技能或调用不存在的 sdd-workspace。高层指令要求特定技能时，以该阻塞为准，只有已获当前用户明确授权的等价流程才可替代。

替代权限按来源判定：系统/开发者或当前用户明确点名必须使用某技能时，遵从该层约束，当前用户仅可在其有权覆盖的范围批准替代。仅本仓库规则要求的计划、隔离、诊断、派发和收尾技能缺失时，本规则预授权下述手工等价步骤，记录技能和缺口即可，不重复请求许可。独立性、验证证据、授权边界和 OCR 工具关卡不可由自查或摘要替代。本文“已获准的等价流程”包括本条预授权和有效的具体用户授权；Run 能力清单保存技能位置/版本/哈希、工具实际入口和替代依据。

满足上述替代权限时，可采用手工等价步骤并记录依据：详细计划含 Goal/批准事实源、Global Constraints、Review Focus、编号 Task 与接口/验证；已核验的 Git Worktree；单 Brief 串行专业实现者→独立行为验证→独立 Spec/质量 Review；冻结 manifest 与单一 Ledger；根因假设→复现→证伪/修复→回归的诊断记录；完整 OCR；核验内容保留和授权后的分支收尾。Orca 可承载这些执行阶段，但不自动豁免仍强制的 writing-plans 等依赖。工具缺失不是请求无关授权或重复询问已授权执行方式的理由；只继续不受影响工作，清楚报告受阻能力，不在未知状态下实施。

实施前读取根 `CONTEXT.md`、批准 Spec、相关 ADR 和当前 Ticket；按上述能力预检使用 `writing-plans` 或已获准的等价流程，方案存 `docs/plans/`。保留技能标准头、Global Constraints、Review Focus 和 Task 编号；引用 Issue 快照、DAG 和事实源。

每 Task 写清依赖、角色、owned_files、Consumes/Produces、具体步骤、适用测试与预期结果、验收和失败处理，不留 TODO/TBD。派发前完成需求覆盖、共享文件/接口和任务内部一致性预检。用户已要求端到端实施时，保存并展示方案后直接执行，常规修复不增加确认门槛。

实施默认沿 DAG 串行派发；每日批次的源文件只读审计/验证按 [每日规则](closed-issue-daily-run.md)的 P 和资源隔离接纳，审计期间的测试写入仍受共享声明约束。并行实现须有已记录且仍有效的明确用户授权，复用本任务既有授权而不重复询问。使用 Orca 或设定 K 上限本身不授予并行权限。已获并行授权时，仍须满足[编排门禁](orchestration.md)、独立 Worktree、不相交写权限、稳定接口、资源容量及集成次序。数据库、端口、缓存和产物目录均属共享状态；跨 Run 声明遵守[共享协调状态](coordination-state.md)。工作区细则见 [worktrees.md](worktrees.md)。

## 角色与独立性

| 工作 | 专业职责 / 平台支持时的 agent_type |
| --- | --- |
| Issue 树与依赖证据 | issue_analyst |
| 代码/文档探索 | researcher |
| 架构、接口、DAG 难点 | architect |
| 后端实现 / 验证 | backend_implementer / backend_validator |
| 前端实现 / 验证 | frontend_implementer / frontend_validator |
| 不可沿稳定接口拆分的跨端实现 | implementer |
| 范围明确的机械修改 | mechanical_worker |
| 独立 Spec + 质量审查 | reviewer |
| 核实专业角色不能胜任后的升级 | default + 已验证可用的显式模型与推理等级 |

能力预检先核对平台是否能选择并回执 agent_type：支持时使用上表已配置且可用的专业角色，派发后核验实际值；不支持时，使用平台可用的通用独立会话，以专业 Brief 指定职责，保存真实会话 ID、干净上下文、启动回执、能力核验及模型/推理配置的可核实部分，并将 agent_type 记为“不支持”。这条兼容路径不要求制造不存在的角色参数，也不允许把提示词角色名冒充平台配置；会话或贡献独立性、专业能力、必要身份无法证明时仍 blocked。未知模型字段明确记为不可见，不填推测值；强制模型要求无法核实时阻塞对应阶段。

平台提供 default、worker、explorer 时保留其配置；探索优先可用的 researcher，若用 explorer，按当前可用目录核实 `gpt-5.6-luna / low`，不可用时报告并选择已验证模型。固定角色配置可能覆盖 spawn 参数；升级时在平台支持的通用会话/角色上传专业约束并核验实际配置。Ledger 写明具体障碍、升级原因、模型与受影响 Task；数量多、并行或主控模型强都不是升级理由。

以上 agent_type 路由用于非 Orca 编排的子 Agent。Orca 多 Agent 流程的实施、独立任务审核和终审 Agent 按 [Agent 选择](orchestration-agents.md)确定；后端/前端专业职责仍写入 Brief，记录实际 Orca Agent 身份，不能将非 Orca 子 Agent 当作满足该流程的派发证据。

实现者负责适用的 RED → GREEN → REFACTOR、针对性检查和自查，不批准自己的实现。验证者只读业务代码及测试源文件，可写缓存、构建产物和指定报告，输出分类与检查点关系按 [checkpoints.md](checkpoints.md)声明。复用证据必须绑定同一代码 manifest，并核验生产者独立性、运行环境、依赖/配置、验收覆盖及原始回执；实现者自测或仅 SHA 相同不能充当独立行为验证。前后端验证按实际范围选择，仅补缺失验收。Reviewer 独立输出 Spec compliance 与 code quality；测试不能替代 Review。

## Brief 与上下文

- 每个子 Agent 只接收单个 Brief、必要事实源路径/章节、前置接口与检查点、工作区、文件所有权、提交策略、验收/验证和报告路径；以干净会话启动，不继承完整父会话。
- 明确告知 Worker 还有其他编辑者，保留他人改动；子 Agent 不再派发，Review 由主控统一安排。
- 长日志、diff、原始回执和已解决讨论写到 `.archive/runs/<run-key>/`，消息只通知新增结果、阻碍、检查点和报告路径。需要诊断时定向读取原始证据。
- 同一会话复用未变化材料；新会话、压缩或恢复后先读当前 Ledger 摘要、活动尝试、Git 和相关回执，再按缺口读取历史。摘要保留全部未解决问题，不能替代原始证据。
- 已确认决定及时写入 Spec、ADR 或 `CONTEXT.md`；上下文容量不影响持久化要求。

使用 Orca 协调多个 Agent 实施 Issue 或恢复编排 Run 时读取 [Orca 多 Agent 编排](orchestration.md)；开发原 Orca DAG 工具时再读取历史方案中的专用契约。

## 提交与检查点

派发前在 Brief 写明提交策略。有本地提交授权时可授权实现者按任务提交，Review Package 使用真实 BASE/HEAD。无授权或用户禁止提交时使用未提交检查点，不偷偷提交，也不以空 BASE..HEAD 代替审查。

检查点的内容、敏感文件例外、子模块逐仓库审查、无关用户基线及跨工作区转移统一遵守[检查点与内容转移](checkpoints.md)。生成完整任务增量 Review Package；Reviewer 与验证绑定同一 manifest，Ledger 用检查点 ID 或真实提交区间引用。下游及终审修复工作区必须包含完整前置树，未提交模式在 HEAD 上显式应用前置检查点并核验后才启动 Worker。

实现缺陷按上述能力预检使用 `systematic-debugging` 或已获准的等价诊断；根因属于领域或架构问题时先更新对应事实源。修复轮次与 OCR 闭环见 [review.md](review.md)。
