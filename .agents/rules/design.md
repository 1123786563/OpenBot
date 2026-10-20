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

## 设计工作流

Matt Skills 负责 WHAT / WHY：`grill-with-docs`、`grilling`、`domain-modeling`、`codebase-design`、`improve-codebase-architecture`、`prototype`、`research`、`wayfinder`、`to-spec`、`to-tickets`、`handoff`，按当前可用技能选择。

此阶段只在用户明确同意的一次性原型范围内写代码。设计完成要求重要决定已解决、领域词汇已记录、相关 ADR 已有结论、Spec 已批准；大型需求拆成纵向业务 Ticket。前后端是 Agent 职责，业务 Ticket 保留业务完整性；Ticket 内可按稳定接口拆成实现 Task。

已有批准 Spec 时直接进入实施准备，只澄清真正未决的实现歧义或冲突。一个阶段只有一个编排器；Superpowers 接手实施后，不再使用 Matt `implement`、`implement-spec` 或 `tdd` 编排实现。
