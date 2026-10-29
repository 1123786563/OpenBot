# OpenBot Agent 入口

## 常驻规则

- 按表中触发条件读取适用条款，不递归加载整个目录；同会话复用未变材料，恢复先核当前事实源。
- 需求、批准、替代关系及冲突以[设计与事实源](.agents/rules/design.md)为准。
- 保留他人改动；实施及提交、推送、合并、发布、GitHub 写入和破坏性操作以当前授权为准，计划、Issue 和历史记录不扩权。
- 实施先按[执行分档](.agents/rules/execution.md)选流程；关联 Issue 不自动升级。仅分析、计划或 Review 时遵守限定范围。
- 完成须有匹配当前内容的验收、适用验证与审核证据，如实报告阻塞、跳过和未验证项。
- 规则归 `.agents/rules/`，`docs/` 新增方案及方案细节；落盘证据归 `.archive/`。创建或迁移前读[产物归处](.agents/rules/artifacts.md)，按档位保留。

## 按需目录

| 触发条件 | 读取规范 |
| --- | --- |
| 查询、创建、拆分或更新 Issue | [Issue tracker](.agents/rules/issue-tracker.md) |
| 审计已关闭且带 ready-for-agent 的 Issue，或核对/添加 agent:ready-for-review | [已关闭 Issue 验证](.agents/rules/closed-issue-audit.md) |
| 配置或运行每日已关闭 Issue 审计修复 | [每日审计与修复](.agents/rules/closed-issue-daily-run.md) |
| 使用/修改领域术语、进入子模块 | [领域上下文](.agents/rules/domain.md) |
| 设计、Spec、ADR、任务拆分或需求冲突 | [设计与事实源](.agents/rules/design.md) |
| 新增 Module、调整 Interface、跨 Module 调用、迁移目录、更换 Adapter，或改变事实所有权、持久化写入、事务及关键运行链路语义 | [模块架构](.agents/rules/architecture.md) |
| 分析、计划、审查或实施单个、父级或一组 Issues | [Issue 摄取与 DAG](.agents/rules/issue-delivery.md)；摄取不启动实施或外部写入 |
| 编写实施计划、派发、实现、修复或恢复 | [执行与上下文](.agents/rules/execution.md) |
| 固定/审查/转移检查点，或修改子模块 | [检查点与内容转移](.agents/rules/checkpoints.md) |
| 跨 Run 占用 Issue、工作区、测试资源，或恢复每日任务 | [共享协调状态](.agents/rules/coordination-state.md) |
| 使用 Orca 协调多 Agent，或规划/审查/恢复编排 Run | [Orca 编排](.agents/rules/orchestration.md) |
| 创建、复用、收尾 Orca Worktree 或分支 | [Worktree](.agents/rules/worktrees.md) |
| 测试、类型检查、Lint、构建或验收 | [验证与测试资源](.agents/rules/testing.md)，再读其指定的测试 ADR |
| 审查、处理 finding、最终交付 | [Review 与 OCR](.agents/rules/review.md) |
| 创建、移动、归档文档或写入执行证据 | [产物归处](.agents/rules/artifacts.md) |

普通问答和只读工作只加载实际触发的条款；链接是按需入口，不是自动启动所有被引用流程。
