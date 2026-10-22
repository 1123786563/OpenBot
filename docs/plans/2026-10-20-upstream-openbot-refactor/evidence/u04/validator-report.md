# U04 Validator Report — 工具活动分组与摘要（A07 / Issue #499 / up07）

- 验证者：frontend_validator（只读业务与测试源码；唯一写入：本报告）。工作区：`.worktrees/upstream-openbot-update`。
- 验证日期：2026-10-20。材料：`brief.md`、`implementer-report.md`、`before/after-tracked.diff`、`red/green-group-run.txt`、`final-verification.txt`、新文件 `app/src/components/channels/tool-activity.tsx` + `app/tests/tool-activity.test.tsx`（untracked 直读）。
- 已知裁定（ledger §7 Ruling U04-OBS1）：billing-credits-ui 8/18 红为环境依赖基线红，不在回归范围；ai-observability 为 manifest 已登记 BASE 红，同不计入。

## 结论：**PASS（验收通过）**

五项验收全部 PASS，无阻断/主要问题；2 条 NIT 级观察（均不要求修改）。

## 1. 行为 — PASS

**亲跑** `bun test ./app/tests/tool-activity.test.tsx`：**18 pass / 0 fail / 95 expect**（bun 1.4.2，980ms，exit 0）。与 implementer 报告的 GREEN 数字一致；RED 证据（`red-group-run.txt`：Cannot find module、0 pass / 1 fail）真实。

抽查断言（逐条在测试文件中定位并核对，全部成立）：

| 要求 | 用例 | 证据 |
|---|---|---|
| 相邻 connector/browser 折叠 | "adjacent connector and browser steps fold into one group led by the first step's id" | 1 组、`steps[i]` 与入参 `toBe` 身份相等、入参未被改写 |
| 单 connector 对象身份透传保留原单行 | "a single connector keeps its own line, exactly as it renders today" | `expect(grouped[0]).toBe(only)`，kind 仍为 `"tool"` → 落既有 `TranscriptToolCall` 分支 |
| 文本打断 | "a text message breaks the run…" + "grouping reads a real streamed conversation…"（toVisibleChatItems 真实投影） | 两侧各自成组，text 原位保留 |
| 组 id=首步骤 id（DOM 身份钉住） | "stream growth keeps the group on the first step's id…" + "the folded line keeps its identity and stays open…" | 分组层 `id===first`；DOM 层 rerender 后 `document.querySelector("details")).toBe(line)` 同一节点且 `open` 保持 |
| 连接卡片/consent 不折叠 | "a refusal that asks the person to act stays outside every fold" | connectAppRefusal 与 [team-bot-consent] 两分支均原位保留 |
| 接管/自定义组件不折叠 | "a human takeover request and a custom component tool stay independent…" | `computer_request_help`、`display_chart` 均打断 run |
| 审批不折叠 | 组件结构 + 回归 | `<PendingApprovals toolCallIds>` 渲染在 ToolLine 折叠外（tool-activity.tsx:397，与 browser-activity.tsx:179 同构）；approvals-rules 12/12 绿 |
| pending→终态计数更新 | "statuses follow the real results as they land, in place" | rerender 后 "Not completed" 消失；失败→"Didn't work"+"1 issue" |
| 完整参数/结果展开 | "the collapsed line summarises the run and opens to every step…" | 折叠行→步骤行→connector `<details>` 参数 `<dl>`（query/standup notes）+ forDisplay→Streamdown 结果可见 |
| 唯一错误信息不截去 | "a browser step keeps its browser facts…"（refused.output/failed.output `toBe` 全文）+ "expanded inputs keep the whole argument, however long"（400 字符 > 上游 200 截断线） | 全文保留 |
| 失败/拒绝分类保留 | 同上 | `refused.refused=true/failed=false`；`failed.failed=true/refused=false` 互斥成立 |

