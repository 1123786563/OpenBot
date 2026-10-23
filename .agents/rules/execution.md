# 实施、派发与上下文

编写实施计划、派发、实现、修复或恢复任务时读取。Issue 实施先完成 [摄取与 DAG](issue-delivery.md)；只做文档或小范围配置不启动完整 Issue 流水线。

## 计划与工作区

Superpowers 负责 HOW / EXECUTE：`writing-plans`、`using-git-worktrees`、`subagent-driven-development`、`test-driven-development`、`systematic-debugging`、任务 Review、验证及 `finishing-a-development-branch`。按当前可用技能执行，不用竞争实现编排器。

实施前读取根 `CONTEXT.md`、批准 Spec、相关 ADR 和当前 Ticket；使用 `writing-plans`，方案存 `docs/plans/`。保留技能标准头、Global Constraints、Review Focus 和 Task 编号；引用 Issue 快照、DAG 和事实源。

每 Task 写清依赖、角色、owned_files、Consumes/Produces、具体步骤、适用测试与预期结果、验收和失败处理，不留 TODO/TBD。派发前完成需求覆盖、共享文件/接口和任务内部一致性预检。用户已要求端到端实施时，保存并展示方案后直接执行，常规修复不增加确认门槛。

普通实施默认沿 DAG 串行派发。使用 Orca 协调多个 Agent 实施 Issue 时，按 [Orca 多 Agent 编排](orchestration.md)的活跃任务上限及派发门禁执行，仍须满足依赖、独立 Worktree、不相交写权限、稳定接口、资源容量及集成次序。数据库、端口、缓存和产物目录均属共享状态。工作区细则见 [worktrees.md](worktrees.md)。

## 角色与独立性

| 工作 | agent_type |
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

保留内置 default、worker、explorer；探索优先 researcher，若用 explorer，按当前可用目录核实 `gpt-5.6-luna / low`，不可用时报告并选择已验证模型。派发实现前检查专业角色，派发后核对实际 agent_type、模型和推理等级，不以提示词中的角色名称代替实际配置。固定角色配置可能覆盖 spawn 参数；升级改用 default 并传专业约束。Ledger 写明具体障碍、升级原因、模型与受影响 Task；数量多、并行或主控模型强都不是升级理由。

以上 agent_type 路由用于非 Orca 编排的子 Agent。Orca 多 Agent 流程按 [编排规范](orchestration.md)由 Pi 实施、Claude 任务审核、Codex 最终审核；后端/前端专业职责仍写入 Brief，记录实际 Orca Agent 身份，不能将非 Orca 子 Agent 当作满足该流程的派发证据。

实现者负责适用的 RED → GREEN → REFACTOR、针对性检查和自查，不批准自己的实现。验证者只读业务代码及测试源文件，可写缓存、构建产物和指定报告；复用同一代码版本有效证据，仅补缺失验收。前后端验证按实际范围选择。Reviewer 独立输出 Spec compliance 与 code quality；测试不能替代 Review。

## Brief 与上下文

- 每个子 Agent 只接收单个 Brief、必要事实源路径/章节、前置接口与检查点、工作区、文件所有权、提交策略、验收/验证和报告路径；以干净会话启动，不继承完整父会话。
- 明确告知 Worker 还有其他编辑者，保留他人改动；子 Agent 不再派发，Review 由主控统一安排。
- 长日志、diff、原始回执和已解决讨论写到 `.archive/runs/<run-key>/`，消息只通知新增结果、阻碍、检查点和报告路径。需要诊断时定向读取原始证据。
- 同一会话复用未变化材料；新会话、压缩或恢复后先读当前 Ledger 摘要、活动尝试、Git 和相关回执，再按缺口读取历史。摘要保留全部未解决问题，不能替代原始证据。
- 已确认决定及时写入 Spec、ADR 或 `CONTEXT.md`；上下文容量不影响持久化要求。

使用 Orca 协调多个 Agent 实施 Issue 或恢复编排 Run 时读取 [Orca 多 Agent 编排](orchestration.md)；开发原 Orca DAG 工具时再读取历史方案中的专用契约。

## 提交与检查点

派发前在 Brief 写明提交策略。有本地提交授权时可授权实现者按任务提交，Review Package 使用真实 BASE/HEAD。无授权或用户禁止提交时使用未提交检查点，不偷偷提交，也不以空 BASE..HEAD 代替审查：

1. Task 前后记录 HEAD、tracked staged/unstaged diff、任务范围内 untracked 完整内容和哈希；无关用户改动作为基线保留。快照存 `.archive/runs/<run-key>/checkpoints/`。
2. 生成包含新增/删除文件的任务增量 Review Package，记录前后快照路径、哈希、实际检查命令和结果。
3. Reviewer 审查该增量；验证绑定同一快照，内容变更后补相关验证及 Review。Ledger 用检查点 ID 替代提交区间。
4. 同一串行工作区集成后才放行下游；跨工作区须显式转移并核对检查点。

实现缺陷用 `systematic-debugging`；根因属于领域或架构问题时先更新对应事实源。修复轮次与 OCR 闭环见 [review.md](review.md)。
