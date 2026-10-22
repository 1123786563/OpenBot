# H09 (#452) — 登录、工作台导航和窄屏侧栏迁移报告

状态：implemented（workspace 增量，无 commit）；BASE `203d0f0244b2`，分支 `feat/heroui-v3-migration`。
工作区：`/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`。
检查点产物：`POST-CHECKPOINT.sha256`（本域 5 个改动文件的终态指纹）；全量 app native 证据 `native/report.json` + `native/results/`。

## 域起点事实（决定本轮 delta 形态）

本域组件与路由在 BASE（即 H02–H03 波次之后的工作树）已直接消费冻结的 `@/components/ui/*` HeroUI v3 适配层：全域 grep `@base-ui`/`radix`/`useRender` 0 命中；无裸表单控件；无 `bg-muted` 遗留 token（本域 4 个文件已随早期波次完成 token 更名与 ButtonLink 迁移，见变更清单）。`ui/sheet.tsx`（→ HeroUI Drawer）与 `ui/sidebar.tsx`（本地 renderSlot 去 Base-UI 化）已随 H02 迁移并冻结，`h09/controls.md` 是其交付记录；本轮只消费。

因此本轮 H09 是**验证 + 单点修正**：唯一新红是 driven 层 `multitenancy/selection.test.tsx` 8 条失败，单变量归因为 HeroUI Select.Trigger 丢弃 wrapper 转发的 `role="combobox"`（h04 已记录的同款 Interface 变更申请），按 h04 既有模式修正测试查询后 25/25 绿。组件源码零改动需求。

## 变更清单

| 文件 | 变更 | 要点 |
| --- | --- | --- |
| `app/tests/multitenancy/selection.test.tsx` | **本轮修正** | 20 处单行触发器查询替换（W3B F4 修正口径：21 系 diff 删除行数，其中 1 行为旧 import）`getByRole/findByRole/queryByRole("combobox", { name })` → `role: "button"` + 同一可访问名（aria-label 仍在路由组件上，查询特异性不变），附 why-comment 指向 Interface 变更申请（wrapper 转发的 role 在 DOM 中不存在，若 wrapper 恢复属性可回到 role 查询）。另按 biome `organize-imports` 整理 import 块（机械，无行为）。全部 25 条断言语义保留：五态状态机、深链接、撤销不复位、URL/storage/generation 三写、zh/en 双 bundle。 |
| `app/src/components/app-sidebar/app-sidebar.tsx` | 早期波次已改，本轮验证 | `Button render={<Link/>}` → `ButtonLink to="/channel/new"`（真实 `<a>`，不再把 role=button 放上 anchor；`ui/router-link.tsx:19-23` 明文禁令）。登出、admin 入口 role 门控、activeProps 选中态零改动。 |
| `app/src/components/layout/page-shell.tsx` | 早期波次已改，本轮验证 | backButton `Button render` → `ButtonLink`；`PageShell/PageSection/PageRows/PageEmpty` 导出面与 props 零改动；滚动容器 `min-h-0 flex-1 overflow-y-auto`（`:110`）原样。 |
| `app/src/components/layout/row-mark.tsx` | 早期波次已改，本轮验证 | `bg-muted/60` → `bg-ob-muted-surface/60`（全仓 token 更名面）。 |
| `app/src/components/layout/self-host-banner.tsx` | 早期波次已改，本轮验证 | 同 token 更名一处。 |

不改动（越权清单均未触碰）：`ui/*`（含 sheet/sidebar）、`package.json`/`bun.lock`、`main.tsx`/`__root.tsx`、`styles/*`、`lib/theme.ts`、`lib/auth/*`（零 diff）、`tests/preload.ts`、`tests/theme-preference.test.ts`；agents/bots/skills/knowledge/bot-profile/responsibilities/routines 域（H06 并行中）未进入；settings/admin 页面域（H04/H05/H08 冻结）未进入。

## AC 状态（h09.md AC1–AC5，组件/单元级；浏览器级缺口如实标注）

### AC1 登录、退出、引导、请求登录与公司/团队选择统一控件，深链接与守卫保留 — PASS

