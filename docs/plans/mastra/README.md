# Mastra 专题

Mastra 从 Intelligence-only 迁移到受治理执行的方案集合，以及 2026-10-19 的 Agent 执行迁移。

## 入口

| 用途 | 文件 |
| --- | --- |
| 当前迁移主计划 | [agent-execution/2026-10-19-mastra-agent-execution-migration.md](agent-execution/2026-10-19-mastra-agent-execution-migration.md) |
| 主计划 DAG 与恢复索引 | [agent-execution/2026-10-19-mastra-agent-execution-migration-dag.md](agent-execution/2026-10-19-mastra-agent-execution-migration-dag.md) |
| 规划基线哈希 | [agent-execution/baseline.json](agent-execution/baseline.json) |
| Intelligence-only DAG（前一阶段入口） | [intelligence/2026-10-11-mastra-intelligence-only-dag.md](intelligence/2026-10-11-mastra-intelligence-only-dag.md) |
| 业务 Ticket | [../tickets/mastra-agent-execution/](../tickets/mastra-agent-execution/) |
| 规范 | `docs/specs/2026-10-19-mastra-agent-execution-migration-design.md`、ADR 0010 |

## 目录

- `intelligence/`：2026-10-11 至 10-13 的 Intelligence-only 迁移、T2 Runner/SSE、受治理执行与恢复方案。按日期顺序阅读；`2026-10-13-mastra-orca-continuation.md` 是阶段交接入口。
- `agent-execution/`：2026-10-19 的 Agent 执行迁移主计划、DAG 和规划基线。

## 状态与证据

- 更早的 Mastra 方案（`docs/plans/superpowers/2026-10-10-mastra-intelligence-migration.md` 等）是历史版本，保留在 [superpowers](../superpowers/README.md)，不要作为当前事实源。
- 执行证据在 `.archive/runs/2026-10-19-mastra-execution-run/` 与 `.archive/runs/legacy-plans/`。
- T2 阶段方案内的 `.omc/`、`.superpowers/sdd/` 路径是当时工作区记录，当前可能不可读；需要复核时以方案正文的结论和 Git 为准。
