---
status: accepted
---

# Mastra 执行 Agent 循环，OpenBot 保留业务运行与治理权威

OpenBot 已有 Run/Attempt、逐调用预算与结算、工具授权审批、会话 intent 和公司/团队范围，当前内置执行仍依赖 CopilotKit BuiltInAgent。建议以受控 Mastra 适配替换执行循环，保留现有 AG-UI 客户端和 OpenBot 权威模块；普通 Agent 显式挂起/恢复先与 OpenBot 生命周期对齐，暂不同时引入第二个 durable workflow 调度权威。

替代方案是整体转交 Mastra 的执行、memory、workflow 与客户端协议，但会同时改变运行身份、审批副作用、写入者和结算事实源，迁移与回滚风险较高。本方案的代价是维护流/完整消息/continuation 适配，以及保留可选 Intelligence 学习依赖；将来若删除这些适配，需要独立证明授权、预算、恢复和新旧数据兼容。

用户于 2026-10-19 确认详细方案与拆票，本 ADR 随该方案 accepted；它不修改 ADR 0004/0005/0006/0008/0009 的既有约束，也不授权代码实施或生产发布。验收见 [详细方案](../specs/2026-10-19-mastra-agent-execution-migration-design.md)。