另核：untrusted envelope 用例断言 "CRITICAL:…" 与 `<untrusted_data` 不进 DOM、内容在内；en/zh 双语用例真实渲染断言。

## 2. 边界判定 — PASS

- **信封剥离同语义**：`asksThePerson`（tool-activity.tsx:92-98）与 U03 `connectPromptOf`（chat-transcript.tsx:1445-1450）逐步相同：`undefined` 守卫 → `asText` 解 JSON 编码 → `startsWith(REFUSAL_MARKER)` → `slice(marker.length).trim()` → 交给 codec（U04 多并 `readTeamBotConsent`，U03 只 `readConnectPrompt`）。fail-closed 一致：marker 在文本中部不触发。
- **普通策略拒绝照常折叠**：`foldable` 只豁免 codec 认定的 asks-the-person；"an ordinary refusal folds like any other step" 用例钉住（`Refused. The policy does not allow that.` 与后续步骤同组）。
- **forDisplay/Streamdown 沿用现有 renderer**：tool-activity.tsx:337 与 ServerToolLine（chat-transcript.tsx:1423-1425）逐字相同 `<Streamdown components={markdownComponents}>{forDisplay(...)}</Streamdown>`；只绘制不执行，供应商内容不当授权。

## 3. 范围 — PASS

- **改动恰为 owned_files + manifest**：对 `before-tracked.diff`（U03 后状态）与 `after-tracked.diff` 逐文件 hunk 级比对——两 diff 交集内发生变化的 tracked 文件仅 `chat-transcript.tsx`、`locales/en/channels.json`、`locales/zh-CN/channels.json`、`e2e-bun-suites.json`（全部 owned）；`browser-activity.tsx` 为唯一新增 tracked 变更（before-status.txt 确认 U04 前未改）。**非 owned tracked 文件零新增 hunk**。untracked 新文件恰为 `tool-activity.tsx` + `tool-activity.test.tsx`（before-status 无此二者）。
- **chat-transcript.tsx 仅 3 处增量**：① import 换至 `./tool-activity`（移除 browser-activity import）；② 投影 `groupBrowserSteps(...)` → `groupToolSteps(toVisibleChatItems(messages))`（:1589）；③ 分支 `kind==="browser"` → `kind==="tools"` 渲染 `<ToolActivity>`（:1729，key/messageId/delay/active 语义不变）。`ServerToolLine`/`connectPromptOf` 区块在 before/after diff 中逐字相同（零改动，U03 增量原样）。
- **browser-activity.tsx 仅新增导出**：`isBrowserStep`（`Object.hasOwn(labelKeys, name)`，与原内联判定等价）+ `export type { StepLabelKey }`；`groupBrowserSteps` 改用之，其余零改动（+19/−8 与报告一致）。
- **locales 纯新增**：en +12 键、zh +9 键（`tools.*` 命名空间，另 U03 的 connectCard 块为在场改动非本任务）；无删除/改写。
- **manifest 登记（part 4）**：`app/tests/tool-activity.test.tsx` 在 `groups["app/tests part 4"].files`（8 文件组）、flat `files`（第 102/464）、`causes` 有具名原因；`node scripts/e2e-coverage-audit.mjs` **no gaps**：1055 文件 · 576 native · **464 driven（+1）** · 9 engine · 6 exclusions。
- **回归（全部亲跑）**：connect-app-card 15 + approvals-rules 12 = **27 pass / 0 fail**；transcript 消费者 person-sent-message / transcript-attachments / composer-attachments-ui / composer-queue-attachments = **65 pass / 0 fail**（3+40+10+12）。
- **统一驱动（亲跑）**：`E2E_BUN_ONLY=app/tests bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` → **5/6 组绿**（part 2 15.88s / part 3 3.19s / **part 4 34.58s（含本文件）** / multitenancy 0.45s，part 1 亦绿）；唯一红 `app/tests/ai-observability` = 已登记 BASE 红（本次失败签名 `queryClient.ensureQueryData` undefined，环境性，与 U04 六文件零 import 交集）。
- **billing-credits-ui 排除核实**：import 图 = `@/lib/billing/credits`、`@/lib/i18n`、`./settle-react-work` 等，与 U04 六文件零交集；失败文本 "连续包月" 仅存在于该测试自身 fixture（:260/:299/:314），locale 零涉及 → U04-OBS1 裁定成立。

