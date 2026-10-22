# ME06 (#478) Fix Round 1 Report — 评审修复（报告更正 / F2 跟踪 / 同义反复测试替换 / 503 映射 / F4 列表收窄 / F5 诊断 / F7 注记）

- Date: 2026-10-20
- Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`（分支 `1123786563/mastra-exec`，未提交树，BASE `bf64d0f2`；本轮零 commit/push/stash）
- 输入：控制器 fix-round-1 brief（7 项）+ 独立评审 findings（`me06/review-findings.md` 在落盘时缺失，以 brief 内嵌摘要为契约）
- 方法：先以临时探针验证真实引擎行为（探针即删），再落实现，最后全量绿波 ×3 + typecheck + biome。

## 1. 逐项处置

| 项 | 处置 | 说明 |
|---|---|---|
| **1. 报告更正**（AC1/AC3 → PARTIAL + dated correction note） | **done** | `report.md` §2 顶部加 **修正记录（fix-round-1，2026-10-20）** 块；AC1 标题 PASS→**PARTIAL（装配已交付、未接线）**，并补缺口段：`createMastraComputerTools` 作用域装配合同 + 4 测试已交付，但 Mastra 路径至今**无 server 侧 computer 工具生产 mount 点**，接线收敛于 ME09/ME10；AC3 标题 PASS→**PARTIAL（生产参与完成被有意拒绝）**，补缺口段：loopFor 在 receipt 之前抛 `MASTRA_RESUME_LOOP_MODEL_UNWIRED`（index.ts:3001-3006）+ F2 grant 门形状缺陷 + 浏览器回调接线 → ME16。§6.2 的"MASTRA 路径装配一律经 computer-scope.ts"已按指令改为"**已交付但未接线**（合同存在，生产无 mount 点），ME09/ME10 收敛"。其余 AC 判定与计数未动。 |
| **2. F2 跟踪**（grant 门 kind-aware 进入条件，文档 only） | **done** | `report.md` §4 末尾新增具名段落 **"F2 接线进入条件（fix-round-1 起跟踪；ME09/ME10 的硬前置）"**：生产 `toolGrantCurrent`（index.ts:2973-2982）以 plugin grantedTools 判定，对 browser 声明的 frontend_tool 名**恒假**（恒 403 GRANT_REVOKED）；ME09/ME10 接线 loopFor 前必须把门改为 kind-aware（`approval` 决策照旧查 plugin grant 台账，`frontend_tool` 决策改查本挂起绑定的 frontend 声明集或等价可撤权台账）。§6.3 同步引用。**index.ts 本轮零改动**。 |
| **3. 同义反复测试替换**（tests/mastra-computer-tools.test.ts:344） | **done** | `approval_pause_still_saves_an_approval_fact_alongside_frontend_tools`（现 :363，**测试名保留**）重写为**真引擎**断言：provider 脚本以 fixture 的 `toolName` 参数在 turn 0 点名 **granted** 工具（`computer_click`，execute 内置 throw 哨兵——若 durable pause 未先于 execute 触发，run 以 RUN_ERROR 响亮失败），`requestWith` 挂真实 granted 工具 + `durableToolNames`（requireApproval pause）+ frontend 桥，经 `runMastraExecution`（模块公共面）drain：断言 terminal 无（terminal-less 审批等待）、TOOL_CALL_START 在、`suspensions` 恰 1 条且 **kind === "approval"**、toolName 为 granted 名——同一台账上 ME05 语义未被桥扰动。选型说明：brief 的两个选项中取"真实 granted-tool 挂起"路径，但未接 Postgres 引擎存储（unit 文件无 DB 依赖；requireApproval 挂起在无存储时为进程内挂起，execution.ts:284-286 注释口径），fact 保存钩子与 kind 派发（execution.ts:444 `suspensionKindOf`）全为生产路径；DB 背书的 approval 挂起证据已由 ME05 套件（kind "approval" 带存储断言）持续覆盖。探针先行：临时 probe 文件验证引擎行为后即删（不在树中）。 |
| **4. statusForRefusal**（continuation-routes.ts） | **done** | 新增两枚举 case `MASTRA_CONTINUATIONS_UNWIRED` / `MASTRA_RESUME_LOOP_MODEL_UNWIRED` → **503**，取 503 而非 409 的理由写在 case 上方注释：配置边界（同一请求在已接线的部署上会成功），非调用方错误（4xx 会错怪请求）、非状态竞争（409 会诱导同调用重试）。函数改为 `export` 以供单元断言（生产消费者仍只有 route onError）。测试：unit 文件新增 `unwired_dependency_refusals_map_to_503_not_500`（:398）断言两码 =503、既有码映射不变（GRANT_REVOKED=403 / NOT_FOUND=404 / REVISION_CONFLICT=409 / 未知=500）。**未走 integration 路由文件路径**（该文件要在路由上真实命中 503 需构造第二个 mock install——不满足"trivially feasible"，按 brief 的 fallback 取 export + 单元断言）。两个拒绝码的铸造点（copilot.ts:2225 / index.ts:3003）不在本票允许清单，零改动。 |
| **5. F4 列表收窄**（continuation-store.ts listContinuations，:656） | **done** | 谓词组追加 `principalId = scope.principalId`（+6 行注释）：列表是查看者**自己的** waiting todo 列表——个人语义，非团队看板；挂起仅其属主 principal 可 act（每次 resume 逐字段复核 binding），列出同事的挂起只会展示永远无法 resume 的行。`getContinuation`/claim 保持 tenant+workspace 身份判定（外来行读作不存在，绝不枚举）；仅 LIST 面收窄。**route 测试无需更新**：`participation_route_list_get_and_tool_result_apply` 的挂起绑定与路由 scope 同为 `SCOPE`（principalId 同值），从未依赖跨 principal 可见——绿波实证。`listContinuations` 签名仍在 :656，report.md 原行号引用未失效。 |
| **6. F5 丢弃诊断**（frontend-tools.ts:88-100） | **done** | 复合丢弃条件改为逐因判别（invalid declaration / invalid tool name / reserved / granted 冲突 / duplicate），每次丢弃发**一条**结构化 `console.warn({ event: "mastra_frontend_tool_declaration_dropped", toolName, reason })`，带仓库同款 `// biome-ignore lint/suspicious/noConsole: stable-code operational log`（与 compatibility.ts:434 的 `console.warn({...})` 同形）；只点名工具名与原因，**永不回显 args**。既有让位测试的输出即见该行（`toolName: "computer_navigate", reason: "collides with a granted (server-executed) tool"`）——诊断已实证生效。 |
| **7. F7**（app.ts import 排序） | **done** | 不回退（biome 强制）；`report.md` §3 生成物行下补一句：app.ts diff 除路由挂载外含一遍 biome organize-imports（强制格式，逻辑零改动）。 |

