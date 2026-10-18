# OpenBot 本地分支与 Worktree 审计

审计时间：2026-10-18（Asia/Shanghai）  
仓库：`/Users/wuyongjun/trea/OpenBot`  
Orca 执行文件：`/Applications/Orca.app/Contents/Resources/bin/orca`  
Orca 版本匹配指南：通过 `orca skills get orca-cli --json` 读取当前安装版指南。

## 结果

本轮未删除任何 Worktree 或分支。审计证明当前活跃工作高度集中，尚无候选能通过全部删除门槛：Orca 返回 409 个本机 Worktree，`truncated: false`、`omittedHostIds: []`；其中 403 张卡片为 `in-progress`、3 张为 `in-review`、3 张为 `completed`。卡片状态仅作为线索，不能证明 Git 内容集成或 Agent 已退出。`orca worktree ps --json` 返回 423 个条目且 `truncated: true`，故会话覆盖不完整。实际观察到一个运行中的 Agent 在 `craft-preview-origin-exec` 路径修改文件。

主仓库 `git worktree list --porcelain` 有 410 个条目（含主工作区），`git branch -vv` 有 375 行分支记录（含当前 HEAD detached 标记行等输出项，需后续按 ref 规范复算）。主工作区分支为 `fix/craft-write-origin-guard-410`，HEAD `152d9c590a3c1645d31dbf27d8627dad71a2438b`。主工作区状态包含 927 个已修改路径、10 个未跟踪路径；这些内容保持原样。它位于候选清理范围之外。

审计期间执行 `git fetch --all --prune` 成功：更新 `upstream/main` 至 `12c3a694`、`upstream/arcade-provider` 至 `289ef458`。目标分支尚未逐个映射到 409 个工作区，故这些更新不构成任何候选分支已集成的证明。

## 命令与证据

- `orca skills get orca-cli --json`：成功，读取当前 CLI 对应指南。
- `orca worktree list --repo id:d6edf033-748a-4549-ae5a-e9efd34cef91 --json --limit 1000`：成功；409 条，未截断，本机 hostScope 完整。
- `orca worktree ps --json`：成功；423 条，`truncated: true`。不能将未显示的 Agent/终端推定为不存在。
- `git worktree list --porcelain`：410 个 worktree 条目。
- `git branch -vv`：375 行输出；需在后续逐 ref 规范盘点时给出精确本地分支计数。
- `git status --short --branch`：主工作区 927 个 ` M`、10 个 `??`。
- `git fetch --all --prune`：成功；更新 `upstream/main` 和 `upstream/arcade-provider`。
- 对全部 408 个非主 Orca Worktree 的逐项 `git status` / 子模块扫描已启动，但截至本报告写入时尚未结束；结果不得臆测或视作通过。

原始机器输出暂存于 `/tmp/openbot-worktree-audit/`：`orca.json`、`ps.json`、`git-worktrees.txt`、`branches.txt`、`main-status.txt`。此临时目录不属于仓库持久记录，后续应将需要的逐项结果附入本报告。

## 分类

- **已安全清理：** 无。
- **保留且仍在使用：** 至少 `craft-preview-origin-exec`，可见 Agent 正在修改；另有 403 项 Orca 卡片标记 `in-progress`，尚未逐项核实活跃性。
- **存在未提交内容：** 主工作区明确有 927 个修改路径及 10 个未跟踪路径；非主工作区的逐项状态扫描尚未完成。
- **待核对：** 其余候选全部待核对。目标集成分支、最新引用、候选 HEAD 的祖先验证、Squash/cherry-pick 的 PR 范围与最终代码比对、Ledger/验收证据和 Agent/终端退出状态尚未逐项完成。`worktree ps` 截断进一步阻止了会话安全结论。
- **清理失败：** 无删除尝试；未对任何不确定项使用强制删除。

## 计数

| 范围 | 清理前 | 清理后 | 说明 |
| --- | ---: | ---: | --- |
| Orca Worktree | 409 | 409 | 本轮未删除 |
| Git Worktree | 410 | 410 | 含主工作区 |
| `git branch -vv` 输出行 | 375 | 375 | 需复算 refs 精确数量 |

## 后续恢复步骤

1. 读取 `/tmp/openbot-worktree-audit/orca.json`、`ps.json` 与 Git 清单；对 `ps` 使用该 CLI `--help` 支持的分页/limit 参数取得完整会话覆盖。
2. 完成非主工作区的 staged、unstaged、untracked、ignored-but-retained 和递归子模块状态扫描；保存每项路径、完整 Orca ID、分支、HEAD、Issue/PR、目标分支、Ledger、会话状态。
3. 对明确目标分支执行 fetch 后记录候选 HEAD，并逐项运行 `git merge-base --is-ancestor <HEAD> <target>`；改写历史合并需要独立的 PR 范围、代码与验收证据。
4. 仅对满足全部门槛的单项执行 Orca `worktree rm`（完整 ID、无 `--force`），每项后重新核对 Orca/Git 列表与 refs，再决定下一项。
