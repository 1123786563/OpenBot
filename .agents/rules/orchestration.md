# Orca 多 Agent Issue 编排

使用 Orca 协调多 Agent，或规划/审查/恢复编排 Run 时读取。先核当前 `orca-cli`、`orchestration` 技能及版本指南；Orca 是工作区、Agent、监督 Task/Dispatch 的事实源，argv/能力按当前帮助与回执。

## 运行边界与职责

一个 Run 只有一个主控、集成工作区/分支和交付入口。普通实施绑定一个根 Issue；[每日批次](closed-issue-daily-run.md)用不可变 source_issues/scope，不虚构父票。登记仓库、原始 BASE、授权、交付目标、并发授权/预算和唯一证据根；Task 分别绑定来源/finding/授权，批次读范围不授予写权。

主控负责摄取、计划、派发、集成、裁决和收尾；Worker 不再派发，Brief 提醒其他编辑者并保护其改动。只读研究/计划/Review 保持只读范围。

| 决策 | 权威合同 |
| --- | --- |
| 需求完整性、contains/depends_on、验收/DAG、全部 rescan 时点 | [issue-delivery.md](issue-delivery.md) |
| 风险档位、自足 Brief、实施授权 | [execution.md](execution.md) |
| Agent 候选、独立性、能力升级 | [orchestration-agents.md](orchestration-agents.md) |
| 权威 attempt、消息、资源、失败与恢复 | [orchestration-protocol.md](orchestration-protocol.md) |
| 任务审核、终审/OCR、交付收尾 | [orchestration-review.md](orchestration-review.md) |
| 工作区、前置树、证据 | [worktrees.md](worktrees.md)、[checkpoints.md](checkpoints.md)、[artifacts.md](artifacts.md) |

## 监督派发

实施、任务审核、整改复审、终审均用 `worker-start`，记录业务 Task→Orca Task/Dispatch；建工作区与启动分开，普通 launch 不替代监督回执。

Brief 在执行规范基础上增加 Task/attempt/Dispatch、角色/预期 Agent、资源、预期验证结果、失败上报条件；事实源定位章节/版本。保存完整启动回执，核实际 Agent、Task/Dispatch、主机、工作区、handle；远端按 Dispatch 寻址。失败/响应丢失先按协议对账权威 attempt、failedStage/residualResources，不盲重启或混用普通 launch 参数。跟进走监督消息；接受输入不等于已读或完成。

## 分支与 Worktree 容量

- 唯一集成工作区按 Worktree 规范建立/复用；就绪 Task 从集成 HEAD 按需派生，每活跃 Task 一个任务工作区，实施/整改/审核复用。Brief 写明提交策略，无授权则使用未提交检查点，不声称分支合并。
- 启动须取得全部前置树：正常业务 `deliverable_verified`，限定修复可用 `frozen_failed`。未提交/混合内容另还原并核 manifest，HEAD 一致不够。
- K=4 个活跃任务工作区，另加一个集成工作区；开发/整改/审核均占任务名额。每日 P 管在途 Task/Dispatch，C 管 slot；三者不互代，也不授予并行实施权。派发还须满足 DAG、文件/接口、资源和实际 Worker 槽位。
- 只有前置成果进入实际集成树且组合验证通过才派生业务后继。完成后按保全条件释放名额；未知状态/未集成内容/有效会话保留。终审修复从完整失败组合树派生，不复活已清理工作区。

## DAG 调度与单任务阶段

实现 → 停止写入并结算 Dispatch → 独立行为验证及 Spec/质量审核 → 串行集成/组合验证 → 已集成 verified → 释放业务后继。

行为/审核合并条件按 Agent 选择合同；worker_done、closed、exit 0、ready 列表均不单独证明 verified。缺页/冲突仅放行有证据证明不受影响的任务。

### 独立审核通过后合入集成分支

1. 核已审检查点、HEAD、完整增量和验证；停止任务写入，锁集成树，记录集成前树/已验前置。审核后变化须新检查点与复审。
2. 按授权合入已审提交或完整未提交检查点，核增量/哈希并保留用户基线。
3. 冲突或超范围增量固定新检查点并独立审核；在实际组合树验本任务及受影响行为，保存命令/退出码和前后版本。失败保留树并阻止业务后继。
4. 内容一致、组合通过后才记已集成 verified；逐任务串行集成，再归档并安全释放。

## 完整交付

全部交付 Task 已集成、根聚合验收通过；每日批次另含全部交付 source_issues 及必要父聚合。按编排审核合同执行新会话完整终审、OCR 和修复回路；目标变化后的完整重审要求保持。推送/合并及 GitHub 写入执行 [delivery-gates.md](delivery-gates.md)，权限不由 Run 推导。
