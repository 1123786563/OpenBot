# 方案 — #358 后续票池编排（run_1c280a8a8873）

- 日期：2026-10-26｜编排者：Claude｜Run 证据：`.archive/runs/2026-10-26-358-followups/`（主 checkout）
- 根：#358（Craft 预览独立 Origin）收口 Run 产生的 9 张 OPEN 后续票：#647 #648 #649 #650 #651 #652 #654 #655 #659
- 集成：`1123786563/issue-358-followups-integration`；BASE=origin/main `9ee7500c0`（含 #358 全部交付）
- 授权：本地实施/验证/提交/合入集成分支；推送/PR/关票待用户逐步授权（沿 #358 程序先例）

## 1. 票群分形与 DAG

| 节点 | 票 | 类型 | 依赖 | 状态（2026-10-26 收口回填） |
| --- | --- | --- | --- | --- |
| T1 | #648 #649 #650 #647 | craft preview 三文件卫生批（#650 择形=严格解码对齐 verify 臂，理由见 T1 报告 §#650 与 `reviews/T1-review-r1.md`） | — | ✅ verified：审核 Spec 4/4 → 集成 4 笔逐票 SHA（映射见 dag.json；闭区间复核：`git log c5fe329b9^..5b841df30`） |
| T2 | #651 | pass 索引容量/逐出（行为变更） | T1 | ✅ verified：A 臂 N=8 → 集成 `755a2ae5c` |
| T3 | #652 | db 迁移语义（评估+实施） | — | ✅ verified：A 臂原位改写 → 集成 `a9ceb630b` |
| T4 | #655 | agent-sandbox Dockerfile | — | ✅ verified：COPY shared /shared → 集成 `1d4beb954` |
| T5 | #659 | DELETE 重试缺陷诊断+修复+真机复跑 | — | ✅ verified：204/205 早返回+幂等容忍 → 集成 `b45aacfb3` |
| T6 | #654 | same-site/host mint 观察 | — | **blocked(env)**：票面钉 BE-2 环境（同 #416 BE-2 门），票保持 OPEN；解除条件=BE-2 可用或用户批准本地 host-form 等价栈 |
| OCRfix-1 | （#652 伞） | 0210 守卫式迁移（OCR-5 high）+四表命名（OCR-6 medium） | 终门 OCR R1 | ✅ verified：审核双 PASS（3 info）→ 集成 `c400130bb` |
| OCRfix-2 | （#651 伞） | craft rebind 分支逐出补齐（OCR-1 medium） | 终门 OCR R1 | ✅ verified：审核双 PASS（0 findings）→ 集成 `7575ceb2a` |
| OCRfix-3 | （#652 伞） | 0216 守卫硬化（OCR-F5 EXCEPTION + OCR-F6 运行时套件 + OCR-F7 头注史实） | 终跑 OCR review 段 | ✅ verified：审核 PASS/PwF（1 low）→ 集成 `2ba5df211` |

- Wave-1 并行 T1/T3/T4/T5（K=4 依 #358 程序授权）已全部收割；T2 于 T1 集成后 Wave-2 派发并闭环。**8/9 票 verified；T6（#654）blocked(env) 票保持 OPEN**，环境门解除后重估。
- 每代码节点门禁全部走完：实施（claude）→ 独立审核 r1（claude 异会话，Spec+质量双结论）→ 集成+组合验证 → verified。终审：R1（Spec PwF=PASS-with-findings / Quality PASS / 可交付）→ OCR R1 修复波（OCRfix-1/2）→ R2（Spec PwF / Quality PASS / 可交付；Spec 残留 2 low 文档面由编排者回填承接——R2-1 plan 行补、R2-2 锚点更新，见 ledger 09:3x 行）→ OCR 终跑修复波（OCRfix-3；其审核 1 low 入候选池，见 `ocr/ocrfix3-findings-ruling-r1.md`）→ R3（Spec PASS / Quality PwF=PASS-with-findings / **可交付**；2 low 文档面已回填=本文件 §1 OCRfix-3 行与候选池 test-robustness 3 行，见 ledger 11:5x 行）→ 终跑 OCR 重跑与覆盖对账。编号约定：`OCR-<n>`=终门 OCR R1 轮 ID，`OCR-F<n>`=终跑 review 段轮 ID，映射与全裁决见本目录 `ocr/*findings-ruling*.md`（含 `ocrfix{1,2,3}-findings-ruling-r1.md`）与 ledger.md。残留 low 均入候选票池延期跟踪（`candidate-followups.md`）。状态回填以 `.archive/runs/2026-10-26-358-followups/`（主 checkout：dag.json、ledger.md、reviews/、tickets/、ocr/ 全部裁决与报告、candidate-followups.md）为权威证据源；正文相对路径均以该目录为基准。

## 2. 验收映射

- 逐票 AC 以票面原文为准（快照 `tickets/<n>.json`，2026-10-26T02:58Z）；审核按票逐条核验。
- #650 明示允许两臂（严格解码对齐 verify / 注释收窄），择形理由入报告与审核范围。
- #652 明示两臂评估（原位改写 0210 / 新迁移），评估与理由为第一交付物。
- #659 诊断结论为第一交付物；owned_files 由诊断钉定后登记 dag.json。
- #654 阻塞解除条件：BE-2 环境可用，或用户批准本地 host-form 等价栈。重估触发与归属：解除条件满足时由主控（编排者）在下轮 Run 重估并登记 dag.json；本 Run 仅跟踪 blocked 状态，票保持 OPEN。

## 3. 交付与门禁

- 代码节点全部 verified（blocked(env) 节点 T6/#654 除外：票保持 OPEN，按票面解除条件跟踪——BE-2 可用或用户批准本地 host-form 等价栈）→ 集成分支组合验证（定向套件+typecheck 基线+受影响 fresh DB 链）→ 独立终审 → 全范围 OCR（BASE..集成分支；按 review.md L38 修复波后重跑并做覆盖对账，终态以 `ocr/coverage-ledger.md` 为准）→ 报告用户。
- push/PR/GitHub 关票：每步待用户授权（沿 #358 程序节奏）。
