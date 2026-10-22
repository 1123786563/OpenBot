# E01 Architect Report（方法 / SHA / 摘要）

- Task：E01（UP11 / AC A12）。角色：architect。日期：2026-10-20。
- 工作区：`/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`（隔离 git worktree；未 cd 主 checkout、未 stash/commit/push、未派发子 Agent）。
- 约束遵守：只读生产代码与文档；唯一写入为 `../adoption-decisions.md`（正文）与本报告。R03 并行作业文件（`app/src/lib/plugins/tool-name.ts` 等）仅只读未触碰。

## 评估方法

1. 读事实源：父 Spec `docs/specs/2026-10-20-upstream-openbot-adoption-design.md`（§8、A12、Out of Scope）、up11 六条 criteria、ADR 0002/0003/0005/0010、Mastra 已批准 Spec（只引用）、实施计划 Task E01（`implementation-plan.md:389-401`）。
2. 固定对象后只读比对：本地 worktree（HEAD `3b4a7c68`）、OpenMuse 子模块 gitlink、上游 `e8bb2736` 的 `mobile/`、`shared/harnesses.json`、`shared/harnesses.ts`、`shared/research.ts`、`agent-antigravity/`、`toolkit/` 及桌面/建 Bot 对话框对应文件。
3. 对既有矩阵 `docs/research/2026-10-20-upstream-openbot-feature-matrix.md` 的三项已知误判逐条以 `git show`/`git grep`/`git ls-tree` 复核并修正。
4. 对 toolkit 与本地 `server/src/routines/run-turn.ts` 做逐行 diff（≈600 行差异，集中在 import 路径与 ports 抽取），确认同源而非双实现，据此做映射去重而非建票。
5. 每项按 Brief 固定七字段（现有入口/行为差距/约束/复用方案/后续验收/采用或延期结论/证据路径）落正文；结论只登记决定，不宣称功能上线。

## SHA 固定记录

| 对象 | SHA | 获取命令 | 可读性验证 |
|---|---|---|---|
| 本仓库 worktree HEAD | `3b4a7c68132c3507300408346a44fb9d56f3c14c` | `git log --oneline -1` | 直接只读；`server/src/audit.ts` 工作树有在途改动（HEAD `:477` / 工作树 `:480`，双注） |
| OpenMuse 子模块 gitlink | `491d6215fa508808289053757e5084c875b7318c`（worktree 内子模块未初始化，`git submodule status` 前缀 `-`） | `git ls-tree HEAD apps/openmuse` | `git --git-dir=/Users/wuyongjun/trea/OpenBot/.git/modules/apps/openmuse cat-file -t 491d6215` → commit（"docs(agents): 对齐 OpenBot 集成工作的 Issue tracker 与事实源边界"） |
| 上游 CopilotKit/OpenBot | `e8bb27368ff436958b614292ae91283e51d5a813` | `git remote -v`（upstream）+ `git cat-file -t` → commit | `git show e8bb2736:<path>` 全部可读（mobile/、shared/harnesses.*、agent-antigravity/、toolkit/、shared/research.ts） |

## 结论摘要表

| # | 评估项 | 结论 | 关键依据（证据见正文对应节） |
|---|---|---|---|
| 1 | 移动端 | **延期**（OpenMuse mobile 为唯一移动产品；不复制第二套到根目录） | 子模块 `apps/mobile/` 有页面（60+ 文件）、有 API（`MuseApi` Bearer）、已实测（9 测试文件入 monorepo `pnpm test` + CI + 演示录像）；上游 mobile 10 页中 5 类独立页在 OpenMuse mobile 无对应，登记为 backlog 候选 |
| 2 | Antigravity | **延期，不旁路接入** | 上游部署级 `GOOGLE_API_KEY` 单 Key 与 ADR 0002 逐用户虚拟 Key / ADR 0003 预留结算正面冲突；Gemini v1beta 兼容网关门面（带 reserve/settle）本地与上游均不存在 |
| 3 | 统一 harness 目录 | **采用机制，后续任务交付**（本轮只评估） | 上游 `shared/harnesses.json` + TS 类型 + 桌面 `include_str!`（`e8bb2736:desktop/src-tauri/src/harness.rs:197-198`）+ Web `WEB_HARNESSES`；本地桌面 Rust 硬编码 13 行（仅缺 antigravity 行），本地独有 `agent-trpc`/`agent-sandbox` 需保留为新行；Web 向导保持 builtin/managed 分叉 |
| 4 | toolkit | **延期拆包采用；lock/lease/settle/cancel 行为映射进 Mastra 已批准票，不建第二套 Run/Attempt 权威** | `toolkit/src/run-turn.ts` 与本地 `server/src/routines/run-turn.ts` 同源（diff≈600 行为 import/ports）；thread lock=引擎级互斥≠业务 owner lease（RunService 权威）；五个映射对齐 ME02/ME04/ME05/ME09/ME14 |
| 5 | 既有能力核验 | **已具备**（记忆镜像、Learning、身份绑定、CSV 导出），不建重复实现票 | `server/src/memory/store.ts:65-71,111,129-130`、`learning/auto-assign.ts`+`ensure-container.ts`、`identity/` 7 模块 13 测试、`app.ts:1587` CSV 路由 + `audit.exported` + 双端测试 |
| 6 | 剩余缺口 | 每项带采用/延期理由与独立验收边界（正文 §6 表）；评估完成≠功能上线 | 启动诊断（D01/A09）与三 provider 研究（R01–R03/A10）由在途任务覆盖，不在 E01 重复 |

## 矩阵误判修正摘要

1. 根 mobile "缺失" → OpenMuse mobile 在子模块存在，三态（页面/API/实测）均有证据。
2. 记忆镜像 "部分具备/可能缺失" → 已具备（`mirrorEligible` 谓词 + 逐人单飞镜像 + user-scope grant）。
3. 上游 `server/src/web-research.ts` → 路径不存在；实际为 `shared/research.ts`（`e8bb2736:shared/research.ts:2`）+ `server/tests/web-research.test.ts`。

## 验证与遗留

- 全部结论带 `file:line` 或 `git show e8bb2736:<path>` / `491d6215:<path>` 证据路径；子模块读取命令已在正文"固定对象与证据路径约定"给出，reviewer 可独立复跑。
- 本任务未运行产品测试（评估任务，验证方式 = 只读对照 + 独立 reviewer 复核，见 up11 Verification）。
- 未宣称任何被评估能力已上线；后续验收边界均要求独立行为证据。
