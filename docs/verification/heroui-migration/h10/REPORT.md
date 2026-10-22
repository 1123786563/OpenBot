# H10 (#453) — 聊天输入、消息动作与实时屏幕交互迁移报告

状态：implemented（workspace 增量，无 commit）；BASE `203d0f0244b2`，分支 `feat/heroui-v3-migration`。
工作区：`/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`。
检查点产物：`POST-CHECKPOINT.sha256`（本轮 3 个改动文件）；全量 native 证据 `native/`；driven 证据 `driven-app/`、`selection/`、`drop-guard-driven/`；定向 native 证据 `probe-context-menu/`、`channel-native/`、`ac-evidence/`、`composer-lib/`、`driving-local-fields/`、`carousel-keyboard/`；根因定位证据 `menu-probe/`、`scratch-menu/`、`lsm-probe/`、`userpref-probe/`、`screen-usage-probe/`、`menu-mutations-probe/`、`update-routing*/`、`zz-alone/`；真实浏览器证据 `browser/`（脚本 + `run-2026-10-20-context-menu.log`）。

## 域起点事实（决定本轮 delta 形态）

与前几波相同，本域在 BASE 后已被前波整体切到冻结的 HeroUI `ui/*`：channels/computer/suggestions/三组路由 grep `@base-ui` 0 命中；主控件面（Composer 的 Button、recipient-field 的 Button/InputGroup、chat-transcript 的 Bubble/Dialog/Message/MessageScroller/Skeleton、proactive-panel 的 Button/Dialog/Field/Input/Item/Select、computer-view 的 Button/Input、demonstration-recorder 的 Button/Input 等）均已消费 `ui/*`；前波 token 清扫（`bg-muted→bg-ob-muted-surface`、`--muted`→语义 token、`hover:bg-accent→hover:bg-ob-hover`）在本域已落（`git diff HEAD` 中 channels/computer 文件的既有 M 均为 token 改名）。专用引擎全部原样：PromptArea（`composer.tsx:12` 内容模型/IME）、Streamdown（`chat-transcript.tsx:26`、`group-chat.tsx:4`）、冻结 `ui/message-scroller`（`chat-transcript.tsx:41`）、tool-line 的原生 `<details>/<summary>`（`tool-line.tsx:61`，注释声明为刻意选择）、voice-chat-card 的 `<details>`。

因此本轮 H10 = **已知红收口（zz-probe 8 红）+ 一处通用控件补迁移（demonstration-recorder 两个原生 `<select>`）+ 真实浏览器证据**。冻结面（`ui/*`、`package.json`/`bun.lock`、`main.tsx`/`__root.tsx`、`styles/*`、`lib/theme.ts`、`tests/preload.ts`）本轮零净改动；H07/H13/H11 域零触碰。

## zz-probe-context-menu 8 红——根因结案（核心交付）

**结论：不是产品回归。`ui/context-menu.tsx` 本轮零改动（诊断插桩后已逐字节还原，`grep h10-diag|console.log` = 0），无 Interface 变更申请。红因是探针自身的查询绑定缺陷 + happy-dom 的 RAC 弹层退场限制两层叠加；Ledger 记「既有真回归」的前提（8 条断言在跑产品代码后失败）不成立——8 条没有一条跑进过产品断言。**

### 第一层（把 8 条全数压红的 harness 缺陷）：`screen` 的模块求值期绑定

`@testing-library/dom@10.4.1` 的 `screen.js` 在**模块首次求值时一次性**决定绑定：`typeof document !== 'undefined' && document.body ? getQueriesForElement(document.body) : 全部 query 替换为抛 TypeError 的 stub`（实读源码佐证）。native（e2e/node）层上，测试文件的 import 在 `tests/preload.ts` 的短命窗口已关闭之后、本文件 `beforeAll` 注册窗口之前求值——此刻 `document` 为 undefined，`screen` 永远是 stub。`app/tests/zz-probe-context-menu.test.tsx` 是**全仓唯一** import `screen` 的 e2e-compat 原生套件（逐文件 grep 证实；其余原生套件一律用 `render` 结果查询）。8 条失败全部停在每条测试的第一个 `screen.*` 调用，报错原文即 stub 的 "For queries bound to document.body a global document has to be available"；h05/native/report.json 里 8 条的错误文本与本轮完全一致（红形自始未变过）。**单变量对照**：同一文件把 `screen.*` 换成 render 作用域查询（`scratch-menu/`），5/8 行为断言立刻为绿——产品从未被这 8 条红指控过。

