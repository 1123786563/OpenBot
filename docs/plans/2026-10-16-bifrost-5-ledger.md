# Bifrost-5 Ledger（可恢复状态）

- Orca Run: `run_f470ca949934`（objective：Bifrost-5 实施 151 Ticket）
- 快照: `.omc/research/bifrost5/tickets.json`（151 票正文/状态/依赖，2026-10-16 摄取）
- DAG/波次/AC 映射: `docs/plans/2026-10-16-bifrost-5-dag.md`
- 计划: `docs/plans/2026-10-16-bifrost-5-implementation.md`
- 集成基线: 主 checkout `/Users/wuyongjun/trea/OpenBot`（main @ bab7c0b9 起，未提交增量累积；各 worker 子 worktree 名 `b5-<ticket>`）

## 票据状态

| 票 | 组 | 状态 | Task ID | Dispatch ID | Worktree | 检查点 | 备注 |
|---|---|---|---|---|---|---|---|
| #207 | 01.1 | fixing | task_5749a47a5506 | ctx_ebf5528c37e6 + fix ctx_b5868d026992 | b5-207 | ckpt ✓ | coordinator 验证过（33/33）；review：1 high F1 首存竞态 + 5 low；fix 轮运行中 |
| #209 | 01.3 | **verified+integrated** | task_8047fcd8feb2 | ctx_082fa912af1a | b5-209（已释放） | ckpt ✓ | review 通过（0 中高危/1 low 注释错位）；4 文件集成哈希全过 |
| #215 | 02.1 | **verified+integrated** | task_edf454823ae8 | ctx_6a95c7bcb7c5 | b5-215（已释放） | ckpt ✓ 复审版 | M1/L2 修复后复审通过（21/21×3）；7 文件集成；下游 #216/#217/#218/#290 解锁 |
| #216 | 02.2 | **verified+integrated** | task_063427f47b8a | ctx_18775224f825 | b5-216（已释放） | ckpt ✓ | review 通过（0 中高危/2 low）；3 文件自有增量集成 |
| #218 | 02.4 | dispatched | taskmap['218'] | ctx_d31166b64382 | b5-218 | | 运行中；20 文件集成层同步 |
| #234 | 04.1 | **verified+integrated** | task_8142899ca59b | ctx_998ae61aff46 | b5-234（已释放） | ckpt ✓ | review 通过（0 中高危/2 low）；22 直复制 + 迁移重编号 0123 + snapshot 合并（补 public.payer_accounts）+ journal 追加；集成层全量验证 73/73 + 双 typecheck 0；#235 解锁 |
| #235 | 04.2 | dispatched | taskmap['235'] | ctx_22b0951ca847 | b5-235 | | 运行中；44 文件集成层同步 |
| （其余 144 张） | | pending | 已建 task 行 | | | | 票→task_id 映射：`.omc/research/bifrost5/taskmap.json` |

集成模型：无 commit 授权下，每票验收后 coordinator 将其 worktree 未提交增量显式复制进主 checkout 集成层；下游 worktree 创建后、worker 启动前，coordinator 先把集成层同步进该 worktree（含哈希核对），再 `worker-start --worktree <exact>`。

## 事件日志

- 2026-10-16 T1：Issue #5 + 151 票摄取；DAG 验证通过；Run `run_f470ca949934`；151 task 行建好。Wave 1 派发（全部 pi/ready）。
- T2：**4 速率限流事件**——glm-5.3 账户 429（4 并发超限），#207/#209/#234 agent idle。裁决：并发降至 ≤3，串行唤醒，不重派不丢工。#215 未受影响完成。
- T3：#215 全流程闭环（验证 18/18→审阅 1 medium→修复 M1+L2→复审 21/21×3 通过）→ 集成主 checkout（7 文件哈希全过，typecheck+21/21 复验）→ 释放终端。
- T4：#207 coordinator 验证 33/33 + review（Spec 合规通过、F1 high 实测复现首存竞态）→ fix-207 派发（F1+F2+F4+F6）。#209 验证 22/22 → review 运行中。#234 唤醒。

- T5：#209 review 通过（1 low 注释错位，记录）→ 集成 → 释放。#216 全流程闭环（review 0 中高危）→ 集成 → 释放 → #218 派发（20 文件同步）。
- T6：#234 question 裁决（允许填票据 Checkpoint 段，仅追加）；#234 完成（23/23）→ review 通过（2 low/2 info）→ 集成（0122→0123 重编号、snapshot 合并、journal 链修正）→ 集成层 73/73 全绿 + server/app typecheck 0 → 释放 → #235 派发（44 文件同步）。
- T6a：**事故记录**：集成库 URL 拼接错误（/openbot/openbot_b5_int1 双路径）导致 migrate 连接失败；核查 live openbot 库确认未受影响（无新表、110 基线迁移）。教训：TEST_DATABASE_URL 构造必须用 sed 替换末尾库名。
