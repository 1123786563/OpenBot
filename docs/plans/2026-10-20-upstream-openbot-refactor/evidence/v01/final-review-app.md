# V01 终审报告 — app 域（U01 / U03 / U04 / L03 / R03）

- Reviewer: V01-app（只读终审）
- 日期: 2026-10-21
- 范围: BASE `3b4a7c68` → 当前工作树全量未提交增量中 `app/` 域（tracked 20 文件 + untracked 8 文件），跨任务集成视角
- 方法: 亲读全部 diff 与新文件；对每个跨任务 seam 亲跑测试；en/zh 键集合机比；I1–I4 合约逐字对照 implementation-plan；孤儿文件逐一对回 owned_files；BASE 行为用 `git show 3b4a7c68:` 复核

## 1. 结论

**无 BLOCKER / MAJOR / MINOR 须修项。** 跨任务叠加一致，无孤儿改动，Spec §3/§4/§5/§7 前端行为无未裁决矛盾，秘密不进 UI 持久层。3 个自选跨任务 seam 全部亲跑通过。发现项全部为 V01 台账记录（下 §5）。

## 2. 任务间交互核验

### 2.1 chat-transcript.tsx 上 U03+U04 的叠加 — 一致

- 管线单一：`items = groupToolSteps(toVisibleChatItems(messages))`（chat-transcript.tsx:1589），`groupBrowserSteps` 不再在生产管线（保留导出供 approvals-rules / browser-activity 既有测试消费，非死代码）。
- 分组边界与卡片路径不冲突：`foldable()` 只折叠 browser 步骤与不带"问人"拒绝的 `mcp__` 连接器；`asksThePerson()` 用与 `ServerToolLine` 相同的信封剥离（`asText` → `REFUSAL_MARKER` 前缀 → slice+trim）后同时探测 `readTeamBotConsent` 与 `readConnectPrompt`，两个"问人"卡片（Team Bot consent、ConnectAppCard）永不落进折叠。ServerToolLine 内 consent 分支先行、connectPromptOf 次之（chat-transcript.tsx:1408-1412），与分组判断 OR 语义一致，不存在"分组视为问人、渲染却不画卡"或反向的缝隙。
- 两端 marker 一致：`app/src/lib/plugins/tool-result.ts:11` 与 `server/src/plugins/tools.ts:42` 同为 `"Refused."`，server `tools.ts:343` 以 `${REFUSAL_MARKER} ${message}` 写出，`shared/connect-prompt.ts` 的 `connectAppRefusal` 产出 `[connect-app]{...}` 载荷，`readConnectPrompt` 严格回读（对象括号配对、长度上限、fail-closed）。U03 卡片与 U04 边界探测消费同一 codec，无第二解析器。

### 2.2 tool-activity.tsx 上 U04+R03 的叠加（StepKind 扩展）— 一致

- `StepKind` 只声明一次（tool-activity.tsx），U04 的 `"browser" | "connector"` 被 R03 扩为 `"search" | "fetch" | "browser" | "connector"`；`summarise()`、`stepDetails()`、`StepRow` 单点消费，无双定义。
- R03 分类读 `shared/research.ts` 的 `researchRoleOfTool`（与 server 授权求交同一张表，`RESEARCH_TOOLS` 六个 catalogue key 由 `server/tests/plugin-catalogue.test.ts` 钉住），前端不会自称 server 词表没有的角色；研究 server 上的未编目工具保持 connector 步骤（有测试）。
- 页数只从真实返回计：pending/failed/refused 的 fetch 计 0，摘要只数已返回的 search；错误保留 provider 原因与来源链接。上游匿名化（不显示 vendor 名）在标签层落实。
- 相邻性造成的表现差异（单条研究调用走 ServerToolLine 英文回退、成组走本地化 labelKey）见台账 L-1，非缺陷。

### 2.3 locales 多任务叠加 — 无键冲突

- channels.json：U03 加 `connectCard`（13 键），U04 加 `tools`（12 键），R03 往同一 `tools` 块加 `researchSearch`/`researchFetch`——嵌套感知去重扫描无重复键（`2.people` 报告项经 BASE 复核为扫描器数组边角，BASE 与现状同形，非本批引入）。
- common.json：L03 的 `signInForm` 6 新键；skills.json：R03 的 `tools` 4 新键。
- en/zh 全量扁平键集合机比：common/skills 完全一致；channels 仅 en 多 5 个 `_one` 复数变体——符合 i18next 复数类别（zh 只有 other）。改动文件内被 `t()` 引用的全部键在两种语言下可解析。
- L03 词条落 common.json 而非 brief 所写 settings.json——`signInForm` 命名空间事实源在 common.json，L03 review 已核实并声明偏差，成立。

### 2.4 computer-activity I1 两端 — 与计划合约逐字一致

