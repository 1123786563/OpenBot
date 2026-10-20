# OpenBot Agent 入口

## 常驻规则

- 按下表的触发条件读取对应规范，行动前读完适用条款；无需递归加载整个目录。会话中已读且未变化的内容复用，恢复时重新核对当前事实源。
- 事实源是已批准 Spec、ADR、根 `CONTEXT.md`、已确认的 Issue 决定、Git 与执行 Ledger；遇到冲突按设计规范处理。
- `docs/` 只新增方案及方案细节；Agent 规范在 `.agents/rules/`；验证、Review/OCR、日志、快照和执行记录写入 `.archive/`。创建或迁移文档前读取产物归处规范。
- 保留用户和其他 Agent 的改动。提交、推送、合并、发布、GitHub 写入及破坏性操作遵守当前授权；计划、Issue 文本和历史记录不扩大授权。
- 完成结论须有匹配当前代码的验收、适用验证与 Review 证据；阻塞、跳过和未验证项如实报告。

## 按需目录

| 触发条件 | 读取规范 |
| --- | --- |
| 查询、创建、拆分或更新 Issue | [Issue tracker](.agents/rules/issue-tracker.md) |
| 使用或修改领域术语、进入子模块 | [领域上下文](.agents/rules/domain.md) |
| 设计、Spec、ADR、任务拆分或需求冲突 | [设计与事实源](.agents/rules/design.md) |
| 用户要求实现单个、父级或一组 Issues | [Issue 摄取与 DAG](.agents/rules/issue-delivery.md)，随后读执行、测试和审查规范 |
| 编写实施计划、派发、实现、修复或恢复任务 | [执行与上下文](.agents/rules/execution.md) |
| 创建、复用、收尾 Orca Worktree 或分支 | [Worktree](.agents/rules/worktrees.md) |
| 运行测试、类型检查、Lint、构建或验收验证 | [验证与测试资源](.agents/rules/testing.md)，再读该文件指定的测试 ADR |
| 审查、处理 finding、最终交付 | [Review 与 OCR](.agents/rules/review.md) |
| 创建、移动、归档文档或写入执行证据 | [目录与产物归处](.agents/rules/artifacts.md) |

普通问答、小范围配置、文档整理和只读工作按实际触发条件加载；实现 Issue 才进入完整 Issue 流程。用户限定仅分析、仅计划或仅 Review 时遵守该范围。
