# OpenBot Web 端重设计方案

> 版本 v1 · 2026-10-11
> 依据：对 `app/src` 全量静态审计（210 个 `.tsx`、52,332 行）、`app/DESIGN.md`、`README.md`、`PRODUCT.md`
> 范围：React + Vite + TanStack Router 前端（`app/`），桌面端（Tauri）与移动端为同一产品的打包，不在本次范围内

---

## 0. 一句话结论

现有前端**有一份写得很好的设计规范，和一套没有完全执行它的代码**。`DESIGN.md` 提出的 "The Quiet Control Room" 方向是对的，应当保留并强化；真正需要重设计的不是审美，而是三件事：

1. **信息架构**：51 个页面只有 28 个导航入口，11 项侧栏全平铺，"需要人决策"这件事散落在 5 个地方表达；
2. **状态表达**：Bot 在做什么、在等什么，没有统一的视觉语言（`isRunning` / `turnsInFlight` / `runsInFlight` 三套并行，源码注释自承"三者互不相等"）；
3. **规范执行**：存在三套并行的设计方言，Inter 字体从未真正生效，焦点环在浅色模式下实测约 1.7:1 几乎不可见。

重设计的核心命题是：**把"人工在环"从散落的状态提示，提升为产品的一级结构。**

---

# 第一部分 · 现状诊断

## 1.1 信息架构

| 指标 | 实测值 |
|---|---|
| 叶子路由数 | **51**（`_app` 19 + `admin` 19 + `settings` 8 + 其他 5） |
| 侧栏可见导航入口 | **28**（应用 11 + 管理 11 + 设置 6） |
| 无导航入口的页面 | **23**（多为详情页与孤儿路由） |
| 侧栏分组 | 应用侧栏 **0 组**（11 项平铺）；管理侧栏 4 组；设置侧栏 0 组 |
| 面包屑 | **0 处**（全仓 `grep -i breadcrumb` 零命中） |
| 命令面板 / 全局搜索 | **无**。侧栏搜索框仅匹配已加载频道的 name/summary/lastMessage |
| 全局快捷键 | **1 个**（`Shift+N` → `/channel/new`） |

### 问题清单

**P1 · 三个 Bot 列表语义重叠，用户不知道该进哪个**

`/bots`（我能触达的 Bot + 各自待办）、`/agents`（卡片网格：置顶/我的/探索/隐藏）、`/team-bots`（团队发布与订阅）三者主视图都是 Bot 列表，数据源同为 `agentListQueryOptions()`。更糟的是侧栏顺序为 `Bots → Skills → Market → Agents → Team Bots`，同一业务对象被两个无关入口打断。

**P1 · "需要人决策"散落在 5 处，没有收件箱**

审批 `/approvals`、Bot 提问（`/approvals` 内 `questions` 区块）、浏览器接管请求（`HandoffResumeNotice`，1s 轮询）、密钥输入（`secretWanted`，屏幕内提示）、侧栏待办徽标（`BotAttentionList`，3s 轮询）——五处各自拉取状态，其中 `ControlState` 被三处独立轮询，一致性靠运气。

**P1 · 23 个页面没有入口，4 层深页面没有层级指示**

`/admin/plugins/$key/bots/$agentId` 是 4 层深页面，无面包屑、无统一返回路径。孤儿路由：`/bot`、`/routines`（侧栏注释自承已移除入口）、`/tenant/channels`。`/admin/enterprise` 在管理侧栏缺失，只能从概览页进入。

**P2 · 两套侧栏宽度、三种 IA 语言**

`_app` 侧栏 `340px`，`admin`/`settings` 侧栏 `300px`（`_app.tsx:14` vs `admin/route.tsx:20`）。应用侧栏无分组标题，管理侧栏有 4 组带标题——同一产品两种信息组织方式。

**P2 · 术语三套并存**

`Bot`（`/bots`）、`Agent`（`/agents`）、`Coworker`（首页注释）、`专家`（market 映射）。`responsibilities` / `routines` / `standing instructions` 三个词指向同一类"定时指令"概念。

**P2 · 管理员能力混入消费级页面**

`/market` 内部按 `me.data?.role === "admin"` 条件渲染安装按钮；`/team-bots` 同时承载"订阅同事 Bot"与"管理员推入群侧栏"。

---

## 1.2 布局

### 两套外壳 + 四种写法

| 外壳 | 特征 | 页面 |
|---|---|---|
| `_app` 应用壳 | `h-svh overflow-hidden`，面板内部滚动 | 19 页 |
| `_authed` 文档壳 | 文档自然滚动 | admin 19 + settings 8 |
| 裸壳 | 无侧栏 | `/onboarding`、`/tenant/channels`、`/sign-in/$requestId` |

`PageShell` 契约遵守率：**admin 95%（18/19）、settings 100%（8/8）、`_app` 58%（11/19）**。

`_app` 下 8 个未遵守页面中最突出的是 `_app/market.tsx`（引入一整套 `*Wb` 平行组件）与 `_app/agents/index.tsx`（自绘 `max-w-2xl`，且缺少 `min-h-0 overflow-y-auto`，在 `overflow-hidden` 外壳下长列表会被静默裁剪——`page-shell.tsx:94-112` 的注释记录了同类 bug 曾导致"246px 内容沉在折叠线下"）。

### 布局问题

**P1 · 会话页详情区三态互斥，无法同时看屏幕和文件**

`DetailPanel` 由 URL search param 驱动（`settings` / `watch` / `workshop`），打开一个必定清空另外两个（`$channelId.tsx:117-129`）。而 `workshop` 内部还有 6 个 Tab（process/files/artifacts/usage/share/schedules）。想"边看 Bot 屏幕边看它下载的文件"做不到。

**P2 · 侧栏宽度用 px，primitive 用 rem**

三个 shell 传 `width="340px" / "300px" / "300px"`，而 `ui/sidebar.tsx:29-31` 的常量是 `16rem/18rem/3rem`——两套单位混用，这正是历史上"侧栏比别处宽 20px" bug 的引入方式。

**P3 · `admin/playground.tsx` 是管理后台唯一不用 `PageShell` 的页面**（三栏代码编辑器，有正当理由，但意味着两套视觉语言）。

---

## 1.3 交互流程

### 值得保留的三处设计

1. **`DetailPanel` 用 URL search param 承载开关态**——可链接、可刷新、可后退，比组件内 state 高一个层级；
2. **`PageShell/PageSection/PageRows/PageEmpty` 四件套**——已覆盖 38 个页面，是重设计最可靠的抓手；
3. **`boundaries` 的 dry-run 预演**——规则改动前先在真实 trail 上回放影响，"先试后存"是治理界面最成熟的交互，值得推广。

### 问题清单

**P0 · Bot 运行状态没有统一来源**

三套并行：`agent.isRunning`（CopilotKit）、`turnsInFlight`（自维护轮次计数）、`runsInFlight`（可 Stop 的 run）。源码注释承认 `agent.isRunning` 会在轮次中间报 idle，因为浏览器工具是 frontend tool，一次点击会结束当前 run 再开新 run（`channel-chat.tsx:585`）。

**P0 · "等待接管"是唯一没有持续可见表达的阻塞态**

靠 7px 琥珀圆点 + 3s 轮询 + 自动弹窗表达。用户一旦手动关掉 Computer 面板（`shownPrompt` ref 已记过），就只剩一个没有任何文字的圆点。而这是产品最关键的人工在环时刻。

**P1 · 全项目 0 处 toast**

`grep -rl "toast|sonner"` = 0。所有反馈靠内联 `role="alert"` / `role="status"`，写操作成功与否没有瞬时提示。

**P1 · 大量页面加载时整页空白**