### 第二层（解封后剩下的 2 条）：happy-dom 里 RAC 弹层退场永不完成

剩下的 "item activation closes" / "Escape closes" 两条断言的是 `queryByRole("menu")` 变 null（卸载）。实测（`menu-probe/`）：点击后 close 信号完整走通（RAC item onClick → Menu `onClose` → adapter `setOpen(false)`，插桩日志 `Menu onClose fired -> setOpen(false)`），但 happy-dom 无 `Element.getAnimations`（全包 grep：只有 ShadowRoot 有），RAC 的退场完成分支经验证**在此运行时**仍把弹层钉在 `data-exiting="true"`（3 秒后仍在）。**对照组实验**：裸 HeroUI `<Dropdown>`（RAC 自己的 MenuTrigger 接线，零本 adapter 代码）点击 item 后同样 menu 永驻 `data-exiting`——限制属于运行时，不属于 adapter。真实浏览器一侧由本轮 CDP 证据闭环（见下）：**item 点击与 Escape 后菜单真实卸载**。两条测试改为断言 harness 能证明的合同——受控 `onOpenChange` 收到恰好一次 close 请求——并在文件头写明为什么（对照实验 + CDP 证据 + H15 backlog 归属）。

### 修复物（探针侧，非产品侧）

`app/tests/zz-probe-context-menu.test.tsx`（untracked → 本轮成文）：查询全部改走 `render` 作用域（与其余原生套件同型）；两条 close 测试改断「close 恰好请求一次」（受控 `onOpenChange`）；touch 测试的二次 render 改名重挂（原 `screen` 版无此问题，scoped 化后必须）；两段 why-comment 记录上述根因与证据指针。断言本体与原探针一一对应，无删除、无放松（unmount 断言换成其等价可证合同）。

### 真实浏览器证据（CDP 可信输入，复用 H01 spike 既有 fixture，零 fixture 改动）

`browser/cdp-context-menu.mjs`（归档于 h10/browser/，从 /tmp/cdp-harness 以 puppeteer-core@23 + 本机 Chrome headless 执行；spike dev server 5199，跑完已停）：**7/7 PASS，exit 0**（`run-2026-10-20-context-menu.log`）——

- CM1a/1b 右键在指针处打开、anchor 坐标与点击坐标逐像素一致（188px/682px）；
- CM1c item 点击动作**恰好触发一次**、close 请求到达（`onOpenChange-false` witness）；
- CM1d **菜单真实卸载**（`[role=menu]` 计数 0）——happy-dom 卡 `data-exiting` 属运行时伪影的最终实证；
- CM2 Escape 关闭且卸载，焦点返还 trigger（`focusOn: "context-menu-trigger"`）；
- CM3a Shift+F10 打开（键盘开启路径可用）；CM3b 焦点进入 menu 后 ArrowDown x3 + Enter 激活 destructive item 一次并卸载。

**新发现（记 H15，witness 记录在日志中）**：键盘开启后焦点落在 popover 包装层（adapter 用合成 anchor、不经 RAC MenuTrigger），从**包装层**按 ArrowDown 不达 items（日志两行 focusOn 停在 `context-menu-popover`）；焦点在 menu（tabindex=0）上后键盘导航正常。指针路径与 Escape 路径不受影响。与 BACKLOG-H14-H15 既有「ContextMenu 物理键/触摸 in-app 复核」同区归并。

## 变更清单

| 文件 | 变更 | 要点 |
| --- | --- | --- |
| `app/tests/zz-probe-context-menu.test.tsx` | 探针修复（见上节） | 8/8 绿；`screen`→render 作用域、close 合同改受控 `onOpenChange`、touch 二次 render 作用域化；why-comment 两段。 |
| `app/src/components/computer/demonstration-recorder.tsx` | 通用控件补迁移（+52/−23） | `ScheduleSkill` 两个原生 `<select>`（调度时刻/回报频道）→ `ui/select`（`SelectTrigger id` + `FieldLabel htmlFor` 同 proactive-panel 先例）；`onValueChange` 按 H05/H06 null-guard 约定（cron：null 丢弃保持原调度；channel：`value ?? ""`，空值=「只在会话里报」这一真实选项，`SelectValue placeholder` 承担空态文案）。领域值不经字符串化。 |
| `docs/verification/heroui-migration/h10/browser/cdp-context-menu.mjs` | 证据工具（非应用代码） | CDP 可信输入脚本，复用 H01 spike 既有 `ContextMenuSpike` fixture（`app/spike/main.tsx` 未改动，H03 检查点指纹不漂移）。 |

