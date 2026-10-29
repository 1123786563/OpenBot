# Orca 编排协议：执行权、资源与恢复

Orca 派发、消息、集成、失败或恢复时读取；入口/容量见 [orchestration.md](orchestration.md)，身份/改选见 [orchestration-agents.md](orchestration-agents.md)。工具参数和回执字段查当前 Orca 技能/帮助。

## 权威状态与事件

- 业务 Task、内部阶段、Orca Task/Dispatch 分别记录。业务依赖只等待前置 Task 已集成 verified，阶段完成只推进阶段。产物整改生成新 attempt/检查点，阶段重试有独立 Dispatch；仅权威 Dispatch 可推进当前状态，旧结果保留并结算生命周期。
- 派发前持久记录工作区、Task/阶段、授权、资源、预期 Agent 和启动意图，启动后核实际身份。响应丢失先查 Orca/Ledger；未知写者/资源/副作用为 unverifiable，取得正面退出或安全结算证明前不重启同范围写者。
- Worker 报告写入唯一 Run 根；消息只传 Delivery/Task/Dispatch、状态、检查点哈希、报告/回执路径和待裁决项。主控按 Delivery ID 去重、核权威 Dispatch，持久化结果并处置资源/会话后才 ack。重放只返回已有结论，不重复副作用。
- 成功/失败/未知尝试分列；已结算 Worker 记录复用/保留/释放决定。空等待按技能枚举并对账，列表缺席不证明退出。

## 资源与并发

正常派发同时满足前置已集成 verified、授权/容量、owned_files、接口与资源条件。只读审核不增加工作区，但占 Worker 槽位。

副作用前按 [coordination-state.md](coordination-state.md)原子取得 Issue、工作区/分支、测试/迁移、缓存/输出声明，集成树独占。每日另按 [coordination-format.md](coordination-format.md)原子预留 C/P、动作预算和启动意图，再逐个 worker-start；先启动独立就绪波次再等待，并发调用不能绕过接纳。不同 Run/clone 或空本地列表不豁免声明，覆盖不明延迟派发。

获并行授权的独立任务可从同一已验前置树派生，未提交内容仍须完整还原。集成始终串行，按入口的四步集成核对；冲突/新增差异须独立复审，组合失败锁树，只能以完整 frozen_failed 派发限定修复，业务后继继续阻塞。

## 失败、变化与恢复

先写持久 RecoveryDecision：环境/已结束阶段故障重试该阶段；代码 finding 回原 Task 实施者；需求变化且可复用则重验；集成/终审失败从完整 frozen_failed 派生限定修复，不要求失败树先通过；身份/副作用不明先对账。每轮绑定新代码哈希、验证和独立审核。[review.md](review.md)统一轮次/无进展升级；每日写入另绑定不可变修复波次，不能改 Task/finding 谱系重置预算。

需求/政策变化按 [issue-delivery.md](issue-delivery.md)全部边界 rescan，同边界共用结果。保存 scope revision、受影响 Task/后继闭包及证据失效；承接项记录需求、前置树、所有权、代码哈希依据，移出票范围的在途工作先结算并裁决代码去向。

恢复核当前授权/scope、集成 HEAD/工作树、DAG/Ledger、活动 Dispatch、资源/Issue 声明、启动/集成意图、待处理 Delivery/回执。投影不替代原事件/Git；不一致从两者重建，未知保持 blocked/unverifiable，不凭超时/旧摘要重派。

检查点/子模块/敏感例外与转移按 [checkpoints.md](checkpoints.md)；验证/审核绑定同一 manifest。集成记录前后树、授权文件、实际结果；回执不明先核树与清单。
