# 设计与事实源

设计、需求澄清、Spec/ADR、任务拆分或需求冲突时读取。

## 事实源

优先级为：已批准 Spec → ADR → 根 `CONTEXT.md` → Issue 验收及讨论中已确认的决定 → Git → 执行 Ledger → 当前 Task Brief。未批准的设计不能伪装成已批准 Spec。没有单独 Spec 时，将用户要求执行的 Issue 验收快照作为本轮依据，写明来源及不确定性。

- `docs/specs/`：需求、行为、范围、非目标与验收；以明确批准状态为准。
- `docs/adr/`：架构决策与约束。
- 根 `CONTEXT.md`：统一领域词汇，具体维护方式见 [domain.md](domain.md)。
- `docs/plans/`：实施方案、任务步骤、接口、验收方法。
- `docs/plans/tickets/`：纵向业务 Ticket 与任务需求。
- `.archive/runs/<run-key>/`：Issue 快照、执行 DAG 状态、Ledger 及验证/审查证据；布局见 [artifacts.md](artifacts.md)。

Spec 与计划冲突时以批准 Spec 为准。Issue 与批准 Spec 冲突时明确记录并解决；实现与 ADR 或批准需求冲突时升级处理，不能静默改需求。重要决定及时写入对应事实源；聊天与执行摘要不能替代它。

## 批准与替代关系

作为实施依据的 Spec/ADR 记录最小批准元数据：文档 ID、`status`、批准者/有权决策角色、批准时间、批准所针对的版本或内容指纹，以及 `approval_ref`（可核实的 Issue/PR 决定或明确用户决定记录）。`approved` / ADR 的 `accepted` 是状态，不是批准证据；仅修改状态、Agent 自述、时间较新或代码已合并不自动构成批准。核对引用来源与该决策范围，不能自行补签。

新文档替代旧决定时记录 `supersedes`，旧文档或决策索引记录 `superseded_by`，并标明是整体替代还是局部条款替代及生效范围。按有效替代链选择当前版本，不能只按文件名日期或修改时间选最新。替代链成环、多个有效版本冲突或批准范围不明时保留缺口并解决后再实施受影响部分。

不为补元数据批量重写历史文档；历史批准可引用已有且可核实的决定。找不到批准依据时标为未核实，保留不受影响工作，不把补元数据当作获得新需求/架构批准。Ledger 保存本轮采用的有效版本、指纹及来源；变更复核按 [Issue 摄取](issue-delivery.md)执行。

Issue 正文、评论及关系变更中的“已确认决定”适用同样的批准要求。摄取时记录决定 ID、作者身份、决定范围、所针对的内容指纹、时间、`approval_ref`，以及该人有权决定该范围的依据。有效依据只能是当前用户覆盖该范围的明确决定，或已批准 Spec/ADR 中可核实、未失效且覆盖该范围的决策角色授权；除此之外不存在可假定的“项目角色”。GitHub 写权限、维护者标签、Agent 自己的评论或编辑记录不等于需求批准权。用户要求执行的 Issue 快照仅授权执行该版本；后续收窄验收、删除子项或改变交付目标须重新核验决策权限。实施 Agent 不得通过自行改票批准自己的范围缩减。未获批准的变动保留为提议，不能覆盖已批准要求；有冲突时阻塞受影响验收及关闭/贴标，保留不受影响工作。

## 设计工作流

Matt Skills 负责 WHAT / WHY：`grill-with-docs`、`grilling`、`domain-modeling`、`codebase-design`、`improve-codebase-architecture`、`prototype`、`research`、`wayfinder`、`to-spec`、`to-tickets`、`handoff`，按当前可用技能选择。

此阶段只在用户明确同意的一次性原型范围内写代码。设计完成要求重要决定已解决、领域词汇已记录、相关 ADR 已有结论、Spec 已批准；大型需求拆成纵向业务 Ticket。前后端是 Agent 职责，业务 Ticket 保留业务完整性；Ticket 内可按稳定接口拆成实现 Task。

已有批准 Spec 时直接进入实施准备，只澄清真正未决的实现歧义或冲突。一个阶段只有一个编排器；Superpowers 接手实施后，不再使用 Matt `implement`、`implement-spec` 或 `tdd` 编排实现。