`if (isPending) return null` 出现在 `bots.index.tsx:36`、`bots.$agentId.tsx:22`、`activity.tsx:187`、`bot.tsx:99`。`Skeleton` 只在 12 个文件使用。

**P1 · 审批决策无 per-item pending**

13 个 mutation 共用一个 `error` 变量、一个 `isPending`（`inbox.tsx:101-113`）——点一个按钮会连带禁用所有按钮。

**P1 · 错误处理 5 种写法并存**

页面底部一行红字 / 整页居中红字 / `Empty` + `border-destructive` / `<p className="p-8">` / 塞进页脚。`text-destructive` 出现在 98 个文件，模式不统一。且**几乎没有重试**。

**P2 · Bot 卡片不承载任何状态**

`AgentCard` 只有 name + roleDescription。运行状态、待办数、未读、暂停状态只出现在 `/bots` 行和侧栏——用户在 `/agents` 看不到哪个 Bot 需要他。

**P2 · 无批量、无筛选、无排序、无分页**（除侧栏频道分页外）。`/bots` 无搜索，`/approvals` 无分类。

**P2 · 两套空状态组件并存**：`ui/empty`（15 文件，dashed border 卡片）与 `PageEmpty`（21 文件，muted 一行文字）。

**P2 · 巨型组件阻碍重构**：`composer.tsx` 82KB、`chat-transcript.tsx` 79KB、`channel-chat.tsx` 45KB、`agent-dialog.tsx` 29KB、`computer-view.tsx` 31KB。

**P3 · `SCREEN_PANEL_WIDTH = 400` 是死常量**（实际 watch 也拿 480，`$channelId.tsx` 传的是 `WORKSHOP_PANEL_WIDTH`）。

---

## 1.4 视觉风格

### 评分

| 维度 | 评分 | 结论 |
|---|---|---|
| Token 落地 | 8.5/10 | OKLCH 值与文档逐项一致，15px 根字号、`--radius: 0.55rem`、`.dark` 齐备 |
| 组件复用 | 9/10 | 26 个 ui 原语**全部被引用**，无死组件；`Item` 508 次、`Button` 291 次 |
| **规范一致性** | **4/10** | **三套并行方言**；89 处硬编码彩色；`rounded-full` 72 处；`[Npx]` 87 处 |
| 响应式 | 3.5/10 | 82 处断点集中在 30/210 文件；无 `2xl`；≤640px 无实质重排 |
| 无障碍 | 5.5/10 | focus ring 4 种写法；15 个图标按钮无可访问名；ring 对比度 2.59:1 |
| 暗色模式 | 7/10 | 42 个变量齐全，但 85 处 `dark:` 覆盖集中在 28 文件，硬编码色多半只跑得通 light |

### 三个 P0

**P0-1 · Inter 字体从未生效**

`styles.css:105` 的 `body { font-family: Inter, ... }` 引用了不存在的字族——`@fontsource-variable/inter` 只注册了 `'Inter Variable'`。且这条规则在 `@layer` 之外，优先级高于所有 layer，因此全站正文继承的是**系统 UI 字体**（macOS 上是 SF Pro），只有 4 处显式写 `font-heading` 的元素才真的拿到 Inter Variable。事实上的两套字体。修复成本：1 行。

**P0-2 · 浅色模式焦点环几乎不可见**

`--ring: oklch(0.708 0 0)`（≈`#a1a1a1`）对白底 **2.59:1**，而规范要求再叠 `/50` → 实际约 **1.7:1**，远低于 UI 组件所需的 3:1。这是 `DESIGN.md:214` 自己定的写法，需要修正 token 而非修正用法。

**P0-3 · `--success` 小字号不达 AA**

`oklch(0.6 0.118 184.704)` ≈ `#009689`，对白底 **3.66:1**，低于正文 4.5:1。当前 5 处 `text-success` 全是小字号。

### 三个 P1

**P1-1 · 三套并行的设计方言**

| 方言 | 位置 | 问题 |
|---|---|---|
| 规范实现 | `components/ui/`（26 组件） | 正确 |
| **market 方言** | `components/market/wb.tsx`（368 行，16 个 `Wb*` 导出） | `rounded-2xl` + rgba 阴影 + 48px 图标槽 + 第二套 Button + 4 组 hex 渐变（`experts-pane.tsx:43-46`，违反 "no gradient surfaces"） |
| **gallery 方言** | `components/gallery/`（17 个生成式卡片） | 第 4 个 Badge 方言 + 6 色 chromatic 图表盘 |

**P1-2 · 图表配色彻底违反规范**

`--chart-1…5` 灰阶 token 定义了但**零引用**（全仓 grep 0 命中）；实际 `gallery/palette.ts:5-12` 用了 `["#6366f1","#10b981","#f59e0b","#0ea5e9","#8b5cf6","#ec4899"]`。这是全部规则里被违反得最彻底的一条。

**P1-3 · 89 处硬编码 Tailwind 调色板色 / 27 个文件**

`text-amber-600`(17)、`bg-amber-500`(13)、`bg-emerald-500`(11)、`text-amber-500`(16)……重灾区 `routines-list.tsx`(16)、`gallery/frame.tsx`(12)、`admin/audit.tsx`(8)。语义 token 明明在那：`text-success` 全仓只有 5 处，而 `emerald-*` 有 17 处。

### 其余

- **72 处 `rounded-full` / 37 文件**（规范："pills appear nowhere"）。头像、指示点、Switch 滑块约 12 处必要，其余约 60 处违规，重灾 `voice-call-widget.tsx`(10)。
- **87 处 `[Npx]` / 24 种取值**，含 `text-[10/11/12/14px]` 16 处、整个 `ui/switch.tsx` 是 px 几何、`_app/index.tsx:148` 一处 18 个 `h-[180px]`。
- **focus ring 4 种写法**：`ring-3`(9) / `ring-[3px]`(3) / `ring-2`(8) / `ring-0`(2，视觉上完全无指示，`ui/input-group.tsx:125,141`)、`outline-*` (3)、`outline-none`(1)。约 15/62 ≈ 24% 偏离契约。
- **15 个图标按钮无可访问名称**（`aria-label` 全仓 151 处且都走 i18n，说明是遗漏而非无意识）。
- **47 处 `font-mono`** 引入第二字族，而 `@theme` 未定义 `--font-mono`。
- **无视觉回归 / token / 对比度测试**（`tests/` 152 文件中仅 1 个主题切换测试），上述违规不会被测试拦住。

### 响应式

- 断点 82 处：`sm` 40 / `md` 25 / `lg` 8 / `xl` 9 / **`2xl` 0**。开发者只用 `sm` 做手机/桌面二值切换。
- 侧栏是唯一有结构级响应的部分（<768px 转 Sheet，`ui/sidebar.tsx:201-223`），且 a11y 到位（sr-only SheetTitle）。
- `admin/audit.tsx` 6 列 + `whitespace-nowrap` + `w-[22rem]` 固定列 → 375px 视口需横滚约 2.5 屏。**对照 `settings/invoices.tsx` 已用 `md:table-cell` 隐藏次要列**，`audit` 明显落后。
- 结论：**"mobile-tolerant"（容得下手机），而非 "mobile-designed"（为手机设计）**。
- 15px 根字号把控件压小 6.25%：主力 `size="sm"` h-7 = **26.25px**，全站出现 **312 次**，远低于 40px 舒适线；9 个 `xs` 级按钮 22.5px，**低于 WCAG 2.2 SC 2.5.8 的 24px 硬线**。

---

## 1.5 优先级矩阵

