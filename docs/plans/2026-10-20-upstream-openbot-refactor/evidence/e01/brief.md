# Task Brief E01：后续架构与客户端差距评估

- **Task/AC**: E01 / A12。正式 Issue：[#498](https://github.com/1123786563/OpenBot/issues/498)（本地票 `docs/tickets/upstream-openbot-update/issues/up11.md`）。
- **owner_role**: architect（你）。**只读生产代码与文档**；唯一写入为产出文档与报告。
- **工作区**: `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`。不得 cd 主 checkout、不得 git stash/commit/push、不派发子 Agent。

## 事实源

1. Spec §8 与 up11 六条 criteria；ADR 0004–0010；Mastra 已批准 Spec `docs/specs/2026-10-19-mastra-agent-execution-migration-design.md`（只引用不修改）。
2. 固定对象：本地 `apps/openmuse` 子模块（`git submodule status` 取当前 SHA 并记录）；上游 `e8bb27368ff436958b614292ae91283e51d5a813` 的 `mobile/`、`shared/harnesses.json`、`agent-antigravity/`、`toolkit/`（用 `git show e8bb2736:<path>` 只读）。
3. 既有矩阵 `docs/research/2026-10-20-upstream-openbot-feature-matrix.md`——已知误判（根 mobile "缺失"、记忆镜像"可能缺失"、`server/src/web-research.ts` 路径）以你的复核为准修正。

## owned_files

- `docs/plans/2026-10-20-upstream-openbot-refactor/adoption-decisions.md`（新建，唯一产出）
- `docs/plans/2026-10-20-upstream-openbot-refactor/evidence/e01/architect-report.md`

## 要求

每项输出固定字段：`现有入口 / 行为差距 / 约束 / 复用方案 / 后续验收 / 采用或延期结论 / 证据路径`。

1. **移动端**：固定子模块 SHA；分别登记 OpenMuse mobile 的"有页面、有 API、已实测"三态（读 `apps/openmuse/apps/mobile/` 与其运行证据/测试）；上游 `mobile/` 的能力对照；**结论不得复制第二套 mobile 到根目录**。
2. **Antigravity**：上游 `agent-antigravity/` 的 Gemini 凭据需求 vs 本地逐用户模型网关授权（ADR 0002/0003）逐项比较；不兼容则明确**延期**而非旁路接入。
3. **统一 harness 目录**：上游 `shared/harnesses.json` 单一事实源方案 vs 本地 `app/src/components/agents/create-agent-dialog.tsx`、`desktop/src-tauri/src/harness.rs` 的双端映射；保留本地 trpc/sandbox 差异的复用方式。
4. **toolkit**：上游 `toolkit/src/`（run-turn、headless-tools 等）的 lock/lease/settle/cancel 与 Mastra 已批准票（#472 树）映射去重；**不建第二套 Run/Attempt 权威**。
5. **既有能力核验**：记忆镜像（`server/src/memory/`）、Learning（`server/src/learning/`）、身份绑定（`server/src/identity/`）、CSV 导出（audit export）——列现有实现证据，不重复建实现票。
6. 每个剩余缺口给采用/延期理由与独立后续验收边界；**评估完成不宣称功能已上线**。

## 验证

- 只读源码/Spec/ADR 对照矩阵；所有结论带 `file:line` 或 `git show e8bb2736:<path>` 证据路径。
- 完成后主控交独立 reviewer 复核（A12）。

## 报告

`evidence/e01/architect-report.md`：评估方法、SHA 固定记录、结论摘要表；正文进 `adoption-decisions.md`。
