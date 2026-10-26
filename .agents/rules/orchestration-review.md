# Orca 编排审核与 Issue 交付

在 [Orca 编排](orchestration.md)中启动独立任务审核或集成终审、处理 finding 或关闭 Issue 时读取。Agent 候选与身份见 [Agent 选择](orchestration-agents.md)；本文件补充 [Review/OCR](review.md)，报告与回执按 [产物归处](artifacts.md)存档。

## 任务级独立审核

编排者在实施 Agent 写入停止、检查点和验证证据固定后，经 Orca `worker-start` 在同一任务 Worktree 派发按 [Agent 选择](orchestration-agents.md)确定的独立审核阶段，记录其 Task/Dispatch。Brief 给出 Issue 验收、批准事实源、前置接口、完整任务增量、检查点哈希、验证结果和只读范围。审核 Agent 分别给出 Spec compliance 与 code quality 结论，并以 finding ID、严重度、位置、影响和证据报告问题。

编排者核实 finding；按 [review.md](review.md)统一阈值裁决，有效 critical/high/medium 问题形成原实施 Agent 的整改 Brief，原任务分支和 Worktree 保留。整改后重新固定检查点并补相关验证，编排者再经 Orca 启动新的独立审核轮次。每轮报告、finding 裁决、实际 Agent 身份和启动回执单独保存。误报记录反证；真实问题不得为结束循环降级。未通过前禁止集成。

## 集成后的终审与 OCR

所有任务通过独立审核、已集成到工作树并通过组合验证，根级验收无遗漏且[终审前 rescan](issue-delivery.md)通过后，编排者停止写入、固定完整范围。经 Orca `worker-start` 派发新的[终审 Agent](orchestration-agents.md)，对**按 [checkpoints.md](checkpoints.md)核对的完整授权范围（含提交映射及未提交内容）**做完整 Spec/质量审核；保存 Task/Dispatch、回执、范围、结果和 findings。终审通过后，外层 `open-code-review` 按 [Review 规范](review.md)对同一完整范围运行，二者均须通过。

终审或 OCR 发现有效问题时，按受影响 Task 建立修复 DAG/方案，从集成 HEAD 通过 Orca 创建修复工作区，按[检查点规范](checkpoints.md)应用并核对完整前置树（终审 finding 或集成回归可使用冻结失败检查点，仅限修复任务）后才派发实施者；未提交模式不能只从 HEAD 开始。独立审核、集成并重跑组合验证后，内容改变须重新完整终审与 OCR。旧报告仅作历史；轮次、升级与阻塞按 [Review 规范](review.md)。

## Issue 关闭与清理

每个 Issue 仅在以下条件全部成立时可关闭：任务及根级聚合验收通过，当前交付检查点的验证、独立审核、终审、OCR 通过，且代码已按授权进入 Run 初始化时约定的交付目标。目标为 main 时须核实目标远程分支的实际 SHA；本地集成分支、PR 已创建或代码 verified 均不替代目标交付。若明确约定 PR/分支本身为验收交付物，保存该约定及可访问的交付引用，不默认推导关闭权限。

关闭前及推送/合并前执行 [delivery-gates.md](delivery-gates.md) 的新鲜度、目标 SHA 的 CI、写入意图、写后完整 rescan 和失配纠正门禁。目标/交付树改变后必须重新完整终审与完整 OCR；父 Issue 另验自身要求。无关闭授权记 `close_pending`，错误写入待纠正记 `close_correction_pending`；未进入目标记 `integration_pending`。旧方案中的标签和评论只在本轮明确启用时同步，不代替关闭条件。

任务分支在其变更已集成、组合验证通过、证据可恢复且无活跃会话后清理；集成工作区在全部 Issue 状态及 Git 交付去向确认后，按 [Worktree 规范](worktrees.md)收尾。分支清理前核对已合并、未提交及未跟踪文件、Orca Worker、报告和 Ledger；未知或未集成内容保留。最终报告逐 Issue 列出验收、关闭状态、验证、独立审核/终审/OCR 结果、集成 SHA、剩余分支与阻塞。
