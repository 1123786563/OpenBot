# U03 验收报告：对话内连接卡片（frontend_validator，2026-10-20）

- 验收对象：Task U03（A06 前端半部 / Issue #495 / 本地票 up06）。
- 工作区：`.worktrees/upstream-openbot-update`（HEAD 3b4a7c68 + 在场未提交树）。验证者只读源码与测试，唯一写入为本文件；未 commit/stash/push、未派发子 Agent。
- 材料核验：`implementer-report.md`、`after-tracked.diff`（761 行，含在场其他任务改动，任务增量见 §4）、`brief.md`、`green-card-run.txt`、`driven-part3-run.txt`、`driven-app-tests-summary.json`、新文件 `app/src/components/channels/connect-app-card.tsx`（243 行）与 `app/tests/connect-app-card.test.tsx`（429 行）直接读取。

## 结论：**ACCEPTED（5/5 项 PASS）**

无 DEFECT 级发现。3 条 OBS（info 级）见 §6。

## 1. 行为验证 — PASS

亲跑 `bun test ./app/tests/connect-app-card.test.tsx` → **15 pass / 0 fail / 39 expect，exit 0**。本人共跑 3 次（首跑 + 2 次稳定性复跑），三次全 15 pass，无 flake。与 `green-card-run.txt` 逐项一致（15/0/39）。

断言抽查（逐条对照实现 + 测试）：

| 行为 | 判定 | 证据 |
|---|---|---|
| 点击同步预占空 tab，先于任何 await | PASS | `connect-app-card.tsx:131-133`：`open()` 首两语句 `attempted.current = true; window.open("about:blank","_blank")`，之后同步 `connect.mutate`，中间无 await。测试 `:238-248` 在 `fireEvent.click` 后、`settle` 前即断言 `openSpy` 恰 1 次 |
| URL 到达后 `location.replace` + opener=null | PASS | `:158-161` onSuccess 内 `tab.location.replace(authorizationUrl)`；opener 在预占时即断开（`:137-141`）——比"到达后再断"更严格（预占到导航之间无窗口期）。测试断言 `navigated===AUTH_URL`、`opener===null`（假句柄可写，断言真实钉住赋值发生） |
| popup blocked 退路链接 | PASS | `:163` `tab` 为 null → `setBlockedUrl(url)`；`:219-231` 渲染 `<a target="_blank" rel="noreferrer">`。测试 `:250-259` 断言 href/target |
| null URL（key 模式）→ 设置页、绝不导航 null | PASS | `:150-155`：`tab?.close(); setNeedsKey(true)`，无任何导航语句；`:183-189` Link 到 `/settings/connected-accounts/$key`。测试 `:261-276` 断言 `navigated` undefined、`closed===true`、链接 href 正确 |
| 轮询仅等待期每 2s | PASS | `:73` `refetchInterval: waiting ? 2_000 : false`。测试 `:296-318`：空闲 6s 计 1 次（仅挂载首读）→ 等待期 2×2s 计 2 次 → Stop waiting 后 6s 计 0 次 |
| 5 分钟超时转重试态 | PASS | `:18` `WAIT_LIMIT_MS=5*60*1000`，effect `:110-117`。测试 `:320-339`：6×50s 后出现超时文案、轮询停（10s 计 0）、按钮 enabled 可重试 |
| 成功只认 serverId 匹配且 revoked!==true | PASS | `:82-87`：`personalConnections(...)`（queries.ts:351 过滤 `holder!=="deployment"`）`.some(row => row.serverId===serverId && revoked!==true)`。测试 `:341-372` 覆盖 deployment 行 / revoked 行 / 他 app 行均不判成功，person 行判成功 |
| tab 关闭/窗口返回不算成功 | PASS | 组件无任何 tab 状态监听（无 close/focus/visibility 处理）；成功唯一来源是连接列表。测试 `:383-395`：10s 后仍 waiting 文案 |
| 成功 → invalidate + "再次发起"、不自动重放 | PASS | `:101-108`：成功边沿（且 `attempted`）→ `invalidateQueries({queryKey: pluginKeys.all})` + 退出等待；`:176-179` connected 文案。测试 `:365-371`：spy 断言参数恰为 `pluginKeys.all`、`connectPosts` 全程 1 次、文案含 "Ask again" |
| 卸载/切范围旧响应不污染新卡片 | PASS | `attempted`/`was` 均为实例 ref，随卸载消亡；新卡片 `was` 以首读初始化。测试 `:399-427`：unmount 后 60s fetch 数不变；前卡片未答 connect 卸载后，新卡片独立空闲态 |

## 2. transcript 接入 — PASS