| 优先级 | 问题 | 影响面 | 修复成本 |
|---|---|---|---|
| P0 | Inter 未生效 | 全站正文 | 1 行 |
| P0 | ring 对比度 1.7:1 | 全站焦点 | 1 行 + 回归 |
| P0 | success 3.66:1 | 5 处状态文本 | 1 行 |
| P0 | 状态机三套并行 | 会话页全部状态表达 | 中 |
| P0 | "等待接管"弱表达 | 核心人工在环时刻 | 中 |
| P1 | 三套设计方言 | 3 个模块 | 大 |
| P1 | 图表 chromatic | 6 个图表组件 | 小 |
| P1 | 89 处硬编码色 | 27 文件 | 中 |
| P1 | 导航扁平 + 23 页无入口 | 全站 | 中 |
| P1 | 无 toast / 白屏加载 | 全站反馈 | 中 |
| P2 | ≤640px 无重排 | 移动端 | 中 |
| P2 | 312 处 26.25px 按钮 | 触摸体验 | 小（media query） |
| P2 | 72 处 pill / 87 处 px | 视觉一致性 | 中 |

---

# 第二部分 · 重设计方案

## 2. 设计原则

继承 "The Quiet Control Room"，并补上执行层缺失的三条：

| # | 原则 | 说明 |
|---|---|---|
| 1 | **状态优先于装饰** | 色彩、动效、布局优先服务于"让用户知道 Bot 现在在干什么、在等什么"。装饰性元素一律不新增。 |
| 2 | **人工在环是一级结构** | "需要你"不是一个徽标和一个圆点，而是一个收件箱、一个状态条、一套统一状态机。 |
| 3 | **单一来源** | 任何状态（Bot 运行态、待办计数、控制归属）只有一个数据出处，界面各处只是它的投影。 |
| 4 | **一个壳，一个契约** | 配置类页面一律 `PageShell`；面板类页面一律 `Pane` 契约。侧栏宽度、断点、单位全局统一。 |
| 5 | **规范可执行** | 每条规则都要有测试或 lint 兜底，否则它只是一条愿望。 |

---

## 3. 页面与导航结构

### 3.1 导航重构：从 11 项平铺到 1 个收件箱 + 频道区 + 3 个分组

```
┌─ 应用侧栏（新）─────────────────────────┐
│ [＋ 新会话]        [⌘K 搜索]            │  ← 顶部动作区
├─────────────────────────────────────────┤
│ 需要你          ③                        │  ← 新增，聚合审批/提问/接管
├─────────────────────────────────────────┤
│ 频道                                     │  ← 可折叠花名册（保留）
│  · 费用报销 Bot        ②                │
│  · 会议纪要助手                          │
├─────────────────────────────────────────┤
│ 同事                                     │  ← 合并 /bots + /agents + /team-bots
│  我的同事 / 团队同事 / 发现              │
├─────────────────────────────────────────┤
│ 能力                                     │
│  技能 / 知识库 / 记忆 / 连接器           │
├─────────────────────────────────────────┤
│ 我的                                     │
│  职责 / 触达方式 / 设置                  │
└─────────────────────────────────────────┘
```

**核心改动：把"需要你"从徽标提升为独立收件箱。**

现状：审批在 `/approvals`、提问在同页 `questions` 区块、接管靠 1s 轮询的琥珀条、密钥在屏幕内提示、计数在侧栏徽标。

新方案：**`/inbox`** 是唯一入口，三类待办（审批 / 提问 / 接管）同列表呈现，按紧急度排序，支持批量决策。侧栏徽标与频道行标记都是它的投影。

### 3.2 路由表重排

| 动作 | 现状 | 新路由 | 说明 |
|---|---|---|---|
| **合并** | `/bots` `/agents` `/team-bots` | `/coworkers`（`?tab=mine\|team\|discover`）<br>`/coworkers/$agentId` | 一个业务对象一个入口，Tab 切换身份视角 |
| **合并** | `/approvals` + 分散 attention | `/inbox` | 收件箱 |
| **合并** | `/routines` → | `/responsibilities?tab=routines` | 消除同义三词并存 |
| **拆分** | `/market`（experts/skills/connectors 三 Tab） | experts → `/coworkers?tab=discover`<br>skills → `/skills?tab=market`<br>connectors → `/settings/connected-accounts` | 消除"消费级页面内嵌管理员能力" |
| **下线** | `/bot` `/tenant/channels` | — | 孤儿路由，无入口 |
| **收编** | `/admin/enterprise` | 加入管理侧栏 access 组 | 现状只能从概览页进入 |
| **新增** | — | `/inbox`、`/coworkers` | |
| **保留** | 其余 40 页 | 不变 | 主要是 admin/settings 深层页 |

**页面数：51 → 约 42**（合并 6、下线 2、新增 2、拆分回收 3）。

### 3.3 全局导航机制：命令面板 + 面包屑 + 快捷键

| 机制 | 现状 | 新方案 |
|---|---|---|
| 命令面板 | 无 | `⌘K / Ctrl+K` 打开，覆盖全部 42 页 + 频道 + Bot + 技能 + 设置项；支持 `>` 前缀执行命令（新建 Bot、暂停、接管） |
| 面包屑 | 0 处 | `ui/breadcrumb` 组件，所有 ≥2 层深的页面强制挂载；`PageShell` 增加 `breadcrumb` prop |
| 全局搜索 | 仅频道名/摘要/末条消息 | 命令面板内统一检索，服务端接口就绪前先覆盖本地已知实体 |
| 快捷键 | 1 个（`Shift+N`） | 扩展至 8 个：`⌘K` 面板、`Shift+N` 新会话、`⌘B` 侧栏、`⌘/` 快捷键面板、`⌘E` 收件箱、`Esc` 关闭面板、`G then C/B/I` 跳转 |
| 最近访问 | 无 | 命令面板首屏展示最近 8 个实体 |

### 3.4 术语收敛

| 概念 | 统一用词 | 落地 |
|---|---|---|
| Bot / Agent / Coworker / 专家 | **同事（Coworker）** | UI 文案统一；路由 `/coworkers`；i18n key 重映射（`/bots` `/agents` 现有中文包仍为英文，一并修复） |
| responsibilities / routines / standing instructions | **职责（Responsibilities）** + 子 Tab「定时任务」 | |
| reachability / connected-accounts | 触达方式（渠道）/ 已连接账号（凭证） | 职责边界写进页面描述 |

### 3.5 侧栏统一

- 宽度统一为 **`20rem`（300px）**，三处 shell 使用同一个常量 `SIDEBAR_WIDTH`（定义在 `ui/sidebar.tsx`，shell 只引用不硬编码）。
- 分组标题语言对齐管理侧栏已有范式（`SidebarGroupLabel`）。
- 应用侧栏支持分组折叠（现状只能整体折叠）。

---

## 4. 核心页面的组件划分与交互逻辑

### 4.1 会话页 `/channel/$channelId`（最高优先级重做）

#### 4.1.1 从"互斥单栏"到"常驻状态条 + 可堆叠工作区"

```
┌────────┬──────────────────────────────────┬──────────────┐
│ 导航    │ ┌──────────────────────────────┐ │  工作区       │
│        │ │ ChannelStatusBar  ← 新增·常驻 │ │  Workspace    │
│        │ │ 「正在浏览 3 个页面 …」 [接管] │ │  ┌────────┐  │
│        │ ├──────────────────────────────┤ │  │ Screen │  │
│        │ │                              │ │  ├────────┤  │
│        │ │  ChannelTranscript           │ │  │ Files  │  │
│        │ │   MessageGroup               │ │  ├────────┤  │
│        │ │   ToolLine (4 态)            │ │  │Activity│  │
│        │ │   GenerativeCard             │ │  ├────────┤  │
│        │ │   HandoffResumeNotice        │ │  │Process │  │
│        │ │                              │ │  └────────┘  │
│        │ ├──────────────────────────────┤ │              │
│        │ │ Composer                     │ │  400–480px   │
│        │ └──────────────────────────────┘ │  可折叠为条   │
└────────┴──────────────────────────────────┴──────────────┘
```

