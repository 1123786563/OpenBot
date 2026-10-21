> 路径约定：下文代码、命令及产物路径相对仓库根目录；Markdown 链接相对本文。

## 5. 真实业务运行流程 R0–R7

这组是工具完成后的实际运行步骤，与 T1–T9 的工具开发任务及 T10 运行交接分开记录：

| ID | 动作 | 依赖 | 可检查产物 |
| --- | --- | --- | --- |
| R0 | 解析根 Issue、核对授权范围、执行工作区和并发预算 | 无 | scope.json，包含 root_issue 和执行 BASE |
| R1 | 递归扫描根及全部子 Issue、讨论和依赖 | R0 | Issue 快照、contains 图、分页与完整性清单 |
| R2 | 核验 closed/进行中节点的 Git 与现有 Orca 执行证据 | R1 | satisfied/in-progress/external-blocked 分类 |
| R3 | 对照 Spec/ADR 分解任务、补父级未覆盖验收、校验 DAG | R2 | dag.json、验收映射、带证据的依赖边 |
| R4 | 保存详细计划、Brief、接口和所有权预检，计算 dry-run | R3 | writing-plans 计划、可派发集合及延迟原因 |
| R5 | 按最大可行集合派发，事件到达后持续补位 | R4 | Orca Run/Task/Dispatch、检查点、验证和 Review |
| R6 | 聚合根 Issue 验收、完整范围 OCR、修复与复审 | R5 的全部交付节点 verified | 根验收报告、OCR 和最终范围证据 |
| R7 | 按 Issue 同步待人工审核标签和交付评论 | 该 Issue 满足[审核同步](review-sync.md) 的审核就绪条件；根 Issue 还须 R6 通过 | 标签、评论 URL、同步回执或待同步故障记录 |

R1 不完整时不得宣称全树已扫描；仅当可证明局部验收及前置条件完整时，才允许 R3–R5 处理不受影响的部分。根 Issue 无子项时直接将自身需求分解为任务；父节点不重复实现已由子节点覆盖的工作。R5 内按真实 DAG 并行，R0–R4 是准备步骤，不能为提高并行度跳过依赖核验。

### 运行纪律

- Spec 票号从 scope.json / dag.json 机械导出，派发前校验均属于当前 scope。
- 验证命令从仓库根目录解析路径，记录实际 cwd，避免相对路径造成假缺失。
- 清理 Worktree 前归档 Worker 的关键输出与最终报告到 `.archive/runs/<run-key>/workers/<name>/`，并核对可读取性。

这些规则的历史事故记录存 `.archive/runs/2026-10-20-agent-guidance/orca-runtime-retro.before.md`，只在追溯上述规则来源时读取。
