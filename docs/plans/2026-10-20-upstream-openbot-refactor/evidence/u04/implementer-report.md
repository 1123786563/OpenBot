# U04 实施报告：工具活动分组与摘要（A07 / Issue #499 / 本地票 up07）

- 执行者：frontend_implementer。工作区：`.worktrees/upstream-openbot-update`（HEAD 3b4a7c68）。
- 未 commit/push、未用共享 stash、未派发子 Agent、未 cd 主 checkout。
- 改动仅限 brief owned_files。工作区在场 S01–S04/U01/U02/U03 改动未触碰：`shared/connect-prompt.ts`、`connect-app-card.tsx`、`chat-messages.ts`、`tool-line.tsx` 零改动（只消费）。
- 证据文件（本目录）：`red-group-run.txt`（RED，exit 1，Cannot find module，0 pass）、`green-group-run.txt`（GREEN，18 pass / exit 0）、`driven-app-groups-run.txt`（统一驱动全文）、`final-verification.txt`（套件/回归/typecheck/format/audit 汇总）、`after-tracked.diff`（全 tracked 工作区 diff，含在场其他任务改动；本任务增量见 §1）、`after-sha256.txt`（改动文件 SHA-256）、`brief.md`。

## 1. 改动摘要

| 文件 | 改动 |
|---|---|
| `app/src/components/channels/tool-activity.tsx`（新建，402 行） | ① 纯分组函数 `groupToolSteps(items: readonly VisibleChatItem[]): TranscriptItem[]`，`ToolGroup {kind:"tools"; id; steps}`——id 取**首步骤 id**；单条非 browser 工具按**原对象身份**透传（保持既有 `TranscriptToolCall` 单行渲染路径不变）；单条 browser 步骤仍成组（与既有 `groupBrowserSteps` 行为一致，第二条到达时行形状不变）。② 边界判定 `foldable`：browser 步骤可折；`mcp__` 前缀 connector 可折，但拒绝结果携带连接卡片（`readConnectPrompt`）或 Team Bot consent（`readTeamBotConsent`）时**不折**（`asksThePerson`：先 `asText` 解 JSON 编码、再剥 `Refused. ` 前缀才交给 codec，与 U03 交接的 `connectPromptOf` 同一信封剥离语义；fail-closed）。③ `stepDetails`：generic browser/connector 分类（**无 research 逻辑**——R03 接入点留待 R01/R03）；connector 分类沿用 `asText`/`REFUSAL_MARKER`/`toolResultFailed`（pending/success/blocked/failed 四态来自真实结果，不猜测措辞）；browser 委托既有 `browserStepDetails`。④ `summarise` 纯计数（browsed/browserSteps/去重 connectors），展示层用 i18n 组句。⑤ `ToolActivity` 组件：`ToolLine` 折叠行（running 时显示首个 pending 步骤 label…）+ 展开后每步骤一行，connector 步骤再展开 `<details>`（完整参数 `<dl>` + `forDisplay`→Streamdown 结果），渲染 `<PendingApprovals>` **在折叠外**。输入值**不截断**（偏差 D1）。 |
| `app/src/components/channels/chat-transcript.tsx`（本任务增量 +3 处） | 投影管线 `groupBrowserSteps(...)` → `groupToolSteps(toVisibleChatItems(messages))`；分支 `item.kind === "browser"` → `item.kind === "tools"` 渲染 `<ToolActivity>`（key/messageId/delay/active 语义不变）；import 换至 `./tool-activity`（`TranscriptItem` 类型来源随迁，`assertNever` 穷尽性保持）。`ServerToolLine`/`connectPromptOf` 零改动（U03 面板与 seam 保持）。该文件 diff 同时含 U03 在场改动，本任务增量仅上述三处。 |
| `app/src/components/channels/browser-activity.tsx`（+19/−8） | 仅新增导出：`isBrowserStep`（两个分组器共用的同一判定，防"一边算 browser 一边算未知工具"漂移）与 `StepLabelKey` 类型（供 `stepDetails.labelKey` 通过 i18n 字面量键类型检查）；`groupBrowserSteps` 改用 `isBrowserStep`（行为等价）。其余（`BrowserActivity`、`BrowserGroup`、`browserStepDetails`）零改动——`approvals-rules.test.tsx`（非 owned）仍挂载 `BrowserActivity`，须原样可用。 |
| `app/src/locales/{en,zh-CN}/channels.json`（各 +12 词条） | 新增 `tools.*` 命名空间（键序插在 `toolLine` 与 `transcript` 之间）：摘要短语（browsedPages_one/_other、usedBrowser、usedConnector、usedConnectors_one/_other）、连接词（andPhrase、listSeparator）、问题计数（issueCount_one/_other）、步骤状态（stepBlocked、stepFailed）。**纯新增，零删除/改写**（已核对 diff 无减行）。复用既有键：`browser.inProgress`、`browser.notCompleted`、`browser.step.*`、`browser.stepFailed`（与 `BrowserActivity` 同语义同文案）。无 locales 外硬编码文案。 |
| `app/tests/tool-activity.test.tsx`（新建，529 行，18 用例） | TDD 先行（见 §2）。bun-test-compat 层（happy-dom + preload + GlobalRegistrator，沿 connect-app-card/approvals-rules 先例）；组件用例以**隔离 `QueryClient`**（`new QueryClient({retry:false})`）包裹，fetch 打桩返回空审批 inbox；i18n 用例 `i18next.changeLanguage` 前后自恢复 en（不污染同进程兄弟文件）。 |
| `docs/verification/e2e-bun-suites.json` | `node scripts/e2e-add-driven.mjs app/tests/tool-activity.test.tsx "<reason>"` 登记一条（files + flat + causes），落在 `app/tests part 4` 组；脚本固有 rebalance（若干组逗号行重排 + `server/tests/multitenancy part 3` 拆分）为其自身行为。 |

