# Opik 专题

Opik 自托管观测集成（Issue #4 / 37 张子票）。同一 Issue 存在三个 DAG 版本，保留用于核对 intake 与依赖演进。

## 入口

| 用途 | 文件 |
| --- | --- |
| 集成方案（当前入口） | [2026-10-14-opik-integration-plan.md](2026-10-14-opik-integration-plan.md) |
| DAG 续版（2026-10-16） | [2026-10-16-opik-issue4-dag.md](2026-10-16-opik-issue4-dag.md) |
| DAG 初版（2026-10-15） | [2026-10-15-opik-issue4-dag.md](2026-10-15-opik-issue4-dag.md)、[2026-10-15-opik-4-dag.md](2026-10-15-opik-4-dag.md) |
| 实施计划变体 | [2026-10-15-opik-issue4-plan.md](2026-10-15-opik-issue4-plan.md)、[2026-10-15-opik-4-plan.md](2026-10-15-opik-4-plan.md) |
| T02 观测 UI i18n 与路由交接 | [2026-10-15-opik-t02-observability-i18n-routes.md](2026-10-15-opik-t02-observability-i18n-routes.md) |
| 业务 Ticket | [../tickets/opik-4/](../tickets/opik-4/) |
| 规范 | `docs/specs/2026-10-14-opik-integration-design.md` |

## 说明

- 三个 DAG 不是重复文件：10-15 初版、10-15 issue4 变体、10-16 续版内容不同。以 10-16 续版为最新依赖视图，其余保留对照。
- `2026-10-15-opik-4-plan.md` 与 `2026-10-15-opik-issue4-plan.md` 是同一范围的两个计划版本，内容不同，未做合并；派发前先核对票面。
- 逐 Task 方案在 [superpowers/](../superpowers/README.md)（`2026-10-15-opik-t01`–`t08`）。
- 运行证据在 `.archive/runs/` 下对应的 opik 目录。
