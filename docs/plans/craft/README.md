# Craft 专题

Craft 行为的 Onyx parity 修复、独立预览 Origin 的部署与安全修复，以及 Onyx→OpenBot 的移植参考材料。

## 入口

| 用途 | 文件 |
| --- | --- |
| 预览修复现状方案 | [preview/2026-10-17-craft-preview-remediation.md](preview/2026-10-17-craft-preview-remediation.md) |
| 预览修复波次索引（#403–#419） | [preview/2026-10-17-craft-preview-cp-wave-index.md](preview/2026-10-17-craft-preview-cp-wave-index.md) |
| 最新预览收口计划 | [preview/2026-10-23-craft-preview-404-419/plan.md](preview/2026-10-23-craft-preview-404-419/plan.md) |
| Craft parity 修复 | [parity/2026-10-12-craft-parity-remediation.md](parity/2026-10-12-craft-parity-remediation.md) |
| 移植参考总览 | [port/README.md](port/README.md) |
| 业务 Ticket | [../tickets/craft-preview-origin/](../tickets/craft-preview-origin/) |
| 规范 | `docs/specs/2026-10-10-craft-workshop-design.md`、`docs/specs/2026-10-15-craft-preview-origin-design.md` |

## 目录

- `parity/`：Craft 可观察行为与 Onyx 的 parity 差距及修复方案。
- `preview/`：独立 Origin 预览的修复方案、单 Issue 拆解（#410、#425、#427）和 2026-10-23 收口计划。
- `port/`：Onyx 架构分析、契约、schema 备注和 fixture 对照；这是移植参考，不是执行计划。

## 状态与证据

- 预览相关运行/验收证据在 `.archive/runs/craft-port/` 与 `.archive/runs/2026-10-23-craft-preview-404-419/`。
- `port/README.md` 中的差异清单是移植期结论；行为变更前先核对当前代码和批准 Spec。
