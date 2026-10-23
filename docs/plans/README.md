# 实施方案目录

这里保存方案本身和方案的静态细节：目标、范围、Spec/ADR 引用、任务分解、接口、验收方法和恢复步骤。Agent 进入某项工作时先读对应专题入口，再按入口指向的章节按需读取。

运行过程产生的状态、Issue 快照、Brief、Ledger、检查点、回执、Worker 日志、验证结果和 Review/OCR 报告属于 `.archive/runs/<run-key>/`。方案只保留证据入口和验收方法，不把运行日志复制回方案。归档规则见 [目录与产物归处](../../.agents/rules/artifacts.md)。

## 专题入口

根目录只放索引和固定分类；所有方案按专题（track）归入子目录。

| 专题 | 范围 | 入口 | 关联 Ticket |
| --- | --- | --- | --- |
| [bifrost](bifrost/README.md) | Bifrost 5（Issue #5）与 bf 波次 | [编排计划](bifrost/program/2026-10-16-bifrost-5-implementation.md) | [tickets/bifrost-5](tickets/bifrost-5/) |
| [mastra](mastra/README.md) | Mastra Intelligence 迁移、T2 治理、Agent 执行迁移 | [迁移主计划](mastra/agent-execution/2026-10-19-mastra-agent-execution-migration.md) | [tickets/mastra-agent-execution](tickets/mastra-agent-execution/) |
| [craft](craft/README.md) | Craft parity、独立预览 Origin、Onyx 移植参考 | [预览修复方案](craft/preview/2026-10-17-craft-preview-remediation.md) | [tickets/craft-preview-origin](tickets/craft-preview-origin/) |
| [workspace-redesign](workspace-redesign/README.md) | 工作区重设计 B1、T01–T08 与 P 系列修复 | [B1 实施计划](workspace-redesign/b1/2026-10-20-workspace-redesign-b1.md) | — |
| [better-auth](better-auth/README.md) | Better Auth 全量集成、Agent 交付拆票 | [集成方案](better-auth/full-integration/plan.md) | [tickets/better-auth](tickets/better-auth/) |
| [hindsight](hindsight/README.md) | Hindsight 个人记忆与 hbc 波次 | [设计](../specs/2026-10-15-hindsight-personal-memory-design.md) / [波次方案](hindsight/wave3/hindsight-06-07-09.md) | [tickets/hindsight-personal-memory](tickets/hindsight-personal-memory/) |
| [upstream-sync](upstream-sync/README.md) | 上游 OpenBot 能力同步与 18 项改造 | [范围方案](upstream-sync/2026-10-20-upstream-openbot-update-plan.md) | [tickets/upstream-openbot-update](tickets/upstream-openbot-update/) |
| [opik](opik/README.md) | Opik 自托管观测集成（Issue #4） | [集成方案](opik/2026-10-14-opik-integration-plan.md) | [tickets/opik-4](tickets/opik-4/) |
| [heroui](heroui/README.md) | HeroUI v3 迁移 | [执行计划](heroui/2026-10-19-heroui-v3-migration-execution.md) | [tickets/heroui-migration](tickets/heroui-migration/) |
| [plugin-marketplace](plugin-marketplace/README.md) | 插件包与市场 | [实施计划](plugin-marketplace/2026-10-19-plugin-package-marketplace-implementation.md) | [tickets/plugin-package-marketplace](tickets/plugin-package-marketplace/) |
| [standalone](standalone/README.md) | 没有独立专题的一次性方案 | [目录清单](standalone/README.md) | — |

固定分类：

| 类型 | 位置 | 读取时机 |
| --- | --- | --- |
| 业务 Ticket 与派发材料 | [tickets/](tickets/README.md) | Issue 拆分、派发或交接时 |
| 方案研究 | [research/](research/README.md) | 方案明确引用研究结论时 |
| 历史方案库 | [superpowers/](superpowers/README.md) | 追溯 2026-10-19 之前的旧方案时 |
| 规范性设计 | [docs/specs/](../specs/)、[docs/adr/](../adr/) | 需求、架构或接口冲突时 |
| 静态 DAG / 任务清单 | 方案入口旁的 `.json`、`.md` | 建立或核对 DAG 时 |

