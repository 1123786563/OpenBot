# Issue #4 (Opik 自托管) 收尾 Run 方案 — 2026-10-24

- Root: `1123786563/OpenBot#4`；37 个正式子 Issue #7–#43（#39/T33 已 closed，其余 open）。
- 快照: `.archive/runs/2026-10-24-opik-issue4/scope/issues/`（2026-10-24 GitHub API 实读，41 文件，SHA-256 批 `e5cfe7ba06b341c9`）。
- 批准 Spec: `docs/specs/2026-10-14-opik-integration-design.md`（已批准 2026-10-14，批准进入实施计划阶段）。
- 前序计划: `2026-10-15-opik-issue4-plan.md`、`2026-10-15-opik-issue4-dag.md`、`2026-10-16-opik-issue4-dag.md`（最新依赖视图）；逐 Task 方案 `../superpowers/2026-10-15-opik-t01..t08`。
- 本 Run: Orca `run_e829d8e2ba6d`；集成分支 `1123786563/opik4-integration`；集成 Worktree `/Users/wuyongjun/orca/workspaces/OpenBot/opik4-integration`；**原始 BASE = main `b117c3c3e23f933f7ff025b7170a5314f239b504`**。

## 对账结论（2026-10-24，本 Run 摄取）

前序实施（2026-10-14→10-19 多个会话）已把全部 37 票的实现交付进 main：

- 代码：`server/src/ai-observability/` ~30 文件、12 张 drizzle 迁移（0149–0160）、app 页面/组件/i18n×4 子命名空间。
- 测试：`server/tests/opik-*.test.ts` 55 文件（含 integration）、`app/tests/ai-observability-*` 10 文件、`observability-authz.test.ts`。
- 部署：`docker/compose/opik.yml` + `docker/opik/versions.json`（Opik 2.2.100 digest 钉死，本机镜像已拉取）。
- 审查：5 轮 OCR（r1–r5 + r5fix W1–W4），r5fix 末轮证据口径 "opik suite 1068/0, typecheck 0, biome 0"（提交信息，2026-10-18）；T33/#39 于 2026-10-18 关闭。
- 证据缺口：逐票 ledger 仅存 T02/T03/T06（`.archive/plans/issue-4-ledger/`，主 checkout）；r5fix 报告文件已不在树内也不在本地归档；无存活的完整范围终审 PASS 报告；无真实实例（A1 enabled/A13/T37）证据。
- 风险：2026-10-19 测试运行器迁移、10-23 合并浪潮（mastra/heroui/craft/fix2）与 #489 F03（redaction 文件）在此之后动过相邻面；main 现状未复验。

## 本 Run 的 DAG（验收=「匹配当前代码的证据」，不重做子票已覆盖实现）

| id | 内容 | depends | owner | 产出 |
| --- | --- | --- | --- | --- |
| VBASE | 当前 BASE 的 opik 服务器套件（fresh DB `openbot_opik4_base@55433`）、app 可观测性套件、root typecheck、biome lint | — | 编排者 | `verification/vbase-*.log` |
| RECON | A1–A13 × 37 票逐条对账矩阵：票面验收 → 代码/测试/前序证据 → 差缺清单 | VBASE | 编排者 | `docs/plans/opik/2026-10-24-opik-issue4-reconciliation.md` + run 报告 |
| FIX-* | VBASE/RECON 发现的真实缺口修复任务（每任务一个任务 Worktree，K≤4） | 触发源 verified | claude 实施 + claude 独立审核 | 任务报告 + 集成 |
| E2E | 真实自托管 Opik 2.2.100（compose project `opik4-e2e`）起栈，跑真实实例验收集（A1 enabled 接收、A4 存储无秘密、A11 删除、A13 跨服务映射、T37 闭环），补缺失的验收脚本 | VBASE green | claude（任务 Worktree） | 证据 + 脚本 + 报告 |
| FREV | 完整范围终审（BASE..HEAD + 未提交），独立 Codex | 全部集成且组合验证通过 | codex | `reviews/final-*.md` |
| OCR | 同范围外层 open-code-review（`--audience agent`） | FREV 通过 | 编排者 | `ocr/*.md` |
| CLOSE | Ledger 收尾、Issue 关闭簿记（GitHub 关闭须核对当前授权，条件不足记待关闭） | OCR 无有效 critical/high/medium | 编排者 | `index.md` 终稿 |

## 授权与边界（本 Run）

- 授权：本地计划、任务 Worktree、实现、验证、修复、安全可核对的本地提交与合入集成分支。
- 不授权：push、远端合并、部署、生产数据操作、未经核对授权的 GitHub 写入。
- Agent 选择（main 的 `.agents/rules/orchestration-agents.md`）：实施=claude、独立审核=claude（不同会话）、终审=codex；OCR 由编排者执行。主机核验：本主机 620/489 Run 有 claude/codex 启动成功先例；实际回执为准。

## 资源

- 基线测试库：容器 `opik4-base-pg`（9ad592f6102b，openbot-postgres:latest，127.0.0.1:55433，DB `openbot_opik4_base`）——Run 资源，收尾清理。
- 真实实例栈：compose project `opik4-e2e`（E2E 任务独占）；本机 opik 2.2.100 镜像已就绪。
- 端口：55433（基线库）、5417/5418/5174+（opik 栈，均 127.0.0.1）；互斥声明见 Ledger。