- **信封剥离（U02 reviewer F-07 / OBS-3 落实）**：`chat-transcript.tsx:1445-1450` `connectPromptOf(result)` = `asText`（解 JSON 编码信封，tool-result.ts:28）→ `startsWith(REFUSAL_MARKER)`（`"Refused."`，本地 :11 与 server/src/plugins/tools.ts:36 两端一致）→ `slice + trim` → `readConnectPrompt`。与 U02 validator OBS-3 交接的形态 `Refused. [connect-app]{…}` 完全对应；不剥则 codec 的 `startsWith([connect-app])` 永不命中。
- **fail-closed**：`undefined → null`（:1446）；无 marker / 普通拒绝（`Refused. <sentence>`）/ marker 在文本中部 → null（`:1448`）；codec 拒识 → null → 落入 `ToolLine` 原文本（`refused=true` 徽标 + 剥信封后正文，`:1414-1428`），即旧客户端可读路径。测试 `:212-234` 四个 seam 用例钉住（含用真 writer `connectAppRefusal` 的 roundtrip）。
- **Team Bot consent 等其他分支不受影响**：consent 分支先行（`:1409-1410`，作用于剥信封后的 `body`），marker 互异（`[team-bot-consent]` team-bots.ts:155 vs `[connect-app]`），`readTeamBotConsent` 对 connect-app 文本返回 null，connect 拒绝正常落入下一分支；反向亦然。无普通工具聚合折叠（仅 `groupBrowserSteps`），无 fold 边界改动——与报告声明一致。
- 双重 `asText`（ServerToolLine 已解一次、`connectPromptOf` 再解）无害：`asText` 仅解 JSON 字符串形态，纯文本原样返回（tool-result.ts:29-30），且第二次解是导出函数可独立测试所必需。

## 3. 偏差评估 — 三项均成立

**(a) invalidation 门控于 `attempted`：判断正确。** `was = useRef(connected)` 以首渲染值（数据未达，connected=false）初始化；transcript 历史常驻，旧卡片挂载首次读取命中"已连接"构成 false→true，若无门控每次渲染历史消息都会无效化 plugins 缓存。门控后语义 = "本卡片自己的 connect 尝试以本人 live 行落地"才是一次成功事件，测试 `:374-381` 钉住（mount-connected 零 invalidation）。与既有 `invalidatePlugins`（mutations.ts:96，`disconnectAccount` 等）同键同法，"精准"成立（仅 plugins 实体，覆盖 page/connections/forAgent）。

**(b) try/catch opener：合理且行为仍被钉住。** HTML 规范 `window.opener` 为 [Replaceable]（真浏览器赋值成功）；happy-dom 暴露为只读，strict mode 下赋值抛 TypeError，try/catch 只扩环境容忍、不改真浏览器行为。行为承诺未放松：测试用假句柄接受赋值并断言 `opener === null`（:247）——若有人删掉赋值语句，该断言即红。

**(c) 测试环境三事实：真实、必要、处理正确。**
- **isServer**：核对 query-core 5.102.2 源码——`environmentManager.js` 的 `isServerFn` 默认指向模块加载即冻结的 `isServer` 常量（utils.js:6 `typeof window === "undefined"`），`queryObserver.js:158` 以 `environmentManager.isServer()` 短路整个 refetchInterval 路径。bun 单进程下 query-core 先于 DOM 求值 → 轮询全仓静默失效属实。测试 `beforeAll` `setIsServer(() => false)`、`afterAll` `setIsServer(() => isServer)`（还原为原冻结常量 import）——**成对且精确**，与库源码逐字核对。
- **setTimeout(0)**：react-query observer 通知走 `systemSetTimeoutZero`，假时钟下 `advance()` helper 内建 `advanceTimersByTime(0)` 冲刷，必要且已封装。
- **restoreAllMocks**：afterEach 先 `useRealTimers` 再 `mockRestore`/`restoreAllMocks`（:116-127），顺序正确；本人 3 次连跑无 flake 佐证。

## 4. 范围与登记 — PASS