**关键差异**：现状 `settings / watch / workshop` 三选一互斥，且默认全关；新方案把 `watch`（屏幕）与 `workshop`（文件/活动/进程）合并为一个 **Workspace 面板**，内部 Tab 自由切换，Screen 与 Files **可同时存在**（Screen 置顶固定，下方 Tab 切换）。

#### 4.1.2 组件树

```
ChannelView
├── ChannelStatusBar                    ← 新增，全页唯一状态出口
│   ├── RunPhaseIndicator    (7 态图标 + 文案)
│   ├── ProgressSummary      (已浏览 N 页 / 已运行 N 步 / 耗时)
│   └── ControlAction        (Take control / Hand back / Resume)
├── ChannelTranscript
│   ├── MessageGroup
│   ├── ToolLine             (running / refused / failed / done，图标+色，不只靠颜色)
│   ├── GenerativeCard       (gallery + ToolRenderBoundary)
│   ├── DecisionCard         (askApproval / askChoice / askForm)
│   └── HandoffResumeNotice
├── Composer                            ← 拆分 82KB 巨型组件
│   ├── MentionMenu
│   ├── SkillMenu
│   ├── AttachmentStrip
│   ├── DictationControls
│   ├── QueueIndicator
│   └── SendButton
└── WorkspacePanel                      ← 取代互斥 DetailPanel
    ├── ComputerView        (常驻顶部，可收起)
    ├── ControlHandoff      (密钥输入、交还)
    ├── ActivityLog
    └── WorkshopTabs        (Files / Artifacts / Usage / Share / Schedules)
```

#### 4.1.3 统一状态机（P0）

**用一个 `useRunPhase()` 取代三套并行状态**：

```ts
type RunPhase =
  | "idle"              // 空闲
  | "thinking"          // 思考中
  | "acting"            // 执行工具 / 浏览 / 运行命令
  | "waiting_for_you"   // 等待人决策（提问 / 审批 / 接管 / 密钥）
  | "you_have_control"  // 人正在操作
  | "paused"            // Bot 已暂停
  | "error"             // 失败 / 被拒绝
```

**约束**：`ChannelStatusBar`、侧栏频道行、`/inbox` 计数、`WorkspacePanel` 自动展开，全部订阅同一个 `runPhase`。禁止任何组件单独轮询 `ControlState`（现状 `useNeedsYou` 3s、`HandoffResumeNotice` 1s、`useComputerControl` 各查各的）。

**状态 → 视觉映射表（唯一真源）**

| Phase | 状态条 | 工作区 | 侧栏 | Inbox |
|---|---|---|---|---|
| idle | 隐藏 | 保持上次 | — | — |
| thinking | 中性 + shimmer "思考中" | 保持 | 频道行 working | — |
| acting | 中性 + "正在浏览 3 个页面" + 耗时 | 自动展开 Screen | 频道行 working | — |
| **waiting_for_you** | **warning 底色 + "需要你：登录验证"** | **自动展开 Screen 并聚焦** | **频道行标记 + 计数** | **+1** |
| you_have_control | primary 底色 + "你在操作" | Screen 高亮边框 | 频道行标记 | — |
| paused | muted + "已暂停" [恢复] | 保持 | 频道行 paused | — |
| error | destructive 色调 + 原因 + [重试] | 保持 | 频道行标记 | — |

**"等待接管"的强化路径**（对比现状）：

| | 现状 | 新方案 |
|---|---|---|
| 表达 | 7px 琥珀圆点（无文字） | 状态条 warning 底色 + 明确文案「需要你：登录验证」 |
| 持久性 | 关闭面板后消失 | 状态条常驻，无法关闭 |
| 来源 | 3s 轮询 | `runPhase` 单一来源 |
| 联动 | 无 | 侧栏计数 + Inbox +1 + 工作区自动聚焦，四处一致 |
| 行动 | 需自己找到按钮 | 状态条右侧直接是主操作按钮 |

#### 4.1.4 交互流程（重做后）

```
输入 → Composer（@提及 / /技能 / 附件 / 语音）
  ↓
发送 → runPhase: acting
  ↓
StatusBar 显示实时摘要（"正在浏览 3 个页面 · 12s"）
WorkspacePanel 自动展开 Screen
  ↓
遇到登录/2FA/密钥 → runPhase: waiting_for_you
StatusBar 变 warning + 主操作按钮
侧栏 +1、Inbox +1
  ↓
用户 Take control → runPhase: you_have_control
Bot 动作在此期间被拒绝（现状逻辑，保留）
Screen 高亮边框 + "你在操作"
  ↓
Hand back → runPhase: acting
  ↓
完成 → runPhase: idle，结果以 GenerativeCard 渲染
       若被策略拒绝 → ToolLine refused 态 + 指向 /admin/boundaries 的修复建议
```

#### 4.1.5 Composer 拆分

现状 `composer.tsx` 82KB。拆为 `components/channels/composer/` 目录下 6 个模块 + 1 个容器，容器只负责编排与状态。拆分的判断标准：每个子组件可独立测试、无跨层 prop drilling。

### 4.2 同事域 `/coworkers`（合并三个列表）

#### 卡片信息架构补齐（现状缺失）

| 信息 | 现状 `/agents` | 新 `/coworkers` |
|---|---|---|
| 名称 + 角色描述 | ✅ | ✅ |
| **运行状态** | ❌ | ✅ StatusDot + 文案（运行中/空闲/暂停） |
| **待办数** | ❌ | ✅ Badge（指向 `/inbox?bot=<id>`） |
| **末次活动** | ❌ | ✅ 相对时间 |
| 置顶 / 隐藏 | ✅ | ✅ |

#### 交互

- **三 Tab**：我的（mine）/ 团队（team）/ 发现（discover），取代三个独立路由。
- **筛选与排序**：状态筛选（需处理/运行中/已暂停/全部）+ 排序（最近活动/名称/待办数）。现状完全缺失。
- **批量操作**：多选 + 批量暂停/恢复/隐藏。现状完全缺失。
- **档案页** `/coworkers/$agentId`：现状 `BotProfile` 的段落式布局改为 4 Tab（概览 / 活动 / 权限 / 连接），统一 `PageShell`。
- **创建流程**：保留现有 3 步向导（`identity → visibility → kind`），但补齐"离开时保留草稿"（现状注释明说中途关闭会丢弃全部答案）。

### 4.3 收件箱 `/inbox`（新增，取代 `/approvals`）

```
┌─ /inbox ────────────────────────────────────────────────┐
│ [全部 ③] [审批 ①] [提问 ①] [接管 ①] [已处理]   [批量决策] │
├──────────────┬──────────────────────────────────────────┤
│ 列表          │ 详情                                      │
│ ● 报销 Bot    │ 报销 Bot 想要 send_email                   │
│   审批 · 2m   │ 收件人：finance@company.com                │
│ ○ 纪要助手    │ 理由：超出 ¥500 需要人工确认                │
│   提问 · 1h   │ 策略：ask                                  │
│ ● 费用 Bot    │ ─────────────────────────────────────     │
│   接管 · 3h   │ [允许] [拒绝] [总是允许]                    │
└──────────────┴──────────────────────────────────────────┘
```

**关键修复**：

