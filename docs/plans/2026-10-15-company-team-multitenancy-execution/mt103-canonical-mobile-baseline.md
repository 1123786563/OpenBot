# MT103 — Canonical 移动端可审查基线（openmuse submodule）

> 任务：MT103 / Issue #146（Epic #204）。本文件是冻结归属下的基线说明；完整差异结论见 `reports/MT103.md`，实测命令输出见 `checkpoints/MT103/verification.txt`。

## 基线定义

| 项 | 值 |
| --- | --- |
| 基线工作区（任务专用，唯一被写入的检出） | `/Users/wuyongjun/orca/workspaces/OpenBot/i6-mt103`（Orca child worktree，分支 `1123786563/i6-mt103`） |
| 父仓 BASE / HEAD | `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（全程未变更） |
| 固定 gitlink（基线树） | `apps/openmuse` → `46792335dfc260efa05f2185aa353093b12d9937`（`160000 commit`；`.gitmodules` 无 branch pin） |
| submodule 检出 | init 自 `https://github.com/1123786563/openmuse`，检出即 gitlink 提交 `4679233`（"将移动端 UI 本地化为中文并添加 OpenBot 集成文档"，2026-10-12） |
| canonical 对照 ref | `origin/main` = `81d0d3a15a27b00e24b2bed6f8b24c5b4d5330b4`（fetch 进 remote-tracking，未改检出） |
| 差异区间 | `46792335dfc260efa05f2185aa353093b12d9937..81d0d3a15a27b00e24b2bed6f8b24c5b4d5330b4`（2 commits：`6e3a131` 适配层、`81d0d3a` review 修复；161 files，+17162/−28） |
| 缺失适配层 | `apps/mobile/src/openbot/`（33 源文件）+ `apps/mobile/test/openbot-*.test.ts`（20 套件）+ `apps/mobile/App.tsx` 接线 + better-auth/@better-auth/expo 等依赖 —— 在 gitlink 检出中均不存在 |

## 基线语义与审查方式

- 工作区树 == OpenBot BASE（gitlink 未动）；submodule HEAD == gitlink 提交，回答「pin 里有什么」。
- `origin/main` 仅存在于 remote-tracking refs，回答「canonical 多什么」，无需移动检出：

```bash
cd /Users/wuyongjun/orca/workspaces/OpenBot/i6-mt103
git submodule status apps/openmuse                 #  4679233...（= gitlink，clean）
git -C apps/openmuse log --oneline HEAD..origin/main   # 81d0d3a / 6e3a131
git -C apps/openmuse diff --stat HEAD..origin/main | tail -1
git -C apps/openmuse ls-tree -r --name-only origin/main -- apps/mobile/src/openbot | wc -l   # 33
ls apps/openmuse/apps/mobile/src/openbot           # No such file or directory（pin 无适配层）
```

## 复核锚点（版本标识）

- 父仓：`f0520524f0faa2b4533b9d2f1aa692c8f907ba71`；gitlink 引入提交 `27829833c615e3170a49a60aca9e816416f00b9e`（同提交删除 `apps/openmuse-mobile/`）。
- openmuse：pin `46792335dfc260efa05f2185aa353093b12d9937`（2026-10-12 22:15 +0800）→ `6e3a131558fbeaeab2564814e85f3e38467a8eb3`（2026-10-14 18:24 +0800，适配层）→ `81d0d3a15a27b00e24b2bed6f8b24c5b4d5330b4`（2026-10-14 18:43 +0800，review 修复；远端 `refs/heads/main` 实测值）。
- 结论：**gitlink 固定在 pre-adapter 提交；「缺少适配层的旧 gitlink ≠ 已完成集成」。gitlink 前移到 `81d0d3a1` 是 MT104 的第一前提**（详见 `reports/MT103.md` §5）。

## 边界声明

- 未修改外部主工作区（父执行工作区 submodule 保持未初始化 `-4679233`/`-f10954f`；对 `/Users/wuyongjun/trea/*` 本地 clone 仅只读查询）。
- 未重建已删除的旧移动应用目录（各工作区 `apps/` 下无 `openmuse-mobile`）。
- 未更新 gitlink、未提交、未推送（无授权）；`bifrost` submodule 与本任务无关未动。
