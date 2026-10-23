# Orca 多 Agent Issue 编排

在 OpenBot 中使用 Orca 协调多个 Agent 时读取。本文件是实施流程入口；执行状态、资源与故障细则见 [编排协议](orchestration-protocol.md)，Review 与 Issue 收尾见 [审核和交付](orchestration-review.md)。同时遵守 [Issue 摄取](issue-delivery.md)、[执行](execution.md)、[Worktree](worktrees.md)、[验证](testing.md)、[Review/OCR](review.md) 与[产物归处](artifacts.md)中适用的要求。多 Agent 代码实施须绑定根 Issue；只读研究、仅计划和仅 Review 遵守用户限定范围，不启动实施、集成或关闭 Issue 的阶段。

Orca 是工作区、Agent 与监督式 Task/Dispatch 的事实源。开始前读取当前会话的 `orca-cli` 和 `orchestration` 技能及版本匹配指南；命令、Agent ID、能力与回执以当前 Orca 版本为准。2026-10-18 的[旧工具实施计划](../../docs/plans/2026-10-18-orca-dag-orchestration.md)保留设计和开发历史，不作为本流程的运行状态或权限来源。

## 运行边界与职责

- 每轮 Run 指定一个根 Issue、仓库、集成分支、集成 Worktree、原始 BASE、授权范围、并发预算及证据目录。一个主编排者拥有摄取、计划、派发、集成、裁决和收尾权；Worker 不再派发 Agent。任务 Brief 说明其他编辑者存在，保留其改动。
- 编排者从正式 tracker 完整读取根 Issue 及递归子树、验收、讨论、正式子 Issue 与依赖；分别保存 `contains` 和 `depends_on`。外部阻塞只读核验，closed 状态须用目标代码验证。将全部验收映射到 DAG，校验唯一性、依赖、循环、所有权及资源；缺页或冲突标为不完整，仅放行有证据证明不受影响的任务。
- 方案写在 `docs/plans/`；Issue 快照、动态 DAG、Ledger、Brief、回执、检查点和报告写在 `.archive/runs/<run-key>/`。Ledger 记录 Task 的权威尝试、实际 Agent 身份、工作区、前置检查点、验证、Review 与集成状态。恢复先对账 Ledger、Git 和 Orca，避免重派已完成或仍在运行的工作。
- 本流程的实施 Agent 固定为 Orca 启动的 **Pi**，任务首轮及整改的独立代码审核 Agent 固定为 Orca 启动的 **Claude**，完整集成分支终审 Agent 固定为 Orca 启动的 **Codex**。角色仍按任务专业性在 Brief 中声明并核验；三个身份和各轮回执分别记录。当前 Orca 不能证明某一 Agent 已按要求启动时，保持 blocked/unverifiable，不静默换后端。

## 分支与 Worktree 容量

1. 派发前先用 Orca 建立或核验本轮唯一的**集成分支和集成 Worktree**，记录 BASE。已有同一 Run 的可恢复集成工作区直接复用。当前工作区的无关未提交修改留在原处；按 [Worktree 规范](worktrees.md)核对基线并显式转移必要文档。派发 Brief 写明提交策略：有本地提交授权时可按任务提交并用真实 Git 合并；无授权时保留未提交检查点，由编排者显式转移并核验任务增量，不能偷偷提交或以空 BASE..HEAD 代替审核。
2. 任务满足业务依赖、文件所有权和资源前提后，才从集成分支的**当前已验证 HEAD**用 Orca 创建该任务的分支及 Worktree。一个活跃任务占一个任务分支和 Worktree；Pi 开发、Pi 整改、Claude 审核及复审复用它。不要为每轮审核或修复另开工作区。
3. 活跃任务上限 **K=4**：一轮 Run 同时最多四个任务 Worktree，加一个集成 Worktree。K 是上限而非目标；资源容量、文件冲突或依赖使可派发数变小时按实际可行数派发。下游任务只有在前置成果进入集成分支且组合树验证通过后才创建工作区。独立并行任务依次集成，每次核验变化后的组合树。
4. 任务经 Claude 审核、集成及组合验证后，归档分支检查点与回执，再按 [Worktree 规范](worktrees.md)移除该任务工作区及已合并分支，释放一个名额。Codex 终审发现新问题时，从当前集成 HEAD 创建新的修复任务分支；不复活已清理工作区。未知状态、未集成改动或有效会话必须保留并标记待对账。

## DAG 调度与单任务阶段

一个业务 Task 的内部阶段依次为：

| 阶段 | Agent / 所有者 | 放行证据 |
| --- | --- | --- |
| 实现 | Orca Pi；专业职责写入 Brief | 完整授权增量、检查点哈希、针对性验证及安全结算 |
| 首轮审核 / 整改复审 | 每轮由编排者经 Orca 启动 Claude；Pi 负责有效 finding 的整改 | 同一检查点的 Spec compliance 与 code quality 结论、finding 裁决 |
| 集成 | 编排者在集成 Worktree 串行操作 | 产物已进入集成分支，实际组合树的适用验证通过 |
| 业务完成 | 编排者核对根验收与证据 | Task 标记 verified，下游依赖才释放 |

Pi 完成后停止该工作区写入并结算 Dispatch，再启动只读 Claude 审核。有效问题交回 Pi，使用新检查点补做受影响验证，再启动新的 Claude 审核轮次；直到所有阻塞 finding 消除或达到 [Review 规范](review.md)的失败/升级条件。实现者不能批准自己的代码；`worker_done`、Issue closed、测试 exit 0 或 Orca ready 列表均不能单独标记 verified。

每个 Worker 只接收一个自足 Brief：Task/attempt/Dispatch、验收、角色与预期 Agent、Worktree/BASE、owned_files、前置接口及检查点、资源、验证命令与预期结果、报告路径和失败上报条件。必要事实源给出文件、章节与版本；长日志和无关任务内容留在 Run 证据中。派发与恢复遵守[编排协议](orchestration-protocol.md)。

## 完整交付

所有交付任务已集成且根 Issue 聚合验收通过后，冻结集成分支待审范围，编排者经 Orca 启动新的 Codex Agent，对原始 BASE 至当前集成 HEAD 加未提交交付内容作最终 Spec/质量审核；同时按 [Review/OCR 规范](review.md)完成外层 OCR 覆盖。Codex 或 OCR 的有效问题形成对应修复任务，回到 Pi → Claude → 集成及组合验证，再重新执行完整范围终审。终审与 OCR 通过后，按[审核和交付](orchestration-review.md)关闭已满足验收的 Issue 并清理工作区；提交、GitHub 写入、推送及对外合并仍以当前授权为准。