## 2. RED→GREEN 证据

- **RED（实现前）**：`bun test ./app/tests/tool-activity.test.tsx` → exit 1，`Cannot find module '../src/components/channels/tool-activity'`，0 pass / 1 fail。全文存 `red-group-run.txt`。
- **GREEN（实现后）**：同命令 → **18 pass / 0 fail / 95 expect，exit 0**。全文存 `green-group-run.txt`（格式化后复跑同结果）。
- 过程说明（如实记录）：GREEN 迭代中修复的实现侧问题两类——① locale 键缺失导致摘要行渲染键名（补 en/zh 词条后消）；② 测试自身的**运算符优先级笔误** `expectGroup(groupToolSteps(...))[0]`（`[0]` 落在 expectGroup 结果上而非分组结果上，报"not a group: undefined"）——与生产代码无关，已全部改为 `[0]` 内联正确形式后 18/18 稳定。每类行为断言均先红后绿推进。

## 3. 行为矩阵（brief/criteria → 用例）

| 行为 | 实现 | 用例 |
|---|---|---|
| 相邻 mcp/browser 折为一组，组 id=首步骤 id | `groupToolSteps` close() 以 `run[0].id` 为组 id | adjacent connector and browser steps fold…；stream growth keeps the group on the first step's id… |
| 单 connector 保持原单行（回归） | run 长度 1 且非 browser → **原对象透传**（身份相等），落入既有 `TranscriptToolCall` 分支 | a single connector keeps its own line…（`toBe` 身份断言） |
| 单 browser 步骤仍成组 | `run.length===1 && isBrowserStep` → 组 | a single browser step still folds… |
| 文本打断分组 | 非 tool item 先 close() 再原位保留 | a text message breaks the run…；真实流投影用例（text/tools/tool/text） |
| 连接卡片（U03）不折叠 | `asksThePerson` → `readConnectPrompt` | a refusal that asks the person to act stays outside every fold（connect 分支，fixture=`Refused. ${connectAppRefusal(...)}` JSON 编码线上形） |
| Team Bot consent 不折叠 | `asksThePerson` → `readTeamBotConsent` | 同上（consent 分支） |
| 审批独立可见 | `<PendingApprovals toolCallIds>` 渲染在折叠行**外**（与上游/本地 BrowserActivity 同构；组件级行为由 approvals-rules.test.tsx 钉住，本任务零改动复用） | approvals-rules 12/12 回归绿 |
| 人机接管不折叠 | `computer_request_help`/`computer_request_secret` 非 browser（不在 labelKeys）非 mcp → 独立 | a human takeover request and a custom component tool stay independent… |
| 自定义组件工具不折叠 | 非 `mcp__` 前缀（有注册 renderer 的名字）→ 独立，仍走 `renderToolCall` | 同上（`display_chart`） |
| 普通拒绝照常折叠 | 仅卡片类拒绝豁免 | an ordinary refusal folds like any other step… |
| pending→success/blocked/failed/refused 随真实结果更新 | `stepDetails` 以 `result===undefined`/`REFUSAL_MARKER`/`toolResultFailed` 判四态；`StepStatus`/issues 计数渲染 | statuses follow the real results as they land, in place（rerender 后"Not completed"消失；失败→"Didn't work"+“1 issue"） |
| 完整参数/结果逐项展开 | 组行 `<details>` → 步骤行 → connector 步骤再 `<details>`：参数 `<dl>` 全量 + `forDisplay`→Streamdown | the collapsed line summarises…（点击后 input key/value 与结果文本可见） |
| 原错误信息不截断 | refused → body=剥离 marker 的完整原因；failed → `toolResultFailed` 原文全保留；inputs 不截断（D1） | refused.output/failed.output `toBe` 全文断言 |
| 结果走现有 asText/forDisplay/refusal 处理 | 分类用 `asText`+marker；绘制用 `forDisplay`（去 untrusted 信封/解 vendor JSON 包裹）→ Streamdown+markdownComponents | the untrusted envelope never reaches the reader…（CRITICAL 行与标签不在 DOM，内容在内）；a refused step reads as blocked…（"Refused." 不出现在读者侧） |
| 供应商内容不当授权 | 只绘制不执行；折叠判定只认服务器 `REFUSAL_MARKER`/codec，不猜措辞 | 同上 + grouping 系列用例 |
| 组 id 流中稳定、不重挂载 | 组 id=首步骤 id；React key 稳定 | DOM 节点身份断言：展开组后加入新步骤 rerender，`document.querySelector("details")` **同一节点**且 `open` 保持 true |
| 展开状态稳定 | 原生 `<details>` 持有展开态（ToolLine 注释同理由），组件无受控展开 state | 同上 + 步骤级 details 点击后 `open===true` |
| 键盘操作 | 原生 `<details>/<summary>`（无 tabIndex 覆写，天然可聚焦/Enter 切换）；按钮沿用现有词汇 | click 触发 toggle 的 DOM 断言（happy-dom 探针证实 summary click 置 open） |
| 中英文 | 摘要/状态/计数全走 i18n | the summary reads in English and in Chinese（"Browsed 1 page and used Notes" / “使用了 Notes”/“1 个问题”/“已阻止”） |
| 窄屏 | 沿用同面词汇：`min-w-0`/`truncate`/`break-words`/`flex`，未新设宽度（本地 ToolLine 无图标 prop，行词汇本就 icon-less，见 D2） | 类断言随组件结构；无新宽度值 |
| 历史消息无需迁移 | 纯视图投影，不写回存储；旧 thread 原样渲染 | fold 不改写输入 items（identity/result 不变断言） |