## 2. 变更文件与 diff 摘要（全部未提交；均在本票允许清单内）

| 文件 | 行数 | 摘要 |
|---|---|---|
| `server/src/mastra/continuation-routes.ts` | 208 → 226（+18） | `statusForRefusal` 导出 + 返回类型加 503 + 两个 UNWIRED case（9 行理由注释）。既有映射零改动。 |
| `server/src/mastra/continuation-store.ts` | 871 → 878（+7） | `listContinuations` 谓词加 principalId + 6 行 F4 理由注释。无 SQL/语义外改动。 |
| `server/src/mastra/frontend-tools.ts` | 153 → 169（+16） | 丢弃原因判别 + 结构化 console.warn 诊断（F5）+ 函数 doc 补一句。挂载语义零变化（同一拒绝谓词，仅显因）。 |
| `server/tests/mastra-computer-tools.test.ts` | → 595 | 同义反复测试重写为真引擎审批挂起断言（+1 条 `GRANTED_CLICK_TOOL` 哨兵常量）；新增 statusForRefusal 单元断言 describe；biome organize-imports 重排 import（安全修复）。**11 → 12 tests**（+1）；原 1 expect 的同义反复 → 真 5 expect + 新 6 expect。 |
| `docs/plans/2026-10-19-mastra-execution-run/me06/report.md` | 157 → 163（+6 净） | §2 修正记录块 + AC1/AC3 改判与缺口段 + §3 app.ts 注 + §4 F2 进入条件 + §6.2/§6.3 更正。 |
| `docs/plans/2026-10-19-mastra-execution-run/me06/fix-round-1-report.md` | 新增 | 本报告。 |
| `server/tests/enterprise/mastra-frontend-tool-participation.integration.test.ts`、`server/src/index.ts`、`server/src/copilot.ts` | **未改** | 路由测试无需更新（F4 不涉跨 principal 依赖）；F2 仅文档跟踪。 |