- 统一控件：sign 走 `ui/Button`+`ui/Input`+`ui/Separator`+`ProviderLogo`（`sign.tsx:134-153,217-247`）；onboarding 走 `ui/Button`（`onboarding.tsx:247-276`）；sign-in/$requestId 走 `PageShell`+passwords 域 `SignInForm`（`$requestId.tsx:24-33`）；tenant selection/channels 走 `PageShell`+`ui/Select`+`ui/Item`（`selection.tsx:249-307`、`channels.tsx:95-117`）。
- 深链接：`_authed.tsx` 无登录 → `/sign`（`:11-13`）、未 onboarding → `/onboarding`（`:19-21`，对 admin/settings 同一门）；`admin/route.tsx:11-17` 非 admin → `/`；`sign.tsx:29-42` 已登录 → `/` 且预取 providers；selection/channels 的 `validateSearch` 把 selection 放 URL（`selection.tsx:63-71`、`channels.tsx:58-68`）。以上 beforeLoad 与 BASE 逐字节一致（这些文件 git diff 为空）。
- 认证/授权算法零改动：`lib/auth/*` 不在本轮 diff；signOut 仍 `signOutMutationOptions` + 导航 `/sign`（`app-sidebar.tsx:243-246`）。
- 证据：selection.test 25/25（含 deep-link eligible/revoked 两条）、sign-in-card 3/3、router.test 路由合同（h05 轮 6/6，本轮未触碰其文件）。

### AC2 侧栏折叠偏好、快捷键、选中态、返回导航；真实 anchor 新标签页 — PASS

- 偏好：`SidebarShell` 首绘前读 localStorage（`sidebar-shell.tsx:31-33`）、effect 持久化 `expanded/collapsed`（`:35-39`）；`lib/sidebar.ts` 零 diff。sidebar-preference 4/4。
- 快捷键：⌘/Ctrl+B 经 RAC `keyOf`（ui/sidebar 冻结面），开关控件 `SidebarToggle`（`sidebar-toggle.tsx:72-106`）；app 级 new-chat hotkey 挂在 `_authed`（`_authed.tsx:27`，`app-hotkeys.tsx:16-20`）。sidebar-shortcut-layouts 3/3、live-screen-app-shortcuts 绿（driven）。
- 选中态/返回导航：activeProps 选中洗色（`app-sidebar.tsx:265-267,356,376,399`；两 sidebar 的 `bg-sidebar-accent` 行）；PageShell backButton → ButtonLink（`page-shell.tsx:84-88`）。
- 真实 anchor：ButtonLink 渲染真 `<a>`/`<Link>`（`ui/router-link.tsx:60-79`），中键/修饰键新标签页行为归浏览器；侧栏行经 `SidebarMenuButton render={(props) => <Link/>}` 保持锚元素（ui/sidebar renderSlot 双形式合同，BASE 同构）。

### AC3 窄屏 Drawer 打开/ESC/外部关闭/焦点返回正确；body 滚动锁不残留 — PASS（组件级；浏览器级归 H15）

- 消费而非绕过：移动侧栏 = ui/sidebar 的 Sheet 分支 → ui/sheet = HeroUI Drawer 包装，弹层 ESC/外点/焦点由 `dialog.tsx` 守卫 v3 承担（`ui/sheet.tsx:17` 注释即映射表）；本域无任何直接 portal/监听代码。`max-w-none` 修 320px 裁剪（controls.md）；所需 `drawer.css` 已在 `app/src/styles.css:53`。
- 组件级证据：sidebar-shortcut-layouts（含 mobile 分支 `isMobile ? openMobile : open`，`sidebar-toggle.tsx:36`）3/3；detail-panel.test 2/2（Sheet 分支按名开合、关闭即卸载）。
- 浏览器级缺口（滚动锁释放、真实布局焦点陷阱、portal/z-index）：controls.md「Gaps」原样转 H15，本轮无可运行环境，不虚报。

### AC4 PageShell/PageRows/DetailPanel 布局 Interface 不变；短视口可滚动；详情面板非模态 — PASS