| 现状问题 | 修复 |
|---|---|
| 13 个 mutation 共用一个 `isPending`，点一个禁用全部 | **per-item pending**：每个决策项独立 mutation，禁用态不外溢 |
| 无筛选分类 | 5 个筛选 Tab + 按 Bot 过滤 |
| 无批量 | 多选批量决策 |
| `question.botId` 直接把 id 显示给用户（`"{botId} wants to..."`) | 显示 Bot 名称 + 头像 |
| 规则编辑与待办混在一页 | 规则（ask-before-changes 等）移到 `/settings/approvals` Tab，并引入 **dry-run 预览**（复用 boundaries 的成熟范式） |
| 使用原生 `<select>` 手写样式 | 改用 `ui/select` |

### 4.4 治理域：把 dry-run 推广

`boundaries` 的 dry-run 是全项目最成熟的治理交互。重设计中把它抽象为 **`PolicyPreview` 组件**，推广到：

- `/admin/boundaries`（已有）
- `/settings/approvals` 规则编辑（新增）
- `/admin/plugins/$key` 工具授权变更（新增）

统一交互：改动规则 → 点「先在历史上试跑」→ 展示将影响 N 条历史动作 → 确认后才保存。同时修复 boundaries 现存的两个问题：保存反馈移到操作点附近（现状在页面底部 `mt-8 text-xs`）、deny 列表支持排序/搜索/单条禁用。

### 4.5 反馈系统：引入 Toast

全项目 0 处 toast。新增 `ui/toast`（基于 sonner 或 Base UI Toast），统一四类反馈：

| 类型 | 场景 | 规范 |
|---|---|---|
| success | 保存成功、决策已提交 | muted 底 + success 图标，2.5s 自动消失 |
| error | 操作失败 | destructive tint，手动关闭 + [重试] |
| pending | 长任务进行中 | 常驻直到完成，带进度 |
| info | 状态变更提示 | 中性，2.5s |

**配套**：`isPending` 时不再 `return null`，改用 `Skeleton`；`Skeleton` 使用从 12 个文件提升到所有列表/详情页。

### 4.6 错误处理统一

从 5 种写法收敛到 2 个组件：

- `ErrorInline`：行内错误（`role="alert"`，destructive tint，含 [重试]）
- `ErrorState`：整页错误（复用 `PageEmpty` 的位置，但带 destructive 语义与重试按钮）

规则：**任何 `text-destructive` 的错误必须伴随一个可执行的下一步**（重试 / 去设置 / 联系管理员）。

---

## 5. 响应式适配策略

### 5.1 三档布局（取代当前的二值切换）

| 档位 | 断点 | 导航 | 内容区 | 工作区 | 表格 |
|---|---|---|---|---|---|
| **Compact** | <768px | Sheet 抽屉 | 单栏全宽 | 全屏 Drawer 覆盖 | 卡片列表（非横滚） |
| **Standard** | 768–1279px | 常驻侧栏 20rem | PageShell prose (630px) | 右侧 400px | 列隐藏 + 横滚兜底 |
| **Expanded** | ≥1280px | 常驻侧栏 20rem | PageShell prose（宽表 wide） | 右侧 480px | 全列 |

新增断点 `2xl`（现状 0 处使用）——大屏不是"把桌面拉宽"，而是**列表+详情并排**（如 `/coworkers` 在 ≥1536px 时选中卡片右侧就地展开详情，不跳转）。

### 5.2 各档适配规则

**导航**
- <768px：侧栏转 Sheet（现状已实现，保留），新增底部 Tab Bar（会话 / 同事 / 收件箱 / 我的）作为主要导航手段——现状移动端只有汉堡菜单，核心的"需要你"没有常驻入口。
- ≥768px：侧栏常驻，支持分组折叠。

**会话页**
- <768px：Workspace 强制全屏 Drawer（现状 `ResizeObserver` 降级为 Sheet 的逻辑保留并强化）；StatusBar 缩为单行紧凑型。
- ≥1280px：Workspace 480px，Screen 与 Files 可并排。

**表格**（关键修复）
- `admin/audit` 现状 6 列全显 + `whitespace-nowrap` + `w-[22rem]` 固定列 → 375px 需横滚 2.5 屏。
- 新方案：<768px 转**卡片列表**（每条记录一张 `Item`，关键字段 3 行，次要字段折叠）；768–1279px 隐藏次要列（复用 `invoices.tsx` 已验证的 `md:table-cell` 模式）；≥1280px 全列。
- **禁止** `whitespace-nowrap` 用于长文本列，改为 `truncate` + tooltip 全文。

**表单**
- <768px：单列，输入框 `text-base`（16px）防 iOS 缩放（现状已做，保留）。
- ≥768px：双列网格（`FieldGroup` 内成对字段）。

**触摸目标**（修复 312 处 26.25px 按钮）

```css
@media (pointer: coarse) {
  /* 粗指针设备下把所有控件提升到 ≥40px */
  .btn-sm { height: 2.75rem; }   /* 41.25px */
  .icon-sm { size: 2.75rem; }
}
```

保留 15px 根字号（信息密度是产品特性），但用 `pointer: coarse` 媒体查询在触摸设备上单独放大——桌面保持紧凑，移动端保证可用。9 个 `xs` 级（22.5px）按钮在 coarse 下强制升级或改为非按钮形态。

### 5.3 单位纪律

- 侧栏宽度：三处 shell 统一引用 `SIDEBAR_WIDTH` 常量（rem），消灭 `340px`/`300px` 硬编码。
- 消灭 87 处 `[Npx]`：允许清单仅限**（a）** 与视口相关的 `vw/vh/dvh`，**（b）** 1px 边框类，其余一律 rem。
- `ui/switch.tsx` 的 px 几何改为 rem。

---

## 6. 视觉风格与设计规范

### 6.1 色彩

**保持**：近单色 OKLCH、色彩只为状态服务（"Meaning-Only Color Rule"）。这套方向是对的，不推翻。

**修正（3 个 P0）**

| Token | 现值 | 新值 | 理由 |
|---|---|---|---|
| `--ring`（light） | `oklch(0.708 0 0)` 2.59:1 | **`oklch(0.556 0 0)`** ≈4.48:1 | 焦点环必须可见 |
| ring 用法 | `ring-3 ring-ring/50` 约 1.7:1 | **`ring-3 ring-ring`**（去掉 /50） | 同上 |
| `--success`（light） | `oklch(0.6 0.118 184.704)` 3.66:1 | **`oklch(0.52 0.118 184.704)`** ≈5.1:1 | 正文需达 AA 4.5:1 |
| `--destructive`（light） | `oklch(0.577 0.245 27.325)` on muted 4.24:1 | **`oklch(0.52 0.23 27.325)`** | 在 tinted 背景上也要达标 |

**新增（收编 33 处硬编码 amber）**

| Token | 值 | 用途 |
|---|---|---|
| `--warning` | `oklch(0.62 0.15 70)` | 等待接管、暂停中的浏览器任务、dry-run 提示。收编现有 33 处 `amber-*` |
| `--destructive-foreground` | `oklch(0.985 0 0)` | **现状缺失**，静默失效的定时炸弹 |
| `--info` | `oklch(0.55 0.12 250)` | 中性提示（替代 `sky-*`/`blue-*`） |

**图表回归灰阶**：`--chart-1…5` 从"定义后零引用"改为真正使用；`gallery/palette.ts` 的 6 色 chromatic 盘替换为灰阶 5 阶 + 单一强调（用 `--foreground` 的深浅区分强调序列）。这是规范被违反得最彻底的一条。

**禁用清单（lint 可检查）**：`amber-*` `emerald-*` `rose-*` `red-*` `sky-*` `blue-*` `green-*` `yellow-*` 等 Tailwind 默认彩色类一律禁止，必须走语义 token。89 处 → 0。

### 6.2 字体

**修复 P0**：`styles.css:105` 的 `font-family: Inter` → `Inter Variable`（一字之差，全站正文从系统字体回到 Inter）。

