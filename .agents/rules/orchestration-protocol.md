# Orca 编排协议：执行权、资源与恢复

在 [Orca 编排](orchestration.md)中准备派发、处理消息、集成、失败或恢复时读取。Agent 候选及身份规则见 [Agent 选择](orchestration-agents.md)；具体 Orca argv 与回执字段始终核对当前版本的 `orchestration` 和 `orca-cli` 指南；本文件定义放行证据，不缓存工具参数。

## 权威状态与事件

- 区分业务 Task、内部阶段和 Orca Task/Dispatch：业务依赖只等待前置 Task 的已集成 `verified`；阶段完成只推进该阶段。每次产物整改生成新的 attempt 和检查点；阶段重试有独立 Dispatch。仅当前权威 Dispatch 的结果可以推进状态，旧结果保留为历史并完成其生命周期结算。
- 派发前记录工作区、任务/阶段身份、授权范围、资源占用、预期 Agent 与启动意图；启动回执记录实际身份。响应丢失时先查询 Orca 和 Ledger。未知写入者、资源或副作用为 `unverifiable`，取得正面退出或结算证据前不重新启动同范围写入者。
- Worker 将完整结果写入 Run 报告；消息仅报告 Delivery/Task/Dispatch、状态、检查点哈希、报告/回执路径及需要的裁决。编排者按 Delivery ID 去重，核对权威 Dispatch，先持久化结果并完成资源/会话处置，再 ack。重复消息重放已记录结论，不重复整改、Git 写入或集成。
- 成功、失败及未知尝试分别记录；每个已结算 Worker 有复用、保留或释放决定。空等待只是检查点，按技能要求枚举 Worker 并对账，不据列表缺席推断退出。

## 资源与并发

- 正常业务调度只在 DAG 前置 verified 且已集成、[编排入口](orchestration.md)规定的授权和容量门禁满足、owned_files 不冲突、接口稳定、资源可用时派发。开发、整改和独立审核期间的任务 Worktree 均占名额；只读审核不增加 Worktree，但其 Agent 占实际 Worker 槽位。
- Issue、工作区、分支、数据库、端口、迁移、缓存和产物目录按[共享协调状态](coordination-state.md)原子登记；集成目标工作区独占，资源预留先于副作用。每日批次另按 [协调格式](coordination-format.md)核对 C/P、动作预算与在途启动意图，原子预留后再逐个 worker-start；先派发独立就绪波次再等待，不用并发调用绕过接纳检查。不同 Run 名称、clone 或本地空列表不能规避声明；无法核实覆盖范围时延迟派发。
- 获并行授权的独立任务可从同一已验证集成检查点派生，未提交模式按[检查点规范](checkpoints.md)叠加前置内容；集成必须串行。每次合入前核对前置树，合入后在实际组合树验证；冲突或超出已审查增量的内容形成新检查点并独立复审。失败时锁定目标树，不能放行业务下游；按 [checkpoints.md](checkpoints.md)冻结 frozen_failed 后仅放行限定修复任务。

## 失败、变化与恢复

- 先分类并写持久 RecoveryDecision：环境或已确认结束的阶段故障重试阶段；有效代码 finding 返回该 Task 原实施 Agent 整改；需求变化且代码可复用时重新验证；集成回归/终审 finding 按 [checkpoints.md](checkpoints.md)以 frozen_failed 完整失败组合树为基线修复，无须先使失败树验证通过；身份/副作用不明先对账。每轮整改绑定新的代码哈希和相关验证、独立审核；每日审计另按 [协调格式](coordination-format.md)把写入尝试绑定不可变修复波次，同一 Task 再次尝试须新波，原始 Task/finding 谱系不重置单任务预算。Agent 改选按 [Agent 选择](orchestration-agents.md)记录交接；连续无进展及轮次上限按 [Review 规范](review.md)升级。
- 按[Issue 摄取](issue-delivery.md)在实施前、恢复后、终审前和 GitHub 交付写入前强制 rescan。保存范围修订和变化，计算受影响 Task 及后继闭包；验收、接口、依赖或批准事实源变化使相关证据失效。未受影响结果须记录需求、前置树、所有权与代码哈希的承接依据；移出范围的在途工作先安全结算并记录代码处置。
- 恢复先读当前授权、scope revision、集成分支 HEAD 与 Git 状态、DAG、Ledger、活动 Dispatch、资源/Issue 声明、启动与集成意图、待处理 Delivery 和回执。状态投影不替代原始事件及代码证据；损坏或不一致时从事件和 Git 重建、核验。未知状态保持 blocked/unverifiable，不凭超时、进程列表缺席或旧聊天摘要重派。
- 任务增量、子模块、敏感文件例外及跨 Worktree 转移按[检查点规范](checkpoints.md)，验证与独立审核绑定同一 manifest。集成记录前后树、授权文件和实际结果；回执不明先核对树与清单，再决定继续。