- **任务增量恰为 owned_files + 清单条目**：`connect-app-card.tsx`（新）、`connect-app-card.test.tsx`（新）、`chat-transcript.tsx`（**numstat 26/0**，仅 3 个 hunk：2 import + 接入 3 行 + `connectPromptOf` 导出函数，无其他 hunk）、`en/zh-CN channels.json`（各 +15：13 词条 + 命名空间括号，插序 alphabetical 于 composer/consent 之间，无其他 hunk）。`shared/connect-prompt.ts` 为 U02 的 untracked 新文件，U03 仅消费。
- **manifest 登记**：`docs/verification/e2e-bun-suites.json` 中 `connect-app-card.test.tsx` 入 "app/tests part 3" 组（24 files）+ 顶层 files 列表（463 driven）+ causes 一条。组内其他 churn（bot-sharing 移组、multitenancy part 3 新组、auto-watch-screen/computer-screen-announcement）为脚本固有 rebalance 与在场其他任务登记，与报告 §6.5 声明一致。
- **i18n**：程序化核对 en/zh-CN 各 13 键、键名两语言一致；组件 13 处 `t("connectCard.*")` 全覆盖可见文案，无硬编码英文；`message`（服务端拒绝原句）按 TeamBotConsentCard 先例原样展示，属设计而非违规。
- **键盘/live region**：Button/Link/a 原生可聚焦；`role="status"` ×5（connected/keyMode/waiting/timedOut/blocked）、`role="alert"`（:233）；测试经 `getByRole("alert"/"button"/"link")` 可证。
- **`bun run --filter app typecheck` → exit 0**（本人亲跑，含 pretypecheck 0）。
- **biome**：`bunx biome format` 五个改动文件 exit 0 无修正；`bunx biome check` 三个 tsx 0 error（均亲跑）。
- **统一驱动（本人复跑）**：`E2E_BUN_ONLY="app/tests" bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` → 6 组中 5 组绿，**part 3（含本文件）绿（2.14s）**；唯一红 = `app/tests/ai-observability`（`ai-observability-route-chain.test.tsx` 5/5，`queryClient.ensureQueryData` undefined）——与 ledger.md:101 登记的 BASE 既有红（V01 台账，BASE 一次性 worktree 复现）完全一致。coverage audit：**no gaps**，1054 files · 576 native · 463 driven · 9 engine · 6 named exclusions，exit 0。

## 5. 交叉核对 — PASS

- **断言抽查 3 处**（报告 §3 行为矩阵 → 测试实录）：(1) "the blank tab is claimed synchronously…" 测试 ：238，断言 openSpy 1 次 / `navigated` / `opener` null 于 :243/:245/:247——与矩阵行一致；(2) "after five minutes the wait ends…" :320，超时文案 + 轮询停 + 按钮 enabled——一致；(3) "a mounted card whose app is already connected invalidates nothing" :374，`invalidate` not called——一致。`green-card-run.txt` 与本人首跑计数逐字相同（15/0/39/exit 0）。
- **偏差 4（误删游离 `zz-probe.test.tsx`）无残留影响**：该文件（untracked）已不在树上，全仓（app/tests/docs/verification/scripts）零引用；删除后 coverage audit 仍 no gaps（本人实跑 1054 files，较实现者报告的 1055 少 1，恰为该文件——自洽）；统一驱动各组照常通过。确认为共享工作区并行会话探针误伤，非本任务内容丢失。

## 6. 问题分级

无 BLOCKER / MAJOR / MINOR。以下为 OBS（info，不阻塞验收）：

| # | 级别 | 内容 |
|---|---|---|
| OBS-1 | info | 报告 §1 称 chat-transcript.tsx "+26/−1"，实际 numstat 为 **26/0**（无删行）。纯报告数字失准，diff 本体无恙。 |
| OBS-2 | info | 卡片 `:105` 内联 `invalidateQueries({queryKey: pluginKeys.all})`，未复用既有 `invalidatePlugins(queryClient)` helper（app/src/lib/plugins/mutations.ts:96）。功能逐字等价，属轻微重复。 |
| OBS-3 | info | 对"已连接"卡片再次发起（re-auth 场景）connected 无 false→true 边沿 → 该次不触发 invalidation，而 connect endpoint 已改变服务端状态。与边沿语义一致、brief 未要求，且既有 mutation 本身也不做 invalidation；仅登记供后续参考。 |

## 7. 验证者执行清单（可复现）

```
bun test ./app/tests/connect-app-card.test.tsx                          # 15 pass / 0 fail / 39 expect，exit 0（×3）
bun run --filter app typecheck                                          # exit 0
bunx biome format <5 个改动文件>                                        # exit 0，no fixes
bunx biome check  <3 个 tsx>                                            # 0 error
E2E_BUN_ONLY="app/tests" E2E_UNIT_OUTPUT=.e2e/u03-validator-driven \
  bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts     # 5/6 组绿；唯一红=ai-observability（已登记 BASE 红）
node scripts/e2e-coverage-audit.mjs                                     # no gaps，exit 0
```

运行产物目录 `.e2e/u03-validator-driven/` 为驱动命令固有输出，未触碰任何源码/测试/文档。