- 实现与 implementation-plan §2 I1 完全吻合：`Activity{botId,epoch,announcement}`、`Withdrawal{botId,announcement}`、`reportComputerActivity(): number`、`withdrawComputerActivity(botId, announcement)`、两个订阅器返回退订函数；10 秒静默 epoch 语义保留且注释明言"不是服务器 runId"。
- 生产者唯一（call.ts，403 且有 announcement 才撤回；网络错/500/abort 不撤回，`ON_SCREEN_PATHS` 五路径与 agent-computer 实际 API 逐一核对：`/navigate /click /type /key /scroll`，而 `/screenshot /read /files/* /exec` 存在且保持静默——permit-list 语义正确）；消费者唯一（use-auto-watch-screen，经 channel 路由使用）。旧调用者忽略返回值不受影响，`callComputer` 签名兼容。
- 路由接线（$channelId.tsx）：`busy: isSettingsOpen || isWorkshopOpen` 使 workshop 面板获得与 settings 同等的"不被抢占"保护（BASE 只保护 settings/workatch，workshop 会被偷换面板）——有意的修正，与 brief "busy：settings/workshop 打开不被抢占"一致；`show()` 的 dismiss 交互保留。

### 2.5 其余接口合约（I2/I3/I4）— 消费侧吻合

- I2：卡片复用 `connectAccountMutationOptions(): Promise<string|null>`（returnTo 默认 settings，会话卡片语境正确）与 `connectionsQueryOptions()`，未建第二套 connect API；key 模式导航到既有 `/settings/connected-accounts/$key`（路由存在）。
- I3：`submitSignInCodeMutationOptions` POST `/api/sign-in-requests/:id/code` body `{code}`（server routes.ts:133 同字段）；`code_required` 进 `SignInStatus`、不在 `FINAL_SIGN_IN`（四终态原样），sign-in tool 轮询只在终态返回——code_required 期间 handler 持续等待（sign-in-card 新测试钉住 3.5s 内不返回）。
- I4：`RESEARCH_ROLES` 两枚逻辑 ref 与 `researchRoleOf` 解析互检（错拼 fail-closed 有测试）；`undeclaredElsewhere` 只豁免解析器认得的角色，旧实际 ref（`parallel/web_search` 等）照常上报。

## 3. 孤儿与越界检查

- tracked 20 个 app 文件逐一映射回 U01/U03/U04/L03/R03 owned_files，untracked 8 个（3 组件 + 5 测试）同为 brief 指名新建文件。**未发现不属于任何 brief 的 app 域改动。**
- `docs/verification/e2e-bun-suites.json` 为多域共享清单：app 相关新增（auto-watch-screen、computer-screen-announcement、connect-app-card、sign-in-code-step、tool-activity、user-key-status-ui 等）各有 cause 归因、每文件登记且仅登记一次；desktop/server 条目属其他域任务。
- 已知偏差裁定：
  - **chat-transcript.tsx:1390（ServerToolLine 的 `readToolName(name).label`）与 bot-profile/access.tsx:53 的 zh 英文回退**：两处文件行本身，BASE 同位即以 `readToolName().label` 直出未本地化标签（BASE chat-transcript.tsx:1388 亲证；access.tsx 全文件无 diff），属 **BASE 行为**。R03 新增的 `labelKey` 未接入这两个非 owned 消费点是本批新增的"未接线"面，但不构成回归（回退串即设计上的 en 兜底）。按 R03 review F4 的处置并入 **V01 台账 L-1**，修复为机械改动，另立小票。
  - U01 review F1（路由级 busy 组合无测试钉住）→ 台账 L-2 沿载。

## 4. Spec 层面与回归

### 4.1 Spec 矛盾扫描 — 无未裁决矛盾

- §3：公告具独立标识、403-only 撤回、网络失败/500/取消不撤回、手动面板优先、epoch 抑制、相邻聚合边界（文本/审批/连接要求/人工接管）——逐条有代码与测试对应；活动数据仅内存模块态，无持久化。
- §4：提示仅展示不作授权（成功判定=本人未撤销行，不重放原工具、不写任何授权态）；只预占同步空 tab、`opener` 切断、blocked 退路、key 模式去设置页、2s/5min 轮询窗口、卸载/切范围隔离——全部落实。
- §5：初次提交无 code 字段（submit 与 confirmSaved 双路径移除，旧字段不发送有钉住）；code_required 单字段步骤；filling 无任何可提交控件；终态无可操作控件；秘密清理矩阵（提交/取消/接管/卸载 → state 清空 + mutation `reset()` + `gcTime:0`）——`app/src/query-client.ts` 无任何 persister/本地存储，秘密不可能进 UI 持久层。
- §7：角色声明不等于授权（picker 提示 + 服务端求交）；未知工具不误标；页数不编造；来源 URL 保留。

### 4.2 回归抽跑（3 个跨任务 seam，全部亲跑）

