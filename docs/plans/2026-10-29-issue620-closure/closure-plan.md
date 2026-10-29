# #620 收口波与债务票化 — 操作清单（草案，待用户授权后执行）

> 2026-10-29 起草。执行前置：PR #701 已合入 main（#621 验收③随之成立）。本文所有动作均为 GitHub 写入，**未获逐项授权前不执行**。仓库：`1123786563/OpenBot`。

## §1 收口波（27 次写入：25 关票+评论、父票勾选、父票关闭）

### 1.1 前置核验（合并后执行，只读）

1. `bun scripts/check-module-imports.ts` @ 新 main HEAD → 须 **0 违规/0 幻影**（若合并后再现新边：仅登记增量、不阻断其余 24 票关闭，#621 单独等处置）。
2. 根 e2e `tests/module-imports.test.ts` → 14/14。
3. 记录合并后 main SHA 作为收口证据基准。

### 1.2 逐票关闭（顺序无关；统一评论模板）

模板（每票一条评论 + close，不写 `Closes` 关键字到别处）：

> 已验证并集成：verified 提交 `<SHA>`（Orca Run `.archive/runs/2026-10-23-issue620-orchestration/`，独立审核通过，终审=codex v2 通过 + 全范围 OCR r2 零 critical/high）。提交已入 main（2026-10-29 核验为 main 祖先）。遗留项见 `reports/closure2-debt-ledger.md` 及其后续票。

| 票 | verified 提交 | 附加注记 |
| --- | --- | --- |
| #621 MOD01 | `739ccc436`+`8d17ec1f3` | +复查：`6f4b7e9df`(PR #698) 公开环检测；验收③由 #700/#701 恢复（0 违规/0 幻影 @合并后 SHA）；S0 写入清单当前 SHA 复核成立（#621 recheck Task 2 + 独立审 PASS） |
| #622 MOD02 | `90e7f1746` | — |
| #623 MOD03 | `26787bfce` | — |
| #624 MOD04 | `0e31d54ae` | M-7 生产接线延后项已建票（见 §2-D3） |
| #625 MOD05 | `9fd8228ff` | — |
| #626 MOD06 | `bc55d4182` | — |
| #627 MOD07 | `9e6ef2093` | — |
| #628 MOD08 | `5f5528900` | — |
| #629 MOD09 | `3e06f8eb9` | — |
| #630 MOD10 | `cd9f43a02` | — |
| #631 MOD11 | `a44860553` | 外部前置 #618 已 closed(2026-10-25) 后完成 |
| #632 MOD12 | `dcbaf1405` | — |
| #633 MOD13 | `d4e6140c5` | — |
| #634 MOD14 | `9e352088c` | — |
| #635 MOD15 | `16f97f260` | — |
| #636 MOD16 | `592512b6b` | — |
| #637 MOD17 | `b3618eaba` | — |
| #638 MOD18 | `ec94fdc2e`（`1b650cf26` 同入） | — |
| #639 MOD19 | `9dd28588d` | — |
| #640 MOD20 | `7b8e3f1fd` | — |
| #641 MOD21 | `46c77a0c5` | — |
| #642 MOD22 | `7acec616d` | 外部前置 #619 已 closed(2026-10-25) 后完成 |
| #643 MOD23 | `d5ba262c1` | — |
| #644 MOD24 | `d4dc024ed` | B3/G-1 设计缺口已建票（§2-D2） |
| #645 MOD25 | `29c3ffaa5`（七提交栈） | 收口票：P2 例外收窄、P3 M-1/2/4/5/9 清零、P4 AR01–AR18 映射（AR05/AR10 薄→§2-D2）；42 skip→§2-D1 |

### 1.3 父票 #620

1. 评论：五条完成条件逐条对应证据（①run DAG 25/25+提交入 main；②AR01–AR18 映射=MOD25 P4 工件、AR05/AR10 薄项转 §2-D2；③#701 合入恢复+0 违规核验；④codex 终审 v2+OCR r2 全范围+两轮独立审；⑤逐票授权范围 diff，稳定 ID/Payer/wire 保留）。
2. 正文 5 个 `- [ ]` 勾为 `- [x]`（状态更新，不改需求文本；若你不愿动正文则跳过，仅评论+关闭）。
3. close as completed。

标签：默认不动 `ready-for-agent`；如需加 `agent:verified` 类标签另说。

## §2 债务票（8 张新建；D1/D2 需产品决策不贴 ready-for-agent，其余贴）

| # | 标题草稿 | 标签 | 来源 |
| --- | --- | --- | --- |
| D1 | [MOD 债务] 扩门面决策：42 条未上公开出口符号（auth/approvals/plugins/routines/agents/channels） | enhancement | closure2 B1+B2 |
| D2 | [MOD 债务] AR05 撤权串行化与 AR10 重放/未知费用交错级专项验证钉 | enhancement | closure2 B3、MOD24 G-1 同族 |
| D3 | [MOD 债务] 生产首条接线装配：credentialLease 链、6 operator 连接池消费者、readPinnedSkills 接线 | enhancement, ready-for-agent | closure2 M-7+C6 |
| D4 | [MOD 债务] mastra 接线：mastraContinuationRouteDeps 已构造未挂载 | enhancement, ready-for-agent | closure2 M-8 |
| D5 | [MOD 债务] http.ts cancel/audit-failed catch 日志纪律 + lifecycle 启动中段回滚窗口 | enhancement, ready-for-agent | closure2 M-3+M-6 |
| D6 | [工具债] scripts/test-db.ts --down 增加归属过滤（两次误删他属容器事故） | bug, ready-for-agent | closure2 C1 |
| D7 | [harness 债] committed manifest 陈旧态全量重建 + e2e 覆盖调度缺口（SUITE_DIRS 死目录） | enhancement, ready-for-agent | closure2 C2+C8 |
| D8 | [MOD 结构债] 64 条环闭合边反转：M02↔M01×32、M12↔M02×15、#464 dispatch×10 及余量（逐簇移交 BA503/PKG；票面门禁=过 checker） | enhancement, ready-for-agent | #700 移交 |

各票正文要点（建票时展开）：目标/验收（D8 验收=反转后按 exit_condition 逐条删除基线条目并复跑 checker 收缩）/文件范围/来源 ledger 行/约束（保持行为、稳定 ID、Payer、wire）。D6 复验=构造双 project 误删场景负向测试。C9 存量 tsc/drift 不建票（#699 吸收 tsc；pin 漂移并入 D7）。

## §3 一次授权粒度

- A（收口波）：§1 全部 = 27 写入（25 评论+关闭、父票评论+勾选+关闭）。
- B（债务票）：§2 全部 = 8 建票（含标签）。
- 可单独授权 A 或 B，或 A+B。