**明确第二字族**：`@theme` 定义 `--font-mono: ui-monospace, "SF Mono", "JetBrains Mono", monospace`，**仅允许用于 ID / token / 代码 / CEL 表达式**（现状 47 处用途大多合理，只是从未纳入规范）。除代码外禁止出现第二种字族。

**排版尺度：4 档 → 5 档**（消灭 16 处 `text-[10/11/12/14px]`）

| 档位 | 类 | @15px 实际 | 用途 |
|---|---|---|---|
| Display | `text-2xl` | 22.5px | PageShell 标题（每屏一个） |
| Headline | `text-lg` | 16.875px | PageSection / Dialog 标题 |
| **Body-L** | `text-base` | 15px | **新增**：长文阅读、空态文案（收编现存 28 处） |
| Body | `text-sm` | 13.125px | 主力：正文、按钮、输入、行内容 |
| Label | `text-xs` | 11.25px | 侧栏组标签、时间戳、元信息 |

层次靠字重（700 / 500 / 400）+ 这 5 档，不靠新颜色、不靠新字族。

### 6.3 间距与尺寸

- **基准 4px**，全部 rem 化（消灭 87 处 `[Npx]`）。
- **控件尺寸**：主力从 `sm`(h-7 = 26.25px，出现 312 次) 改为 **`default`(h-9 = 33.75px)**；粗指针设备下 `2.75rem`(41.25px)。`xs`(22.5px) 在 coarse 下禁用。
- **Section 间距**：保留 `mt-12`（3rem）大留白——"空间而非分隔线"是这套系统最好的判断，不动。
- **行内间距**：`0.625rem 0.75rem` 保持不变。

### 6.4 圆角 / 阴影 / 图标

**圆角**：保留 `--radius: 0.55rem` 与 ×0.6/×0.8/×1/×1.4/×1.8 阶梯（删除未定义的 3xl/4xl 两档）。

`rounded-full` **豁免清单**（明确写入规范，lint 按清单放行）：头像、在线状态点、Switch 滑块、轮播指示点、加载指示点。清单外约 60 处全部改为 `rounded-lg`——尤其 `voice-call-widget.tsx`(10)、`skills.tsx` 分类 pill、`desktop-illustration.tsx`(5)。

**阴影**：严格执行 Border-Not-Shadow。静止面只有边框（dark 下 `dark:border-transparent`），浮层才有阴影。删除 `market/wb.tsx:28,30` 的 rgba 阴影、`ui/checkbox.tsx` 的 `shadow-xs`、`computer-view.tsx:467` 的 `shadow-sm`。

**图标**：Tabler 单行图标（现状零混用，做得最好的一项，保持）。尺寸从 8+ 档收敛到 **3 档**：`size-3.5`(13px) / `size-4`(16px，默认) / `size-5`(19px)。消灭 `market/wb.tsx:51` 的 48px 图标槽。

### 6.5 组件库：26 → 38

现状 26 个 ui 原语**全部被引用、无死组件**，说明"够用就好"的策略成功。缺口是补齐而非推翻：

| 新增 | 解决什么 |
|---|---|
| `badge` | 待办计数、状态标签（现状 4 个 badge 方言并存） |
| `tabs` | `/coworkers` 三 Tab、`/inbox` 筛选、`workshop` 六 Tab（现状 `market.tsx:255` 手绘 Tabs 无 `aria-selected`） |
| `table` | `admin/audit`、billing 表格的现状手绘 `<table>` |
| `toast` | 全项目 0 处反馈 |
| `command` | 命令面板 |
| `breadcrumb` | 0 处面包屑 |
| `progress` | 长任务进度（现状只有 shimmer，无 step/百分比） |
| `status-dot` | 统一 7 态状态点（现状散落 `size-1.5/2/3` 无语义） |
| `alert` | 统一 5 种错误写法 |
| `empty`（统一版） | 与 `PageEmpty` 合并为一套，消灭两套空状态 |
| `scroll-area` | 统一滚动容器（解决 `_app` 下缺 `min-h-0 overflow-y-auto` 的裁剪陷阱） |
| `kbd` | 快捷键展示 |

**消灭 market 方言**：`components/market/wb.tsx`（368 行、16 个 `Wb*` 导出）整体重写，改用 `ui/button` + `ui/card` + `ui/tabs` + `ui/badge`。5 个引用文件同步改造。

**gallery 方言**：保留（生成式 UI 是 Bot 产物，允许有自己的容器性格），但必须遵守：容器走 `rounded-xl border bg-card`，图表配色走 `--chart-1…5`，状态色走语义 token。

### 6.6 动效

保留现有预算（150ms 状态 / 200ms 布局 / 1.6s shimmer），新增：

| 动效 | 时长 | 用途 |
|---|---|---|
| Toast 进出 | 200ms ease-out | 新增反馈 |
| 工作区展开 | 200ms ease-out | 与侧栏折叠同速 |
| 状态条底色切换 | 150ms | 状态跃迁 |
| 卡片 mount 错峰 | 4px rise（已有） | 列表 |

`prefers-reduced-motion` 下全部降级（现状已覆盖 shimmer，扩展到全部新增动效）。删除 `duration-300`(2) / `duration-400`(1) 超预算项。

### 6.7 无障碍

| 项 | 现状 | 目标 |
|---|---|---|
| focus ring | 4 种写法，含 `ring-0`/`outline-none` 无指示 | **统一 `ring-3 ring-ring` + `border-ring`**；删除全部 `ring-2` / `ring-[3px]` / `outline-*` 变体 |
| ring 对比度 | 1.7:1 | ≥3:1（token 修正后 4.48:1） |
| 图标按钮可访问名 | 15 处缺失 | 0 |
| 触摸目标 | 312 处 26.25px、9 处 22.5px | coarse 下 ≥40px |
| 文本对比度 | success 3.66:1 | 全部 ≥4.5:1（正文）/ 3:1（大字与 UI） |
| 减少动效 | 仅覆盖 shimmer | 全部 |
| 测试 | 0 | axe 集成 + token 快照 + 对比度单测 |

### 6.8 规范可执行化（关键）

现状 152 个测试文件中 0 个与设计相关，所以违规不会被拦住。新增三层防线：

1. **ESLint 规则**：禁止 Tailwind 默认彩色类、禁止 `[Npx]`（白名单除外）、禁止非 `ui/` 的 button/card 手写。
2. **Token 快照测试**：`styles.css` 的 OKLCH 值与 `DESIGN.md` frontmatter 逐项比对。
3. **对比度单测**：所有前景/背景 token 组合按 WCAG 公式实算，低于阈值即失败。

---

## 7. 新旧界面差异对比

### 7.1 全局对比

| 维度 | 现状 | 重设计后 |
|---|---|---|
| 页面数 | 51 | ~42 |
| 导航入口覆盖率 | 28/51（55%） | 42/42（100%） |
| 侧栏分组 | 应用 0 组、管理 4 组、设置 0 组 | 统一 4 组 + 收件箱 |
| 侧栏宽度 | 340 / 300 / 300 px | 统一 20rem |
| 全局搜索 | 仅频道名 | 命令面板覆盖全实体 |
| 面包屑 | 0 | 深层页强制 |
| 快捷键 | 1 | 8 |
| "需要你"的表达点 | 5 处各自轮询 | 1 个收件箱 + 1 条状态条，单一来源 |
| Bot 状态来源 | 3 套并行 | 1 个 `useRunPhase()` |
| Toast | 0 | 4 类统一 |
| 加载态 | 大量 `return null` 白屏 | Skeleton 全覆盖 |
| 错误写法 | 5 种 | 2 个组件 |
| PageShell 合规（`_app`） | 58% | ≥90% |
| 设计方言 | 3 套 | 1 套（gallery 保留但守 token） |
| 组件库 | 26 | 38 |
| 硬编码彩色 | 89 处 | 0 |
| `rounded-full` | 72 处 | ~12（豁免清单内） |
| `[Npx]` | 87 处 | 白名单外 0 |
| focus ring 合规 | 76% | 100% |
| ring 对比度 | 1.7:1 | 4.48:1 |
| 字体 | 系统字体（Inter 未生效） | Inter Variable |
| 图表配色 | 6 色 chromatic | 5 阶灰阶 |
| ≤640px 适配 | 仅列数塌缩 | 三档体系布局重排 |
| <40px 按钮（coarse） | 312 处 | 0 |
| 对比度 P0 违规 | 3 | 0 |
| 设计相关测试 | 0 | lint + token 快照 + 对比度 |

