# Orca 分支与 Worktree 规范

此流程适用于为 OpenBot 工作创建、复用和结束 Orca Worktree 或 Git 分支。Orca 管理的工作区通过当前会话的 `orca-cli` 操作；先读取该技能的版本匹配指南。多 Agent Issue 实施以[编排规范](orchestration.md)的集成分支、任务分支和容量门禁为准，并遵守[执行规范](execution.md)及[审查规范](review.md)的 Ledger 与审查要求。

## 创建前：先找现有归属

1. 确定根 Issue 或独立任务、目标仓库、所需 BASE、现有执行 Ledger，以及本次是否真的需要隔离。只读研究、审查和非编排式串行修复优先使用已有合适工作区；Orca 多 Agent Run 复用本轮唯一的集成 Worktree，并且每个活跃 DAG 任务最多一个任务 Worktree，不按审核轮次或 Agent 人数分别创建。
2. 用 `orca worktree list --repo <仓库选择器> --json` 查任务引用、状态、路径和分支，并核对 `git worktree list --porcelain`、`git branch -vv`。Orca 结果若有 `truncated: true` 或主机未覆盖，使用 `--limit` 取得完整列表并核对对应主机；不能把未返回的工作区当作不存在。检查候选工作区的 `git status`、HEAD、Ledger 和现有 Agent；可恢复的任务直接复用，避免重复派发。
3. 新建前记录原因、预期用途和收尾负责人。Orca 多 Agent Run 的集成 Worktree 在派发前建立；任务 Worktree 在 DAG 就绪且容量允许时按需创建。已有未提交改动保持在原工作区；不要用共享 `git stash` 转移。

## 创建时：一项工作有明确身份

- 使用可追溯且简短的名称，如 `issue-410-write-origin` 或 `review-410`；Orca 新建 Worktree 会同时产生新分支，一个任务只保留一个主执行分支。临时审查或验证优先在主执行工作区只读进行，需要隔离时才创建有用途标识的临时 Worktree。只需要新 Agent 时复用现有分支和 Worktree。
- 明确仓库与基线。本仓库默认目标为 `1123786563/OpenBot` 的 `origin/main`，核对实际 remote 身份、目标 ref 的完整 SHA 和读取时间，不用 `upstream/main` 或当前功能分支冒充。用户明确指定其他基线时记录该依据。普通独立任务使用 `--no-parent`；只有已核实 Orca 默认基线与目标 ref/SHA 一致时才可省略 `--base-branch`，否则显式指定并核对新 HEAD。Orca 任务以集成 HEAD 加[完整前置检查点](checkpoints.md)派生，记录父工作区；`--no-parent` 只决定 Orca 关系。
- 有 Issue/PR 时创建时附上引用；记录 Orca 返回的完整 Worktree ID、路径、分支、BASE、拥有的任务和 Agent 到 Ledger。监督式阶段统一用 `worker-start`；非监督式的独立会话/完整 ownership handoff 才使用 `agent launch` 或 `worktree create --agent`，不得将其当成 Task/Dispatch 回执。只换 Agent 不另建工作区；结果不明先对账，不重复创建或启动。
- 实现默认串行；每日批次只读审计/验证可按 [每日规则](closed-issue-daily-run.md)的 P 与资源隔离并行。明确获用户并行实现授权后，才在接口稳定、文件/共享资源不冲突且集成次序明确时使用多个 Worktree。任务容量按[编排规范](orchestration.md)，资源登记按[共享协调状态](coordination-state.md)。审核通过的成果串行进入集成工作树，组合验证后记录检查点并释放下游。

## 收尾：核验后关闭

每个任务结束或暂停时更新 Ledger 与 Orca 状态；暂停的工作区记录恢复入口，不计为完成。完成后核对提交、未提交文件、未跟踪文件、子模块状态、有效 Agent/终端、测试容器和审查证据。还必须按进程 cwd、可执行入口、容器 bind mount、端口及共享资源声明核对全部后台 workload，包括分离的 dev server、文件 watcher、普通 worker 和开发容器；只查活跃终端或测试容器不够。属于本轮且不再需要的 workload 先安全停止并复核，仍需保留的登记 owner、资源与恢复入口；归属不明或仍在写入时不得删除工作区。额外核对 ignored 文件清单（如 `git status --short --ignored` 和有界目录清单），分类为可重建缓存、需保留本地配置/数据、归档及未知内容；不要打印秘密原文。`.env`、运行数据、受保护检查点和子模块内的 ignored 文件均不能由“git status 干净”推断可删。保留仍承载未集成改动、待保留/未知数据、有效会话或未处置 workload 的工作区。

确认改动已集成、受影响子模块提交已通过 [checkpoints.md](checkpoints.md)的接收方远端可达及递归 checkout 核验，需保留数据已安全转移并核验接收位置/清单/哈希，且按 [coordination-state.md](coordination-state.md)事务更新全部活跃恢复引用并从共享 Ledger 实际试读新位置成功，其他数据可删除后，才用 Orca 的 `worktree rm --worktree <完整 ID> --json` 移除工作区；命令可能同时删除已合并的本地分支，先核对目标 ID、路径和分支。默认不使用 `--force`，不批量删除，也不因卡片 completed 推断内容安全。未提交检查点已转移不等于 Git 分支已合并，移除要求 force 时先保留并报告，不为清理擅自提交或丢弃。删除后核对 Orca、Git Worktree 与分支列表；只单独处理已合并、未被使用且无须保留的残留分支，保存清理结果。

Ledger、基线、检查点、转移及清理报告统一存入 `.archive/runs/<run-key>/`，命名与保留要求见 [产物归处](artifacts.md)。

普通 Git/Superpowers 创建且未纳入 Orca 管理的 Worktree 使用同等保留门禁后，以 `git worktree remove <已核实路径>` 清理；有技能时再按其收尾流程，不要求不存在的 Orca ID。先核对创建者及管理归属，不对同一工作区混用两套删除命令。无论哪条路径，force、未集成分支删除及未知数据处置均须已有相应授权；删除后核对实际目录和管理列表，失败则保留待处理状态。
