# Review、OCR 与交付

任务审查、处理 finding 或最终交付时读取。仅 Review 的用户请求不授权修改；已授权完整实施则包含必要修复。

## 任务 Review

普通 SDD 负责每 Task 的独立 Spec compliance 与 code quality Review。Reviewer 默认只读；验证者和实现者自查不能替代独立 Review。Orca 多 Agent Run 的任务审核与集成终审 Agent 按 [Agent 选择](orchestration-agents.md)确定，具体门禁见[编排审核与交付](orchestration-review.md)。非 Orca 的完整分支审查按风险使用当前已验证可用的 Sol high 或 Astra high；角色/升级遵守 [execution.md](execution.md)。

遵守 SDD 每任务最多 5 轮等规则；第 4–5 轮至少升级一档。真实阻塞问题全部解决后才能交付。连续两轮同一 finding 无进展时，触发 `systematic-debugging`，换新上下文并升级到已验证的 Sol/Astra，重新判断根因和边界；缺权限、环境或必要输入时记录阻塞与恢复条件。

## OCR 外层关卡

SDD 或 Orca 任务验证及独立 Review 后，由主控按 `open-code-review` Skill 直接执行 OCR，始终 `--audience agent`，提供 Issue、验收、接口和范围背景，不先探测安装情况。Orca Run 先集成、验证并由选定的终审 Agent 审查完整范围，再完成外层 OCR。未安装按技能安装；不支持 `--output` 按技能升级要求处理；provider/凭据失败报告所需配置，禁止编造凭据或盲重试。`review_model` 不配置 OCR provider，不能假定终审 Agent 的模型别名可用于 OCR。

- 已提交范围使用真实记录的 BASE、HEAD：`ocr review --audience agent --background "业务背景" --from <BASE> --to <HEAD> --output <本轮报告路径>`，执行前替换真实参数。
- 有未提交交付时使用 workspace 模式覆盖 staged、unstaged 和 untracked；混合交付同时审查原始 BASE..HEAD，不能遗漏已提交部分。
- 每轮单独保存范围、SHA/检查点、退出码、警告、跳过与失败文件。exit 0、超时或预算不足不能替代完整覆盖。
- critical/high/medium 核实证据、位置及验收影响，保留 finding ID、有效性裁决与理由；误报须有证据。low 按影响处理或明确延期。
- 有效问题生成只覆盖 finding 的编号修复 DAG/方案，使用 writing-plans；普通实施走 SDD 专业实现者、验证者、reviewer，Orca 多 Agent Run 的实施、独立任务复审与完整终审按 [Agent 选择](orchestration-agents.md)执行。主控不绕过已选流程自修生产代码。
- 修复后重新 OCR，确认原问题消除；最终对原始 BASE..HEAD 加全部未提交交付取得覆盖完整的通过报告。外层新编号修复方案不受单次 SDD “一次修复波次”限制，也不重派原已完成 Task。

所有审查、修复验证和裁决证据写入 `.archive/runs/<run-key>/`，方案写到 `docs/plans/`；具体布局见 [artifacts.md](artifacts.md)。

## 完成与收尾

Issue 实施完成须同时满足：Issue 树完整且范围明确、验收映射无遗漏、交付节点 verified、适用测试/类型检查/Lint/构建通过、独立 Review 通过、完整 OCR 无有效 critical/high/medium、最终 diff 仅授权范围。真实环境阻塞或阻塞 finding 不计完成；低风险延期明确披露。

清理 Worktree 前持久保存 Issue/DAG、验证、Review/OCR、全部裁决与风险，核对其可恢复性，再按 `finishing-a-development-branch` 和 [worktrees.md](worktrees.md) 收尾。提交、推送、合并、发布和关闭 Issue 依已有独立授权。最终报告列实际验收、验证命令及结果、审查状态、遗留限制和变更范围。
