# U03 独立 Review：对话内连接卡片（A06 前端半部 / Issue #495 / 本地票 up06）

- Reviewer：独立 reviewer（Task U03 最终质量关口；OCR 已按用户裁决取消）。只读；唯一写入为本文件。
- 对象：`app/src/components/channels/connect-app-card.tsx`（新，243 行）、`app/tests/connect-app-card.test.tsx`（新，429 行）、`app/src/components/channels/chat-transcript.tsx`（+26/0）、`app/src/locales/{en,zh-CN}/channels.json`（各 +15）、`docs/verification/e2e-bun-suites.json`（登记条目）。
- 材料：brief.md、implementer-report.md、validator-report.md、after-tracked.diff、red/green 证据、spec §4、up06、上游参考 `evidence/upstream-sources/.../connect-app-card.tsx`（172 行）、ledger §7。逐项独立复核，含亲跑验证。

## 结论：**PASS（无 BLOCKER / MAJOR / MINOR；6 条 OBS）**

## 1. Spec compliance（§4 前端半部逐条）

| §4 / up06 要求 | 判定 | 独立证据 |
|---|---|---|
| 复用现有 connect endpoint，服务端再校验 | PASS | 卡片仅消费 `connectAccountMutationOptions()`（mutations.ts:428 起，POST `/api/plugins/servers/:id/connect`，`requireUser` 在 routes.ts 服务端门禁）；未建第二套 API，未改 server/。marker 解析结果只用于绘制卡片，不作授权依据。 |
| 提示仅展示，不向任意 origin 导航 | PASS | 唯二外导航：`tab.location.replace(authorizationUrl)` 与 blocked 退路 `<a href>`，URL 全部来自 connect endpoint 响应；key 模式走内部 `Link`（路由 `app/src/routes/_authed/settings/connected-accounts/$key.tsx` 实存）。prompt 三字段（serverId/title/message）不进入任何导航。 |
| 预占新 tab；得到 URL 后导航；断 opener；popup blocked 退路 | PASS | `open()` 前两语句先 `attempted` 后 `window.open("about:blank","_blank")`，同步于 click、先于任何 await（测试在 settle 前断言 openSpy 恰 1 次）；URL 到手后对该句柄 `location.replace`；blocked → `blockedUrl` 可点链接（`target="_blank" rel="noreferrer"`，noreferrer 隐含 noopener，该链路天然切断）。**opener 在预占时即断**的判断见 §4。 |
| 仅等待期 2s 轮询，最长 5 分钟 | PASS | `refetchInterval: waiting ? 2_000 : false`（:73）；idle/超时后计数为 0 有测试钉住；`WAIT_LIMIT_MS=5*60_000` deadline effect 转 `timedOut` 明确重试态，按钮 enabled 可再按。上游参考**无**时限（无限轮询），本地按 Spec 补齐——正确的超出上游的 Spec 实现。 |
| 以未撤销有效记录为成功；返回/关闭不算成功 | PASS | 成功判定唯一来源 `personalConnections(rows).some(row => row.serverId===serverId && revoked!==true)`（holder!=="deployment" 过滤在 queries.ts:351，Shared/deployment 行不判成功）；组件无任何 tab 状态监听（无 close/focus/visibility），tab 关闭后 10s 仍 waiting 有测试。本地服务端行类型无 `revoked` 字段（GET /connections routes.ts:1306 不下发；本地撤权表现为行消失/secretFor 拒绝），`ConnectableRow` 交集防御性读取：absent≠revoked、`true` 永不判成功——与上游行型（含 revoked）语义桥接正确，且有测试覆盖 revoked 行。 |
| key 模式进设置页，绝不导航 null | PASS | `!authorizationUrl` → `tab?.close(); setNeedsKey(true)`，无导航语句（测试断言 `navigated` undefined）；渲染到 `/settings/connected-accounts/$key` 的 Link。 |
| 成功提示再发起、不重放 | PASS | connected 文案含 "Ask again"；connect POST 全程恰 1 次（测试计数）；无任何工具重放语句。 |
| 切范围/卸载旧响应不污染新卡片 | PASS | `attempted`/`was` 均为实例 ref 随卸载消亡；新卡片以自身首读初始化；unmount 后 60s fetch 数不变、前卡片未答 connect 不影响后卡，均有测试。app QueryClient staleTime 0（query-client.ts），重挂载即新读，无陈旧残留面。 |
| 旧客户端可读拒绝；中英/键盘/status | PASS | 识别失败/codec 拒识 → 落 `ToolLine` 原文本（refused 徽标 + 正文），即旧客户端路径；en/zh 各 13 键程序化核对完全一致、组件 13 处 `t("connectCard.*")` 全覆盖无遗漏无孤儿；`role="status"`×5、`role="alert"`（错误），Button/Link/a 原生可聚焦；`flex-wrap` 窄屏可用。 |