## 4. 偏差评估 — PASS

- **D1（参数不截断，偏离上游 200 字符截断）：判断正确。** AC A07"工具摘要可展开完整步骤" + up07 criterion 4"完整参数/结果可展开，原错误信息和来源链接不丢失"是事实源；上游截断与 AC 直接冲突，deviation 方向正确。展开面板 `max-h-60 overflow-auto` 提供了上归属界，不构成无界渲染。测试以 400 字符用例钉住。
- **D2（icon-less 行词汇）：取舍合理。** `tool-line.tsx` 非 owned 且本无 icon prop；不改非 owned 文件是正确约束。
- **D3（summarise 结构化计数 + 组件 t() 组句）：取舍合理。** brief 明令 en/zh 词条、禁 locales 外文案；结构化计数还保持了纯函数可单测性（有独立 summarise 用例）。
- **D4（不做 research 分类）：正确遵 brief。** brief.md:32 明令不预建 research 词表（`StepKind = "browser" | "connector"` 证实）。
- **D5（保留 BrowserActivity/groupBrowserSteps）：取舍合理。** 非 owned 的 approvals-rules.test.tsx 仍挂载 `BrowserActivity`；不越权改测试的前提下保留是唯一选择，且 12/12 回归绿证实其仍可用。

## 5. typecheck / format — PASS

- **typecheck（亲跑）**：`bun run --filter app typecheck` → `app typecheck: Exited with code 0`。
- **biome format（亲跑，七文件）**：`tool-activity.tsx`、`tool-activity.test.tsx`、`chat-transcript.tsx`、`browser-activity.tsx`、`locales/en/channels.json`、`locales/zh-CN/channels.json` 全部 **exit 0**；`e2e-bun-suites.json` exit 1，但 `git show HEAD:` 版本同样 exit 1（基线对照亲证）→ **零新增违规**（BASE 脚本生成文件，与 D6 陈述一致）。

## 问题分级

**Blocker / Major：无。**

- **NIT-1（报告文案，不要求修改）**：implementer-report §5 标题"en / zh-CN 各 12"，实际 zh-CN 为 9 键（3 个 `_one` 键缺席）。行为正确：zh-CN 复数规则只有 `other` 类，i18next 永不查找 `_one`，`browsedPages_other` 等 `_other` 键已覆盖；§5 表格本身如实标了"—"。仅标题计数不准。
- **NIT-2（观察）**：validator 统一驱动中 ai-observability 的失败签名（`queryClient.ensureQueryData` undefined）与 implementer 轮文本不同，但同属该已登记基线红的环境内 variability；该组与 U04 六文件零 import 交集，不计入。

## 验证命令汇总（均在 worktree 根亲跑）

| 命令 | 结果 |
|---|---|
| `bun test ./app/tests/tool-activity.test.tsx` | 18 pass / 0 fail / 95 expect |
| `bun test ./app/tests/connect-app-card.test.tsx ./app/tests/approvals-rules.test.tsx` | 27 pass / 0 fail |
| `bun test person-sent-message + transcript-attachments + composer-attachments-ui + composer-queue-attachments` | 65 pass / 0 fail |
| `E2E_BUN_ONLY=app/tests … e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` | 5/6 组绿（part 4 ✓）；ai-observability = 登记基线红 |
| `node scripts/e2e-coverage-audit.mjs` | no gaps · 464 driven |
| `bun run --filter app typecheck` | exit 0 |
| `bunx biome format`（六文件 + HEAD manifest 基线） | 六文件 exit 0；manifest exit 1 = HEAD 同（无新增违规） |