## 4. 分组边界清单

**可折叠（foldable）**：browser 步骤（`computer_navigate/read/snapshot/click/type/key/scroll`）；`mcp__*` connector，且其拒绝结果**不是**卡片类拒绝。

**边界（不折叠、原位保留）**：① 任何非 tool 行——文本（user/assistant）、activity（自定义组件界面）、attachments；② 携带 `[connect-app]` 连接卡片提示的拒绝（U03 卡片经既有 `ServerToolLine` 绘制）；③ 携带 `[team-bot-consent]` 的拒绝；④ 人机接管请求（`computer_request_help`、`computer_request_secret`）；⑤ 自定义组件工具（非 `mcp__` 命名，`renderToolCall` 有注册 renderer）；⑥ 等待审批——步骤本身可折叠，但审批卡片由 `PendingApprovals` 绘制在折叠行外（问题对人是问题，不进 disclosure）；⑦ 普通策略拒绝（无卡片 marker）**视为一行事实**，照常折叠——它不要求人做任何事。

## 5. i18n 词条（`channels:tools.*`，en / zh-CN 各 12）

| key | en | zh-CN |
|---|---|---|
| browsedPages_one | Browsed {{count}} page | —（zh 走 _other） |
| browsedPages_other | Browsed {{count}} pages | 浏览了 {{count}} 个页面 |
| usedBrowser | used the browser | 使用了浏览器 |
| usedConnector | used {{connector}} | 使用了 {{connector}} |
| usedConnectors_one | used {{count}} connector | — |
| usedConnectors_other | used {{count}} connectors | 使用了 {{count}} 个连接器 |
| andPhrase | " and "（前后空格） | 并 |
| listSeparator | ", " | ， |
| issueCount_one | 1 issue | — |
| issueCount_other | {{count}} issues | {{count}} 个问题 |
| stepBlocked | Blocked | 已阻止 |
| stepFailed | Didn't work | 未成功 |

