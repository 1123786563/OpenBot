# 工作区重设计专题

Workspace Redesign B1 的主计划、T01–T08 任务拆分、P 系列修复，以及 B1 验证过程中发现的基础设施修复。

## 入口

| 用途 | 文件 |
| --- | --- |
| B1 主计划 | [b1/2026-10-20-workspace-redesign-b1.md](b1/2026-10-20-workspace-redesign-b1.md) |
| B1 任务 T07 | [b1/2026-10-20-workspace-redesign-b1-t07.md](b1/2026-10-20-workspace-redesign-b1-t07.md) |
| B1 任务 T08（终验门禁） | [b1/2026-10-20-workspace-redesign-b1-t08.md](b1/2026-10-20-workspace-redesign-b1-t08.md) |
| T01 控件边界级联修复 | [b1/2026-10-21-t01-control-border-cascade.md](b1/2026-10-21-t01-control-border-cascade.md) |
| T03 Skills 草稿生命周期 | [b1/2026-10-21-t03-skills-draft-lifecycle.md](b1/2026-10-21-t03-skills-draft-lifecycle.md) |
| 设计交接与页面结构 | `docs/design/2026-10-20-workspace-redesign/`、`docs/design/2026-10-20-page-structure-map.md` |

## P 系列修复

- [P11 审批规则保存错误焦点](b1/2026-10-21-workspace-redesign-p11-error-focus.md)
- [P14 发布对话框保存错误焦点](b1/2026-10-21-workspace-redesign-p14-error-focus.md)
- [P15 设置保存错误焦点](b1/2026-10-21-workspace-redesign-p15-error-focus.md)
- [P15 角色文本域回归复审修复](b1/2026-10-21-workspace-redesign-p15-textarea-review-fix.md)
- [P28 DetailPanel 宽度修复](b1/2026-10-21-workspace-redesign-p28-detailpanel-fill.md)

## 验证基础设施

- [B1 native 确定性修复](b1/2026-10-23-native-determinism-repair.md)：mock.module 注册表泄漏与串行/并行失败复现。
- [Driven JUnit 巨型报告解析修复](b1/2026-10-22-driven-junit-huge-report.md)：junit 报告体积与 driver 读取失败。

## 状态与证据

运行证据、截图、OCR、Brief 与 Ledger 在 `.archive/runs/2026-10-20-workspace-redesign-b1/`。P 系列和 T01/T03 方案是收口后的修复计划，保留在方案侧供追溯；不要再向 `docs/verification/` 写新证据。
