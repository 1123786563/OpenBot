# Orca 编排 Agent 选择

在 Orca 多 Agent Run 中选择、派发、复审或恢复 Agent 时读取。本文件是该流程的 **Agent 候选与身份规则的唯一事实源**；任务顺序、工作区、集成和 OCR 门禁仍由 [编排入口](orchestration.md)、[编排协议](orchestration-protocol.md)与[审核和交付](orchestration-review.md)规定。

| 阶段                        | 候选 Agent   | Orca `--agent` 值                                         | 选择时机                                             |
| --------------------------- | ------------ | ----------------------------------------------------------- | ---------------------------------------------------- |
| 任务实现与有效 finding 整改 | OpenCode     | `opencode`                                                | 首次派发前为每个 Task 选定；整改默认交回原实施 Agent |
| 任务独立审核与整改复审      | Claude、Kimi | Claude 为 `claude`；Kimi 的准确 ID 须由当前 Orca 主机核实 | 每轮审核启动前选定；不得由该检查点的实现者自审       |
| 集成分支完整终审            | Codex        | `codex`                                                   | 全部任务集成并完成组合验证后启动                     |

主编排者为每个 Task/审核轮次在 Brief 和 Ledger 记录选定角色、预期 Orca Agent ID、工作区、检查点与实际启动回执。后端/前端等专业职责写入 Brief，不用 Agent 产品名代替任务所有权。审核 Agent 对同一检查点给出独立 Spec compliance 与 code quality 结论；终审覆盖原始 BASE 到集成 HEAD 及全部未提交交付内容。OCR 是主编排者执行的外层工具关卡，不列入 Agent 候选。

派发前读取当前版本的 `orca-cli` 和 `orchestration` 指南，核实目标执行主机支持所选 Agent 的准确 ID 和启动方式；示例命令中的 `<implementation-agent>`、`<review-agent>`、`<final-review-agent>` 均须替换为已核实的 ID。选定 Kimi 时必须取得当前主机的正面可用性证据，不能依据名称猜测其 ID。

启动后核对回执中的实际 Agent 身份、handle、Dispatch 和工作区，与 Ledger 中的预期值一致才接受结果。启动或身份不明时保持 `blocked/unverifiable` 并按[编排协议](orchestration-protocol.md)对账；不得把另一 Agent 的结果当成选定 Agent 的审核。确需改选实施或审核 Agent，先记录原因、原检查点、交接范围与新预期身份，再启动新轮次；不静默切换。模型、推理等级和运行表面仅在用户明确要求且当前 Agent/主机支持时传入。