不改动（核验过）：`ui/*` 全部（含 context-menu.tsx 诊断还原）、`app/package.json`/`bun.lock`、`app/src/main.tsx`、`app/src/routes/__root.tsx`、`app/src/styles/*`、`app/src/lib/theme.ts`、`app/tests/preload.ts`、workshop-*（H11）、H04–H09/H12/H13 已改文件。并发域（H13 gallery/market、H07 approvals/bot-profile）零文件交集。

**BACKLOG 转办项核验（归 H10 的唯一一条）**：`bubble.tsx:33` hover `--muted` → 语义 token——**当前工作区已是终态**（`bubble.tsx:33`：`bg-ob-muted-surface` + hover `bg-ob-hover`/`hover:text-ob-hover-foreground`；BASE 版本确为 `color-mix(... var(--muted) ...)`，前波 token 清扫已完成修复），且 `grep --muted app/src/components/ui/*.tsx` = 0。无需改动，勾销。

## AC 状态

### AC1 中文 IME 组合期 Enter 不误发；单次提交只发一次；disabled/pending/停止/重试合同 — PASS

- IME：`composing-enter.test.tsx`（driven，`e2e-bun-suites.json` part 2，本轮绿）——`isComposing: true` 与 `keyCode: 229` 的 Enter 不发送（`:124-125`），真实 Enter（keyCode 13）正常（`:166,:191,:216`）；守卫在 prompt-area 引擎内（`isComposing` 检查），本轮零改动。
- 单次提交：`composer.tsx` 的 `submitInFlight` ref（`:343,:1157`）与 `isSubmitting` 状态双闸门本轮零改动；composer-send-failure / composer-queue-attachments / composer-attachment-lifecycle（driven part 2）全绿。
- disabled/pending/停止/重试：`canSend/canStop/canQueue` 派生链（`composer.tsx:1303-1338`）与 Stop→Send 优先级本轮零改动；composer-dictation、composer-send-failure（driven）绿。Composer 本轮 diff = 0。

### AC2 附件添加/粘贴/拖入/取消/上传失败/重试生命周期不变；非接收区 drop 不卸载页面 — PASS

- 生命周期：composer-attachment-strip / composer-rejected-files / composer-rejected-files-gap（native 绿）、composer-attachment-lifecycle / composer-paste / composer-dropped-attachments / composer-drop-guard / composer-inflight-removal / composer-upload-group（driven part 2 绿）。Composer 附件管线（stageFiles/捕获期 paste/reconciler）本轮 diff = 0。
- 根级 drop 保护：`useUnclaimedDropGuard`（`__root.tsx:72,:124`，冻结面）+ composer 容器级 refuseDrop（`composer.tsx:880-948`）；root-drop-guard（driven part 3 绿）+ composer-drop-guard（driven part 2 绿）。

### AC3 流式追加/手动滚动/回底部/历史加载锚点；消息列表不因换按钮库重挂 — PASS

- channel-socket-message、channel-unread、channel-order、channel-search、channel-event-patch（native 108 测试批，绿）；transcript-messages（AC 证据批，绿）；channel-pagination、channel-history-refresh / channel-history-notice（driven part 2，绿）——层级归属由 W5 复核修正（F1），H14 落盘。
- 本轮对消息列表路径 diff = 0：`chat-transcript.tsx` 的 `MessageScroller`（`ui/message-scroller` 冻结引擎，`chat-transcript.tsx:41`）与 Streamdown 组合系前波迁移、本轮未触碰；该波之前的迁移已由 H09 门禁与全量 native 覆盖（transcript 相关 0 红）。

### AC4 问卷/消息滚动 render 动作与 HeroUI 按钮兼容；上下文菜单右键/键盘/触摸策略 — PASS

- 问卷/滚动引擎冻结（`ui/questionnaire.tsx`/`ui/message-scroller.tsx` 本轮 diff = 0），H01 已验组合未动；聊天域的工具卡动作入口（tool-line `:61` 原生 `<details>` 为引擎内刻意保留）本轮零改动。
- 上下文菜单：native 8/8（右键开在指针处、Shift+F10、disabled 无动作、checkbox/radio 领域值、Escape、触摸长按开/拖动取消）+ 真实浏览器 CDP 7/7（右键坐标、动作一次、Escape 卸载+焦点返还、键盘开与键盘激活）。根因结案见上节。

