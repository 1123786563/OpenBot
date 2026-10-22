# U04 Review — 工具活动分组与摘要（A07 / Issue #499 / up07）

- 审查者：独立 reviewer（只读；唯一写入：本报告）。日期：2026-10-20。
- 工作区：`.worktrees/upstream-openbot-update`（HEAD 3b4a7c68，未提交树）。
- 材料：`evidence/u04/{brief.md,implementer-report.md,validator-report.md,after-tracked.diff,before-tracked.diff,before-status.txt,red-group-run.txt,green-group-run.txt,final-verification.txt,after-sha256.txt}`；新文件 `app/src/components/channels/tool-activity.tsx`（402 行）+ `app/tests/tool-activity.test.tsx`（529 行，untracked 直读）；事实源 `docs/specs/2026-10-20-upstream-openbot-adoption-design.md` §3 第 4 条、`docs/tickets/upstream-openbot-update/issues/up07.md`；上游参考 `evidence/upstream-sources/app/src/components/channels/tool-activity.tsx`（447 行）；ledger §7 Ruling U04-OBS1。

## 0. 审查者亲跑验证（全部复现报告数字）

| 命令 | 结果 |
|---|---|
| `bun test ./app/tests/tool-activity.test.tsx` | **18 pass / 0 fail / 95 expect**，exit 0 |
| `bun test ./app/tests/connect-app-card.test.tsx ./app/tests/approvals-rules.test.tsx` | 27 pass / 0 fail |
| `bunx e2e run --config e2e.unit.config.ts browser-activity tool-result tool-name`（native 回归） | **29/29** |
| `bun run --filter app typecheck` | exit 0 |
| `bunx biome format` 六个改动文件 | 全部 exit 0；`e2e-bun-suites.json` exit 1 且 `git show HEAD:` 版本同样 exit 1（D6 基线亲证） |
| `node scripts/e2e-coverage-audit.mjs` | no gaps · 1055 文件 · 464 driven |
| SHA-256（两新文件） | 与 `after-sha256.txt` 逐一相符 |
| locales 键数（JSON 解析直数） | en `tools.*`=12，zh-CN=9（缺 3 个 `_one`） |

证据真实性：`red-group-run.txt`（0 pass / 1 fail / Cannot find module）与 `green-group-run.txt`（18 pass）真实；`final-verification.txt` 尾部与报告一致（唯一红 = 已登记 BASE 红 ai-observability）。

## 1. Spec compliance — §3 第 4 条逐字对照

Spec 原文："相邻可普通展示的 connector/browser 工具聚合；文本、审批、连接要求和人工介入形成边界。保留步骤原始参数与结果、失败/拒绝分类和稳定组 ID。"

| Spec 短语 | 实现 | 钉住用例 |
|---|---|---|
| 相邻可普通展示的 connector/browser 工具聚合 | `groupToolSteps`：`isBrowserStep` + `mcp__` 前缀且非 asks-the-person 拒绝的工具连续折叠 | "adjacent connector and browser steps fold into one group…" |
| 文本…形成边界 | 任何非 tool item 先 `close()` 再原位保留 | "a text message breaks the run…" + 真实 `toVisibleChatItems` 投影用例 |
| 审批…边界 | `<PendingApprovals toolCallIds>` 渲染在折叠行外（tool-activity.tsx:397，与 browser-activity.tsx:179 同构） | 结构 + approvals-rules 12/12 回归 |
| 连接要求…边界 | `asksThePerson` 豁免携带 connect-prompt 的拒绝（卡片经既有 `ServerToolLine` 绘制） | "a refusal that asks the person to act stays outside every fold"（connect 分支） |
| 人工介入…边界 | `computer_request_help`/`computer_request_secret` 非 foldable；`[team-bot-consent]` 拒绝豁免 | "a human takeover request and a custom component tool stay independent…"（consent 分支同用例） |
| 保留步骤原始参数与结果 | `inputValue` 不截断（D1）；refused output=剥 marker 全文；浏览器事实委托既有 `browserStepDetails` | "expanded inputs keep the whole argument, however long"（400 字符）；refused/failed `toBe` 全文 |
| 失败/拒绝分类 | `pending`/`failed`/`refused` 三态互斥、来自真实结果（`result===undefined`/`toolResultFailed`/`REFUSAL_MARKER`），不猜措辞 | "statuses follow the real results as they land, in place"；分类互斥断言 |
| 稳定组 ID | 组 id = 首步骤 id；DOM 节点身份 + `open` 保持 | "stream growth keeps the group on the first step's id…" + "the folded line keeps its identity and stays open…"（同一 `details` 节点） |