Fail-closed seam（brief 第 2 条、U02 OBS-3 交接）：`connectPromptOf` = `asText`（解 JSON 编码信封）→ `startsWith("Refused.")`（两端 marker 一致：本地 chat-transcript.tsx:57 与 server/src/plugins/tools.ts:36）→ slice+trim → `readConnectPrompt`（严格 codec）。普通拒绝、undefined、中部 marker 均为 null 有测试；与 team-bot-consent 分支互斥不串（前缀互异，consent 分支先行）。整行替换为卡片、否则原样文本——正确。

**Spec compliance 判定：逐条满足，无偏离已批准 Spec 之处。**

## 2. Code quality

### 2.1 `connectPromptOf` 的正确性与放置 — 好
- 放在唯一消费者 `chat-transcript.tsx` 内、导出为纯函数：`asText`/`REFUSAL_MARKER` 均是该文件既有依赖，紧邻 `ServerToolLine`；不塞进 U02 的 `shared/connect-prompt.ts`（本任务禁改 shared）也不另建文件，放置合理。双 `asText`（调用点已解一次、函数内再解）幂等无害（纯文本原样返回），且是导出函数可独立钉住所必需。
- 与既有 `isPersonSentMessage` 同先例；非 refused 结果进该函数只花一次 `startsWith`，代价可忽略。

### 2.2 `attempted` 门控（偏差 a）— 判断正确，优于上游
上游在 `connected` false→true 即 `invalidateQueries()` **全库**且无门控：本仓库 transcript 历史常驻，旧消息卡片每次挂载首读命中"已连接"都会构成一次边沿，等效于每次渲染旧消息都无效化整个查询缓存。`was=useRef(connected)` 首读必为 false（数据未达），门控后语义 = "本卡片自己的 connect 尝试以本人 live 行落地"才是一次成功事件。正确的本地化改造，且有专测钉住（mount-connected 零 invalidation）。残余缺口（卡片在成功前卸载 → attempted 消亡、该次不 invalidation）自愈：staleTime 0 重挂载即新读，且服务端每次执行独立校验授权，不构成正确性问题。失效范围 `pluginKeys.all=["plugins"]` 覆盖 page/connections/forAgent/composio/openConnector（queries.ts:216），与既有 `invalidatePlugins`（mutations.ts）同键；bot 授权（agents 族）本就不读 connections，不失效是对的。

### 2.3 opener 在预占时即断（对 brief 更严格）— 判定：正确，无窗口期问题
三点依据：
1. **上游参考就是这样做**：`claimTab()` 内 `if (tab) tab.opener = null`（上游 :83），预占即断先于 URL 到达。brief 的"得到授权地址后导航并切断 opener"是对 spec §4 压缩句的转述，与上游事实源不符处应以上游参考与 Spec 安全意图为准。
2. **技术上这是唯一可行顺序**：`about:blank` 阶段与 opener 同源、可写其属性；一旦 `location.replace` 到跨源 vendor 页，此侧再触该句柄任何属性都会因跨源限制抛错——"导航后再断"在真浏览器内必然静默失败。预占即断不仅更严，而且是能落地的唯一写法。
3. **无功能依赖被破坏**：成功判定是服务端轮询，回调是同 tab 内重定向，不依赖 opener 通道；blocked 退路链接自带 noreferrer。预占即断是把（claim→vendor 页运行）这段窗口关掉而不是打开。无窗口期问题。

