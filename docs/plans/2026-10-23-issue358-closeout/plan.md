# 方案 — #358 Craft 预览独立 Origin 聚合收口（2026-10-23-issue358-closeout）

- 根 Issue：1123786563/OpenBot#358（已批准 Spec，AC1–AC9）
- Run：Orca `run_dff077721387`；证据目录（主 checkout）`.archive/runs/2026-10-23-issue358-closeout/`
- 集成分支：`1123786563/issue-358-closeout-integration`（Worktree `/Users/wuyongjun/orca/workspaces/OpenBot/issue-358-closeout-integration`）；原始 BASE `4f88d9b310`
- 前序：`2026-10-23-craft-preview-404-419` Run（#404–#419）已全量并入 main 且 OCR R6 零 finding——本轮不重复派发其 verified 范围
- 授权：本地任务/集成分支提交与合并；push/关票/#358 正文写入待授权（PA 清单见 ledger）

## 背景与缺口判定（摄取结论）

32 张正式子 Issue（10 closed / 22 open）+正文提及 #359–#367（closed，不扩范围）。当前 main 已含 #433/#437/#425/#431-T1T2/#436 的实现（内容级核验，见 scope.json prior_runs_reconciled 与摄取事件），真缺口收敛为：

1. open 实现票在**当前 HEAD** 的验收锚定与裁决（尤其 #427 轮换语义 vs #431 签名 pass）；
2. 真机验收链证据（#437 Acceptance、#431-T3、#414、#416 dev 拓扑复跑——main 已修上轮 FAIL 归因）；
3. fresh-DB 链在当前 HEAD 复验（#436，其后新增 0188–0208）；
4. AC1–AC9 聚合证据表与终审。

blocked(env)：#412 公网签发、#416 same-site live、#431-T4 staging DNS、CI 实跑——记录解除条件，不记为通过。

## DAG（K=4）

| 节点 | Issue | 依赖 | 角色 | 交付 |
| --- | --- | --- | --- | --- |
| N0-audit | #425/#427/#431/#433/#436/#437 | — | Pi(researcher) | 逐票 verdict + GAP 清单 + 回归清点 |
| N1-freshdb | #436 | — | Pi(backend_validator) | fresh-DB migrate/drift/boot 证据 |
| N2-live | #437/#431-T3/#414/#416 | — | Pi(backend_implementer+live) | 真机链 + TOPOLOGY=dev 复跑证据 |
| N3-closeout | #358/#419 | N0,N1,N2 | Pi(mechanical) | AC1–AC9 证据表 + 收口增量 |
| N4-final | #358 | N3 | Codex + OCR | 终审与全范围 OCR |
| fix-* | 按 finding | 对应节点 | Pi | 修复与复验 |

节点接口细节见 `.archive/runs/2026-10-23-issue358-closeout/dag.json`；Brief 见同目录 `briefs/`。

## 执行

1. Wave 1 并行派发 N0/N1/N2（三任务树自集成分支当前 HEAD 派生；owned_files 均空、资源互不冲突：N0 纯单测、N1 容器内 5432+空闲宿主端口、N2 server 端口+沙箱+隔离库）。
2. 每任务：Pi 完成 → 固定检查点（报告+`git status`+HEAD）→ 编排者经 Orca 在**同一 Worktree** 启动新 Claude 做 Spec compliance + code quality 审核（只读）→ 有效 finding 回 Pi 整改（新 attempt/检查点）→ 新 Claude 复审 → 通过后编排者串行集成（真实合并或显式转移）并在组合树跑适用验证 → 释放下游。
3. GAP → fix 节点（同流程）；BE/PA 不阻塞非受影响节点。
4. 全部交付节点集成且聚合验收有当前代码证据后：冻结终审范围（BASE..集成 HEAD + 未提交交付），Orca 启动新 Codex 完整终审；同时编排者跑全范围 OCR（open-code-review，--audience agent）。有效问题回 Pi→Claude→集成循环，修复后重做完整终审。
5. 收口：最终报告（逐 Issue 验收/验证/审查/集成 SHA/遗留），PA 清单交用户裁决。

## 验证策略

- 单任务：票面验收 + 声明套件（craft 8 套件、agent-sandbox proxy/webapp、fresh-DB 四连、TOPOLOGY=dev）。
- 集成：每次合入后在组合树复跑受影响套件；终局全量 craft 域 + tls + guard。
- 测试纪律：`.agents/rules/testing.md`（容器记录/清理、.e2e 结果目录）。

## 失败与恢复

- 阶段失败重试阶段；代码 finding 回 Pi；集成回归以失败组合树为基线修复；环境缺失记 BE 并给解除条件。连续两轮同 finding 无进展 → systematic-debugging + 升级。回执不明先对账 Orca/Git/Ledger，不重派。