**结论：逐条成立。**

## 2. Spec compliance — up07 六条 criteria

1. **相邻分组/文本打断/单 connector 原单行**：PASS。单 connector 以**对象身份透传**（`grouped.push(first)`，用例 `toBe` 断言），`kind` 仍 `"tool"` → 落 transcript 既有 `renderToolCall` 单行分支，渲染路径零改动。
2. **连接卡片、审批、Team Bot consent、接管、自定义组件工具独立可见**：PASS。前四者见 §1；自定义组件（非 `mcp__` 命名，如 `display_chart`）不 foldable，仍走注册 renderer。
3. **首步骤稳定 ID + 计数随真实结果更新**：PASS。issues 计数 `steps.filter(failed||refused).length`；rerender 后 "Not completed" 消失、"Didn't work"+"1 issue" 出现。
4. **完整参数/结果可展开，原错误信息和来源链接不丢失**：PASS。参数 `<dl>` 全量；结果 `forDisplay`→Streamdown（去 untrusted 信封/解 vendor JSON 包裹，与 `ServerToolLine` 逐字同构，tool-activity.tsx:337）；浏览器 `href` 保真为可点链接（`rel="noopener noreferrer"`）；refused 原因全文、failed `toolResultFailed` 原文全保留。
5. **沿用现有转义/untrusted envelope/renderer，不当授权**：PASS。绘制走 `asText`/`forDisplay`/`REFUSAL_MARKER`/`markdownComponents` 既有管线；折叠判定只认服务器 marker 起始的拒绝（marker 居中不触发，fail-closed，随 U02 codec 语义）；用例钉住 "CRITICAL:…" 与 `<untrusted_data` 不进 DOM、内容在内；"Refused." 不出现在读者侧。
6. **验证流式更新、展开状态、窄屏、键盘及中英文，历史消息无需迁移**：PASS（附 F-01）。流式更新/展开状态/DOM 身份有显式测试；中英文有显式渲染断言（"Browsed 1 page and used Notes" / "使用了 Notes"/"1 个问题"/"已阻止"）；窄屏与键盘为**构造性验证**（见 F-01，理由成立）：无新宽度常量（仅复用 `min-w-0`/`truncate`/`break-words`/`flex` 与既有 `max-h-60` 高度界），展开控件为原生 `<details>/<summary>`、无 tabIndex 覆写（天然可聚焦/Enter 切换），happy-dom click-probe 证实 summary 可交互。历史消息无需迁移：纯视图投影，fold 不改写输入 items（身份与 `result` 不变断言钉住），旧 thread 走同一投影原样渲染。

## 3. Code quality

### 3.1 `groupToolSteps` 纯度与对象身份透传 — 正确

- 纯函数：无副作用、无外部状态、只新建数组与组对象；输入 items 未被改写（测试钉住）。可脱离渲染器单测（分组系列用例即如此）。
- 单 connector 不重挂载的实现：**透传原对象引用**而非包一层 1-step 组。React key（`item.id`）与元素类型（既有 tool 分支）都不变 → 最常见单调用场景完全零扰动。这正是 up07 criterion 1 "单 connector 保持原单行行为" 的最小实现。
- 单 browser 步骤仍成组：组 id=首步骤 id，第二条到达时 id 不变、行形状不变（不重挂载、不跳变）。见 §4 不对称裁决。

### 3.2 `asksThePerson`/`foldable` 与 U03 seam 的 DRY 取舍 — 归因成立（F-02）

