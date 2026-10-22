# H12 (#455) — 运行记录、评估对比与运维观测迁移报告

状态：implemented（workspace 增量，无 commit）；BASE `203d0f0244b2`，分支 `feat/heroui-v3-migration`。
工作区：`/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`。
检查点产物：`POST-CHECKPOINT.sha256`（本域 6 个改动文件）；native 证据 `native/`（report.json + results/）；命令与对照日志 `verify/`。

## 域起点事实（决定本轮 delta 形态）

- 全域 13 组件 + 12 路由在 BASE 即已直接消费 `@/components/ui/*`（button/item/separator/dialog/field/input/textarea/router-link；grep 聚合 41 条 ui 导入，0 条 `@base-ui`/`@radix-ui`/裸表单元素残留）：本域为 **verify-and-fix**，非重写。
- 域内无 Select 控件（grep `onValueChange|<Select` 0 命中）→ h05/h06 的 Select null 守卫模式在本域无适用点。
- 域内无 Recharts、无 `<table>`（grep 0 命中）→ AC2 的"图表/复杂表头/横向滚动"子句无对象；列表全部为 `Item` 行组合（Item `render={<Link/>}` 行导航是 h06 壳契约点名的合法形态，与 Button 的 render 移除不同面）。
- `runs`/`datasets`/`evaluations`/`exports` 页面体均经 `BotSubpage` 消费 H06 壳（`runs-list.tsx:405-416`、`evaluations-page.tsx:13-29`、`exports-status.tsx:59-76`、datasets 路由 `:22-28`）；三个孙级详情页（dataset-detail `:37-46`、experiment-comparison `:113-124`、experiment-results `:99-114,:142-152`）按既有深链接链设计直接用 `PageShell` + backButton 指向 evaluations 父页——BotSubpage 的返回链接冻结指向 `/bots/$agentId`，表达不了父=evaluations 的返回语义，故非"自写第二套壳"，而是壳契约自身包装的原语，未改壳。
- 本轮发现并修复 **1 个域内 driven 红**（`ai-observability-route-chain.test.tsx` 5/5），经纯净 BASE 对照定性为 **BASE 既有红**（非迁移引入），见下。

## 变更清单（6 文件；域内其余文件对 BASE 零 diff）

| 文件 | 变更 | 要点 |
| --- | --- | --- |
| `app/src/components/ai-observability/run-detail.tsx` | Button→ButtonLink | 详情页"返回列表"从 `Button render={<Link/>}`（role=button 的锚）改为 `ButtonLink`（真锚、role=link；`router-link.tsx:24-26` 冻结注释明确禁止前者），保留 `params/to/size/variant`（`:134-142`）。AC1：新标签页/中键/modifier 行为由浏览器保留。 |
| `app/src/components/ai-observability/runs-list.tsx` | 同上 | runs 列表页"Export status"兄弟页链接同改（`:258-265`）；分页/筛选/aria-pressed/keepPreviousData 异步合同零改动。 |
| `app/src/routes/_authed/admin/computers.tsx` | token 更名跟随 | per-bot 隔离说明行 `bg-muted`→`bg-ob-muted-surface/40`（`:124`）——全仓 token 更名（`styles/tokens.css:19-20`）在域内的遗留点，样式事实不变。 |
| `app/tests/ai-observability-exports.test.tsx` | 断言跟随 + biome | 导出链接断言 `role button`→`role link` + href/键盘路径保留（`:685`），与生产 ButtonLink 形态一致。 |
| `app/tests/ai-observability-run-detail.test.tsx` | 断言跟随 + biome | 返回链接断言同上（`:407`）。 |
| `app/tests/ai-observability-route-chain.test.tsx` | **本轮实质修复** | 见下节。 |

不改动（越权清单均未触碰）：`ui/*`、`package.json`/`bun.lock`、`main.tsx`/`__root.tsx`、`styles/*`、`lib/theme.ts`、H04–H09/H11 已改文件、H09 并行域（app-sidebar/layout/auth/sign/tenant）。

## 实质修复：route-chain 守卫上下文（BASE 既有红，5/5 → 5/5 绿）

