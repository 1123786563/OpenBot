# Better Auth 专题

Better Auth 全量集成的两版方案：2026-10-22 的完整集成设计（接口/验收/计划）与同日的 Agent 交付拆票版。

## 入口

| 用途 | 文件 |
| --- | --- |
| 全量集成方案 | [full-integration/plan.md](full-integration/plan.md) |
| 冻结接口 | [full-integration/interfaces.md](full-integration/interfaces.md) |
| 验收合同 | [full-integration/acceptance.md](full-integration/acceptance.md) |
| Agent 交付计划（25 任务拆票） | [agent-delivery/plan.md](agent-delivery/plan.md) |
| 拆票说明 | [agent-delivery/issues.md](agent-delivery/issues.md) |
| 任务映射 | [agent-delivery/task-map.json](agent-delivery/task-map.json) |
| 业务 Ticket | [../tickets/better-auth/](../tickets/better-auth/) |
| 规范 | `docs/specs/2026-10-22-better-auth-full-integration-design.md`、ADR 0011 |

## 阅读顺序

1. 先读 `full-integration/plan.md` 与 `acceptance.md`，确认范围和验收。
2. 需要派发时读 `agent-delivery/plan.md`；`task-map.json` 把内部 Task 映射到 Ticket 编号（T01.01–T08.08）。
3. Ticket 正文在 `../tickets/better-auth/`，正文中的「源计划」路径已指向本目录。

运行证据与设计评审在 `.archive/runs/2026-10-22-better-auth-*`。