### 7.2 三个场景 Before / After

**场景 A · Bot 卡在登录页需要你**

- **Before**：屏幕上一个 7px 琥珀圆点；`useNeedsYou` 3s 轮询；若用户此前关过 Computer 面板，就只剩圆点，没有任何文字说明发生了什么、要做什么。
- **After**：状态条变 warning 底色，文案「需要你：example.com 的登录验证」，右侧主操作按钮「接管」；同时侧栏频道行标记 +1、`/inbox` 新增一条、Workspace 自动展开并聚焦到 Screen。四处表达来自同一 `runPhase`。

**场景 B · 找"哪个同事需要我"**

- **Before**：侧栏 `BotAttentionList` 有计数，但点进去是 `/bots/$agentId` 单个档案；`/agents` 卡片完全没有状态信息；审批在 `/approvals`；接管在频道里。要拼出全貌需访问 4 个地方。
- **After**：`/inbox` 一页列出全部（审批 / 提问 / 接管），按紧急度排序，支持批量决策；`/coworkers` 卡片直接显示状态点与待办数。

**场景 C · 在手机上看审计日志**

- **Before**：`admin/audit` 6 列全显 + `whitespace-nowrap` + `w-[22rem]` 固定列，375px 视口需横滚约 2.5 屏；按钮 26.25px。
- **After**：转卡片列表（每条一张 Item，关键字段 3 行，次要字段折叠）；按钮在 coarse 指针下 ≥40px。

---

## 8. 分阶段落地实施计划

原则：**先止血、再打地基、后做 IA 与页面**。视觉规范的修正（Phase 0–1）必须早于页面重做（Phase 3），否则新页面会继续复制旧问题。

### Phase 0 · 止血（3–5 天）

**目标**：修掉改 1 行就能生效、但影响全站的问题。

| # | 任务 | 文件 |
|---|---|---|
| 0.1 | `font-family: Inter` → `Inter Variable` | `styles.css:105` |
| 0.2 | `--ring` light → `oklch(0.556 0 0)`；`ring-ring/50` → `ring-ring` | `styles.css:41` + 全站用法 |
| 0.3 | `--success` light → `oklch(0.52 0.118 184.704)` | `styles.css:38` |
| 0.4 | 补 `--destructive-foreground`（`:root` / `.dark` / `@theme`） | `styles.css` |
| 0.5 | 删除死常量 `SCREEN_PANEL_WIDTH`、死变量 `--sidebar-width-mobile`、未使用依赖 `recharts` | `$channelId.tsx`、`sidebar-shell.tsx:55`、`package.json` |
| 0.6 | 15 个图标按钮补 `aria-label`（走 i18n）；`ui/dialog.tsx:110` 硬编码 "Close" 改 i18n | 见 §1.4 清单 |

**验收**：正文渲染 Inter Variable；浅色模式焦点环清晰可见；`text-success` 达 AA；axe 扫描无 P0。

**风险**：0.2 会改变全站焦点观感，需一次完整视觉走查。

---

### Phase 1 · 地基：规范可执行化（2 周）

**目标**：让规范从"文档里的一句话"变成"会被 lint 和测试拦住的规则"。

| # | 任务 |
|---|---|
| 1.1 | Token 修订：新增 `--warning` / `--info` / `--destructive-foreground`；删除未定义的 `radius-3xl/4xl`；`--chart-1…5` 接入 |
| 1.2 | 收编 89 处硬编码彩色 → 语义 token（重灾 `routines-list.tsx` 16、`gallery/frame.tsx` 12、`admin/audit.tsx` 8） |
| 1.3 | 图表配色回归灰阶：`gallery/palette.ts` 替换 chromatic 6 色盘 |
| 1.4 | focus ring 统一为 `ring-3 ring-ring + border-ring`，删除 `ring-2` / `ring-[3px]` / `outline-*` / `ring-0` 变体 |
| 1.5 | 补齐 8 个高频缺口组件：`badge` `tabs` `table` `toast` `breadcrumb` `progress` `status-dot` `alert` |
| 1.6 | 重写 `components/market/wb.tsx`：16 个 `Wb*` 组件改用 `ui/*`（删除 rgba 阴影、48px 图标槽、第二套 Button） |
| 1.7 | 消灭 `rounded-full` 违规（约 60 处），建立豁免清单 |
| 1.8 | `[Npx]` → rem（白名单：vw/vh/dvh、1px 边框） |
| 1.9 | **三层防线落地**：ESLint 彩色/px 规则 + token 快照测试 + 对比度单测 |
| 1.10 | 引入 Toast 并替换现有内联反馈（先从写操作密集的 `admin/*` 开始） |

**验收**：ESLint 0 违规；token 快照测试通过；对比度单测全绿；market 页与 admin 页视觉语言一致（截图对比）。

**风险**：1.6 是最大的单点工作量；建议与 `/coworkers` 合并（Phase 2）并行，避免 market 改造做完又被 IA 重构推翻。**建议把 1.6 挪到 Phase 2 与 market 拆分一起做。**

---

### Phase 2 · 导航与信息架构（2–3 周）

**目标**：51 页 → 42 页，全部有入口，全局可达。

| # | 任务 |
|---|---|
| 2.1 | 应用侧栏分组重构：4 组（需要你 / 频道 / 同事 / 能力 / 我的）+ 分组折叠；宽度统一 `SIDEBAR_WIDTH` |
| 2.2 | 合并 `/bots` + `/agents` + `/team-bots` → `/coworkers`（三 Tab）；`/coworkers/$agentId` 档案页 |
| 2.3 | 新增 `/inbox`（收件箱），取代 `/approvals`；`/approvals` 规则部分移到 `/settings/approvals` |
| 2.4 | `/market` 拆分回收：experts → `/coworkers?tab=discover`；skills → `/skills?tab=market`；connectors → `/settings/connected-accounts` |
| 2.5 | **market 方言重写**（从 Phase 1 挪来，与 2.4 合并做） |
| 2.6 | 命令面板 `⌘K`：覆盖 42 页 + 频道 + Bot + 技能 + 设置项；`>` 前缀执行命令 |
| 2.7 | 面包屑：所有 ≥2 层深页面强制挂载；`PageShell` 增加 `breadcrumb` prop |
| 2.8 | 快捷键扩展至 8 个 + `/settings` 快捷键面板同步 |
| 2.9 | `/routines` 并入 `/responsibilities?tab=routines`；下线 `/bot`、`/tenant/channels` |
| 2.10 | 术语收敛：Bot/Agent/Coworker/专家 → 同事；i18n key 重映射（修中文包遗留英文） |
| 2.11 | `/admin/enterprise` 加入管理侧栏 |

**验收**：42 页全部可从导航或命令面板到达（自动化检查：遍历路由树，确认每个路由有入链或面板索引）；4 层深页面有面包屑；`/coworkers` 三 Tab 视觉与功能验收。