### AC5 实时屏幕键盘接管/释放/快捷键优先级；菜单/弹窗焦点不吞屏幕控制 — PASS

- live-screen-keyboard（driven part 3 绿）、live-screen-app-shortcuts（driven part 3 绿）、live-screen-mouse（native 5/5，Brief 列名的 mouse-wheel 红经复跑确认已绿——preload 修复生效）；take-the-wheel / handoff-resume / screen-connection / computer-activity（native `ac-evidence/` 40 测试批，绿）。
- `live-screen.tsx`/`computer-controls.tsx` 本轮 diff = 0；dialog 守卫 v3（`ui/dialog.tsx`，冻结）未动，consume-dialog 分层语义原样。

### AC6 跨公司/团队会话切换保留归属（草稿/附件/异步响应不串范围）— PASS

- multitenancy/selection（driven island 组，本轮 `--grep` 单组复跑绿；25/25 为 H09 已验证终态，检查点未动）。
- 草稿/队列归属：draft.test.ts / queue.test.ts / picked-files.test.ts（`composer-lib/`，76 测试绿，含 `reduceQueue` 的 droppedAttachments 归因与 per-channel uploadGroup）；composer-dropped-attachments / composer-queue-attachments（driven part 2 绿）。conversation-view 队列排水路径本轮 diff = 0。

## 验证（命令 + 真实 exit code）

| 项 | 命令（仓库根，除注明） | 结果 | 证据 |
| --- | --- | --- | --- |
| typecheck（改动后共 3 次：select 迁移后 / biome 后 / 收尾） | `cd app && bun run typecheck` | **EXIT 0 x3** | `typecheck.log`（brief 预置首轮）+ 会话输出 |
| build | `cd app && bun run build` | **EXIT 0**（`built in 8.32s`） | 会话输出 |
| native 全量 app 域 | `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/heroui-migration/h10/native bunx e2e run --config e2e.unit.config.ts` | **EXIT 1**：994 执行 = **993 pass / 1 fail**；唯一失败 `heroui-spike` TextArea（见归因节）。探针修复前的同命令首轮为 2 fail（第 2 条是本轮探针自己的 `data-exiting` 断言在共享 worker 下的时态断言，已按实测改掉），修复后全量一致为 1 | `native/report.json`（vcs commit `203d0f0244b2`，dirty=true，finished 2026-10-20T06:37Z） |
| zz-probe 单套件（修复后） | `E2E_UNIT_SCOPE=app ... bunx e2e run --config e2e.unit.config.ts app/tests/zz-probe-context-menu.test.tsx` | **EXIT 0，8/8**（biome 格式后复跑同绿） | `probe-context-menu/report.json` |
| driven app 组（ADR 0008 两层制：e2e 调度、Bun 执行） | `E2E_UNIT_SCOPE=tests ... bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts --grep "bun runtime suite app/tests part"` | **EXIT 0**，4 组全绿（part 1-4，87 个 app driven 文件；part 1 的 4 个仅共享进程红由驱动器单文件重跑后转绿，属其 ISLANDS 机制） | `driven-app/report.json` |
| multitenancy selection（AC6） | 同上 `--grep "bun runtime suite app/tests/multitenancy"` | **EXIT 0** | `selection/report.json` |
| drop guard（AC2） | 同上 `--grep "app/tests part 2"`（composer-drop-guard）+ part 3 在 driven-app 内（root-drop-guard） | **EXIT 0** | `drop-guard-driven/report.json`、`driven-app/report.json` |
| 定向 native（域内 channel/chat 系） | `.../h10/channel-native ... app/tests/channel-*.test.* app/tests/chat-*.test.*`（15 个位置参数，8 个可收集文件） | **EXIT 0，108 测试** | `channel-native/report.json` |
| 定向 native（AC 证据批） | `.../h10/ac-evidence ...` app/tests/{transcript-messages,group-people,start-group,bot-roster-groups,take-the-wheel,handoff-resume,screen-connection,computer-activity} | **EXIT 0，7 文件 40 测试** | `ac-evidence/report.json` |
| 定向 native（composer 纯逻辑） | `.../h10/composer-lib ...` app/src/components/channels/composer/{draft,queue,picked-files}.test.ts | **EXIT 0，76 测试** | `composer-lib/report.json` |
| 定向 native（组件挂载/录制流程 + carousel + mouse + menu mutations） | driving-local-fields（4/4——挂载 recorder 并驱动录制流程，非迁移 Select 本身的驱动，W5 F9 口径修正）、carousel-keyboard（3/3）、lsm-probe（live-screen-mouse 5/5）、menu-mutations-probe（6/6） | **EXIT 0 x4** | 各目录 report.json |
| update-routing 复跑（Brief 列名红） | update-routing（2/2）+ update-routing-settings（1/1） | **EXIT 0 x2**——preload 修复后已如 Brief 预期转绿 | 各目录 report.json |
| 真实浏览器（CDP 可信输入） | spike server：`cd app && bunx vite --config vite.spike.config.ts --port 5199`；驱动：`/tmp/cdp-harness && node cdp-context-menu.mjs`（CHROME 默认本机 Chrome） | **ALL PASS，exit 0**（7 断言）；spike server 跑后已停 | `browser/run-2026-10-20-context-menu.log` + `browser/cdp-context-menu.mjs` |
| biome | `bunx biome check <2 个改动文件>` → `--write` → 复查 | 首轮 3 项格式诊断 → **修复后 EXIT 0 clean** | 会话输出 |
| 根因对照实验 | menu-probe（插桩 + 裸 Dropdown 对照，scratch 测试文件已删）；scratch-menu（scoped 化单变量） | 记录性运行（非门禁） | `menu-probe/`、`scratch-menu/` |

