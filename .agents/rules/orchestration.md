# Orca 多 Agent Issue 编排

在 OpenBot 中使用 Orca 协调多个 Agent 时读取。本文件是实施流程入口；Agent 候选与身份见 [Agent 选择](orchestration-agents.md)，执行状态、资源与故障细则见 [编排协议](orchestration-protocol.md)，Review 与 Issue 收尾见 [审核和交付](orchestration-review.md)。同时遵守 [Issue 摄取](issue-delivery.md)、[执行](execution.md)、[Worktree](worktrees.md)、[验证](testing.md)、[Review/OCR](review.md) 与[产物归处](artifacts.md)中适用的要求。多 Agent 代码实施须绑定根 Issue；只读研究、仅计划和仅 Review 遵守用户限定范围，不启动实施、集成或关闭 Issue 的阶段。

Orca 是工作区、Agent 与监督式 Task/Dispatch 的事实源。开始前读取当前会话的 `orca-cli` 和 `orchestration` 技能及版本匹配指南；命令、Agent ID、能力与回执以当前 Orca 版本为准。

## 运行边界与职责

- 每轮普通 Run 指定一个根 Issue、仓库、集成分支、集成 Worktree、原始 BASE、授权范围、交付目标（远程、分支或 PR）、并发授权/预算及证据目录。每日已关闭 Issue 批次是显式例外：用 [daily_run_manifest](coordination-schema.json#/$defs/daily_run_manifest) 的 source_issues/scope 代替单一根 Issue，仍只有一个协调者、集成入口和完整终审范围；Task 逐项绑定原票/finding/授权，不创建虚假父票，不自动取得批次全部写权限。关闭门禁绑定该目标，不由本地集成分支替代。一个主编排者拥有摄取、计划、派发、集成、裁决和收尾权；Worker 不再派发 Agent。任务 Brief 说明其他编辑者存在，保留其改动。
- 编排者从正式 tracker 完整读取根 Issue（每日批次为 scope 内各原票）及递归子树、验收、讨论、正式子 Issue 与依赖；分别保存 `contains` 和 `depends_on`。外部阻塞只读核验，closed 状态须用目标代码验证。将全部验收映射到 DAG，校验唯一性、依赖、循环、所有权及资源；缺页或冲突标为不完整，仅放行有证据证明不受影响的任务。
- 方案写在 `docs/plans/`；Issue 快照、动态 DAG、Ledger、Brief、回执、检查点和报告写在 `.archive/runs/<run-key>/`。Ledger 记录 Task 的权威尝试、实际 Agent 身份、工作区、前置检查点、验证、Review 与集成状态。恢复先对账 Ledger、Git 和 Orca，避免重派已完成或仍在运行的工作。
- 按 [Agent 选择](orchestration-agents.md) 为任务实现、独立审核轮次和集成终审确定 Agent；在 Brief 与 Ledger 记录预期身份，并核对 Orca 实际启动回执。

## Agent 启动命令示例

实施、任务审核、整改复审和集成终审均使用监督式 `worker-start`，每个阶段记录业务 Task → Orca Task/Dispatch 映射。创建 Worktree 与启动 Worker 分开；普通 `agent launch` 或 `worktree create --agent` 只启动会话，不能代替监督派发证据。以下 `ORCA` 是已按技能选定的可执行文件占位符，执行前替换；具体 argv、Agent ID 与回执字段按当前指南核对。

```text
# 本轮只建立/绑定一个 Run，已有 Run 先恢复
ORCA orchestration run-create --objective "<run 目标>" --json

# 仅创建工作区；按检查点规范还原并核对完整前置树后才启动实施者
ORCA worktree create --repo id:<repoId> --name <task-key> --base-branch <集成分支> --json
ORCA orchestration worker-start --spec "<implementation brief>" --worktree id:<repoId>::<worktreePath> --agent <implementation-agent> --json
ORCA orchestration check --wait --types "worker_done,escalation,question" --timeout-ms 60000 --json

# 接受结算、保存报告并决定不立即复用后才释放；处理全部消息后再 ack
ORCA orchestration worker-release --dispatch <settled_dispatch_id> --json
ORCA orchestration check --ack <delivery_id> --json

# 固定检查点且写入停止后，在同一任务工作区派发独立审核阶段
ORCA orchestration worker-start --spec "<review brief>" --worktree id:<repoId>::<worktreePath> --agent <review-agent> --json

# 全部集成和组合验证后，在集成工作区派发独立终审阶段
ORCA orchestration worker-start --spec "<final review brief>" --worktree id:<repoId>::<integration-worktree> --agent <final-review-agent> --json

# 需跟踪的跟进问题进入监督消息通道；范围变更另更新 Brief/attempt
ORCA orchestration send --to dispatch:<dispatch_id> --type question --subject "<follow-up question>" --json
```

- 保存完整启动回执，按当前版本提取实际 Agent、Task/Dispatch、执行主机、工作区和 handle；远程 Worker 按 Dispatch 寻址。`worker-start` 失败或响应丢失时先查权威尝试、`failedStage`/`residualResources` 并加载技能的恢复指南，不盲目重启，也不把普通 launch 的 `--retry-launch` 套到监督式命令。跟进使用监督消息和回执；接受输入不等于已读或完成。
- 三个 Agent 占位值按 [Agent 选择](orchestration-agents.md) 在启动前替换；不以示例里的占位符或历史回执推断当前主机能力。

## 分支与 Worktree 容量

1. 派发前先用 Orca 建立或核验本轮唯一的**集成分支和集成 Worktree**，记录 BASE。已有同一 Run 的可恢复集成工作区直接复用。当前工作区的无关未提交修改留在原处；按 [Worktree 规范](worktrees.md)核对基线并显式转移必要文档。派发 Brief 写明提交策略：有本地提交授权时可按任务提交并用真实 Git 合并；无授权时保留未提交检查点，由编排者显式转移并核验任务增量，不能偷偷提交或以空 BASE..HEAD 代替审核。
2. 任务满足业务依赖、文件所有权和资源前提后，用 Orca 从集成 HEAD 创建分支及 Worktree，再按[检查点规范](checkpoints.md)还原**完整前置树**（正常业务为 deliverable_verified；限定修复按检查点规范使用 frozen_failed）。未提交或混合模式必须额外应用已审查检查点并核对目标 manifest，只有 HEAD 一致不够。一个活跃任务占一个任务分支和 Worktree；实施、整改及独立审核复用它。
3. 活跃任务上限 **K=4**：一轮 Run 同时最多四个任务 Worktree，加一个集成 Worktree。实现默认串行；并行实现须有已记录且仍有效的明确用户授权，K 不构成该授权。每日批次的独立只读源文件审计/验证可按 [每日规则](closed-issue-daily-run.md)的 P 并行；P 限制实际在途 Task/Dispatch，审核阶段也占容量，C/K/P 不互相替代。获授权后实际并发仍服从依赖、资源、文件所有权与 Worker 槽位。下游仅在前置成果进入集成工作树且组合验证通过后派生；多个独立任务依次集成。
4. 任务审核、集成及组合验证后，归档检查点与回执，再按 [Worktree 规范](worktrees.md)核验并清理可安全删除的工作区/分支，释放名额。终审/OCR 修复从集成 HEAD 加完整 frozen_failed 检查点派生，仅放行限定修复任务；不复活已清理工作区。未知状态、未集成改动或有效会话必须保留并待对账。

## DAG 调度与单任务阶段

一个业务 Task 的内部阶段依次为：

| 阶段                | Agent / 所有者                                              | 放行证据                                                        |
| ------------------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| 实现                | [选定的实施 Agent](orchestration-agents.md)；专业职责写入 Brief | 完整授权增量、检查点哈希、针对性验证及安全结算                  |
| 独立行为验证 | 编排者另启符合 [Agent 选择](orchestration-agents.md)的只读验证会话，落实 DAG validator_role | 同一 manifest 的行为验收报告、版本/环境证据；必需场景全部通过 |
| 首轮审核 / 整改复审 | 编排者启动[选定的独立审核 Agent](orchestration-agents.md)；原实施 Agent 整改有效 finding | 同一检查点的 Spec compliance 与 code quality 结论、finding 裁决 |
| 集成                | 编排者在集成 Worktree 串行操作                              | 产物已进入集成分支，实际组合树的适用验证通过                    |
| 业务完成            | 编排者核对根验收与证据                                      | Task 标记 verified，下游依赖才释放                              |

实施 Agent 完成后停止该工作区写入并结算 Dispatch，再启动独立行为验证及选定的只读独立审核阶段。有效问题交回原实施 Agent，使用新检查点补做受影响验证，再启动新的独立审核轮次；直到所有有效 critical/high/medium finding 消除或达到 [Review 规范](review.md)的失败/升级条件。`worker_done`、Issue closed、测试 exit 0 或 Orca ready 列表均不能单独标记 verified。

### 独立审核通过后合入集成分支

1. 编排者核对独立审核通过的检查点哈希、任务分支 HEAD、完整任务增量与验证证据；停止该任务 Worktree 的写入，锁定集成 Worktree，并记录集成前 HEAD、工作树和已验证前置版本。审核后内容有变化时先生成新检查点并复审。
2. **已有本地提交授权**：在集成 Worktree 将该任务分支的已审查提交合并到集成分支，核对实际合入的提交和文件增量。**没有提交授权**：将已审查的未提交检查点显式转移到集成 Worktree，逐文件核对内容及哈希；这属于集成工作树的内容，不声称 Git 分支已合并。两种方式均不得覆盖原有无关改动。
3. 发生冲突或集成时产生审核范围外的修改，固定新的集成检查点，交选定的独立审核 Agent 审核新增增量。随后在实际组合树上执行该任务及受影响范围的验证，记录命令、退出码、集成前后 HEAD／工作树哈希和结果。失败则保留现场并阻止下游派发。
4. 只有合入内容与已审查检查点一致、组合验证通过，才在 Ledger 将任务记为已集成 `verified` 并释放其后继节点；再按上述容量规则归档和清理任务工作区。多个就绪任务逐个执行本节，不并行写入集成 Worktree。

每个 Worker 只接收一个自足 Brief：Task/attempt/Dispatch、验收、角色与预期 Agent、Worktree/BASE、owned_files、前置接口及检查点、资源、验证命令与预期结果、报告路径和失败上报条件。必要事实源给出文件、章节与版本；长日志和无关任务内容留在 Run 证据中。派发与恢复遵守[编排协议](orchestration-protocol.md)。

## 完整交付

推送/合并前按 [delivery-gates.md](delivery-gates.md)完成目标新鲜度及经验证结果的条件写门禁；目标更新后重新完整终审/OCR。所有交付任务已集成且根 Issue 聚合验收通过后（每日批次为全部交付 source_issues 的适用验收及必要父聚合通过），冻结集成分支待审范围，编排者经 Orca 启动新的[终审 Agent](orchestration-agents.md)，对按 [checkpoints.md](checkpoints.md)核对的完整授权提交映射和未提交交付内容作最终 Spec/质量审核；终审通过后由编排者按 [Review/OCR 规范](review.md)对同一完整范围执行外层 OCR。终审或 OCR 的有效问题形成对应修复任务，回到实施 Agent → 独立审核 Agent → 集成及组合验证，再重新执行完整终审与 OCR。两项均通过后，按[审核和交付](orchestration-review.md)关闭已满足验收的 Issue 并清理工作区；提交、GitHub 写入、推送及对外合并仍以当前授权为准。
