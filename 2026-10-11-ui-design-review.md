# OpenBot Web 应用 UI 设计系统评审报告（终版）

- **评审日期**：2026-10-11
- **评审对象**：`app/`（React + TanStack Router + Tailwind v4 + Base UI/shadcn）
- **设计资产**：令牌表 `app/src/styles.css`（:root 浅色 + .dark 深色）；规范 `app/DESIGN.md`
- **覆盖方式**：7 维度专项调查（色彩 / 字体间距 / 组件一致性 / 信息架构 / 视觉层次 / 无障碍响应式 / 令牌收敛），对比度全部经 WCAG 公式精确计算，非估算
- **总体判断**：这是一个纪律性显著高于平均水准的设计系统——令牌体系完备、组件代码色彩硬编码旁路为 0、4px 网格零违例、focus 契约全原语一致、reduced-motion 覆盖 15 个文件。问题集中在三类：**静默失效的拼写错误、规范与代码的漂移、无障碍反馈覆盖的局部缺口**。

---

## 一、问题汇总表

### 高优先级（10 项）

| # | 维度 | 问题位置 | 影响 |
|---|------|---------|------|
| H1 | 排版 | `app/src/components/app-sidebar/app-sidebar.tsx:373,394,414,629` | `trackint-tight` 拼写错误 ×4，类不存在，letter-spacing 静默失效；证明 lint/review 未拦截此类问题 |
| H2 | 色彩 | `ui/checkbox.tsx:15`、`ui/switch.tsx` ON 态 | 白 glyph on #00c29a = **2.29:1，WCAG AA 违规**；黑 glyph 同底 = 7.84:1（现成解法） |
| H3 | 排版 | 11 个文件 15 处 px 硬编码字号（`text-[11px]`×13、`[10px]`×2 等） | 违反 rem 纪律；`text-[11px]` 与 Label 档 text-xs（11.25px）仅差 0.25px，纯浪费 |
| H4 | 信息架构 | `app-sidebar.tsx:334-560` | 11 个一级入口零分组平铺；admin 侧边栏自己有 4 组标签并写明扁平化的危害——双标 |
| H5 | 信息架构 | `routes/_authed/_app/bots.index.tsx:41`、`agents/index.tsx:94-103` | Bots 空状态是死胡同；「新建 Agent」埋在另一页面 section 标题行右侧的 ghost sm 按钮 |
| H6 | 信息架构 | `locales/zh-CN/nav.json`、market 页 | 同一实体三个名字：Bot / Agent / 专家（experts），中文用户概念混乱 |
| H7 | 无障碍 | `app-sidebar.tsx:275-290` | 新建频道「+」主入口 icon 按钮无 aria-label（相邻群组按钮有）——全项目唯一确认漏网的主操作 icon 按钮 |
| H8 | 无障碍 | `components/computer/computer-view.tsx:592-730` | 自绘全屏 dialog（portal + role="dialog"）无 focus trap、无初始焦点、无焦点返回；全项目唯一不用 Base UI Dialog 的模态 |
| H9 | 无障碍 | `admin/audit.tsx:120`、`settings/invoices.tsx:246`、`billing/consumption-table.tsx:64` | 业务表格 overflow-x-auto 容器无 tabIndex={0}+aria-label 键盘滚动兜底（gallery/table.tsx 已有正确示范未反哺）；audit 是合规页面，键盘用户够不到右侧列 |
| H10 | 无障碍 | `components/channels/chat-transcript.tsx:1637-1684` | parked 队列/Stopped 块 DOM 顺序在对话之前（order 仅移动 paint）：Tab 先到队列再进对话（WCAG 2.4.3），SR 线性阅读先听队尾（1.3.2）。代码注释自认「KNOWN, UNPAID DEBT」 |

### 中优先级（14 项）