`git status` 复核：本轮写入仅上表 6 个路径（探针文件已删除；`compatibility.ts` 的 M 为本轮之前既有树状态，本轮零触碰）。

## 3. 命令与真实计数

绿波（report.md §1.2 同一 15 文件清单与 env），实现后连跑 **3 次全绿、计数逐次相同**：

```
ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test \
bun test server/tests/mastra-computer-tools.test.ts \
  server/tests/enterprise/mastra-frontend-tool-participation.integration.test.ts \
  server/tests/mastra-continuations.test.ts \
  server/tests/enterprise/mastra-continuations.integration.test.ts \
  server/tests/mastra-stream-events.test.ts server/tests/mastra-ag-ui-agent.test.ts \
  server/tests/mastra-governed-execution.test.ts server/tests/mastra-governed-tools.test.ts \
  server/tests/mastra-browser-runner.test.ts server/tests/mastra-agent-resume-process.test.ts \
  server/tests/enterprise/mastra-compatibility.test.ts server/tests/mastra-tools.test.ts \
  server/tests/mastra-message-parts.test.ts \
  server/tests/enterprise/mastra-conversation-runtime.integration.test.ts \
  app/tests/mastra-runtime-compat.test.tsx
→ exit 0；**165 pass / 0 fail / 0 skip**，15 files，**796 expect() calls**（×3 复跑同数）
```

账目：评审基线 164 pass / 786 expect + 本轮 **+1 测试**（statusForRefusal 断言）与 **+10 expect**（审批挂起重写 1→5、新单元断言 6）= 165 / 796，吻合。本轮**未新增测试文件** → `e2e-file-audit` / `e2e-bun-manifest` 无需重跑（条件项）。

Typecheck / Biome：

```
bun run --cwd server typecheck → exit 1，恰好 3 条基线错误
  （scripts/bootstrap-local-gateway.ts:106/108/120，与本票零交集，与基线一致）
bunx biome check server/src/mastra → exit 0，clean（23 files）
bunx biome check <本轮触碰的 4 个代码文件> → exit 0，clean
  （测试文件一次 organize-imports 安全修复后复检通过）
```

## 4. 与 brief 的偏差与说明

1. **F5 断言路径**：brief 优先建议"route test 断言（若 trivially feasible）"；实际路由命中 503 需在 integration 文件构造第二个 mock install/驱动——不满足 trivially feasible，按 brief 预留的 fallback 导出 `statusForRefusal` 做单元断言（映射函数是路由 onError 的唯一生产消费面，断言真实）。
2. **同义反复替换的"持久"口径**：取真实 granted-tool 挂起 + durableToolNames（requireApproval）+ onSuspension fact 保存，但未接 Postgres 引擎存储（进程内挂起）；理由见 §1 项 3。若评审要求 DB 背书版本，需给 unit 文件引入 DB fixture（更大的改动面），可在下一轮再议。
3. report.md 原文各段（含个别行号 ~1-2 行漂移）除指令点名的更正外未动——与本轮"keep changes minimal"一致。
4. 评审 findings 文件（`me06/review-findings.md`）在本轮开工时未落盘，以控制器 brief 内嵌摘要为契约执行；评审原文于本轮中途由控制器落盘，**逐项交叉核对一致**（Required 1-4 与 Non-blocking F4/F5/F7 全覆盖，S4 tautology、S5 ME16 具名依赖均已处置）。

## 5. 遗留跟踪（不在本轮修复）

- **F2 进入条件** → ME09/ME10 硬前置（report.md §4 具名段落；index.ts 未改）。
- AC1 server 侧 computer mount 接线 → ME09/ME10；浏览器参与回调接线 → ME16（report.md §6 原样保留；review-findings.md S5 的"具名依赖、不埋 UNVERIFIED"已由 AC3 PARTIAL 段与 §6.1 具名承担）。
- 生产 503 的两个 UNWIRED 码在接线落地后应随之消失（届时 503 映射保留为防御性正确映射）。
- stop 门组合 generation 回调未测（review-findings.md Non-blocking，派 ME09/ME10 生产 headless 测试）。
- 零 commit/push/stash；共享未提交树状态与 ME01–ME06 各轮一致。
