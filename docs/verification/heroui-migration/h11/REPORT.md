# H11 (#454) — Craft 工作区、预览与产物操作迁移报告

状态：implemented（workspace 增量，无 commit）；BASE `203d0f0244b2`，分支 `feat/heroui-v3-migration`。
工作区：`/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`。
检查点产物：`POST-CHECKPOINT.sha256`（本轮 4 个改动文件）；全量 native 证据 `native/`；改动前基线 `baseline/`（同命令 pre-edit 对照）；改动后域内 native `native-domain/`；driven 证据 `driven-craft/`。

## 域起点事实（决定本轮 delta 形态）

与 H05–H10 各波相同，本域在 BASE 后已被前波整体切到冻结的 HeroUI `ui/*`：routes `craft/{index,$sessionId,tasks}` 与 `craft/*`、`channels/workshop-*` grep `@base-ui`/`@radix-ui` 0 命中；token 清扫（`bg-muted→bg-ob-muted-surface`、`hover:bg-accent→hover:bg-ob-hover`、`bg-muted` 0 残留）与 ButtonLink 转换（`session-sidebar.tsx` tasks.nav、`craft/tasks.tsx` new-task action）已在前波落盘（`git diff HEAD` 中本域既有 M 均为 token/机械改名）。`workshop-schedules.tsx`、`scheduled-task-editor.tsx` 已消费 ui/Select+ui/Input+ui/Textarea+ui/Field；preview-tab 的 iframe 生命周期引擎（D4 票据、M-2 换帧、fix-ocr11 退避、两级探针）原样。

因此本轮 H11 = **域内残余控件收口**：workshop-share 两个原生 `<select>`、4 处 Select `as` 强转、1 个原生 checkbox、1 个内联重命名 `<input>`。预览/产物/download-share 面零行为改动（见 AC2/AC3 节）。

## 变更清单

| 文件 | 变更 | 要点 |
| --- | --- | --- |
| `app/src/components/channels/workshop-share.tsx` | 2 个原生 `<select>` → `ui/select` | scope（`WorkshopShareScope` 字符串域值）与 days（**数字键 7/30/0，0=永久**）：`onValueChange` 按 H05/H06/H10 null-guard 约定（`:87-90`、`:120-122`）；days 用数字 key 往返（`SelectItem value={7|30|0}`），原生 select 的 `Number(event.target.value)` 字符串化被**删除而非保留**——ui/select 的 `keyForValue/valueForKey` 保证数字域值无损；`<label htmlFor="share-scope|share-days">` + `SelectTrigger id` 同 proactive-panel/demonstration-recorder 先例；密度 `size="sm" className="h-8 text-xs"` 与同族 workshop-schedules 表单一致；`disabled={create.isPending}`（`:92,:124`）与 `create.isError` `role="alert"`（`:153`）原样保留。带 why-comment 两段。本文件 diff 另含前波一行 token 改名 `bg-muted/60→bg-ob-muted-surface/60`（W6 F5a 补记，token 族机械改名，非本轮行为）。 |
| `app/src/components/channels/workshop-schedules.tsx` | Select `as` 强转移除 | `setUnit(value as typeof unit)` → null 守卫（`:300-302`）：null（无选择）保持半成品表单的原 unit，不再铸值。 |
| `app/src/components/craft/scheduled-task-editor.tsx` | 3 处 Select `as` 强转移除 + 原生 checkbox → `ui/checkbox` | mode/unit/status 三处 null 守卫（`:355-358`、`:405-406`、`:518-519`），域值联合类型直接流经泛型，无 `as`、无 String()；`task-run-now` checkbox → `Checkbox`（`:542-551`，H04 shared-approval-fields 模式）：`id` 经 inputRef 落在隐藏原生 input 上，兄弟 `<label htmlFor>` 指向的仍是真正切换的控件；`accent-foreground`（原生外观着色）随迁移删除。 |
| `app/src/components/craft/session-sidebar.tsx` | 内联重命名 `<input>` → `ui/Input`（H13 decisions.tsx 模式） | DOM props 与 ref 直通（React 19）；`h-7 min-w-0 flex-1 rounded-md bg-background px-1.5 py-0.5 text-sm focus-visible:ring-1` 把基础 h-9/ring-3 压回 roster 行的既有密度（tailwind-merge 覆盖）；Enter/Escape/blur-commit、`inputRef` 自动聚焦、确认删除的 `disabled={deleting}`（`:185`）全部原样。 |

不改动（核验过，理由如下）：

