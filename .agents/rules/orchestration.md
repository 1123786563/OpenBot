# Orca 多 Agent Issue 编排

使用Orca协调多Agent、规划/审查/恢复编排Run时读取。先读当前 `orca-cli`、`orchestration` 技能和版本匹配指南；Orca是工作区、Agent与监督Task/Dispatch的事实源，命令/能力以当前回执为准。

## 运行边界与职责

- 普通代码实施绑定一个根Issue；每日批次按[每日规则](closed-issue-daily-run.md)使用不可变source_issues/scope，不虚构父票。每Run只有一个主控、集成分支/工作区与交付入口，登记仓库、原始BASE、授权、交付目标、并发授权/预算及证据根。Task逐项绑定来源/finding/授权，批次不授予全部票写权。
- 主控负责摄取、计划、派发、集成、裁决与收尾；Worker不得再派发，Brief说明其他编辑者存在并保护其改动。只读研究/计划/Review按用户范围执行，不启动实施、集成或关闭。
- 需求完整性、contains/depends_on、DAG验收映射和全部rescan时点按[Issue摄取](issue-delivery.md)执行；领域、风险和授权按[执行规范](execution.md)。缺页/冲突仅放行有证据证明不受影响的任务。
- 方案/执行证据按[产物归处](artifacts.md)，Ledger索引权威attempt、实际Agent、工作区、前置树、验证/Review/集成状态；恢复先核Git/Ledger/Orca，避免重派。

## 监督派发

实施、任务审核、整改复审和终审均用监督式 `worker-start`，记录业务Task→Orca Task/Dispatch；建工作区与启动分开，普通launch不替代监督回执。具体argv向当前技能/帮助查询，不复制历史示例。

Agent候选、每轮预期/实际身份、会话独立性和改选/升级按[Agent选择](orchestration-agents.md)。保存完整启动回执，核Agent、Task/Dispatch、主机、工作区、handle；远端按Dispatch寻址。失败/响应丢失先对账权威attempt、`failedStage/residualResources`及当前恢复指南，不盲重启或混用普通launch重试参数。

跟进走监督消息与回执；接受输入不等于已读/完成。消息去重、持久化再ack、Worker复用/保留/释放及未知状态处置按[编排协议](orchestration-protocol.md)。

Brief沿用[执行规范](execution.md)的自足合同，另带Task/attempt/Dispatch、角色与预期Agent、资源、预期验证结果及失败上报条件；事实源定位到章节/版本，长日志留Run。

## 分支与 Worktree 容量

1. 按[Worktree规范](worktrees.md)建立/复用唯一集成分支和工作区，记录BASE；无关未提交改动留原处，必要文档显式转移。Brief写提交策略：有授权才提交/合并；否则转移未提交检查点，不以空BASE..HEAD审查或声称分支合并。
2. 就绪Task从集成HEAD按需建一个任务分支/工作区，实施、整改、独立审核复用。启动前按[检查点规范](checkpoints.md)取得完整前置树：正常业务为deliverable_verified，限定修复可为frozen_failed。未提交/混合内容须额外还原并核manifest，HEAD一致不够。
3. K=4个活跃任务工作区，另加一个集成工作区；开发/整改/审核都占任务名额。实现默认串行，明确且有效授权才并行；K不授予权限。每日P限制实际在途Task/Dispatch及审核，C/K/P不互代；DAG、文件、接口、资源及Worker槽位同时满足才派发。
4. 下游只在前置成果进入实际集成树并组合验证通过后派生；多个独立任务串行集成。任务完成按保全/清理规范释放名额；未知状态、未集成增量或有效会话保留。终审修复从完整失败组合树派生限定修复，不复活已清理工作区。

## DAG 调度与单任务阶段

实现→停止写入并结算Dispatch→独立行为验证及Spec/质量审核→串行集成/组合验证→已集成verified→释放业务后继。

独立会话、行为/审核可合并的条件、角色和报告按[Agent选择](orchestration-agents.md)；任务审核、finding裁决/整改复审与轮次按[编排审核](orchestration-review.md)及[Review](review.md)。worker_done、closed、exit0或ready列表不单独证明verified。完整业务前置条件、资源声明和恢复按[编排协议](orchestration-protocol.md)。

### 独立审核通过后合入集成分支

1. 核通过的检查点、分支HEAD、完整任务增量和验证；停止任务写入，锁集成树，记录集成前HEAD/工作树/已验前置。审核后变化先定新检查点并复审。
2. 按提交授权合入已审提交，或显式转移完整未提交检查点；核实际增量/哈希并保护原有改动。未提交内容进入工作树不等于分支合并。
3. 冲突或范围外新改动固定新检查点并独立审核新增增量；在实际组合树验本任务及受影响行为，保存命令、退出码、集成前后版本/哈希。失败保留现场并阻止下游。
4. 合入内容一致且组合通过才记已集成verified，逐任务串行执行；再归档和安全释放工作区。

## 完整交付

所有交付Task已集成，根Issue聚合验收通过；每日批次还须全部交付source_issues及必要父聚合通过。按[编排审核与交付](orchestration-review.md)执行完整授权范围的新会话终审、OCR、finding修复回路和关闭/清理；目标更新后的完整终审/OCR要求继续适用。

推送/合并前遵守[交付门禁](delivery-gates.md)的目标新鲜度、实际最终树/CI、条件写和写后回读。提交、推送、合并及GitHub写入均以当前授权为准。