**风险**：2.2 与 2.3 涉及数据层复用（现状三个列表共用 `agentListQueryOptions()`，合并成本低）；2.6 依赖服务端搜索接口，接口未就绪时先做本地索引，不阻塞。

---

### Phase 3 · 核心页面重做（4–5 周）

**目标**：解决 P0 状态表达问题，重做会话页与收件箱。

| # | 任务 | 周 |
|---|---|---|
| 3.1 | 统一状态机 `useRunPhase()`（7 态），取代 `isRunning` / `turnsInFlight` / `runsInFlight` | 1 |
| 3.2 | `ChannelStatusBar` 组件：7 态 + 主操作 + 进度摘要 | 1 |
| 3.3 | `WorkspacePanel`：Screen 常驻顶部 + Files/Activity/Process Tab 并存（取代三态互斥 DetailPanel） | 1–2 |
| 3.4 | 消灭三处独立轮询：`useNeedsYou`(3s) / `HandoffResumeNotice`(1s) / `useComputerControl` 统一订阅 `runPhase` | 2 |
| 3.5 | `Composer` 拆分（82KB → 6 子模块 + 容器） | 2–3 |
| 3.6 | `/coworkers` 卡片补齐状态/待办/末次活动；加筛选、排序、批量操作 | 3 |
| 3.7 | `/inbox` per-item pending + 批量决策 + Bot 名称显示（不再是 id） | 3 |
| 3.8 | `PolicyPreview` 抽象（复用 boundaries dry-run）→ `/settings/approvals`、`/admin/plugins/$key` | 3–4 |
| 3.9 | 加载态：`return null` → `Skeleton` 全覆盖 | 4 |
| 3.10 | 错误处理收敛到 `ErrorInline` / `ErrorState`，全部带可执行的下一步 | 4 |
| 3.11 | `_app` 下剩余未用 `PageShell` 的页面补 `scroll-area`（`agents`→`coworkers`、`index`、`market`→已拆） | 4–5 |

**验收**：`runPhase` 是 Bot 状态的唯一来源（代码审查确认无组件单独轮询）；StatusBar 在 7 态下文案与操作正确；"等待接管"在关闭工作区后仍可见；Composer 6 个子模块可独立单测。

**风险**：3.1 是全项目最大的重构，涉及 `channel-chat.tsx`(45KB)。建议先建 `runPhase` 适配层，让新旧状态并存一个迭代，逐步切换，不要一次性替换。

---

### Phase 4 · 响应式与无障碍（2 周）

**目标**：从 mobile-tolerant 到 mobile-designed。

| # | 任务 |
|---|---|
| 4.1 | 三档断点体系落地；新增 `2xl`（列表+详情并排） |
| 4.2 | `@media (pointer: coarse)` 控件放大：sm → 2.75rem，禁用 xs 级按钮 |
| 4.3 | `admin/audit` 表格：<768 卡片列表、768–1279 列隐藏、≥1280 全列；禁止长文本 `whitespace-nowrap` |
| 4.4 | 移动端底部 Tab Bar（会话 / 同事 / 收件箱 / 我的） |
| 4.5 | 会话页 Compact 档：Workspace 全屏 Drawer、StatusBar 紧凑单行 |
| 4.6 | 全站 axe 审计 + 键盘走查（42 页）+ 屏幕阅读器抽查 |
| 4.7 | `prefers-reduced-motion` 覆盖全部新增动效 |

**验收**：375 / 768 / 1280 三档逐页走查通过；axe 0 P0 / 0 P1；键盘可完成核心流程（发起会话 → 接管 → 审批）。

---

### Phase 5 · 固化（持续）

| # | 任务 |
|---|---|
| 5.1 | 视觉回归测试（Storybook + Chromatic 或等效） |
| 5.2 | 更新 `app/DESIGN.md`：把本方案的修正写入规范（含豁免清单、禁用清单、新增 token） |
| 5.3 | 建立设计 QA 清单（新页面上线前 12 项检查） |
| 5.4 | 度量看板：导航覆盖率、PageShell 合规率、lint 违规数、对比度失败数 |

---

## 9. 度量与验收

| 指标 | 现状 | 目标 | 达成阶段 |
|---|---|---|---|
| 导航入口覆盖率 | 55% | 100% | Phase 2 |
| 命令面板覆盖实体 | 0 | 42 页 + 频道/Bot/技能 | Phase 2 |
| Bot 状态数据源 | 3 套 | 1 套 | Phase 3 |
| "等待接管"可见性（关闭工作区后） | 无 | 常驻状态条 | Phase 3 |
| PageShell 合规（`_app`） | 58% | ≥90% | Phase 3 |
| 设计方言数 | 3 | 1 | Phase 2 |
| 组件库 | 26 | 38 | Phase 1 |
| 硬编码彩色 | 89 | 0 | Phase 1 |
| focus ring 合规率 | 76% | 100% | Phase 1 |
| 对比度 P0 违规 | 3 | 0 | Phase 0 |
| 字体正确性 | ❌ | ✅ | Phase 0 |
| 图表灰阶 | ❌ | ✅ | Phase 1 |
| `<40px` 按钮（coarse） | 312 | 0 | Phase 4 |
| 移动端布局重排 | ❌ | 三档 | Phase 4 |
| 设计相关测试 | 0 | lint + 快照 + 对比度 | Phase 1 |

---

## 10. 风险与开放问题

| # | 风险 | 缓解 |
|---|---|---|
| R1 | `runPhase` 重构（3.1）涉及 45KB 核心文件，回归面大 | 建适配层，新旧状态并存一个迭代；优先保证 `waiting_for_you` 一态先切 |
| R2 | `/coworkers` 合并会改变用户肌肉记忆 | 旧路由 301 重定向保留一个版本；侧栏提供一次性的"入口已合并"提示 |
| R3 | 命令面板依赖服务端搜索接口 | 先做本地索引，接口就绪后增量接入，不阻塞 Phase 2 |
| R4 | market 方言重写量大（368 行 + 5 引用文件） | 与 Phase 2 的 market 拆分合并做一次，避免重复改造 |
| R5 | 15px 根字号与 40px 触摸目标存在张力 | 用 `pointer: coarse` 分离，桌面保持密度、移动端保证可用，不做全局妥协 |
| R6 | 视觉规范修正会改变全站观感 | Phase 0/1 结束后做一次完整视觉走查再进入 Phase 2 |

**开放问题（需要产品决策）**

1. `/market` 是否长期保留为独立入口？本方案建议拆分回收，但若市场是未来商业化重点，应保留并单独规范化（而非拆散）。
2. `/admin/components` 与 `/settings/components-gallery` 互为镜像，是否合并为一个页面 + 权限视图？
3. 是否需要在 Compact 档支持"语音优先"的会话模式（现状已有 `voice-call-widget`）？这会显著改变移动端信息架构。
4. 术语统一为"同事"后，是否需要同步改 API / 数据库字段名，还是仅 UI 层改名？

---

## 附：本方案依据的关键文件

| 文件 | 用途 |
|---|---|
| `app/DESIGN.md` | 现有设计规范（保留并修订） |
| `app/src/styles.css` | 全站唯一 token 源（292 行） |
| `app/src/components/layout/page-shell.tsx` | 布局契约（219 行，注释完整） |
| `app/src/routes/_authed/_app/channel/$channelId.tsx` | 核心会话页（284 行） |
| `app/src/components/channels/composer/composer.tsx` | 巨型组件（82KB） |
| `app/src/components/market/wb.tsx` | 平行设计系统（368 行） |
| `app/src/components/gallery/palette.ts` | 违规图表配色 |
| `app/src/components/app-sidebar/app-sidebar.tsx` | 导航现状（639 行） |
| `app/src/routes/_authed/admin/boundaries.tsx` | dry-run 范式（应推广） |
