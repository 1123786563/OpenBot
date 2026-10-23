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

历史活跃 Run 兼容区（`2026-10-19-orca-*`、`2026-10-20-orca-dag-wave3/` 的运行状态）已于 2026-10-23 停止并交接后整体迁入 `.archive/runs/<run-key>/`，本目录不再保留过渡区；`docs/verification/heroui-migration/` 因 worktree 仍在执行暂留原路径，见下方迁移状态。

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
- 多租户方案已于 2026-10-22 随 Issue #6 整体作废（not planned）：方案正文、执行目录、i6-mt001 review fixes 与 `tickets/multitenancy/` 已删除，spec 与 ADR 0004 以 tombstone 覆写；原文归档在 `.archive/runs/2026-10-22-issue6-void/`。
- Hindsight/Mastra 旧方案中的 Ledger、Issue 快照、库存清单和 baseline 已移到 `.archive/runs/legacy-plans/`；方案正文仍保留在本目录。
- Ticket 目录中的发布脚本、发布日志、验证/校验 JSON、handoff 压缩包、Checkpoints 和原始来源快照已移到 `.archive/runs/legacy-plans/tickets/`；Ticket 正文、父 Issue、manifest 和派发说明仍保留。
- 2026-10-23 第三轮整理（[台账](../../.archive/runs/2026-10-23-docs-reorganization/index.md)）：orca wave2/run-all/mt-bifrost、mastra-execution-run、plugin-package-marketplace 的 Run 目录整体迁入 `.archive/runs/<run-key>/`；wave3 只留 hindsight 方案，`state.json`/`scope.json`/`issues/` 等运行状态入该 Run 归档；upstream-openbot-refactor 同规则拆分。方案正文与根部 `*-implementation.md` 保留。
- workspace-redesign b1 的验证、OCR、报告、Brief 与 Ledger（原 `docs/verification/workspace-redesign/`、`docs/plans/reports/`、`docs/plans/task-briefs/` 及根部 b1 修复 brief）迁入 `.archive/runs/2026-10-20-workspace-redesign-b1/`；design 阶段 review 截图与检查入该 Run `reviews/design/`。
- `docs/tickets/` 在 #489 与 mastra 派发期间重新出现的两套 Ticket 目录已按新版本合并回 `docs/plans/tickets/`，被覆盖的旧版本存 `.archive/runs/legacy-plans/superseded/`。
- 根部历史 fix/repair brief 与执行 DAG 状态（`*-dag.json`）归入 `.archive/runs/legacy-plans/<plan-key>/`；`docs/` 根的 `tls-certs.md`、`web-research.md`、`craft-preview-origin.md` 分流到 `reference/`。
- `docs/verification/heroui-migration/` 暂留：heroui worktree 仍有 Agent 在执行。停止或交接后按同规则迁入 `.archive/runs/2026-10-19-heroui-migration/`，迁移前不要在该路径新增产物。
- 每次迁移的旧→新映射与移动前后 SHA-256 见对应 Run 的 `migration-manifest.tsv`；本轮为 `.archive/runs/2026-10-23-docs-reorganization/migration-manifest.tsv`。
