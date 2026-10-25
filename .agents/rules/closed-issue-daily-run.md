# 已关闭 Issue 每日审计与修复

配置或运行“每天审核已关闭 Issue，发现问题后修复”的自动化时读取。审计判定沿用 [已关闭 Issue 验证](closed-issue-audit.md)，Agent 路由以 [Orca Agent 选择](orchestration-agents.md)为准；修复沿用 [Issue 摄取与 DAG](issue-delivery.md)、[执行](execution.md)、[验证](testing.md)、[Review/OCR](review.md) 和 [Worktree](worktrees.md)。定时触发只启动一次受控 Run，不改变这些门禁或 GitHub 写入授权。

## 调度配置

优先用本机 Orca `automations` 为本仓库建立独立任务，不复用普通仓库健康检查的自动化。创建前读取当前 `orca-cli` 的版本匹配指南和 `orca automations create --help`，核对仓库 ID、主机、默认基线与目标 GitHub tracker。当前仓库同时有 `origin=1123786563/OpenBot` 与 `upstream=CopilotKit/OpenBot`；Issue 查询和标签写入显式指定 `1123786563/OpenBot`，代码基线显式指定 `origin/main`，不能依赖 Orca 显示的上游项目身份。

建议初始配置如下；时间和单次容量可调整，实际值记入自动化回执：

| 项 | 值 |
| --- | --- |
| 名称与 Agent | `OpenBot closed Issue 每日审计修复`；`codex` 协调 |
| 触发 | `daily`，`10:00`，`Asia/Shanghai`；含周末 |
| 运行位置 | 本机 `/Users/wuyongjun/trea/OpenBot`；`new-per-run`，每次新会话 |
| 基线 | `origin/main`；启动前 precheck 获取 `origin/main` 并确认 GitHub 可读，失败则记录跳过 |
| 容量 | 每次最多一张 Issue；漏跑宽限 120 分钟，宽限外跳过 |

首次启用前在人工触发的试运行中走完一票，核对读取、隔离、证据、修复与恢复路径；实际启用状态以 Orca 回执为准。错过触发时只补一次，过期跳过并记录；不要并发补跑多次。本机调度要求运行主机可用；每次检查 Orca `automations runs` 回执，不能把“已触发”当作“已审核”。

## 每次运行

1. **独占与恢复**：检查 Orca 运行历史、活跃 Run/Worktree、共享测试资源和本任务 Ledger；用共享持久目录中的原子锁防止同仓库每日任务重叠。锁含运行 ID、主机、开始时间与工作区；超时锁先核对实际进程和 Orca 状态再接管。先恢复未完成的同一票，不把未集成修复丢在上一日 Worktree。
2. **选择**：按 [已关闭 Issue 验证](closed-issue-audit.md)重新分页获取候选集。优先级为：可恢复的未完成票 → 自上次验证后代码/需求改变且带 `agent:ready-for-review` 的票 → 尚无有效结论且未贴标的 `completed` 票。`not_planned`、作废、读取不完整和外部阻塞票记录原因及下次重试条件，不让它们长期卡住队列。已存在标签不是跳过审核的充分理由。
3. **审计**：按 [Orca Agent 选择](orchestration-agents.md)另启逐票审核 Agent，冻结 `origin/main` 的完整 SHA、子模块和环境，逐条核对 Issue 验收、实际装配链、适用测试与独立代码质量审查。报告每条 `verified / failed / blocked / unproven / not_applicable`、证据、finding 严重度和归属。审计 Agent 只读业务代码和测试源文件；不能以旧测试报告或 `closed` 状态宣称通过。
4. **缺陷分流**：主控核实 finding 的复现、验收影响及是否仍存在于冻结 SHA。误报记录反证；环境阻塞保存复跑命令；有效且在本票范围内的缺陷进入修复。跨票或需要改批准 Spec/ADR 的问题先明确边界和依赖，不在本票中顺手扩大范围。
5. **修复闭环**：在隔离执行工作区保存 Issue 快照、最小修复 DAG、`writing-plans` 方案及检查点；按 [Orca Agent 选择](orchestration-agents.md)把有效问题交给与审核者不同的修复 Agent，跑针对性 RED→GREEN 与受影响验证，再由新的独立复审 Agent 检查 Spec compliance 和 code quality，最后对完整修复范围完成终审与 OCR。有效 finding 返回修复与复审；连续两轮同一问题无进展按 [Review/OCR](review.md)诊断升级。主控不以自己写完代码代替独立审核。
6. **交付门禁**：修复后的结论绑定实际修复检查点。仅在代码按现有授权进入目标 `main`、重新冻结新的 SHA、受影响验收和完整审核在该 SHA 通过后，才按 [已关闭 Issue 验证](closed-issue-audit.md)添加或保留 `agent:ready-for-review`。没有提交、推送、合并或 GitHub 写入授权时保留可恢复 Worktree 与完整未提交检查点，状态记 `repair_prepared` 或 `integration_pending`；不声称当前 `main` 已修复。生产部署、数据迁移与外部发布另按各自授权执行。
7. **结算**：保存候选清单、目标 SHA、逐票报告、命令与用例数、资源清理、Review/OCR、标签回执、未解决问题和下一次恢复入口。释放本轮独占锁前确认 Ledger 已落盘；受控资源只清理本轮创建且归属已核对的部分。