- `craft/composer.tsx` 的 textarea + 隐藏 file input——**专用引擎保留**：JS 测高的 auto-grow（`el.style.height = min(scrollHeight, 160px)`）+ Enter 发送与 PromptArea 同族；H10 对 channels PromptArea 的处置先例是「内容模型/IME 引擎原样」，而 ui/Textarea 的 `field-sizing-content` 是另一套生长机制，两机制叠一个元素是纯风险且密度（min-h-9 vs min-h-16）会漂。spec 明示 textarea 迁移「不替代聊天富文本/专用编辑器」。隐藏 `type=file`（`composer.tsx:92`、`workshop-files.tsx:112`）是 Button 触发的程序化句柄，非可见控件。
- `craft/output-panel/preview-tab.tsx` **本轮零 diff**（W6 F1 口径精确化：相对 BASE 尚有前波 3 个 hunk/6 行 token 改名 `bg-muted→bg-ob-muted-surface`，mtime 早于本轮窗口，H11 未触碰）——expand/restore 是 AC2 红线本体：wrapper 换位（`fixed inset-0 z-50`，`:1088`）而非 portal/Dialog 挂载（`:35-42` 注释即该合同），iframe 单帧（`key={sessionId}` `:1098`）、sandbox 属性（`:1125`）、票据交换与两级探针全部原样；角落簇的裸 `<a>`/`<button>` 是与 iframe 同生共死的微控件（ref 即焦点返还目标），动它违背「不重挂载」红线，且与全仓 75 处既有裸 button 的规范一致。
- `craft/output-panel/{index,files-tab,artifacts-tab}.tsx`、`craft/message/*`、`craft/tool-cards/diff-body.tsx`、`craft/{chat-panel,attachment-input,subagent-view,sandbox-status-indicator}.tsx`、`channels/workshop-{panel,turn,usage,artifacts,files}.tsx`——已消费 `ui/*` 或为裸 button/真 `<a>` download 锚点的既定规范形态；loading/failed/success 状态核验在位（files-tab `:31-33,:107`、artifacts-tab `:26-37`、workshop-panel `:52-56`、workshop-artifacts 预览禁用门 `:98,:155`）。
- 冻结面 `ui/*`、`package.json`/`bun.lock`、`main.tsx`/`__root.tsx`、`styles/*`、`lib/theme.ts`、`tests/preload.ts` 本轮零净改动；H04–H10/H12/H13 已改文件零触碰。

## AC 状态

### AC1 Craft 列表、任务、文件与产物动作保持原有加载/失败/成功状态 — PASS（组件级）

- 会话列表：`session-sidebar.tsx` 加载/空态（`:91-98`）、新建 `disabled={create.isPending}`（`:84`）、删除 `disabled={deleting}`（`:185`）本轮零行为改动（仅重命名 input 换 ui/Input）。
- 任务：`scheduled-task-editor.tsx` save/runNow/remove 三 mutation 的 pending 禁用（W6 F2 修正：实际行 `:559,:570,:578`）与 `role="alert"` 错误行（`:323`）、runs 历史（`:600-647`）原样。
- 文件/产物：`files-tab.tsx` root/children 的 isPending/isError 三态（`:31-33,:107`）、`artifacts-tab.tsx` loading/empty（`:26-37`）；download 仍是真 `<a download>` 锚点（artifacts-tab `:85-90`、workshop-artifacts `:106-112`）。
- workshop：schedules 列表四态 + 行级 toggle/delete pending（`workshop-schedules.tsx:58-70,:188,:201`）、share 的 mint/revoke pending 与错误（`workshop-share.tsx:92,:124,:145,:153`）。本轮 Select/Checkbox 迁移不触碰任何 mutation 路径。

### AC2 预览菜单、放大/还原和下载/分享不重挂载 iframe 或丢失预交互状态 — PASS（零改动 + 既有回归全绿）

- 本轮 preview-tab **diff = 0**。放大/还原合同由实现自身的既有测试批证明：`craft-preview-tab.test.tsx` 79 测试全绿（`native-domain/`），其中「THE IFRAME NODE SURVIVES THE EXPAND — no reload, one HMR socket」（`:228-241`）逐节点断言 iframe 元素跨 expand/collapse 存活；Escape 收起 + 焦点返还 trigger（`:215-226`）；「open in new tab」只携带 plain origin、不带票据（`:243-255`）。
- 分享/下载：workshop-share 的 mint→一次性展示→copy→revoke 链路本轮仅换 Select 控件，token/code 展示与 copy 按钮零改动；artifacts/docx 导出仍是真锚点。
- 浏览器级放大/还原与真实 iframe 交互证据按分工归 validator 轮（cdp-harness 可复用）。

### AC3 预览 iframe 的 origin、票据、sandbox 与会话隔离不变；父主题不假设穿透 iframe — PASS（零改动 + 既有回归全绿）

- 本轮对本文件 diff = 0：`sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"`（`preview-tab.tsx:1125`）逐字未动；票据单跳（`previewEntryUrl`，URL API 进 query）、`previewOriginBlocked` hostname 线、exchange 三重 cross-check、`forSession` 会话归属（`:827-830`）、同源拒绝/legacy 门全部原样。
- 隔离事实保持原陈述：隔离来自 host 分裂（F2），非 `allow-same-origin` 属性本身；实现注释明言 iframe 内 app 的外观是它自己的（本域未引入任何「父主题穿透」假设——preview-tab 无主题注入代码）。
- 既有回归批里关于 sandbox/隔离的断言（same-origin 拒绝、evil-host 拒签、scheme 门、会话切换不骑旧票据等 ~40 条）全部绿。

### AC4 窄屏/短屏下任务面板与预览可操作；内层滚动与 Overlay 正确 — PASS（组件级 + 既有回归）