注：全程未 commit/push/stash；BASE 对照无需 /tmp worktree（本轮无 BASE 歧义 diff，token 面与 select 迁移的对照直接对 HEAD 基线做）。

## native 唯一失败归因（非本轮引入、非本域修复面）

| 文件 | 数 | 归因 |
| --- | --- | --- |
| `app/tests/heroui-spike.test.tsx`（TextArea） | 1 | 按 Brief 核对 H13 F3 结论（`h13/REPORT.md:32-38`）：真因 = RAC 受控 TextArea 不消费合成 `fireEvent.change`（与 `user.clear` 同族），套件属 H02 交付物（spike 测试自身，非生产路径）。归属原记「转 H15」，以 LEDGER 16:58 主控裁定为准归 **H14**（W5 F6）；H14 已按 H06/H13 真键击模式修复（Backspace 链 + user.type），隔离复跑 13/15（余 2 红为隔离条件性 Modal ESC，全量绿） |

前 Brief 列名的 `gallery-components`（H13）与 `approval-team-settings`（H07）在本轮全量 native 中已不在失败清单（并发波次已收口）；`zz-probe-context-menu` 8 → 0（本轮修复）。

## 遗留 / Interface 变更申请

- **无共享 Interface 变更申请**：`ui/*` 零净改动，27 primitives 无能力缺口暴露。`ui/context-menu.tsx` 的诊断插桩已逐字节还原（`git diff HEAD` 统计保持 H02 终态 738/142；`grep console.log|h10-diag` = 0）。
- **转 H15（新增 1 条，witness 已录）**：键盘开启（Shift+F10）后焦点落在 popover 包装层，ArrowDown 自包装层不达 items（合成 anchor 无 RAC MenuTrigger 所致）；焦点在 menu 上后键盘导航正常（CDP CM3 PASS）。与既有「物理键/触摸 in-app 复核」条目同区归并，证据：`browser/run-2026-10-20-context-menu.log` CM3 witness 行。
- **转 H15（既有，引用）**：ContextMenu 物理键（ContextMenu 键）与触摸/长按的 in-app browser 复核（BACKLOG-H14-H15 既有条目）。heroui-spike TextArea 原列此处，主控 16:58 裁定归 H14，**H14 已修复关闭**（真键击驱动，见归因节）。
- 浏览器级流式滚动/IME/接管的真实 app 页证据按分工归 validator 轮（本轮 CDP 只补了 context-menu 一处，其余复用 H01/H03 既有链路）；代码侧不阻塞。
- `h10/menu-probe/`、`h10/scratch-menu/` 为根因对照实验的一次性记录（对应 scratch 测试文件已删除，目录仅存 report/trace）。**证据口径修正（W5 F2，H14 落盘）**：menu-probe 的插桩 close-signal 日志行（`Menu onClose fired -> setOpen(false)`）与裸 HeroUI `<Dropdown>` 对照输出是**会话证据**，未落盘、不可从现存产物复原（probe 测试源已删）；根因链不依赖它们——`data-exiting` 卡滞有 scratch-menu trace 实证、close 信号有最终套件的 close-requested-once 断言、真实卸载有 CDP 证据。
