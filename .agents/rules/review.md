# Review、OCR 与交付

任务审查、处理 finding 或最终交付时读取。仅 Review 的用户请求不授权修改；已授权完整实施则包含必要修复。

## 任务 Review

普通 SDD 负责每 Task 的独立 Spec compliance 与 code quality Review。Reviewer 默认只读；验证者和实现者自查不能替代独立 Review。Orca 多 Agent Run 的任务审核与集成终审 Agent 按 [Agent 选择](orchestration-agents.md)确定，具体门禁见[编排审核与交付](orchestration-review.md)。非 Orca 的完整分支审查按风险使用当前已验证可用的 Sol high 或 Astra high；角色/升级遵守 [execution.md](execution.md)。

每任务最多 5 轮修复；第 4–5 轮使用新上下文并至少升级一档。非 Orca 按 [execution.md](execution.md)选择已验证的更强 Sol/Astra；Orca 的升级候选、参数授权与无可用升级时的阻塞处理统一按 [Agent 选择](orchestration-agents.md)，不绕过主机或模型授权限制。连续两轮同一 finding 无进展即触发 `systematic-debugging`，按上述路径换新上下文、升级并重判根因；缺权限、环境或必要输入时记录阻塞与恢复条件。真实阻塞问题未解决不能交付，不因达到轮次上限而改判通过。

## Finding 裁决与统一通过阈值

此标准同时适用于任务 Review、终审、OCR、通用/Orca 回溯审计和每日审计。稳定 finding ID 关联原发现者、复现输入、影响验收、代码位置及每轮检查点；迁移位置不产生“新问题已消失”的假象。

| 严重度 | 判定依据 | 门禁 |
| --- | --- | --- |
| critical | 可造成严重越权、秘密/数据大规模泄露、不可恢复损坏或核心服务全面失效 | 有效即阻塞 |
| high | 安全/隔离边界破坏、主要验收不可达、重大数据/兼容性错误 | 有效即阻塞 |
| medium | 可复现的正确性、回归、可靠性缺陷，或必需验收/证据缺口 | 有效即阻塞 |
| low | 不影响验收、安全、隔离或数据正确性的局部可维护性/展示改进 | 可修复或按下述条件接受风险 |

“有效阻塞/真实阻塞问题”统一指有效 critical/high/medium，以及导致必需验收或证据无法成立的环境/权限/完整性阻塞。无“非阻塞 medium”的放行例外。主控核实 finding，不得单方通过降低严重度绕过门禁；误报/降级须有复现或反证、影响分析，并由新的独立 reviewer 确认，保留原级别和裁决链。涉及需求取舍仍须 [design.md](design.md) 的有权批准者决定，不能作为已满足原验收。

low 延期须记录有权风险接受人及 `approval_ref`、理由/影响、可访问跟踪 Issue 或项目风险条目、责任人、恢复触发条件和复评截止日；缺任何项则保持待处理，不自行接受风险。关闭后跟踪入口仍须有效。

“同一 finding 无进展”指连续两轮在新检查点上复现相同失败或仍缺同一必需证据，且没有验收结果/可复现根因边界的实质变化；改文字、换 ID 或重跑相同配置不算进展。Ledger 对比 ID、输入、结果和影响。非 Orca 升级依次考虑同模型更高推理等级、已核实更强的 Sol、Astra；后两者须有当前能力证据，不单按名称断言顺序。记录前后有效配置和能力改善依据；不支持或无可证明升级则 blocked。Orca 参数授权仍按 [Agent 选择](orchestration-agents.md)。

## OCR 外层关卡

Issue 实施及所有已关闭 Issue 回溯审计在验证和独立 Review 后，由主控按 `open-code-review` Skill 直接执行 OCR，始终 `--audience agent`，提供 Issue、验收、接口和范围背景，不先探测安装情况。Orca Run 先集成、验证并由选定的终审 Agent 审查完整范围，再完成外层 OCR。未安装按技能安装；不支持 `--output` 按技能升级要求处理；provider/凭据失败报告所需配置，禁止编造凭据或盲重试。`review_model` 不配置 OCR provider，不能假定终审 Agent 的模型别名可用于 OCR。