- 预览窄屏路径 = 放大合同本身（420px 面板 → `fixed inset-0` 全视口，`preview-tab.tsx:1088`；modal 语义在 wrapper 上 `:1079-1082`），「expanding goes full-viewport as a modal, and collapse returns」（测试 `:200-213`）绿。
- 内层滚动：路由壳「Nothing here scrolls as a whole — each pane scrolls inside itself」（`craft/$sessionId.tsx:13-15`）未动；session-sidebar roster、output-panel 各 tab、workshop 面板各自的 `overflow-y-auto` 容器原样。
- 任务面板：`craft/tasks.tsx` PageShell/PageSection/Item + ButtonLink（前波已迁，本轮核验零 diff）；dialog 守卫 v3（`ui/dialog.tsx` 冻结面）本域未消费新 Dialog，无 Overlay 新增面。
- 浏览器级窄/短视口证据归 validator 轮（与 H09 Drawer/320px 项同区）。

## 验证（命令 + 真实 exit code，均仓库根执行）

| 项 | 命令 | 结果 | 证据 |
| --- | --- | --- | --- |
| 基线（改动前，单变量对照用） | `E2E_UNIT_OUTPUT=docs/verification/heroui-migration/h11/baseline bunx e2e run --config e2e.unit.config.ts app/tests/craft-preview-tab.test.tsx app/tests/craft-files-tab-outputs.test.tsx` | **EXIT 0**，80/80 | `baseline/report.json`（status passed） |
| typecheck | `cd app && bun run typecheck` | **EXIT 0** | 会话输出（tsc --noEmit 无错误；W6 F4 注记：无落盘产物，终态 EXIT 0 已由 W6 复审与 H14 独立复跑证实） |
| 域内 native（改动后复跑） | 同 baseline 命令，输出 `…/h11/native-domain` | **EXIT 0**，80/80（craft-preview-tab 79 + craft-files-tab-outputs 1） | `native-domain/report.json`（exitCode 0） |
| driven（ADR 0008 两层制；本域唯一 driven 文件 craft-session-title 在 part 3 组） | `E2E_UNIT_SCOPE=tests E2E_UNIT_OUTPUT=…/h11/driven-craft bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts --grep "bun runtime suite app/tests part 3"` | **EXIT 0**（24 文件组，含 craft-session-title 2 pass；part 2 组亦复跑 EXIT 0） | `driven-craft/report.json`（exitCode 0） |
| 全量 native app 域 | `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/heroui-migration/h11/native bunx e2e run --config e2e.unit.config.ts` | **EXIT 1**：994 执行 = **993 pass / 1 fail**；唯一失败 = `heroui-spike` TextArea（见归因节）；本域文件 0 红（W6 F3 口径修正：130 系全量 run 的文件总数，非本域计数） | `native/report.json`（exitCode 1，finished 2026-10-20T06:55Z） |
| build | `cd app && bun run build` | **EXIT 0**（`✓ built in 9.92s`） | 会话输出（W6 F4 注记：终态已由 W6 复审与 H14 复跑证实） |
| biome | `bunx biome check --write <4 改动文件>` → 复查 | 首轮 2 文件格式修正 → **复查 EXIT 0 clean** | 会话输出（W6 F4 注记：终态 0 诊断已由 W6 复审证实） |

## 全量 native 唯一失败归因（非本轮引入、非本域修复面）

| 文件 | 数 | 归因 |
| --- | --- | --- |
| `app/tests/heroui-spike.test.tsx`（TextArea） | 1 | Brief 已列名的 ledger 既有红（~993/994 口径完全一致）；H13 F3/W3C 结论：根因 = RAC 受控 TextArea 不消费合成 `fireEvent.change`，属 H02/H01 域 spike 测试自身，处置归 H14。本域生产代码无此路径（craft 表单 Textarea 为非受控 DOM props 直通、真实键击路径，driven/native 域内全绿） |

与本域直接相关的对照：`craft-preview-tab`（79）、`craft-files-tab-outputs`（1）、`craft-session-title`（driven，2）改动前后同为绿——控件迁移零测试适配需求（本轮无一处 getByRole/事件驱动需要改测试，与 H06/H13 的「迁移引入测试红」形态不同）。

## 遗留 / Interface 变更申请

- **无共享 Interface 变更申请**：`ui/*` 零净改动；本域消费的 Select（数字键/字符串键/null 守卫）、Checkbox（id→inputRef）、Input（ref 直通）能力均已存在，无能力缺口暴露。
- **归 validator 轮（不阻塞代码侧）**：真实浏览器中的预览放大/还原交互、窄/短视口操作、workshop share 控件的指针路径（cdp-harness recipes 可复用，CHROME_PATH override）。
- **记 H14/H15 无新增**：本域未发现新的 a11y/harness 项；Select trigger role 既有裁决项（H15）不受本轮影响（沿用 `ui/select` 冻结面的 `role="combobox"`）。
- 无 BASE worktree 对照需求：本域 4 文件的 diff 全部可归属（前波 token/机械改名与本轮控件迁移逐 hunk 可分），未使用 /tmp 对照（已核 `git diff` 逐块归属）。
