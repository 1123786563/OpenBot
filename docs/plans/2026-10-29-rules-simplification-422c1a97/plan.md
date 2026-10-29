# 规则精简实施计划

目标：在保留现有核心约束与协议兼容性的前提下，减少重复说明和非适用流程的阅读成本。

依据：当前用户“帮我进行优化 精简”，及上一轮 `.archive/runs/2026-10-29-rules-audit-c2d2b83a/report.md`。用户要求构成本轮实施授权；不扩大到提交、部署、外部仓库或GitHub写入。

档位：完整。当前工作区复用；已存在的 `.coordination/` 修改不在本轮写入范围。当前会话串行实施，独立会话只读验证/审核，可写指定报告。

约束：保留三档、各档独立性/验收、Issue全部rescan时点、分页完整性、批准来源、C/P/K与修复上限、公平调度、fencing/恢复、脱敏/保全、目标CI/条件写、专用完整终审/OCR。保持JSON协议及路径兼容，不部署协调工具、不迁移活跃Run。

## Task 1：归一通用与编排流程

- 修改 `.agents/rules/execution.md`、`domain.md`、`artifacts.md`、`testing.md`、`orchestration*.md`：按触发路径组织，重复控制引用其权威文件。
- 接口：原文件路径、机器字段、核心约束不变；已存在章节锚点保持可定位。
- 验收：普通路径立即可判定；多Agent/跨Run专用步骤只在命中时加载；删减条款可找到同等权威定义。

## Task 2：压缩审计与交付说明

- 修改 `closed-issue-audit.md`、`closed-issue-daily-run.md`、`delivery-gates.md`、`coordination-state.md`、必要的 `coordination-format.md`。
- 将状态字段/算法的重复叙述收敛到Schema和协调合同，保留场景顺序及放行条件。文字冲突对齐现有Schema：仅label/close因取消或人审终态失配可保留匹配的验证结论；delivery动作stale仍使验证失效。
- 验收：原候选集合、动作恢复、预算/公平/波次、epoch/稳定窗口、授权与写后纠正均保留；JSON字节不变。

## Task 3：验证与独立审核

- 核对本地文件和章节引用，比较Markdown字符/字节及典型路径成本。
- 运行普通/标准/完整、Orca任务/失败修复、每日预算/父epoch、标签失配/人审终态、交付树失配、敏感恢复等场景；固定最终授权文件及哈希。
- 由新独立会话逐条对照before与当前范围，报告行为、Spec、质量三个结论；有效medium以上修复后复审。
- 无源码改动时OCR记 `not_applicable: no_code_changes`，不宣称空扫描通过。验证/报告留本轮归档。
- 失败处理：遗漏约束立即补回；影响不明保留原条款；不更改共享状态或放宽运行门禁以求通过。
