# 已关闭 Issue 审计规则修订

## Goal

依据当前用户在 2026-10-27 给出的两轮审查意见，修复已关闭 Issue 审计的收敛性、基础设施前置、历史票独立性、调度公平性、唤醒算法、合法取消终态、人审收尾、动作容量与恢复状态表达，并保持现有验证、授权和证据门禁。

## 批准事实源与范围

- 批准依据：当前用户在本次会话中明确给出的修复要求及逐条建议；无独立 Issue 或 Spec。
- 目标文件：`closed-issue-audit.md`、`closed-issue-daily-run.md`、`orchestration-agents.md`、`coordination-format.md`、`coordination-schema.json`，以及为消除引用歧义所需的相邻规则。
- 非目标：不执行实际 Issue 审计，不配置或启用自动化，不安装协调适配器，不进行 GitHub 写入。

## Global Constraints

- 保留现有测试、CI、独立审查、完整 OCR、目标交付和 GitHub 条件写门禁。
- 历史 SHA 审计结论与当前目标放行分开；证据承接必须说明影响分析和补验范围。
- 协议文档不冒充已部署基础设施；自动化启用前必须有可定位且验收通过的适配器。
- 保留用户和其他 Agent 的改动；不提交、不推送。

## Review Focus

1. 父树在目标前移时是否有确定的影响分析、补验和稳定窗口路径。
2. 新票持续到达时类内是否仍有服务上界；退避与条件唤醒是否只有一个算法。
3. 合法取消、人审通过/拒绝是否有终态且不会重新贴标。
4. 历史独立性替代证明是否有有权批准依据且保留缺口。
5. 动作 slot、动作级恢复字段、Schema 和调度样例是否一致。

## Tasks

### Task 1：审计终态与独立性

- Owned files：`closed-issue-audit.md`、`orchestration-agents.md`。
- 明确 N 的资格范围；增加有效取消的 `not_required` 结算、人审通过/拒绝的退出规则和历史独立性替代证明。
- 验收：合法取消不再记 `unproven`；人审终态不会被 N/R 重新贴标；历史身份缺口不再要求恢复不存在的信息。

### Task 2：每日流程与公平调度

- Owned files：`closed-issue-daily-run.md`。
- 增加适配器启用前置、历史/当前目标分层、稳定窗口、工作预算、动作 slot 定义、公平新到票轮转、唯一唤醒算法和人审收尾。
- 验收：每项建议均有操作步骤、状态及恢复条件，默认配置有明确可执行路径。

### Task 3：协调契约与 Schema

- Owned files：`coordination-format.md`、`coordination-schema.json`。
- 同步 `not_required`、动作级原因/恢复字段、slot 身份、公平性重放和唤醒样例。
- 验收：JSON 可解析；必需字段、枚举、状态不变量和文档示例一致。

### Task 4：验证与交付

- 检查 Markdown 相对链接、关键术语交叉引用、JSON 解析和变更 diff。
- 由独立 Reviewer 按本计划 Review Focus 审查；修复有效 finding。
- 主控执行完整 OCR，覆盖全部授权文档变更并处理有效 finding。
- 在 Run 中保存验证与审查证据，最终报告未验证限制。
