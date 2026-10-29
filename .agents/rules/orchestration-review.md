# Orca 编排审核与 Issue 交付

任务审核、集成终审、finding 或关闭时读取。以下是 [review.md](review.md)的 Orca 增量要求；[Agent 选择](orchestration-agents.md)管候选/独立性，[artifacts.md](artifacts.md)管报告。

## 任务级独立审核

实施写入停止、检查点/验证固定后，主控在同一任务 Worktree 用 `worker-start` 启动独立审核，记录 Task/Dispatch。Brief 含 Issue 验收/批准来源、前置接口、完整增量/检查点哈希、验证和只读范围；报告分列 Spec/质量，finding 列 ID、严重度、位置、影响和证据。

finding 阈值/争议/轮次统一按 Review 规范。有效 critical/high/medium 返回原实施者，保留原任务分支/Worktree；整改后新检查点、相关验证，再启动新的独立审核轮次。分别保留报告/裁决/身份/回执；未通过不得集成。

## 集成后的终审与 OCR

全部任务审核/集成/组合验证及根验收完成，且[终审前 rescan](issue-delivery.md)通过后，停止写入并固定完整授权范围（含提交映射与未提交内容，按 [checkpoints.md](checkpoints.md)核对）。用 `worker-start` 另启终审会话做完整 Spec/质量审核，随后主控按 Review 规范执行同范围 OCR；保存实际覆盖、Task/Dispatch/回执及结果，两关均须通过。

终审/OCR finding 按受影响 Task 建修复 DAG/方案，从集成 HEAD 按 [worktrees.md](worktrees.md)创建修复工作区，并取得完整前置树；可用 frozen_failed 但仅限修复。独立复审、串行集成、组合回归后，内容变化须重新完整终审/OCR，旧报告仅作历史。轮次与升级按 Review 规范。

## Issue 关闭与清理

关闭须同时满足当前检查点的任务/根聚合验收、验证、独立审核、终审/OCR，且已按授权进入约定交付目标。目标/默认 main、可访问交付引用、CI、新鲜度、条件写、写后 rescan 与纠正统一按 [delivery-gates.md](delivery-gates.md)；本地 verified/已开 PR 不替代目标交付。目标/交付树变化后仍重新完整终审/OCR，父票另验自身要求。

无关闭授权记 close_pending，错误动作待纠正记 close_correction_pending，未交付记 integration_pending；旧方案中的标签/评论只有本轮明确启用才同步。

任务分支须已集成、组合通过、证据可恢复且无活跃会话；集成工作区另须全部 Issue 状态和 Git 去向确认。按 Worktree 规范完整保全后收尾，未知/未集成内容保留。最终逐票列验收/关闭、验证/审核/终审/OCR、集成 SHA、剩余分支与阻塞。