- 现象：`bun test ./app/tests/ai-observability-route-chain.test.tsx` 5/5 fail，`undefined is not an object (evaluating 'queryClient.ensureQueryData')`，错误边界全屏。
- 单变量归因：`git worktree add /tmp/h12-base-check 203d0f02`（node_modules 符号链接，用后已删）在**纯净 BASE** 上同文件同样 5/5 红（exit 1，`verify/route-chain-BASE-pristine.log`）→ **非迁移引入**。根因在历史：测试 6a35a7bc（RED→GREEN 当时路由尚无 beforeLoad）之后 `bce0bce7` 给 runs/evaluations 路由补上 `requireBotObservabilityAccess(context.queryClient, …)` 守卫，测试从未跟随——测试的 `createRouter` 不传 context，`context.queryClient` 为 undefined。
- 修复（仅测试文件，生产零改动）：`draw()` 按生产形态接线——`createRouter({…, context: {} as RouterContext })` + `<RouterProvider router={router} context={{ queryClient }} />`（`main.tsx:21` 同形，`route-chain.test.tsx:171-181`），并以 `setQueryData(agentKeys.detail("agent-1"), { canManage: true })` + `staleTime ∞` 预置守卫读的缓存（`observability-route-guards.test.tsx:5-20` 同一种子，404 fetch 不会击穿 ensureQueryData）。效果：5 条深链接链断言现在**穿过真实 beforeLoad 守卫**而非崩溃绕过——AC1 的链级证据反而变强。
- 附带修正：原 beforeEach 注释声称"404 = manage gate 的拒绝"，与守卫现实矛盾，已按现实改写（`route-chain.test.tsx:139-150`）。

## AC 状态

### AC1 运行/数据集/评估详情、对比、导出的路径与深链接可用 — PASS（组件/单元级）

- runs 链（列表 + `$bindingId` 详情）与 evaluations 链（父页 + `experiment-comparisons`）经真实路由文件端到端钉死：直输 URL 渲染子页、父 URL 渲染父页、history.push 换屏，5/5（driven，修复后穿过真实守卫；`verify/route-chain-after-fix.log`）。
- 数据集详情 `$datasetId`、实验结果 `experiments/$experimentId/$executionId` 路由文件本轮零改动，backButton 指向 evaluations 父页（`dataset-detail.tsx:37-46`）；页面级证据 datasets 28/28、experiments 43/43（driven）。
- 导出状态页从 runs 列表可达（ButtonLink，`runs-list.tsx:258-265`），链接断言含 href/键盘 Enter 路径（`exports.test:678-690`）；四个 admin 观测路由在约定 URL 挂载并有诚实占位语（`ai-observability-routes.test.tsx` 2/2，driven）。

### AC2 筛选/分页/排序/复杂表头/图表/异步状态保持；不改写查询与 Recharts — PASS

- 筛选：state × time 双组 FilterChip（`aria-pressed` + active 实/outline 变体，`runs-list.tsx:190-212,291-312`）+"仅已加载页"明示（`:214-216`）；无匹配行 `role="status"`（`:226-228`）。
- 分页：cursor 栈 + `keepPreviousData`（`:108-122`，翻页不再整页卸载）、`aria-live` 区间陈述（`:244-250`）、next/prev 按 `nextCursor/isFetching` 禁用（`:266-284`）；导出列表截断明示（`exports-status.tsx:129-143`）。
- 图表/Recharts：本域 0 处（grep 0 命中），无改写对象；`lib/ai-observability/*` 查询层零 diff。
- 异步：五态屏判 `observationScreenFault` 单点共享（`state-notice.tsx:37-46`）；同步中/空/禁用/拒绝各自句子（`runs-list.tsx:180-186,219-228`）。

### AC3 运维连接失败/不可用/无权限/空数据明确；占位不当成功 — PASS

- 无权限：路由级 `requireBotObservabilityAccess`（runs/evaluations 链，canManage 判定，`route-guard.ts:13-22`）+ admin 继承 `_authed/admin` 守卫（`observability-route-guards.test.tsx` 3/3：manager 可达、canManage=false/undefined 重定向）。
- 不可用/失败：transport error → `unavailable` 句（`state-notice.tsx:41`），域内 StateNotice 8 处；管理员页故障同理（`admin-summary.tsx:75` 起）。
- 空数据：runs（`:219-224`）、experiments（`experiments-section.tsx:117-120`）、exports（`exports-status.tsx:105-113`）各有空态句；experiments 区故障不渲染由旁侧 datasets 区（同查询）出拒绝句，是测试钉住的既有设计，本轮不改。
- 占位诚实：`ObservabilityPlaceholder` 只说"此处将是什么"，不冒充 unavailable（`placeholder.tsx` 注释 + `ai-observability-routes.test.tsx` 断言 role=status）；八态 i18n 双语 parity（`observability-i18n-namespaces.test.ts` 4/4）。

