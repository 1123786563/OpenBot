# 上下文、消息与恢复

本文件约束工具开发和后续真实运行的上下文传递。T6 负责生成 Brief，T8 负责消息和恢复流程；工具尚未实现时由协调器执行这些规则。它不会自动清除现有会话历史。

## 1. 单任务派发

每个 Worker 以独立会话启动，只接收一个 Brief；启动配置关闭父会话继承。Brief 直接写清当前目标、验收和必要约束，引用下列材料的具体文件和章节。Worker 仍须遵守工作区适用的 AGENTS.md 与技能要求。

| 当前 Task | 按需协议入口（除 Task 文件、适用共享约束外） |
| --- | --- |
| T1 | contracts.md；protocols.md 的 B.1–B.2；定义 F1–F6 类型时读取对应协议 |
| T2 | acceptance.md 的 1.1；protocols.md 的 B.6 |
| T3 | contracts.md 的相关类型；protocols.md 的 B.3–B.6；review-sync.md 的 C.3–C.4 |
| T4 | protocols.md 的 B.1–B.2；当前版本 Orca 生命周期 reference |
| T5 | contracts.md 的 A.6；protocols.md 的 B.1、B.4；Task 内 F6 |
| T6 | protocols.md 的 B.1–B.2、B.6；本文件 Brief 规则 |
| T7 | protocols.md 的 B.4–B.5；前置接口与检查点清单 |
| T8 | protocols.md、review-sync.md；T3–T7 已交付接口；本文件消息与恢复规则 |
| T9 | acceptance.md、completion.md；完整交付增量及证据索引，协议按验收追踪读取 |
| T10 | runtime.md、review-sync.md；T9 报告与真实运行授权 |

表内文件均在本目录。大文件按指定章节读取，适用的测试 ADR、Spec、领域上下文仍按仓库要求加载。若发现接口、权限或验收冲突，补读对应事实源并报告冲突；上下文预算不能用于省略必要审查。

Brief 必须自足地包含以下内容，建议控制在 100 行以内；超出时将原始证据移到引用路径，保留全部验收及约束：

```text
task_id / attempt_id / stage_attempt_id / scope_revision
目标与逐项验收：当前任务负责的完整条目
角色、预期后端 pi、报告路径；子 Agent 不再派发
workspace / BASE / checkpoint_strategy
owned_files / 禁止写入范围 / resources
consumes：接口签名、前置检查点哈希、产物路径
produces：交付接口、检查点与报告
required_reading：仓库相对路径 + 章节 + 读取原因 + 版本或哈希
verification：适用命令、预期结果和资源要求
failure：停止条件、上报对象和证据位置
```

协调器在 Brief 中明确：Worker 不是唯一编辑者，保留其他人的修改，只在授权范围内写入。验证者和 reviewer 只读代码与测试源文件。

派发包只包含该任务的需求、前置接口和已确认决定。完整 Issue 树、其他 Task 的 Brief、历史聊天、逐行测试日志和已解决 finding 留在文件中；需要诊断或追溯时按 ID 读取。验证者复用同一哈希的有效证据，reviewer 获得完整任务增量及证据索引；“短消息”不能缩减 Review 范围。

## 2. 消息只通知变化

阶段结果写入独立报告，完整日志、diff、回执保存到文件。消息建议不超过 20 行：

```text
event_id / task_id / stage_attempt_id / dispatch_id
status：完成 / 阻塞 / 提问
checkpoint_hash / report_path / receipt_path
summary：本次新增结果或阻碍
needs_action：协调器需作出的决定；无则为空
```

建议长度是提示性预算，不能截断必要问题、验收结果或独立报告。敏感数据不写入报告或消息。

协调器按 delivery_id 去重，再核对权威 Dispatch 与阶段；新结果只读取对应报告和当前代码证据，必要时打开原始日志的相关段。事件持久化、settlement 和资源处置遵守 protocols.md，处理完成后 ack。重复结果使用已记录的处理结论，不重复加载报告；旧 Dispatch 归档并按生命周期结算。回复未解决问题时给出决定、理由和事实源路径，已确认的稳定决定写入持久文件。

空等待只检查轻量状态；既有规则要求的 Worker 枚举继续执行。只有消息丢失、身份不明、报告缺失或结论冲突时，才按 Worker/Dispatch 定向查看会话记录。历史记录仍须归档，供审计和异常追溯使用。

## 3. 从文件恢复

恢复的第一轮只读这些当前材料：

1. 当前授权与配置、scope_revision、工具版本。
2. state.json、DAG 与当前 Ledger 摘要：已 verified/已集成检查点、活动尝试、blocked 原因、待处理事件与证据路径。
3. Git HEAD、工作区状态、文件清单哈希；与 Ledger 中检查点核对。
4. 当前活动 Dispatch、资源/Issue 声明、启动与集成 intent、待 ack、待同步 outbox，以及关联回执。

先完成协议要求的对账，再继续未完成任务。state.json 是投影，不能单独作为成功证据；缺失、损坏或 revision 不一致时由工具从 events.jsonl 重建并校验，协调器只接收重建结果及异常摘要。工具未实现时由协调器定向读取必要日志并记录重建依据；无法确定则保持 blocked/unverifiable。

摘要引用证据路径和检查点哈希。文件哈希变化时先判断失效范围，再补读、验证和 Review；无关心跳不触发全量重载。同一活跃会话且事实源未变化时复用已读内容；新会话或压缩后按本节重建。摘要包含所有未解决阻碍和待决问题，不能通过只保留成功条目来压缩。

## 4. 实施验收补充

下列是 T6/T8 待实现要求，本次文档整理不声称已验证运行效果：

- T6：为 A 生成的 Brief 包含 A 的完整验收和前置接口，不内嵌无关 B 的 Issue 正文、Brief 或历史消息；引用路径、版本和读取原因可追踪。
- T8：重复 Delivery 不重复应用业务事件；同一已处理报告无需再次送入模型；恢复后仍能对账待处理消息、活动尝试和未知副作用。
- T8：记录每次派发的 Brief 字节数、证据读取路径与版本、是否读取 transcript 及原因；平台可提供时另记录输入 token，用于比较真实成本。审计记录不重复进入后续消息。
- T9：复用已有故障轨迹验证上述要求；短报告仍能定位完整增量、原始结果、所有失败及未解决 finding。