摘要组句：纯计数 `summarise` → 组件 `t()` 出短语 → 首字母大写（zh 无影响）→ `andPhrase`/`listSeparator` 连接。连接器名沿用上游 `connectorName`（`google-drive`→"Google Drive"，语言中立）。复用既有键：`browser.inProgress/notCompleted/step.*`（zh 已有完整词条）。无任何 locales 外硬编码用户可见文案。

## 6. 验证结果

| 项 | 命令（worktree 根） | 结果 |
|---|---|---|
| 新套件 | `bun test ./app/tests/tool-activity.test.tsx` | **18 pass / 0 fail / 95 expect**（exit 0；格式化后复跑同） |
| 回归（brief 指定） | `bun test ./app/tests/connect-app-card.test.tsx` | **15 pass / 0 fail** |
| 回归（同面挂载） | `bun test ./app/tests/approvals-rules.test.tsx` | **12 pass / 0 fail**（`BrowserActivity` 仍被其挂载，行为保持） |
| 回归（native 层） | `bunx e2e run --config e2e.unit.config.ts browser-activity / tool-result / tool-name` | **29/29**（3/3、15/15、11/11） |
| 回归（transcript 消费者） | `bun test person-sent-message / transcript-attachments / composer-attachments-ui / composer-queue-attachments` | 3/40/10/12 全绿 |
| 统一驱动 | `E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=.e2e/u04-driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` | **5/6 组绿**（part 1–4、multitenancy ✓，本文件在 **part 4 ✓**）；唯一红 `app/tests/ai-observability` = **已登记 BASE 既有红**（账本 U03 同录） |
| 登记对账 | `node scripts/e2e-coverage-audit.mjs` | **no gaps**：1055 文件 · 576 native · **464 driven（+1=本文件）** · 9 engine · 6 exclusions |
| typecheck | `bun run --filter app typecheck` | exit 0 |
| format | `bunx biome format` 每改动文件 | 五个源文件/测试/locale **全部 exit 0**；`e2e-bun-suites.json` exit 1 = **BASE 既有**（HEAD 同样 exit 1，脚本生成文件、1 空格缩进非 biome 风格；见 D6） |
| biome check | `bunx biome check` 四个 ts(x) | 0 error / 0 warning（organizeImports 已 --write 归位） |

## 7. 偏差与环境事实（如实记录）

