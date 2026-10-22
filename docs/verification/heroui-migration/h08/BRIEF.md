# H08 Task Brief — frontend_implementer（个人与公司积分、购买和订单记录）

工作目录（唯一写入范围）：`/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`
授权来源：父 Issue #443 委派提示词（实施已授权；#451 票面旧状态不适用）。不 commit/push。

## 必读（按序）
1. `docs/tickets/heroui-migration/issues/h08.md`（范围、AC1–AC5）
2. `docs/adr/0008-test-runner-tester-army-e2e.md`
3. `docs/verification/heroui-migration/h03/REPORT.md`「下游 Interface」节
4. `docs/verification/heroui-migration/LEDGER.md` 2026-10-20 段

## 上游 Interface（冻结，只消费不改）
- `ui/*` 27 primitives 已 HeroUI v3 化；禁改 `ui/*`、`package.json`/`bun.lock`、`main.tsx`/`__root.tsx`、`styles/*`、`lib/theme.ts`、H03/H04/H06 已改文件（见各自 POST-CHECKPOINT，冲突上报不覆盖）。
- Dialog/Select/ComboBox/Dropdown/Tooltip 合同见 h03 REPORT；链接用 `ButtonLink`。

## 范围（主所有权）
- 路由：admin/billing、settings/invoices、settings/orders、settings/usage。
- 组件：`billing/*`（admin-credit-grant、consumption-table、credit-bar、credit-grant-list、invoice-status、orders-view、pager、personal-balance-card、plan-card、qr-code、upgrade-dialog、usage-credits-view、welcome-banner）、`admin/billing-cleanup-execution-card.tsx`。

## 合同（AC 对照 h08.md——计费域红线）
- 个人/公司 Payer 归属、金额精度（CREDIT_SCALE=100 语义）、套餐与付款确认事实不变；**余额不足不切换付款账户**。
- 购买/扫码/升级弹窗、处理中/失败/已收款/权益交付状态区分保持，不误导为已支付或已交付。
- 积分/用量/订单/发票列表筛选/分页/空态/时间格式正确。
- 提交中防重复；取消/重试/管理员发放确认可键盘操作。
- **保留现有 QR（qrcode）、Recharts、金额格式实现**——只迁移容器与动作控件，不重写支付/账务逻辑。

## 已知红（须修复或单变量归因——本域最大红区）
- `billing-credits-ui`、`personal-credits-ui`（合计 13 断言，2026-10-20 归因落本域）。先读 `docs/verification/heroui-migration/h02/form-primitives/report.json` 失败明细；单变量对照判 BASE 固有 vs 迁移引入，分别处置并记录。pre-existing 勿追：zz-probe 8、heroui-spike、gallery/bots-nav-badge/approval-team-settings/user-preferences（他域）。

## 验证（全部执行并记录命令+exit code）
- `cd app && bun run typecheck`；`cd app && bun run build`
- native：仓库根 `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/heroui-migration/h08/native bunx e2e run --config e2e.unit.config.ts`
- `tests/e2e/billing.e2e.ts` 属 UI/engine 层——按 ADR 0008 确认归属后由 validator 轮执行，你只保证不被代码阻塞
- 变更文件 biome lint/format

## 交付
`h08/REPORT.md` + `POST-CHECKPOINT.sha256`（格式同 h05）。阻塞记录证据继续可做部分。