### 2.4 测试环境三事实 — 让用例仍测真实行为，成立
- **isServer**：对照实装 query-core 5.102.2 源码逐字核实——`utils.js:6` `const isServer = typeof window === "undefined" || "Deno" in globalThis`（模块求值即冻结）、`environmentManager.js:7` `isServerFn = () => isServer`、`queryObserver.js:158` 以 `environmentManager.isServer()` 短路 refetchInterval。bun 单进程下 query-core 先于 DOM 求值 → 不解冻则轮询路径整段假死，测的是空转。测试以 `setIsServer(() => false)` 解冻、`afterAll` 还原为冻结常量 import——**成对且精确**。解冻后跑的是**生产的真实轮询路径**，不是替代品。
- **setTimeout(0)**：`notifyManager.js:3` `defaultScheduler = systemSetTimeoutZero`（timeoutManager.js:55）核实；假时钟下 `advance()` 内建 `advanceTimersByTime(0)` 冲刷，让库的真实通知路径落 DOM。测的是真调度。
- **restoreAllMocks**：afterEach 先 `useRealTimers` 再 restore（:116-127），顺序正确；本人 3 次连跑 15/0/39 稳定 + driven 全量组通过，无进程级泄漏实证。
- fetch 打桩走真 `client()` 信封线形；假句柄接受赋值使 `opener===null` 断言真实钉住（删赋值即红）；fresh QueryClient 隔离查询、spy 打在生产同款模块单例 `queryClient` 上（main.tsx:20 提供的正是该单例——生产调用路径与测试一致）。

### 2.5 i18n 与可访问性 — 达标
- en/zh 键集程序化核对完全一致（13=13），组件 13 处调用全覆盖，无硬编码可见英文；`message`（服务端写给模型的原句）按 `TeamBotConsentCard` 先例原样展示，属设计。卡片词汇（`rounded-lg border p-3 text-sm`、`flex-wrap`、status/alert）与同面 `TeamBotConsentCard`（team-bot-consent.tsx:34,39,49,84）逐类相同，未新设宽度——符合 openbot-screen-layout 约定；上游的 `max-w-2xl my-2` 未搬入，正确。
- 读经 queries 工厂、写经 mutations 工厂（openbot-data-access）；`queryClient` 模块单例 import 在 app/src 有 50 处先例。

### 2.6 与上游差异清点（均有理由）
| 差异 | 理由 | 判定 |
|---|---|---|
| +5 分钟 deadline / timedOut 态 | Spec §4 明文"最长 5 分钟"，上游没有 | 必须，正确 |
| + Stop waiting 按钮 | up06 "超时/错误有可操作退路"的等待期对应物 | 合理增强 |
| invalidation 门控 + 只失效 plugins 族 | 上游全库失效在常驻 transcript 下不可接受 | 正确本地化 |
| try/catch 包 opener 赋值 | happy-dom readonly 会让卡片死于点击中途；真浏览器 [Replaceable] 可写，行为不变；假句柄断言仍钉住赋值 | 正确的环境容忍 |
| i18n 全覆盖、role="alert"（上游 error 为 role="status"） | 本地 Spec 要求中英 + up06 键盘/status；错误用 alert 语义更对 | 正确 |
| key 模式分支补 `setWaiting(false)`、blocked 成功后清 `blockedUrl` | 上游遗留：needsKey 后 waiting 残 true 会让 refetchInterval 永续；blockedUrl 残留跨重试 | 顺手修正，正确 |

## 3. 亲跑验证（只读命令）

```
bun test ./app/tests/connect-app-card.test.tsx      # 15 pass / 0 fail / 39 expect，exit 0（×3，无 flake）
bun run --filter app typecheck                       # exit 0（pretypecheck 0）
bunx biome format <5 个改动文件>                      # exit 0，no fixes
bunx biome check  <3 个 tsx>                         # 0 error
E2E_BUN_ONLY="app/tests part 3" … tests/bun-suites.test.ts   # 1 passed，2.2s（本文件所在组绿）
E2E_BUN_ONLY="app/tests" … tests/bun-suites.test.ts          # 5/6 组绿；唯一红 = app/tests/ai-observability（ledger §7 已登记 BASE 既有红，与本任务 import 图零交集；part 1/3/4、multitenancy 全绿）
node scripts/e2e-coverage-audit.mjs                  # no gaps，1054 files · 576 native · 463 driven · 9 engine · 6 exclusions，exit 0
```