## 发现后的 Issue 与 PR

- 主控先检索现有 Issue/PR，并以 finding ID、复现、受影响验收及目标 SHA 登记到 Ledger。误报和环境阻塞保留审计记录，不发布“代码缺陷”Issue。
- 有效缺陷若跨模块、需要需求/接口决定、存在独立依赖，或预计跨日修复，创建新的修复 Issue，引用原已关闭 Issue 与证据；原票的关闭状态和历史结论如实保留。范围明确且能在本轮完成的局部修复，可直接以原 Issue 和审计 finding 为跟踪入口，避免重复票。
- 修复代码通过本地验证与独立复审后，若已有提交、推送和 GitHub PR 授权，创建修复 PR；仍待检查时保持 draft，完成所需审核与 CI 后转为可审核状态。PR 描述列原 Issue、修复 Issue（若有）、finding、验收证据、风险和目标代码 SHA。引用已关闭原票用 `Refs #<原票>`；只有希望合并时自动关闭**新修复 Issue**，才对新票使用 `Fixes #<新票>`。
- 合并须满足仓库 Review/OCR 与当前合并授权；PR 已开、获批或合并均不能代替目标 `main` 的最终验收。`agent:ready-for-review` 只在合并后的目标 SHA 经重验通过时添加。缺少相应 GitHub 写入授权时保留本地检查点、PR/Issue 草稿内容和 `integration_pending` 状态。

## 状态与完成条件

单票状态使用 `queued / auditing / finding_confirmed / repairing / repair_prepared / integration_pending / revalidating / verified / blocked / failed`；另记录 `label_pending`，不将它当作验证结论。每次运行即使未完成修复，也要明确报告已审编号、当前状态、未完成原因、下一步和工作区位置。一次定时触发成功或 Agent 会话结束，不等于 Issue 验证或修复完成。

每日 Run 的索引和逐票证据存 `.archive/runs/<run-key>/`，并在跨日共享 Ledger 中登记 `Issue → 最近有效目标 SHA → Run/Worktree → 检查点 → 审核状态 → 标签回执 → 下次动作`。Orca 的 `new-per-run` 工作区不自动带入被忽略的 `.archive/`；跨工作区读取、转移证据时使用明确的绝对路径并核对哈希。运行历史与 Ledger 对不上时先对账，不重新修同一缺陷。

## 自动化任务提示词

```text
在 /Users/wuyongjun/trea/OpenBot 对 GitHub 1123786563/OpenBot 执行一次已关闭且 ready-for-agent 的每日审计与修复。先读根 AGENTS.md、.agents/rules/closed-issue-daily-run.md 及其引用规则，并核对当前 Orca 自动化、Run、Worktree、Git 和共享 Ledger。每次最多处理一张 Issue；优先恢复未完成票。审计目标为 origin/main 的冻结 SHA。逐条实跑验收并保存证据；有效问题按仓库的 writing-plans、SDD、独立 Review、OCR 闭环在隔离工作区修复。仅在交付已进入目标 main 且该 SHA 重新通过验收，并有 GitHub 写入授权时，添加 agent:ready-for-review 并回读保存回执。保留未授权的提交/推送/合并/发布为待处理状态。最后报告本轮 Issue、结论、证据、修复位置、未完成原因和下次恢复入口。
```