| Seam | 命令 | 结果 |
|---|---|---|
| tool-activity + connect-app-card（U04+U03） | `bun test ./app/tests/tool-activity.test.tsx ./app/tests/connect-app-card.test.tsx` | 42 pass / 0 fail |
| tool-name + skill-form（R03，native 层） | `bunx e2e run --config e2e.unit.config.ts app/tests/tool-name.test.ts` | 27 pass / 0 fail（注：该文件 import e2e-compat，`bun test` 直跑在本环境因 `node:module.registerHooks` 缺失失败——BASE 同类文件 chat-origin.test.ts 同样失败，属 harness 两层制事实，非本批缺陷） |
| sign-in 全链（L03） | `bun test ./app/tests/sign-in-code-step.test.tsx ./app/tests/sign-in-card.test.tsx` | 12 pass / 0 fail |
| auto-watch + announcement + 回归（U01） | `bun test ./app/tests/auto-watch-screen.test.tsx ./app/tests/computer-screen-announcement.test.ts ./app/tests/computer-activity.test.ts` | 43 pass / 0 fail |
| 全 app 域 diff 测试合并跑 | 9 文件 | 109 pass，1 个 collect 错误 = BASE 文件 browser-activity.test.ts 的 registerHooks 环境项（单独跑同样失败，非本批引入） |

补充整面验证：
- `bunx e2e run --config e2e.unit.config.ts app/tests`（native 全量）：**806/809 通过**；唯一红文件 `group-people.test.tsx`（3/3，单独跑同红）——BASE 文件、与全部改动文件零 import 交集，判环境红，登记台账 L-5。
- `E2E_BUN_ONLY=app/tests bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`（driven 驱动轮）：6 组中 5 绿，唯一红为 **已登记 BASE 既有红 ai-observability**（`queryClient.ensureQueryData` 环境错），与 brief 声明基线一致。
- `node scripts/e2e-coverage-audit.mjs` exit 0（1061 文件四桶无缺口）。
- `bun run --filter app typecheck` exit 0；`bunx biome format` 12 个改动文件零修改。

## 5. Findings 台账（无本轮须修；以下全部为 V01 台账记录）

| # | 级别 | 位置 | 内容 | 处置 |
|---|---|---|---|---|
| L-1 | ledger（info） | chat-transcript.tsx:1390（ServerToolLine）、bot-profile/access.tsx:53 | zh 下单条研究调用行与 Bot 授权页显示英文角色标签（"Search the web"）。经 BASE 复核：两处消费点直用 `readToolName().label` 为 BASE 既有形态（未本地化非本批引入）；本批新增事实是 R03 的 `labelKey` 未接入这两个非 owned 消费点，同一类步骤因是否成组而呈现两种语言。 | R03 review F4 已建议集成轮跟踪，确认成立。修复机械（两处补 labelKey 翻译参数），另立小票，不阻塞本批。 |
| L-2 | ledger（low，沿载 U01-F1） | $channelId.tsx:71 | 路由级 `busy: isSettingsOpen || isWorkshopOpen` 组合与 pane 关闭 URL 路径无专项测试钉住（hook 层语义已钉）。 | U01 review 已登记；建议 V01 后续小票补路由渲染用例。 |
| L-3 | ledger（info） | tool-activity.tsx:509 | 生产折叠线的审批 seam（ToolActivity → PendingApprovals）只有间接覆盖：tool-activity 测试桩空 inbox，审批贴卡行为由 approvals-rules.test.tsx 经姊妹渲染器 BrowserActivity 钉住（共享同一 PendingApprovals 组件与同形 prop）。 | 可选补一条 ToolActivity 挂 pending 审批 id 的用例；不改行为。 |
| L-4 | ledger（info，沿载 U03 OBS-2/3/4） | connect-app-card.tsx | 内联 `pluginKeys.all` 失效未复用 `invalidatePlugins`；重试 error 路径旧 blockedUrl 残留；等待中按钮可重复点击预占多 tab。均为上游继承形态，无正确性影响。 | 维持 U03 review 登记，供上游反馈口径。 |
| L-5 | 环境（info） | 本 worktree 测试环境 | (a) `group-people.test.tsx` 3/3 红（BASE 文件、零交集，疑与本 worktree 安装态有关）——建议并入 V01 基线红清单核实归属；(b) e2e-compat 系文件在本环境 bun 1.4.2 下 `bun test` 直跑报 `registerHooks` 缺失，只能走 e2e native（BASE 同构文件同行为）；(c) driven 轮 ai-observability 组红为已登记基线红，本轮复跑确认仅此一组。 | 记入 V01 verification-summary 基线红清单；不归因本批。 |

## 6. 变更范围核对

- app/ tracked：20 文件（+888/−94），untracked：8 文件（connect-app-card.tsx、tool-activity.tsx、use-auto-watch-screen.ts + 5 测试），全部有主。无删除文件。
- 关键绝对路径：
  - `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update/app/src/components/channels/chat-transcript.tsx`
  - `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update/app/src/components/channels/tool-activity.tsx`
  - `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update/app/src/components/channels/connect-app-card.tsx`
  - `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update/app/src/components/computer/use-auto-watch-screen.ts`
  - `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update/app/src/components/passwords/sign-in-form.tsx`
  - `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update/app/src/lib/computers/call.ts`
  - `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update/app/src/lib/copilot/computer-activity.ts`
  - `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update/app/src/lib/plugins/tool-name.ts`
  - `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update/app/src/lib/skills/form.ts`

Spec compliance: pass
Code quality: pass
