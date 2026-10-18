# 基线对照记录（无本票改动的全量跑）

- 时间：2026-10-16T19:35Z 前后（本票终验之前，同会话实测）。
- 方法：`git stash push -u -m "mt080-wip" -- app/`（仅 app/ 侧本票改动入 stash，server 侧他人交付不动）→
  `cd app && bun test` 全量 → 记录 → `git stash pop` 恢复（pop 已验证成功，文件清单与 stash 前一致）。
- 实测输出（摘要，转录自该次真实运行；当时未重定向存档，故以本记录如实转述）：

```
   2 (fail) reopening Remember a fact after a failure starts clean [16337.36ms]
   2 (fail) reopening Add source after a failure keeps the draft but not the failure [44210.83ms]
   2 (fail) reopening a research row after a failure starts without it [16120.89ms]
   2 (fail) closing the dialog keeps the link code, so reopening the row shows it again [31358.83ms]
   1  4 fail
   1  1407 pass
```

- 结论：与本票在场时的全量跑（`5-full-app-suite-final.txt`：1432 pass / 4 fail）**同一批 4 个用例失败**
  （bot-memory / composio-picker-add-error / github-sources-settings，超时 12-44s），隔离单跑全过
  （`6-flaky-tests-isolated-pass.txt`）——属全量并发下的负载抖动，**非本票引入**。
- 账目：1407（基线）+ 25（本票新增用例）= 1432（本票在场全量 pass 数），吻合。