| # | 维度 | 问题位置 | 影响 |
|---|------|---------|------|
| M1 | 视觉层次 | 13 处路由 `isPending ? null`（admin 全域 + settings/passwords、connected-accounts、components-gallery、tenant/channels） | 加载白屏；Skeleton 仅 10 文件在用，settings/invoices 已有表格骨架先例可复制 |
| M2 | 组件 | `market/wb.tsx`（整套平行按钮体系 WbPrimaryButton 等 6 处 + hover opacity-85 非 80% + 无 ring-3）；`workshop-schedules.tsx:261-313`（5 input+1 select 手绘）；`computer-view.tsx:542,553`；`approvals/inbox.tsx:555`；市场搜索框 ×2 | 绕开 ui/Button/Input 契约（DESIGN.md「不许手绘」禁令）；约 30 处原生 button 待收敛（gallery/* 为 SDK 宿主可豁免） |
| M3 | 组件 | `audit.tsx:121`、`invoices.tsx:247`、`consumption-table.tsx:65` vs `knowledge.$kbId.tsx:511-527` | 表格两种配方漂移；表头 `text-xs uppercase` 直接违反 DESIGN.md「无字距大写层」禁令 |
| M4 | 色彩 | `styles.css` chart-3/4/5 = 2.44/2.18/3.16:1（白底） | 图表色低于数据可视化 3:1 底线（chart-1 teal 2.29:1 同样不达标） |
| M5 | 令牌 | `market/experts-pane.tsx:62`、`market/wb.tsx:28,30` | `shadow-[0_4px_12px_rgba(0,0,0,0.03)]` 是 `--shadow-card` 等值物旁路 ×2 + hover 变体 1 |
| M6 | 规范漂移 | `sidebar-shell.tsx` vs `DESIGN.md` | 实际 app 340px / admin·settings 300px，规范写 264px；`--sidebar-width-mobile` 设而未读（注释自认） |
| M7 | 无障碍 | `channel-item-content.tsx:52-55` + `channel.tsx` | 未读态 teal 点 + 弱字重差异，无 sr-only 文本——色弱用户难辨、SR 用户完全听不出「未读」；pinned 有图标冗余（做法正确可对照） |
| M8 | 无障碍 | `routes/_authed/_app.tsx` | 无 skip-to-content；侧边栏 roster 最多 60 链接在 main 之前，键盘用户每次跨页都要穿过 |
| M9 | 信息架构 | 侧边栏 Approvals；activity 三处；新建动线 | 无 pending 徽章（等待审批可能被埋）；「Bot 做了什么」分散 transcript/BotProfile/职责 runs 三处；四种「新建」形态（路由/Dialog/侧滑/Dialog）并存 |
| M10 | 排版 | `styles.css:126` | 字体栈无中文声明，而 zh-CN 是完整一等公民（15 文件）；Windows 回落雅黑时「层级靠字重 600/500/400」策略失真 |
| M11 | 组件 | 错误呈现 3 种样式（`mt-4 text-destructive text-sm` 主流 15+ 处 / 裸 `text-destructive` / computers.tsx 卡片式独一份） | 「无 toast」是明确设计决策（channel.tsx:81 注释）——决策本身可保留，但 inline 样式应统一为一种 |
| M12 | 无障碍 | `ui/sheet.tsx:55`、`ui/dialog.tsx:83` | 模态进出 translate 动画无 motion-reduce 处理（前庭障碍）；sidebar 宽度过渡、qr-code Skeleton 同类遗漏 |
| M13 | 无障碍 | `voice-call-widget.tsx`（无 Escape）；`workshop-panel.tsx:62-84`（tablist 无方向键） | 键盘操作多一步；WAI-ARIA tabs pattern 建议 Left/Right |
| M14 | 组件 | `memory.tsx:90-95`、`responsibilities.tsx:65` 无空态；role="alert" 渲染 lib 层英文 fallback（中文用户出错时看到英文） | 空态缺失 + 错误文案 i18n 断层 |

### 低优先级（6 项）

| # | 维度 | 问题位置 | 影响 |
|---|------|---------|------|
| L1 | 排版 | letterspaced caps 6 处（`agent-profile.tsx:99`、`handoff-panel.tsx:72`、`callback-token-panel.tsx:41`、`agent-dialog.tsx:694`、`gallery/preview.tsx:96`、`_app/index.tsx:52`） | 违反 DESIGN.md 禁令（与 M3 表头 uppercase 同源） |
| L2 | 响应式 | xs 按钮 13 处（22.5px < 24px AA 线）、sm 329 处（26.25px < 44px） | 桌面控制台的自觉取舍；移动端 composer 发送钮实测偏小（voice-call 的 60px 圆钮是正确对照） |
| L3 | 信息架构 | `onboarding.tsx:183` | 步数不持久（注释自认 wizard 设计期故意），刷新回第 1 步 |
| L4 | 视觉层次 | 三壳切换 | 侧边栏 340→300px 宽度跳变 40px（回主动线 back 链接已对齐，问题小） |
| L5 | 信息架构 | `bot-profile/activity.tsx:73` | routines 迁移未收尾：routine 活动仍链到 /routines 独立页而非 Bot 自己的 dialog |
| L6 | 无障碍 | `wb.tsx` 焦点环不一致、`consumption-table` 窄屏 hidden 丢列、`workshop-turn.tsx:82` 连接状态仅颜色点（有 aria-label 缓解） | 零散打磨项 |

---

## 二、分维度要点

### 1. 视觉层次与排版
PageShell → PageSection(mt-12) → PageRows(mt-4) 布局契约在全部代表页面健康运转；4px 网格整步:半步 = 1505:224，奇数 px 任意值 0。缺口是 M1 白屏（13 处）与 M6 规范漂移。detail-panel.tsx 的 ResizeObserver 窄屏退化（并列面板→覆盖 Sheet）是优雅的响应式设计，值得推广。

### 2. 色彩体系与对比度（精确计算）
| 组合 | 对比度 | 判定 |
|---|---|---|
| #b42c3f on /10 tint | 5.33:1 | ✅ |
| #0a7d47 on /10 tint | 4.53:1 | ✅ 压线 |
| #5c5c5c on #f7f7f7/#fff/#f2f2f2 | 6.24/6.69/5.97:1 | ✅ |
| dark 全组合（muted/destructive/success/brand） | 4.86–9.26:1 | ✅ 全过 |
| **#fff glyph on #00c29a（checkbox/switch ON）** | **2.29:1** | ❌ H2 |
| #171717 on #00c29a | 7.84:1 | ✅ 修复方案 |
| chart-1 teal / 3 绿 / 4 橙 on white | 2.29/2.44/2.18:1 | ❌ <3:1（M4） |
| chart-2 蓝 / 5 紫 on white | 3.34/3.16:1 | ⚠️ 压线 |

色彩纪律：全 app 组件代码 hex 旁路为 **0**（仅品牌 logo、settings 背景插画、gallery 调色板三处正当用途）；三层色规则（黑交互/teal 品牌/语义色）执行到位，teal 大面积违规 0 处。

### 3. 字体与间距
H1 拼写错误、H3 px 字号、M10 中文字体栈、L1 caps 是四个动作点；间距体系通过、字重全部走 600/500/400 标准刻度、行高任意值仅 1 处（wb.tsx:72 有理由）。

### 4. 组件一致性与状态覆盖
强项：弹窗 26 文件全部统一 ui/dialog、`window.confirm/alert` 全项目 0 处、destructive 变体 21/21 处均为真危险操作、主表单 pending 纪律好（9 处完整禁用+文案切换）、空状态覆盖广（PageEmpty 17+ 处 / Empty 组件）。
债务：M2 手绘集群（wb.tsx 平行体系是最大单点）、M3 表格漂移、M11 错误样式三样、`variant="link"` 全项目 0 使用而 6+ 处手绘 underline 按钮（反向收敛点）。

### 5. 信息架构与用户操作路径
审批双入口（聊天 inline + /approvals 页）同源同步设计是亮点；onboarding gate 位置正确（_authed beforeLoad）；「登录→首条对话」2 次交互即达。缺口：H4 分组、H5 死胡同、H6 术语、M9 徽章/分散/新建形态。数据侧 memory/responsibilities/reachability 全部 owner-scoped，角色隔离干净。

### 6. 功能布局与角色适配
普通用户 11 入口无角色过滤（唯一角色逻辑是 footer Admin 入口）；「治理」类入口（Reachability/Responsibilities）命名晦涩依赖点入后 description 补课。建议对非 admin 折叠治理组、统一「新建」为 PageShell action + Dialog 模式。

### 7. 无障碍与响应式
**总体是 a11y 意识显著高于平均的代码库**：role="alert" 185 处、role="status" 35 处、img alt 覆盖 100%、抽查 5 页标题层级无跳级、focus 契约 17 个 ui 文件一致、useReducedMotion 15 文件、聊天新消息经 MessageScroller role="log" 自动 polite 播报（很多聊天应用做不到）、details/summary 原生手风琴、hotkeys 正确跳过可编辑目标。
缺口集中在：H7-H10 四项高优先级 + M7/M8/M12/M13。断点分布 sm 47 / md 25 / lg 10 / xl 9；<768px 侧边栏整体变 Sheet（带 sr-only 标题）是正确的移动端策略。

---

## 三、设计令牌统一方案

**原则：shadcn 契约命名不动，只做「收敛旁路 + 补语义别名」。**

| 重复/旁路值现状 | 收敛到 | 位置 |
|---|---|---|
| `shadow-[0_4px_12px_rgba(0,0,0,0.03)]` ×2 | `shadow-card`（已有） | experts-pane.tsx:62、wb.tsx:28 |
| `shadow-[0_8px_24px_rgba(0,0,0,0.08)]` | 新增 `--shadow-card-hover` | wb.tsx:30 |
| `text-[11px]` ×13、`[10px]` ×2 | `text-xs` | H3 清单 |
| `text-[12px]/[14px]` ×3 | `text-xs` / `text-sm` | share.$token 等 |
| `text-[1.333rem]` ×1 | `--text-display`（@theme 映射 `text-display`） | page-shell.tsx:126 |
| ON 态白 glyph `--primary-foreground` | 新增 `--brand-foreground: var(--foreground)` | checkbox/switch（修 H2） |
| 手绘表头配方 ×3 + 表头 uppercase | `DataTable` 组件固化：`text-xs text-muted-foreground font-medium` 无 caps | audit/invoices/consumption |
| 侧边栏 340/300 散在 JSX | `--sidebar-width-app` / `--sidebar-width-nav`；同步修订 DESIGN.md | sidebar-shell 调用处 |
| 字体栈 | 追加 `"PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei"` | styles.css:126（M10） |

**命名组织**：维持 `--{role}` / `--{role}-foreground` 双层；新令牌只取语义名。CI 加三条 grep 守卫：`shadow-\[`（白名单 sidebar.tsx 的 border-as-shadow）、`text-\[[0-9]+px\]`、`trackint`。

---

## 四、修复路线图

**第 0 批 · 今日 15 分钟（3 个高优先级即时消除）**
1. `trackint-tight` → `tracking-tight`（4 处替换）
2. checkbox/switch ON 态 `text-primary-foreground` → `text-foreground`（2 文件各 1 行，2.29→7.84:1）
3. app-sidebar「+」补 `aria-label={t("newConversation")}`（nav.json 已有该词条）

**第 1 批 · 规范化（1-2 天）**
- px 字号 15 处收敛 → admin 13 页白屏换 PageRowsSkeleton → 表格 tabIndex={0}+aria-label 兜底（照抄 gallery/table.tsx）→ 未读点补 sr-only → DataTable 抽取（去 uppercase）

**第 2 批 · 信息架构（2-3 天）**
- 侧边栏两组分组（复用 admin-sidebar GROUPS 模式）→ Bots 空状态 CTA + Agents 新建提为主 action → 术语统一「智能体（Agent）」→ Approvals pending 徽章 → computer-view 自绘 dialog 迁移到 Base UI Dialog

**第 3 批 · 打磨**
- 图表色加深复验 ≥3:1 → 中文字体栈 → sheet/dialog motion-reduce → skip-to-content → 错误样式统一 + 英文 fallback i18n → parked 队列 DOM 顺序（需与上游 @shadcn/react 协调，先挂 issue）

---

## 五、方法论附注

- 覆盖：app/src 全量（282 tsx + styles.css + DESIGN.md + locales）逐维度扫描；对比度 WCAG 相对亮度公式精确计算
- 已知局限：逐页键盘走查未全量执行（键盘/SR 结论基于原语层契约 + 代码级检查）；运行时渲染验证需 dev server 起服后补充
- 术语约定：本报告中「文件:行号」均相对 `app/src/`