1. **D1（有意上游分歧）：参数值不截断。** 上游 `inputValue` 对每参数 200 字符截断；本地按 AC A07"完整参数/结果可展开”与 Spec §3“保留步骤原始参数与结果"不截断（展开面板本有 `max-h-60 overflow-auto`）。错误信息保真由 refused/failed 用例钉住。
2. **D2（本地既有词汇）：无图标堆叠。** 上游 StepRow/ToolLine 带图标栈；本地 `tool-line.tsx` **不在 owned_files** 且本无 `icon` prop，`BrowserActivity` 单行本就无图标。本地沿 icon-less 词汇（ StepRow 同样无图标），不改非 owned 组件。
3. **D3（i18n 架构）：`summarise` 返回结构化计数，组句在组件内 `t()`。** 上游硬编码英文短语；brief 要求 en/zh 词条且 locales 外不加文案。结构化计数保持分组/摘要逻辑可无渲染器单测。
4. **D4（范围）：无 research 分类。** `StepKind = "browser" | "connector"`；R01/R03 之前的角色词表不预建（brief 明令）。上游的 search/fetch/url 细节逻辑未移植。
5. **D5：`BrowserActivity`/`groupBrowserSteps` 保留不删。** 非 owned 的 `approvals-rules.test.tsx` 挂载 `BrowserActivity` 并钉住其行为；transcript 不再使用它，但组件与其测试保持原样可用（避免越权改测试）。
6. **D6（BASE 既有）：`docs/verification/e2e-bun-suites.json` biome format exit 1。** 该文件为脚本生成（1 空格缩进），HEAD 版本同样 exit 1（已验证）。本任务经官方 `scripts/e2e-add-driven.mjs` 写入，行风格与脚本输出一致；不对手工重排整文件（下次脚本运行会覆盖）。新增行如实报告为"与脚本输出一致、文件整体非 biome 格式（BASE 既有）”。
7. **OBS-1（待主控/validator 裁定）：`billing-credits-ui.test.tsx` native 直跑 8/18 红（断言"连续包月"未渲染）。** 事实链：该文件属 native 收集（不在 bun 驱动清单）；其 import 图（`@/lib/billing/credits`、`@/lib/i18n`、registry 级 mock 的 `@/components/ui/dialog`）与本任务六文件**零交集**（文件内 "chat-transcript" 仅是注释）；失败断言文本是**测试自身 fixture**（:260/:299/:314 `label: "连续包月"`），非 locale 词条；本任务 locale diff 纯新增。同文件 10/18 用例（含同类渲染）通过。尝试 BASE 一次性 worktree 复现因依赖解析未遂（已全部清理，无残留）。判定：与本任务无关的既有/环境红，交 validator 复核；本任务 driven 面内无此文件。
8. **OBS-2（测试环境事实，供后来者）**：① happy-dom 对 `<details>/<summary>` 的 click toggle 与 rerender 节点保持均真实可用（先用一次性探针验证后删除）；② bun 对 `.tsx` 内联多行函数实参无异常——先前的"编译异常"怀疑实为上述优先级笔误（§2），不要为幻影 transpiler bug 绕路。
9. **U02 交接确认**：`asksThePerson` 在本任务内完成信封剥离（`asText`→剥 `Refused. `→codec），与 `connectPromptOf` 同语义；折叠判定只认 `REFUSAL_MARKER` 起始的拒绝，marker 出现在文本中部不触发豁免（fail-closed，随 U02 codec 行为）。

## 8. 明确不做（brief 禁止项核对）

- 未改消息存储/工具执行（纯视图投影；fold 输入 items 未被改写的身份断言钉住）；未引入新依赖（import 全为既有模块）；未隐藏人工决定类条目（§4 边界清单 + 用例）；未修改 U02 `shared/connect-prompt.ts` 与 U03 `connect-app-card.tsx`（零改动，只消费其导出）；未提前实现 research 逻辑（D4）。
- 非 owned 的 untracked 文件一律未删；过程中自建的一次性探针（`zz-u04-probe.test.tsx`、`zz-u04-min.test.tsx`、`/tmp` 与嵌套 BASE worktree）均已自行清理，`git worktree list`/`git status` 无残留。