RED/GREEN 证据文件与报告口径一致（red-card-collection.txt exit 1 模块缺失；green-card-run.txt 15/0/39）。

## 4. 两份报告交叉核对

- validator **ACCEPTED 5/5** 的各项本人均可独立复现：15/0/39、typecheck 0、format/check 0、part 3 绿、coverage no gaps——两份报告与实物一致，无夸大。
- **OBS（报告口径）确认**：implementer §1 称 chat-transcript "+26/−1"，实测 numstat **26/0**（diff 本体 27 个 `+` 行含 `+++` 头、1 个 `−` 行即 `---` 头）；validator OBS-1 属实。另 implementer 称测试文件 "404 行"，实测 429（wc -l 428 无尾换行），同属报告数字漂移，不影响实物。
- **files 计数**：implementer "1055" vs validator "1054"——差额恰为被删的 `zz-probe.test.tsx`（见 OBS-5 时序）；本人实测 1054，与删除后状态自洽。
- 三个测试环境事实与库源码逐字相符（见 §2.4）；两报告对偏差 (a)(b)(c) 的评估本人均认可。

## 5. Findings

无 BLOCKER / MAJOR / MINOR。以下 OBS（info，不阻塞验收）：

| # | 级别 | 内容 |
|---|---|---|
| OBS-1 | info | **opener 切断机制的保证强度是上游继承属性**：`tab.opener = null` 依赖 `Window.opener` 的 [Replaceable] 语义（自身属性遮蔽原型 getter），对导航后新文档的效力随引擎实现而异，弱于 `noopener`——而 `noopener` 在此不可用（句柄必须保留以便后续导航，组件注释已说明）。本地与上游参考逐字同机制（claimTab），注释 "the same guarantee by a different route" 略有夸大。非本地可修（改法属上游设计变更），仅登记供对外反馈（ledger 口径：向上游反馈不在本授权内）。残余风险面：vendor 页理论可回触 opener 做导航（经典 reverse tabnabbing 面），实际被"授权 URL 仅来自服务端 connect 响应"收窄。 |
| OBS-2 | info | `:105` 内联 `queryClient.invalidateQueries({ queryKey: pluginKeys.all })`，未复用同模块已导出的 `invalidatePlugins(queryClient)`（该文件已 import mutations.ts，一行可换）。功能逐字等价，纯复用缺失。 |
| OBS-3 | info | 重试序列中 `blockedUrl` 不清零：第一次 blocked → 退路链接渲染后，再次点击若走 error 分支，旧 blocked 链接与错误提示并存（href 仍是上次的有效 URL）。纯外观；上游同样残留。 |
| OBS-4 | info | 等待中按钮仍可点（仅 `connect.isPending` disabled）：重复点击会预占多个 tab、多次 POST。上游同行为；成功边沿仍只失效一次，无正确性影响。brief 未约束，登记备查。 |
| OBS-5 | info | **进程性偏差：删除了非本任务的游离文件** `app/tests/zz-probe.test.tsx`（untracked，疑似并行会话遗留探针）。implementer 已如实披露（§6.6），validator 复核零引用、coverage audit 自洽（1054 vs 1055 差额即该文件），本人确认文件不在树上、清单零引用。共享工作区并行会话应把探针放各自 evidence scratch 名下，避免撞名误伤。 |
| OBS-6 | info | 旧客户端回退文本保留 `[connect-app]{…}` 前缀（fallback 不剥 marker），可读但带结构噪音——与 `[team-bot-consent]` 既有先例完全一致，属已接受的 codec fail-closed 取舍（宁可显示原文也不绘制半读卡片）。 |

## 6. 裁决摘要

- 三项已报告偏差（attempted 门控、try/catch opener、测试环境三事实）**全部成立**且处理正确；第四项（opener 预占即断）对 brief 更严格但与上游参考一致、技术上唯一可行、无窗口期问题。
- U03 增量恰为 owned_files + 清单登记；shared/server 未动；TDD 证据链完整；验证命令本人全部亲跑复现。
- **U03 通过，可进入编排者集成。**

Spec compliance: pass
Code quality: pass
