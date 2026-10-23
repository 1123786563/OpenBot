# Orca 编排审核与 Issue 交付

在 [Orca 编排](orchestration.md)中启动独立任务审核或集成终审、处理 finding 或关闭 Issue 时读取。Agent 候选与身份见 [Agent 选择](orchestration-agents.md)；本文件补充 [Review/OCR](review.md)，报告与回执按 [产物归处](artifacts.md)存档。

## 任务级独立审核

编排者在实施 Agent 写入停止、检查点和验证证据固定后，经 Orca 在同一任务 Worktree 启动按 [Agent 选择](orchestration-agents.md)确定的独立审核 Agent。Brief 给出 Issue 验收、批准事实源、前置接口、完整任务增量、检查点哈希、验证结果和只读范围。审核 Agent 分别给出 Spec compliance 与 code quality 结论，并以 finding ID、位置、影响和证据报告问题。

编排者核实 finding；有效阻塞问题形成原实施 Agent 的整改 Brief，原任务分支和 Worktree 保留。整改后重新固定检查点并补相关验证，编排者再经 Orca 启动新的独立审核轮次。每轮报告、finding 裁决、实际 Agent 身份和启动回执单独保存。误报记录反证；真实问题不得为结束循环降级。未通过前禁止集成。

## 集成后的终审与 OCR

所有任务已通过独立审核、合入集成分支并在实际组合树上通过适用检查，根 Issue 的聚合验收无遗漏后，编排者停止集成写入并固定终审范围。经 Orca 启动新的[终审 Agent](orchestration-agents.md)，在集成 Worktree 对**原始 BASE 至当前 HEAD 加全部未提交交付内容**做完整 Spec/质量审核；保存回执、范围、结果和 findings。终审通过后，外层 `open-code-review` 按 [Review 规范](review.md)对同一完整交付范围运行，二者均须通过。

终审或 OCR 发现有效问题时，按受影响 Task 建立修复 DAG/方案，从当前集成 HEAD 通过 Orca 创建修复工作区，由选定的实施 Agent 整改、独立审核 Agent 审核、编排者集成并重跑组合验证。内容改变后重新进行完整终审与 OCR；旧通过报告仅保留为历史。两轮同一问题无进展、缺环境或权限等按 [Review 规范](review.md)记录阻塞和恢复条件。

## Issue 关闭与清理

每个 Issue 的任务与验收映射均 verified、代码在集成分支、根级聚合验收通过、当前代码检查点的验证及独立审核、终审、OCR 通过、交付代码位置可追溯后，才具备关闭条件。父 Issue 另核对自身未被子 Issue 覆盖的要求。关闭属于 GitHub 写入；编排者核对当前运行授权后执行，保存关闭回执与证据链接。无授权或回执不明时记录待关闭状态，不把代码 verified 改写为 Issue 已关闭。旧方案中的 `agent:ready-for-review` 标签和评论只在本轮明确启用时同步，不代替关闭条件。

任务分支在其变更已集成、组合验证通过、证据可恢复且无活跃会话后清理；集成工作区在全部 Issue 状态及 Git 交付去向确认后，按 [Worktree 规范](worktrees.md)收尾。分支清理前核对已合并、未提交及未跟踪文件、Orca Worker、报告和 Ledger；未知或未集成内容保留。最终报告逐 Issue 列出验收、关闭状态、验证、独立审核/终审/OCR 结果、集成 SHA、剩余分支与阻塞。
