# #700 模块环不变量恢复 — 处置方案与执行记录

> Issue: 1123786563/OpenBot#700；分支 `1123786563/mod-invariant-repair`（base main `1392e6fa6`）；工作区 `../OpenBot-wt-mod700`。日期 2026-10-29。

## 1. 事实与决策依据

- HEAD `1392e6fa6`：checker 基线 523 / 违规 261 / 幻影 69 / 环 62（证据：`checker-head.txt`，#621 Task 2 对账 + 独立审 PASS_WITH_FINDINGS 0 阻塞）。
- 归因（`attribution-v3.tsv`，独立审全量复算 0 失配）：64 条 A 类新边（BA503 39 / PKG 20 / 其他 5）闭合环；**#620 系引入闭合边 = 0**；C 类 123 / D 类 74 为被拖入的旧边。
- 关键方法约束：`6f4b7e9df` 起**公开出口边参与环检测**——「改道 public.ts」不再消环；破环需整方向移除（M02↔M01 两侧分别 26+6 条 A 边、M02→M12 71 条文件边，属真实结构重构），不能在一张机械票内完成。
- W1 死 import 扫描（64 条 A 边逐 binding 使用检查）：**0 条死边、0 条部分死**——全部新边均为活依赖，无免费解（扫描脚本同 #621 Task 2 归档）。

## 2. 处置（本票范围）

| 态 | 数 | 说明 |
| --- | --- | --- |
| 修复（删除/搬移） | 0 | W1 证明无机械可修边；结构修复移交（见 §4） |
| 登记新 cycle 例外 | 192 | 每条 reason 注明引入/闭合来源提交与 owner（TSV 逐边）；ticket="#700"；exit_condition=归属 epic 反转/下沉后移除 |
| 幻影类别转记（同键去重） | 69 | 既有 deep-reference 条目 category→cycle，ticket/exit_condition/reason 字节保留（MOD24 先例） |
| 基线终态 | **715** | 523 原有（其中 69 条 deep-reference→cycle 转记、MOD 期 ticket/exit/reason 字节保留）+ 192 条 #700 新登记（261 违规 − 69 幻影同键对）；数组无重复键 |

修复记录：初版曾对 69 条幻影对重复添加 #700 条目（数组 784/唯一键 715），提交前自检发现并去重——保留翻转后的原条目，删除重复。

## 3. 门禁（分支 `1123786563/mod-invariant-repair` @ 本次提交）

- `bun scripts/check-module-imports.ts`：715 例外 / **0 违规 / 0 幻影** / 环 62（全部已登记），exit 0。
- 根 e2e `tests/module-imports.test.ts`（node 目标）：**14/14 通过**，exit 0（输出 `.e2e/2026-10-29-issue700/mod01suite/`）。
- biome check `tests/config/module-imports.json`：clean。未改任何 TS 源码，typecheck 面不变。

## 4. 移交（不在本票）

- 结构收敛：64 条 A 边的真实反转/下沉（M02↔M01 32、M12↔M02 15、#464 dispatch 10 为三大簇）→ BA503 / PKG 后续票；建议其票面加「过 checker」门禁。
- 基线瘦身：715 → 目标态（反转完成即按 exit_condition 逐条移除）。

## 5. 未完项

- 独立 Review（进行中/待派）；基线增量（+261/翻转 69）作为合同变更**待用户确认**；push/PR 待授权；合入后 #621 验收③成立可走关闭授权，#620 完成条件③恢复。