## 方案文件的最小结构

一个可执行方案至少提供：

```text
入口：目标、范围、非目标、事实源和状态
任务：id、依赖、角色、owned_files、接口、验收和验证命令
执行：工作区、检查点、失败恢复和 Review/OCR 入口
交付：完成条件、遗留限制和归档证据路径
```

Issue 摄取和 DAG 规则见 [Issue 摄取与执行 DAG](../../.agents/rules/issue-delivery.md)；派发、上下文和检查点见 [执行与上下文](../../.agents/rules/execution.md)。不要把用户凭据、完整环境变量或无关客户数据写进方案。

## 新增与命名约定

1. 先选专题：新方案放进对应 track 的子目录，并同步登记该 track 的 `README.md`。
2. 没有合适 track 时放 `standalone/`；同一主题累计到两个以上方案时，再提升为独立 track。
3. 文件名为 `YYYY-MM-DD-<issue-or-task>.md`；多文件方案使用同名目录加 `plan.md`。不再向根目录直接新增方案。
4. 方案入口写清状态、事实源、验收方法和证据路径；运行证据只写 `.archive/runs/<run-key>/`。
5. 已收口但仍需保留的方案留在 track 内，在入口标注状态；只有运行证据和修复 Brief 移入 `.archive/`。
6. 移动或重命名方案时，按 [产物归处](../../.agents/rules/artifacts.md) 记录旧→新映射与 SHA-256，并修正当前入口和相对链接。

## 迁移状态

- 2026-10-23 第五轮整理（[台账](../../.archive/runs/2026-10-23-docs-plans-track-reorg/index.md)）：根级 94 个方案 `.md`、19 个日期目录和 4 个固定目录按专题归入 `bifrost/`、`mastra/`、`craft/`、`workspace-redesign/`、`better-auth/`、`hindsight/`、`upstream-sync/`、`opik/`、`heroui/`、`plugin-marketplace/`、`standalone/`；根目录只保留本 README 与固定分类。文件名保持原样，116 项旧→新映射与逐文件 SHA-256 见该 Run 的 `migration-manifest.tsv`；同一轮修复当前文档 39 个历史断链。
- 2026-10-23 第三、四轮（[台账](../../.archive/runs/2026-10-23-docs-reorganization/index.md)）：orca wave2/run-all/mt-bifrost、mastra-execution-run、plugin-package-marketplace 的 Run 目录整体迁入 `.archive/runs/<run-key>/`；`docs/verification/` 删除，heroui 迁移证据整簇迁入 `.archive/runs/2026-10-19-heroui-migration/`；superpowers 修复轮 Brief 迁入 `.archive/runs/legacy-plans/superpowers-briefs/`。
- 2026-10-20 及更早轮次：`docs/agents/` 移到 `.agents/rules/`；原 `docs/superpowers/plans`、`docs/tickets`、`docs/research` 合并到本目录；`docs/craft-port` 拆分为 `craft/port/` 与 `.archive/runs/craft-port/`；产品/部署参考移到 `reference/`，测试配置移到 `tests/config/`。
- 多租户方案已于 2026-10-22 随 Issue #6 整体作废（not planned），原文归档在 `.archive/runs/2026-10-22-issue6-void/`；残留的 `standalone/2026-10-22-mt051-054/` 是作废前的 C 类实施计划，仅作历史参考，不再派发。
- Hindsight/Mastra 旧方案中的 Ledger、Issue 快照、库存清单和 baseline 已移到 `.archive/runs/legacy-plans/`；Ticket 目录中的发布脚本、验证 JSON、handoff 压缩包已移到 `.archive/runs/legacy-plans/tickets/`。
- 每次迁移的完整旧→新映射见对应 Run 的 manifest；历史快照（`superpowers/`、handoff bundle、已归档 Ticket 正文）中的旧路径按历史事实保留，不回写。