- `asksThePerson`（tool-activity.tsx:92-98）与 `connectPromptOf`（chat-transcript.tsx:1445-1450）共享同一段信封剥离语义（undefined 守卫 → `asText` 解 JSON 编码 → `startsWith(REFUSAL_MARKER)` → `slice+trim` → 交 codec），且都 fail-closed。审查者逐行比对属实。
- 重复的合理归因：① tool-activity 若 import chat-transcript 的 `connectPromptOf` 会成环（chat-transcript 已 import tool-activity）；② 把 `connectPromptOf` 迁入 tool-activity 需改 U03 已钉住的 seam 面，与"U03 区块零改动"约束冲突；③ 真正的共享底座 `shared/connect-prompt.ts` 是 U02 owned 文件，brief 明令不改。
- 漂移风险已被双重测试钉住：connect-app-card.test 钉卡片绘制、tool-activity.test 用**同一 fixture 形态**（JSON 编码 `Refused. ${connectAppRefusal(...)}`）钉不折叠——任何一侧语义漂移都会打红一个套件。两处均有互指注释。
- 结论：**当前取舍正确**；建议 U03 seam 下次被触碰时（如 R03 或 V01）把剥离逻辑收敛到单一 helper（F-02，非阻断）。

### 3.3 D1（不截断 vs 上游 200 字符）裁决 — 正确

- 事实源优先级：批准 Spec > 上游参考。Spec §3"保留步骤原始参数与结果"+ up07 criterion 4"完整参数/结果可展开，原错误信息……不丢失"与上游 200 字符截断直接冲突，分歧方向（不截断）正确。
- 渲染有界：展开面板 `max-h-60 overflow-auto`；折叠行本就不显示参数值，无溢出面。
- 披露规范：作为 D1 如实记录，并有 400 字符用例钉住（> 上游截断线）。**合格。**

### 3.4 组件复杂度与接线最小性 — 合格

- 402 行（上游 447）：差额来自 D2（无图标栈，`tool-line.tsx` 非 owned 且本无 icon prop）、D3（组句移入组件 `t()`，上游硬编码英文）、D4（无 research 分类，brief 明令禁止预建词表）——三处偏差全部有 brief/Spec 级归因，非静默简化。
- 结构内聚：3 个导出纯函数（`groupToolSteps`/`stepDetails`/`summarise`）+ 3 个小组件 + 3 个小 helper；注释密度高但均为 load-bearing 语义（为何不折叠、为何不截断、信封从哪剥）。
- chat-transcript 增量恰 3 处（import 换源、投影换函数 :1589、分支换渲染 :1732），审查者对 before/after 两 diff 做 hunk 级比对证实：U03 区块（`ServerToolLine` 卡片分支、`connectPromptOf`、import）在两 diff 中逐字相同；`assertNever` 穷尽性保持（:1788）。
- `browser-activity.tsx` 增量恰为 `isBrowserStep` + `export type { StepLabelKey }`，`groupBrowserSteps` 改用之行为等价（+19/−8 与报告一致）。
- manifest 增量恰为一行登记 + 一条 cause（审查者对 before/after manifest hunk 逐一比对：其余全部为在场任务或脚本 rebalance 既有改动）；audit no gaps。

### 3.5 次要点

- `stepDetails` 为 browser 步骤也计算 `inputs`，但 `StepRow` 的 browser 分支从不渲染它——与上游行为完全一致，零风险（F-05，Info）。
- `ToolActivity` 的空摘要回退链（phrases 空 → 首步骤 label → `usedBrowser`）覆盖了畸形 `mcp__` 名的边缘（`connectorName("")` 为空串被 `summarise` 过滤），防御到位。
- 投影每 render 重跑（含每 tool item 一次 `asText`）——与 transcript 既有 per-render 投影注释（"not worth guarding"）一致的上游同款模式，非新增性能面。

## 4. 不对称裁决：单 browser 步骤仍成组 vs 单 connector 透传

**判断：正确，符合 Spec 与上游语义，非不一致。**

1. **上游逐字同款**：上游 tool-activity.tsx:54 `if (run.length === 1 && !isBrowserStep(first)) grouped.push(first); else grouped.push({…})` 与本地实现相同；上游注释给出的理由（"so the row does not change shape when the second step arrives"）在本地同样成立。
2. **本地既有语义延续**：改造前的 `groupBrowserSteps`（browser-activity.tsx:59）对**单条 browser 步骤本就生成 1-step 组**——单浏览器步骤在本应用中从来就是折叠渲染。保持成组 = 现状零漂移 + 第二步到达时行形状/组 id 双稳定。
3. **单 connector 透传是 Spec 明文要求**：up07 criterion 1 逐字要求"单 connector 保持原单行行为"；透传身份对象是唯一能保证"exactly as it renders today"的实现。
4. 过渡成本（connector-first run 从单行分支换到 ToolActivity 子树，同 key 一次子树重挂）在上游同样存在，且是 criterion 1 的必然代价；折叠行组件词汇（ToolLine）两侧共用，视觉连续。

