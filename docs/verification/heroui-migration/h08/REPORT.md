# H08 (#451) — 个人与公司积分、购买和订单记录（billing 域）迁移报告

状态：implemented（workspace 增量，无 commit）；BASE `203d0f0244b2`，分支 `feat/heroui-v3-migration`。
工作区：`/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`。
检查点产物：`POST-CHECKPOINT.sha256`（本域 7 个改动文件）；全量 native 证据 `native/`；域内定向 native 证据 `native-domain/`；命令日志 `evidence/`。

## 域起点事实（决定本轮 delta 形态）

- 本域 13 个组件 + 1 个 admin 卡片 + 4 条路由在 BASE 即已直接消费 `@/components/ui/*`（H02/H03 后为 HeroUI v3 适配层，导出面冻结）：全域 grep `@base-ui`/`@heroui` 直连 import **0 命中**；`Button/Dialog/Select/Empty/Field/Input/Skeleton` 全部走 ui/*。无 `<a>`/`Link`/`ButtonLink` 需求（grep 0 命中）。**无 Recharts 使用**（grep 0 命中——AC5 的 Recharts 保留条款在本域无对象）；QR（`qrcode` 包）与金额格式化（`lib/billing/format`）实现保留原样。
- 本轮开跑前，工作树里本域已有 5 个文件的 H02 波次 token 更名（`bg-muted`→`bg-ob-muted-surface`，共 9 行）：credit-bar / credit-grant-list / invoice-status / qr-code / upgrade-dialog（各文件 diff 仅 className 一行）。
- 结论：本轮 H08 = **验证 + 红清零归因 + biome 机械修正**。支付/账务逻辑零改动。

## 变更清单

| 文件 | 变更 | 要点 |
| --- | --- | --- |
| `app/src/routes/_authed/admin/billing.tsx` | biome organize-imports + format（本轮） | import 排序 + `PageSection, PageShell` 折行合并，零行为变更。 |
| `app/src/routes/_authed/settings/usage.tsx` | biome organize-imports（本轮） | type import 排序，零行为变更。 |
| `app/src/components/billing/credit-bar.tsx` | token 更名（既有波次，本轮核验保留） | `bg-muted`→`bg-ob-muted-surface`（`:24`）。 |
| `app/src/components/billing/credit-grant-list.tsx` | 同上（3 行） | `:15,:16,:43`。 |
| `app/src/components/billing/invoice-status.tsx` | 同上（3 行） | `:16,:18,:19`——五种 money 状态 TONE 区分不变。 |
| `app/src/components/billing/qr-code.tsx` | 同上（1 行） | `:37`；`qrcode` 包渲染路径原样。 |
| `app/src/components/billing/upgrade-dialog.tsx` | 同上（1 行） | `:420` QR 占位；支付/轮询/取消逻辑零触碰。 |

不改动（越权清单均未触碰）：`ui/*`、`package.json`/`bun.lock`、`main.tsx`/`__root.tsx`、`styles/*`、`lib/theme.ts`、`tests/theme-preference.test.ts`、`tests/preload.ts`、H04/H05 已冻结算域、H06 并发域。

## 已知红归因表（brief 点名的最大红区）

| 红 | 当时账目 | 本轮终态 | 单变量归因 | 处置 |
| --- | --- | --- | --- | --- |
| `billing-credits-ui` | 13 fail（H03 轮，未改动基线同命令复现 13/13，判环境/harness） | **18/18 全绿**（域内 native，`native-domain/report.json`） | H04 落地的 `preload.ts` 预热顺序修复（react-dom 预热移到 GlobalRegistrator.register 之前）解开「DOM 冻结」族——红因在 harness 侧，非本域组件代码 | 已修复（修复属 H04 交付物）；本轮仅验证收绿，不重复修改 |
| `personal-credits-ui` | 5 fail（同上轮） | **8/8 全绿**（同上） | 同上 | 同上 |
| 全量 native 余红 | h05 轮 13 fail | **11 fail**（983 pass / 994） | zz-probe-context-menu 8（既有真回归，brief 明示勿追）+ heroui-spike 1 + gallery-components 1 + approval-team-settings 1（均为 H02 域组件，brief 明示勿追）；较 h05 少的 2 条（user-preferences、h04-probe）系并行波次已修，与本域无关 | 全部域外 pre-existing，如实记录不追 |

## AC 状态（h08.md 对照，均为组件/单元级证据；浏览器级归 validator 轮）

### AC1 Payer 归属、金额精度、套餐与付款确认事实；余额不足不切换付款账户 — PASS

- 账户类型只渲染服务端答案（`personal-balance-card.tsx:41-43`），页面请求不带任何账户标识（测试「页面请求不携带任何账户标识参数」绿）；失败读不铸 0 余额（`usage-credits-view.tsx:179-190` LoadError 分支 + 测试绿）。
- 金额精度：admin 发放 `totalCents: Math.round(amount * 100)`（`admin-credit-grant.tsx:135`，CREDIT_SCALE=100 语义原样）；展示层 `money()`/`credits()`（`lib/billing/format`，BASE 零 diff）；`yuan()`（`upgrade-dialog.tsx:526-530`）原样。
- Payer 永不切换：客户端不存在任何 payer 切换路径——发放体只携带 user 不携带 account（`admin-credit-grant.tsx:9-17` 合同 + `:98-104`），余额不足只以「未覆盖 N」徽标陈述事实（`consumption-table.tsx:131-142`），不改扣费归因。
- 付款确认事实：同意勾选→支付按钮门控（`upgrade-dialog.tsx:505-514`）与测试「gates the pay button behind the agreement」绿。

### AC2 购买/扫码/升级弹窗与状态区分 — PASS

- 加载中「正在加载支付方式…」（`upgrade-dialog.tsx:328-332`，测试绿）；待支付：订单状态行 + 取消入口（`:446-475`）；失败：`payError` `role="alert"`（`:481-485`）；已收款/权益交付：`orderStatus.paid` 绿字 + 仅当 `activationState === "applied"` 才追加「已生效」尾注（`:446-459`）——不误导为已支付/已交付。
- 发票五态 TONE 区分保留（`invoice-status.tsx:14-20`）；409 待支付拒绝、阻塞订单恢复、取消失败文案三条测试全绿。
- 弹窗壳走 ui/dialog（H03 HeroUI Modal 适配层，`open`/`onOpenChange` 合同不变）；本轮零触碰。

### AC3 列表筛选/分页/空态/时间格式 — PASS

- 筛选：`?range=` URL 合同 + Select 域值守卫（`invoices.tsx:58-70`、`:164-168` `typeof value === "string" && isRangeKey(value)`——null 不铸成 range）。
- 分页：`BillingPager` clamp（`pager.tsx:77-79`）+「clamps a page past the end」「keeps the pager for a page walked off the end」测试绿；换窗重置页码（`invoices.tsx:139-141`）。
- 空态三种：空窗保切换器（`consumption-table.tsx:72-75`）、无账单（`invoices.tsx:222-243`）、计费未启用（`usage-credits-view.tsx:108-125`），测试绿。
- 时间格式：`useDateTime`（`invoices.tsx:314`、`orders-view.tsx:289`）与 `dateTime()`（`plan-card.tsx:85`、`credit-grant-list.tsx:67`）原样。

### AC4 提交防重；取消/重试/管理员发放确认可键盘操作 — PASS

- 防重：支付按钮 `paying || canceling` 禁用（`upgrade-dialog.tsx:505-514`）+ 取消守卫（`:223`）+ 双通道互斥（`:160-161`）；admin 发放 `disabled={grant.isPending}`（`admin-credit-grant.tsx:230`）+ 幂等键一 mount 一键（`:84-85`）；测试「the pay button stays inert while a cancel is in flight」绿。
- 键盘：取消/重试/发放确认全部为 HeroUI Button（原生 `<button>` 语义）；admin 发放 driven 层测试（userEvent 键盘驱动）7/7 绿（`evidence/driven-admin-credit-grant-7of7.log`）。

### AC5 QR/Recharts/金额格式保留；不重写支付或账务服务 — PASS

- QR：`qrcode` 包本地渲染两处原样（`qr-code.tsx:15`、`upgrade-dialog.tsx:141-145`）。Recharts：本域 0 使用。
- 支付/账务服务层（`lib/billing/payments`、`lib/billing/credits`、`lib/billing/invoices`）零 diff；billing-payments 9/9 绿。

## 验证（命令 + 真实 exit code）

| 项 | 命令（仓库根，除注明） | 结果 | 证据 |
| --- | --- | --- | --- |
| typecheck | `cd app && bun run typecheck` | **EXIT 0** | `evidence/typecheck-final-exit0.log` |
| build | `cd app && bun run build` | **EXIT 0**（`✓ built in 11.14s`） | `evidence/build-final-exit0.log` |
| native 全量 app 域 | `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/heroui-migration/h08/native bunx e2e run --config e2e.unit.config.ts`（仓库根；app/ 内跑=空集） | **EXIT 1**：994 执行 = 983 pass / 11 fail；11 条全部域外 pre-existing（见归因表）；本域可收集 6 文件 0 失败 | `native/report.json`（exitCode=1）、`evidence/native-full-exit.log` |
| native 域内定向 | 同命令 + 6 个 billing 测试文件参数 | **EXIT 0**：46 pass / 0 fail | `native-domain/report.json`、`evidence/native-domain-final-exit0.log` |
| driven（本域唯一入 driven 清单的文件） | `cd app && bun test ./tests/admin-credit-grant-ui.test.tsx`（ADR 0008：driven 层执行器为 bun，e2e 调度） | **EXIT 0**：7 pass / 0 fail | `evidence/driven-admin-credit-grant-7of7.log` |
| biome（域内 10 文件） | `bunx biome check <10 files>` | **EXIT 1**——仅剩 `upgrade-dialog.tsx:256` useOptionalChain（warning）与 `:252` useExhaustiveDependencies（error，unsafe fix 要求给结算轮询 effect 补 `order` 依赖）；对 BASE 原文件内容复跑得**逐条相同**诊断（已取证），判 BASE 固有；依 AC5 红线不重写支付轮询逻辑，留 H14 lint 清扫。其余 9 文件全绿 | `evidence/biome-domain-after-fix.log` |
| `tests/e2e/billing.e2e.ts` | engine 层（`@e2e-dev/web` target，需真实部署），按 ADR 0008 由 validator 轮执行 | 本轮不执行；该文件仅依赖测试框架，不被本域改动阻塞 | 文件头 import 实读 |

## 遗留

1. 浏览器级证据（真实 DOM 里的 Dialog/Select/QR/键盘焦点走查）归 frontend_validator 轮（含 `tests/e2e/billing.e2e.ts` engine 层回归）。
2. `upgrade-dialog.tsx` 2 条 BASE 固有 biome lint（结算轮询 effect 依赖数组与 optional-chain 风格）——修复需动支付轮询依赖数组（unsafe），按红线不动，建议 H14 lint 清扫轮以行为等价方式处理并回归结算轮询测试。
3. native 全量余红 11 条均为 brief 明示的域外 pre-existing（zz-probe 8 为保留真回归）；H02 域组件的 3 条由该域 verify 轮处置。
