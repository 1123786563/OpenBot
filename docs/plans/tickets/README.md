# 业务 Ticket 与派发材料

按 ticket set 分组的纵向业务 Ticket。每个目录通常包含：`README.md`（范围与依赖）、`parent.md` / `parent-issue.md`、`issues/`（逐票正文）、`manifest.json` / `tickets.json`（静态清单）。派发说明和父 Issue 快照也放在这里。

| Ticket set | 内容 | 关联方案 |
| --- | --- | --- |
| [bifrost-5](bifrost-5/) | Bifrost 5：Issue #5、#207–#357，按 01–22 组 | [../bifrost/](../bifrost/README.md) |
| [mastra-agent-execution](mastra-agent-execution/) | Mastra Agent 执行迁移 16 张子票 | [../mastra/](../mastra/README.md) |
| [craft-preview-origin](craft-preview-origin/) | 独立预览 Origin 与 HMR 票 | [../craft/](../craft/README.md) |
| [heroui-migration](heroui-migration/) | HeroUI v3 迁移 H01–H15 | [../heroui/](../heroui/README.md) |
| [hindsight-personal-memory](hindsight-personal-memory/) | Hindsight 个人记忆逐票 | [../hindsight/](../hindsight/README.md) |
| [opik-4](opik-4/) | Opik Issue #4 清单 | [../opik/](../opik/README.md) |
| [plugin-package-marketplace](plugin-package-marketplace/) | 插件包与市场 PKG01–PKG12 | [../plugin-marketplace/](../plugin-marketplace/README.md) |
| [upstream-openbot-update](upstream-openbot-update/) | 上游能力更新 UP01–UP12 | [../upstream-sync/](../upstream-sync/README.md) |
| [better-auth](better-auth/) | Better Auth T01.01–T08.08 | [../better-auth/](../better-auth/README.md) |

## 规则

- Ticket 正文、父 Issue 和 manifest 是需求快照；运行状态、验证结果、Review/OCR 和修复 Brief 不写回这里，归 `.archive/runs/<run-key>/`。
- 发布脚本、handoff 压缩包、来源快照和校验 JSON 属于运行物料，已迁入 `.archive/runs/legacy-plans/tickets/<set>/`；需要时显式引用归档路径。
- 新 ticket set 使用 `tickets/<set>/`，在 README 登记；对应实施方案放在相邻的 track 目录，不放在 ticket 目录内。
- 多租户 ticket set 已随 Issue #6 作废并删除，原文在 `.archive/runs/2026-10-22-issue6-void/`。