- 已提交范围使用真实记录的 BASE、HEAD：`ocr review --audience agent --background "业务背景" --from <BASE> --to <HEAD> --output <本轮报告路径>`，执行前替换真实参数。
- 有未提交交付时使用 workspace 模式覆盖 staged、unstaged 和 untracked；混合交付同时审查已提交范围，不能遗漏已提交部分。原始 BASE..HEAD 只含授权内容时直接使用；夹杂无关用户提交时按 [checkpoints.md](checkpoints.md)构建授权提交镜像及映射，不将无关内容送入 provider。
- 有无关用户基线或敏感内容时，按[检查点规范](checkpoints.md)构建干净审查镜像并核对授权增量，不能直接把整个脏工作区送入 OCR 或修复基线 finding。受影响子模块分别执行其仓库范围的 Review/OCR，再核对父仓库 gitlink；根仓库报告不替代子模块审查。
- 每轮单独保存范围、SHA/检查点、退出码、警告、跳过与失败文件。exit 0、超时或预算不足不能替代完整覆盖。
- finding 按本文件统一标准裁决和处理；延期仅适用于获风险接受的 low。
- 有效问题生成只覆盖 finding 的编号修复 DAG/方案，使用 writing-plans；普通实施走 SDD 专业实现者、验证者、reviewer，Orca 多 Agent Run 的实施、独立任务复审与完整终审按 [Agent 选择](orchestration-agents.md)执行。主控不绕过已选流程自修生产代码。
- 修复后重新 OCR，确认原问题消除；最终对完整授权交付范围（含已提交映射及全部未提交交付）取得覆盖完整的通过报告。外层新编号修复方案不受单次 SDD “一次修复波次”限制，也不重派原已完成 Task。

OCR 覆盖必须可对账：从逐仓库交付 manifest 生成预期文件及改动范围，保存 OCR 实际输入/处理清单、工具版本/配置、报告清单和逐项映射；预期集合 = 已实际审查项 + 经独立 reviewer 批准的具名排除项。二进制/生成文件可排除 OCR 文本分析，但须记录理由、源文件关系及替代验证/安全审查；源码、配置、需求文档及子模块内容不能仅因 skipped、预算或文件过大而排除。failed/未知/无清单证据的项保持未覆盖；拆批/重跑或补独立审查不能冒充 OCR 已审，需明确工具不支持的阻塞。回溯审计按验收映射列出目标 SHA 的实现、装配链及相关变更作为预期输入；无可用差异时构造只读审查镜像，不能以空 diff 通过。零 finding 或 exit 0 不等于覆盖完整。归档/外发前执行 [artifacts.md](artifacts.md) 的敏感信息检查。

所有审查、修复验证和裁决证据写入 `.archive/runs/<run-key>/`，方案写到 `docs/plans/`；具体布局见 [artifacts.md](artifacts.md)。

## 完成与收尾

Issue 实施完成须同时满足：Issue 树及最新范围明确、验收映射无遗漏、交付节点 verified、适用测试/类型检查/Lint/构建通过、独立 Review 通过、完整 OCR 无有效 critical/high/medium、最终 diff 仅授权范围。真实环境阻塞或有效 critical/high/medium finding 不计完成；low 延期按风险接受契约持续跟踪。本地实现 verified 与目标分支交付分别记录；未进入事先约定的交付目标时为 `integration_pending`，不能据本地通过关闭 Issue。目标 SHA、需求或交付树变化时按 [delivery-gates.md](delivery-gates.md)重新冻结，完成相关验收、完整独立终审和完整 OCR；Required Checks/标准 CI 绑定实际目标 SHA。

清理 Worktree 前持久保存 Issue/DAG、验证、Review/OCR、全部裁决与风险，核对其可恢复性，再按 [execution.md](execution.md) 的技能可用性规则及 [worktrees.md](worktrees.md) 对应创建者的清理路径收尾。提交、推送、合并、发布和关闭 Issue 依已有独立授权。最终报告列实际验收、验证命令及结果、审查状态、遗留限制和变更范围。