### AC4 长表格横向滚动局限于容器；焦点与关键动作窄/短屏可达 — PASS（域内无表格形态）

- 本域列表全为 Item 行（无 `<table>`、无 `overflow-x` 需求面，grep 0 命中）；行导航即链接本体（`Item render={<Link/>}`），键盘焦点天然可达（`exports.test`/`run-detail.test` 的 focus→Enter 断言，修复后经 role=link）。
- 关键动作全部为原生 Button/锚（分页、下载、重置到第一页 `runs-list.tsx:140-149`），无悬浮式动作条；playground 保留自述的"唯一自持几何"双栏页（`playground.tsx` 注释内联说明），编辑器/预览/错误横幅均常规流内可达。
- 焦点陷阱/返回由 ui/dialog 适配层（H03 冻结面）承担；域内 3 个对话框均受控 `open`+`onOpenChange`（computers/playground/datasets review），未自写焦点管理。

## 验证（命令 + 真实 exit code）

| 项 | 命令（仓库根，除注明） | 结果 | 证据 |
| --- | --- | --- | --- |
| typecheck（修复+biome 后复跑） | `cd app && bun run typecheck` | **EXIT 0** | `verify/typecheck.log`、`verify/typecheck-final.log` |
| build | `cd app && bun run build` | **EXIT 0**（`✓ built in 8.72s`） | `verify/build.log` |
| native 全量 app 域 | `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/heroui-migration/h12/native bunx e2e run --config e2e.unit.config.ts`（在 app/ 内跑=空集） | **EXIT 1**：994 执行 = 983 pass / 11 fail / 0 skip（130 文件 = 126 pass / 4 fail）；11 失败全部为 brief/H06 点名的域外既有红，**本域 0 失败**（report.json `vcs.commit` 203d0f02, dirty） | `native/report.json`、`verify/native-h12-full.log` |
| driven 域内 13 文件 | `bun test ./app/tests/ai-observability-{admin-summary,datasets,experiment-comparison,experiments,exports,route-chain,routes,run-detail,run-steps,runs-list}.test.tsx ./app/tests/observability-{i18n-namespaces,route-guards}.test.* ./app/tests/playground-json.test.ts` | **EXIT 0**，13 文件 228/228 pass（biome --write 后复跑同结果） | `verify/driven-h12-domain.log` |
| route-chain 单变量对照 | 纯净 BASE worktree（/tmp，git worktree add 203d0f02 + node_modules 符号链接）`bun test ./app/tests/ai-observability-route-chain.test.tsx` | **EXIT 1，5/5 fail**（修复前工作区同 5/5）→ 红为 BASE 既有，非迁移引入；对照后 worktree 已删 | `verify/route-chain-BASE-pristine.log` |
| biome（6 个改动文件） | `bunx biome check --write <6 files>` 后 `bunx biome check <6 files>` | **write EXIT 0 → check EXIT 0**（修复 organizeImports/格式；同类诊断在 BASE 纯净树上对未改动兄弟文件同样存在，属测试语料普遍形态，前波同法收口） | `verify/biome-check.log` |

native 11 失败归因（均非本任务引入、均不在本域，与 H06 轮红集完全一致）：`zz-probe-context-menu` 8（既有真回归）、`approval-team-settings` 1（H07）、`gallery-components` 1（H13）、`heroui-spike` 1（H02）。注：前一会话 `verify/native-app-tier.log` 的 `__probe-h08` COLLECTION_ERROR 未复现——LEDGER 2026-10-20 01:54 的 e2e-bun-suites.json 孤儿条目修复在本轮生效。

## 遗留 / 记录

- 浏览器级证据（真实浏览器里的列表分页点击、导出下载、对话框焦点返回、窄/短视口走查）按分工留待 frontend_validator；本域组件级与路由链级断言已覆盖对应行为面。
- `h06/REPORT.md` 壳契约节"evaluations*（H12）当前未消费壳"一句与当前树不符：`evaluations-page.tsx`/`exports-status.tsx` 在 BASE 即已消费 BotSubpage（对 BASE 零 diff 可证）。属前波 REPORT 的时点性陈述，无需本轮回改；三个孙级详情页直用 PageShell 的原因见上"域起点事实"。
- `ai-observability-route-chain.test.tsx` 的 BASE 既有红由本轮顺带修复（域内、测试文件、AC1 主体证据），不构成对既有红清单的扩权；如需把"BASE 既有红"回溯进 LEDGER，请以 `verify/route-chain-BASE-pristine.log` 为证据。
- server 161 红为 server 域固有（Brief 在案），不属本任务。
