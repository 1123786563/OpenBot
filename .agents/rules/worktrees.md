# Orca 分支与 Worktree 规范

此流程适用于为 OpenBot 工作创建、复用和结束 Orca Worktree 或 Git 分支。Orca 管理的工作区通过当前会话的 `orca-cli` 操作；先读取该技能的版本匹配指南。仓库 Issue 实施仍遵守[执行规范](execution.md)及[审查规范](review.md)的 Worktree、Ledger 与审查要求。

## 创建前：先找现有归属

1. 确定根 Issue 或独立任务、目标仓库、所需 BASE、现有执行 Ledger，以及本次是否真的需要隔离。只读研究、审查和串行修复优先使用已有合适工作区；同一根 Issue 默认共用一个执行 Worktree，不按 Task、审查轮次或 Agent 人数分别创建。
2. 用 `orca worktree list --repo <仓库选择器> --json` 查任务引用、状态、路径和分支，并核对 `git worktree list --porcelain`、`git branch -vv`。Orca 结果若有 `truncated: true` 或主机未覆盖，使用 `--limit` 取得完整列表并核对对应主机；不能把未返回的工作区当作不存在。检查候选工作区的 `git status`、HEAD、Ledger 和现有 Agent；可恢复的任务直接复用，避免重复派发。
3. 只有现有工作区不能满足隔离要求时才新建：例如两个独立任务需同时写入、已有工作区的脏改动不能混用，或用户指定独立 Worktree。先记录原因、预期用途和收尾负责人。已有未提交改动要保持在原工作区；不要用共享 `git stash` 转移。

## 创建时：一项工作有明确身份

- 使用可追溯且简短的名称，如 `issue-410-write-origin` 或 `review-410`；Orca 新建 Worktree 会同时产生新分支，一个任务只保留一个主执行分支。临时审查或验证优先在主执行工作区只读进行，需要隔离时才创建有用途标识的临时 Worktree。只需要新 Agent 时复用现有分支和 Worktree。
- 明确仓库与基线。独立任务使用 Orca 的 `--no-parent`，省略 `--base-branch` 以采用仓库默认基线，或明确指定仓库默认基线；只有明确的堆叠任务才从当前功能分支派生并记录父工作区。`--no-parent` 只决定 Orca 关系，不决定 Git 基线。
- 有 Issue/PR 时创建时附上引用；记录 Orca 返回的完整 Worktree ID、路径、分支、BASE、拥有的任务和 Agent 到 Ledger。需要在已有工作区启动 Agent 时使用 `orca agent launch`，不为每次新 Agent 另开 Worktree。创建或启动结果不明确时先检查 Orca 与 Git 状态，避免重复创建。
- 并行实现仅在接口稳定、写入文件及共享测试资源不冲突且集成次序明确时使用多个 Worktree。主控负责把已验证的改动集成到执行工作区，并在 Ledger 记录来源与检查点。

## 收尾：核验后关闭

每个任务结束或暂停时更新 Ledger 与 Orca 状态；暂停的工作区记录恢复入口，不计为完成。完成后核对提交、未提交文件、未跟踪文件、子模块状态、有效 Agent/终端、测试容器和审查证据。保留仍承载未集成改动或有效会话的工作区。

确认改动已集成且无待保留数据后，用 Orca 的 `worktree rm --worktree <完整 ID> --json` 移除该 Orca 工作区；该命令可能同时删除可证明已合并的本地分支，执行前核对目标 ID、路径和分支。默认不使用 `--force`，不批量删除，也不因 Orca 卡片标为 `completed` 就推断 Git 内容已安全。删除后核对 Orca 列表、`git worktree list` 和分支列表；残留分支仅在确认已合并、未被其他 Worktree 使用且无须保留时单独处理。记录清理结果。历史积压按同一标准逐个审计；状态不明或有脏改动的工作区先标记待核验，不直接清理。

Ledger、基线、检查点、转移及清理报告统一存入 `.archive/runs/<run-key>/`，命名与保留要求见 [产物归处](artifacts.md)。