- Interface：`page-shell.tsx` 四导出 props 与 BASE 一致（diff 仅 Button→ButtonLink）；`detail-panel.tsx` 零 diff（`open/onClose/title/detail/detailWidth/children`）。
- 短视口滚动：PageShell 自带滚动容器 `min-h-0 flex-1 overflow-y-auto`（`page-shell.tsx:110`，`min-h-0` 为承重注释 `:101-105`）；settings/admin 文档流滚动，`_app` 面板内滚动（`_app.tsx:17-24`）。
- 非模态：DetailPanel 宽屏分支为内联 motion 面板（`detail-panel.tsx:89-146`），窄屏分支 Sheet 与 BASE 同构（ui/sheet `modal` 参数无调用点传过，controls.md 记录），未被误改成模态对话框。

### AC5 亮暗/中英/320px/200% 关键动作可见；根级 drop 防导航不回退 — PASS（可测面）

- 亮暗：theme-preference 8/8（冻结文件，含 setRootTheme/boot 断言）；本域全部语义 token，无硬编码色。
- 中英：selection.test 同文件断言 en/zh 双 bundle 通过；nav 域键位（hideSidebar/showSidebar/skipToContent 等 11 键）两 bundle 抽查在位；`__root.tsx` I18nProvider 传 `i18n.resolvedLanguage`（H02 交付，未触碰）。
- 320px/200%：组件级可控面（语义 token、`min()`/`max-w-none`、触达目标尺寸）无回归；真实渲染扫（zoom/视口）归 H15（controls.md Gaps 已记）。
- 根级 drop 防导航：`__root.tsx:124` `useUnclaimedDropGuard()` 仍为首行挂载，dragover+drop 双监听（`:131-141`）未动、未搬移；root-drop-guard.test 3/3（driven）。onboarding 海报 composer 仍显式依赖该根级 guard（`onboarding.tsx:41-55` 注释）。

## 验证（命令 + 真实 exit code）

| 项 | 命令（仓库根，除注明） | 结果 |
| --- | --- | --- |
| typecheck（修正后复跑） | `cd app && bun run typecheck` | **EXIT 0** |
| build | `cd app && bun run build` | **EXIT 0**（`✓ built in 9.43s`） |
| native 全量 app 域 | `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/heroui-migration/h09/native bunx e2e run --config e2e.unit.config.ts` | **EXIT 1**：994 = 983 pass / 11 fail / 0 skip；11 失败全部为已知域外既有红（见下节归因），本域可收集文件全绿 |
| driven 域内 named 套件 | `bun test ./app/tests/sign-in-card.test.tsx ./app/tests/root-drop-guard.test.tsx` | **EXIT 0**：6 pass / 0 fail |
| driven selection（修正后） | `bun test ./app/tests/multitenancy/selection.test.tsx` | **EXIT 0**：25 pass / 0 fail（修正前 EXIT 1：17 pass / 8 fail） |
| driven pagination+hotkeys | `bun test ./app/tests/channel-pagination.test.tsx ./app/tests/live-screen-app-shortcuts.test.tsx` | **EXIT 0**：7 pass / 0 fail |
| biome（改动文件） | `bunx biome check app/tests/multitenancy/selection.test.tsx` | **EXIT 0**（`--write` 修 organize-imports 后复检） |

### 11 条 native 失败归因（诚实口径）

全部不在本域改动面，与派发单列明的已知红完全一致，零新增：

- `zz-probe-context-menu.test.tsx` 8 — 既有真回归（H03 轮已记账）。
- `heroui-spike.test.tsx` 1、`gallery-components.test.tsx` 1、`approval-team-settings.test.tsx` 1 — H02/H04 域既有红。

本域 named 测试全绿：theme-preference 8、sidebar-preference 4、sidebar-shortcut-layouts 3、detail-panel 2、channel-unread 8、channel-order 3、channel-search 4（native）；sign-in-card 1、root-drop-guard 5（合计 6 pass——逐文件计数由 W3B 复核修正，H14 落盘）、multitenancy/selection 25、channel-pagination、live-screen-app-shortcuts（driven）。

## 遗留

1. **浏览器级证据**（Drawer ESC/外点/焦点返回/滚动锁释放、320px、200% zoom、真实布局）：归 H15（controls.md Gaps 原样移交）。
2. **ui/select Trigger 丢 role**：Interface 变更申请在案（h04 REPORT），归 H15 a11y 裁决；本轮测试已按现行生态适配，wrapper 恢复属性后可回到 role 查询。
3. 11 条 native 已知红归属 H02/H04 域与 zz-probe，非本轮引入。
