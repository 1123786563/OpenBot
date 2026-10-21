# 实施方案目录

这里保存方案本身和方案的静态细节：目标、范围、Spec/ADR 引用、任务分解、接口、验收方法和恢复步骤。Agent 进入某项工作时先读对应方案入口，再按入口指向的章节按需读取。

运行过程产生的状态、Issue 快照、Brief、Ledger、检查点、回执、Worker 日志、验证结果和 Review/OCR 报告属于 `.archive/runs/<run-key>/`。方案只保留证据入口和验收方法，不把运行日志复制回方案。归档规则见 [目录与产物归处](../../.agents/rules/artifacts.md)。

## 当前目录类型

| 类型 | 位置 | 读取时机 |
| --- | --- | --- |
| 方案入口 | `docs/plans/*.md` | 需求、设计和实施准备 |
| 方案细节 | `docs/plans/<plan-key>/`、`docs/plans/superpowers/` | 当前方案明确引用时 |
| 方案研究 | `docs/plans/research/` | 方案明确引用研究结论时 |
| Ticket 与派发材料 | `docs/plans/tickets/` | Issue 拆分、派发或交接时 |
| 规范性设计 | `docs/specs/`、`docs/adr/` | 需求、架构或接口冲突时 |
| 静态 DAG / 任务清单 | 方案入口旁的 `.json`、`.md` | 建立或核对 DAG 时 |
| 活跃 Run 兼容区 | `2026-10-15-company-team-multitenancy-execution/`、`2026-10-19-orca-*`、`2026-10-20-orca-dag-wave3/` | 只在该 Run 对账、恢复或交接时 |

活跃 Run 兼容区是历史编排器仍在读取的过渡状态，不是新规范。它们内部的 `state.json`、`scope.json`、`receipts/`、`workers/`、`reports/` 等不会再扩展；新 Run 的等价产物写入 `.archive/runs/`。迁移前必须停止或交接 Run，并更新所有脚本、Brief 和恢复引用。

## 方案文件的最小结构

一个可执行方案至少提供：

```text
入口：目标、范围、非目标、事实源和状态
任务：id、依赖、角色、owned_files、接口、验收和验证命令
执行：工作区、检查点、失败恢复和 Review/OCR 入口
交付：完成条件、遗留限制和归档证据路径
```

Issue 摄取和 DAG 规则见 [Issue 摄取与执行 DAG](../../.agents/rules/issue-delivery.md)；派发、上下文和检查点见 [执行与上下文](../../.agents/rules/execution.md)。不要把用户凭据、完整环境变量或无关客户数据写进方案。

## 迁移状态

- `docs/agents/` 的 Agent 规范已移到 `.agents/rules/`。
- 原 `docs/superpowers/plans`、`docs/superpowers/specs`、`docs/tickets` 和 `docs/research` 已分别合并到 `docs/plans/superpowers`、`docs/specs/superpowers`、`docs/plans/tickets` 和 `docs/plans/research`。
- `docs/craft-port` 已拆分：方案细节在 `docs/plans/craft-port/`，OCR/验收报告在 `.archive/runs/craft-port/`。
- 已结束的独立 Review/验证报告已移到 `.archive/`，原路径不再接收新报告。
- `tests/config/e2e-bun-suites.json`、`e2e-known-broken.json` 和 `e2e-foreign-suites.json` 是测试实际读取的输入，保留在版本控制中；它们不是运行报告。
- 产品/部署参考文档已移到 `reference/`，测试配置已移到 `tests/config/`；ADR、Spec 和方案仍留在 `docs/`。
- 多租户/Hindsight/Mastra 旧方案中的 Ledger、Issue 快照、库存清单和 baseline 已移到 `.archive/runs/legacy-plans/`；方案正文仍保留在本目录。
- Ticket 目录中的发布脚本、发布日志、验证/校验 JSON、handoff 压缩包、Checkpoints 和原始来源快照已移到 `.archive/runs/legacy-plans/tickets/`；Ticket 正文、父 Issue、manifest 和派发说明仍保留。
- 活跃 Run 尚未批量移动。每项迁移须先核对读取方和当前未提交状态，记录在对应 `.archive/runs/` 迁移索引中。