## 5. 两份报告交叉核对

- 实现者报告全部可复核声明**审查者亲跑复现**：18/95、27 回归、29/29 native、typecheck 0、format、audit no gaps、SHA 一致、RED/GREEN 证据文件真实。
- 验证者报告的行号引用逐一核对属实：`asksThePerson` :92-98、`connectPromptOf` chat-transcript :1445-1450、`<Streamdown>` :337、`<PendingApprovals>` :397（browser-activity :179 同构）、fold 在折叠行外。
- 验证者 §3 的 diff 交集结论（4 个共同变更文件 + browser-activity 唯一新增 tracked 变更 + untracked 恰两新文件）经 before-status.txt 与两 diff 交叉比对**确认**。
- **NIT 确认**（en 12 vs zh 9）：审查者以 JSON 解析直数——en `tools.*` 12 键、zh-CN 9 键（缺 `browsedPages_one`/`usedConnectors_one`/`issueCount_one`）。验证者 NIT-1 成立：实现者报告 §5 标题"en / zh-CN 各 12"计数不准（其表格本身已如实标"—"）；**行为正确**——zh-CN 复数规则只解析 `other` 类，i18next 永不查找 `_one` 键（zh 用例 "1 个问题" 渲染即证）。
- NIT-2（ai-observability 失败签名在两轮间不同）：与 ledger §7 已登记 BASE 红一致的环境内 variability；审查者复跑 `final-verification.txt` 尾部同 suite 红。不计入 U04。
- U04-OBS1（billing-credits-ui 8/18 红）：ledger §7 主控三重对照（BASE worktree 全绿 / 主 checkout 同 .env 同红 / import 图零交集）充分，验证者补充的 fixture 定位（"连续包月"仅存在于测试自身 fixture）一致。**裁定成立，不计入。**

## 6. Findings

| # | 严重度 | 内容 | 处置 |
|---|---|---|---|
| F-01 | Low | up07 criterion 6 中"窄屏/键盘"为构造性验证（类词汇复用 + 原生 `<details>/<summary>` 语义 + happy-dom click-probe），无自动化测试钉住；实现者已如实披露，推理成立（happy-dom 的 Enter-keydown details 行为不可靠，测之只是测 harness）。 | 不要求修改；建议 V01 记一条窄视口人工/视觉抽查候选。 |
| F-02 | Low | 信封剥离语义在 `asksThePerson` 与 `connectPromptOf` 两处重复（约 4 行）。归因成立（避免循环 import、U03 seam 不触碰、`shared/connect-prompt.ts` 为 U02 owned），双侧注释互指、双侧测试以同形态 fixture 钉住。 | 不要求修改；U03 seam 下次被触碰时收敛为单一 helper。 |
| F-03 | Info | 实现者报告 §5 标题 zh 计数不准（"各 12"，实为 9；缺 3 个 `_one` 键，行为无影响）。 | 报告文字勘误即可，不入 V01。 |
| F-04 | Info | `BrowserActivity`/`groupBrowserSteps`/`BrowserGroup`/`TranscriptItem`（browser-activity.tsx）在生产代码中已无消费者（仅测试用）；D5 理由成立（非 owned 的 approvals-rules.test.tsx 仍挂载）。 | V01 清理候选：所有权允许后删除死代码及其测试依赖。 |
| F-05 | Info | `stepDetails` 为 browser 步骤计算 `StepRow` 从不渲染的 `inputs`。与上游逐字同款，零风险。 | 无需处置。 |

**无 Blocker / Major。**

## 7. 结论

Task U04 增量（`tool-activity.tsx` 新建、`chat-transcript.tsx` 3 处接线、`browser-activity.tsx` 两导出、双语词条、manifest 登记、529 行测试）在 Spec §3 第 4 条与 up07 六条 criteria 上全部成立；分组函数纯且身份透传正确；D1/D2/D3/D4/D5 偏差全部方向正确、归因清楚、如实披露；验证者与实现者报告可复核声明经审查者独立复跑全部成立；两条 NIT 确认但不影响交付。OCR 已取消，本审查为最终质量关口：通过。

Spec compliance: pass
Code quality: pass
