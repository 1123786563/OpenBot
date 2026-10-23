# Bifrost 专题

Bifrost 5（GitHub Issue #5 → #207–#357）及其后续能力波次。OpenBot 是积分台账、授权、预留与结算权威，Bifrost 是供应商接入与执行层；付款方固定，余额不足不切换账户。

## 入口

| 用途 | 文件 |
| --- | --- |
| 编排计划（当前主入口） | [program/2026-10-16-bifrost-5-implementation.md](program/2026-10-16-bifrost-5-implementation.md) |
| DAG 波次与 AC 映射 | [program/2026-10-16-bifrost-5-dag.md](program/2026-10-16-bifrost-5-dag.md) |
| 早期 intake 与 DAG（10-15 版本，保留对照） | [program/2026-10-15-issue5-implementation-plan.md](program/2026-10-15-issue5-implementation-plan.md)、[program/2026-10-15-issue5-dag.md](program/2026-10-15-issue5-dag.md) |
| 业务 Ticket | [../tickets/bifrost-5/](../tickets/bifrost-5/) |
| 规范 | `docs/specs/2026-10-14-bifrost-integration-design.md`、`docs/specs/2026-10-14-bifrost-github-spec.md`、ADR 0002/0003/0004 |

## 目录

- `program/`：跨票的编排计划、DAG 与 intake 版本。
- `ticket-plans/`：逐票实施计划，文件名中的 `b5-<Issue 号>` 与 Ticket 编号对应；票面在 `../tickets/bifrost-5/issues/`。
- `waves/`：Issue #5 之后的能力波次（bf13–bf21、组 18 批量、组 19 视频），每个波次一个目录，入口为 `plan.md`。

## 状态与证据

- 方案状态以各文件标题或开头声明为准，本索引不另行维护完成度。
- 运行证据在 `.archive/runs/2026-10-21-bifrost-*`、`.archive/runs/2026-10-22-*` 及 `.archive/runs/legacy-plans/`；Ticket 正文内记录的执行报告路径（如 `.omc/reports/b5-*.md`）属于当时工作区证据，不代表当前仓库可读。
- 10-15 的 `issue5-*` 与 10-16 的 `bifrost-5-*` 是同一父 Issue 的前后版本，保留两者用于核对 intake 范围，不互相覆盖。
