# H09 Task Brief — frontend_implementer（登录、工作台导航和窄屏侧栏）

工作目录（唯一写入范围）：`/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`
授权来源：父 Issue #443 委派提示词（实施已授权；#452 票面旧状态不适用）。不 commit/push。

## 必读（按序）
1. `docs/tickets/heroui-migration/issues/h09.md`（范围、AC1–AC5）
2. `docs/adr/0008-test-runner-tester-army-e2e.md`
3. `docs/verification/heroui-migration/h03/REPORT.md`「下游 Interface」节
4. `docs/verification/heroui-migration/LEDGER.md` 2026-10-20 段

## 上游 Interface（冻结，只消费不改）
- 禁改：`ui/*`（sheet/sidebar 虽名义归本 Issue，但已随 H02 去 Base-UI 化并冻结——如确需改动记 Interface 变更申请）、`package.json`/`bun.lock`、`main.tsx`/`__root.tsx`、`styles/*`、`lib/theme.ts`、H03–H08 已改文件（见各自 POST-CHECKPOINT）。
- 链接一律 `ButtonLink`（真实 anchor、新标签页、组合键）。

## 范围（主所有权）
- 路由：sign、_authed.tsx、_authed/_app.tsx、_authed/_app/index、_authed/onboarding、_authed/sign-in/$requestId、_authed/tenant/{selection,channels}、_authed/settings/route、_authed/admin/{index,route}。
- 组件：`app-sidebar/*`、`layout/*`（page-shell、sidebar-shell、sidebar-toggle、detail-panel、page-skeletons、row-mark、self-host-banner、skip-to-content、stagger）、`settings/settings-sidebar.tsx`、`admin/admin-sidebar.tsx`、`auth/provider-logo.tsx`。

## 合同（AC 对照 h09.md）
- 登录/退出/引导/请求登录/公司团队选择统一控件，深链接与守卫保持；不改认证/授权算法。
- 侧栏折叠偏好、快捷键（react-hotkeys）、选中态、返回导航保持；真实 anchor 新标签页可用。
- 窄屏 Drawer 打开/ESC/外部关闭/焦点返回正确，body 滚动锁不残留（dialog.tsx 守卫 v3 已处理弹层 ESC 分层——消费而非绕过）。
- PageShell/PageRows/DetailPanel 布局 Interface 不变；短视口长内容可滚动；详情面板不改模态。
- 亮暗/中英/320px 宽/200% 缩放关键动作可见；**根级文件 drop 防导航保护不回退**（__root 上的全局 guard，验证不被导航改动破坏）。

## 已知红
- 本域 app 层无已知红（sidebar-preference/sidebar-shortcut-layouts/sign-in-card 在 H02 轮已绿）。新红先单变量归因。

## 验证（全部执行并记录命令+exit code）
- `cd app && bun run typecheck`；`cd app && bun run build`
- native：仓库根 `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/heroui-migration/h09/native bunx e2e run --config e2e.unit.config.ts`
- 重点既有测试：theme-preference、sidebar-preference、sidebar-shortcut-layouts、sign-in-card、root-drop-guard、multitenancy/selection
- 变更文件 biome lint/format

## 交付
`h09/REPORT.md` + `POST-CHECKPOINT.sha256`（格式同 h05）。阻塞记录证据继续可做部分。
