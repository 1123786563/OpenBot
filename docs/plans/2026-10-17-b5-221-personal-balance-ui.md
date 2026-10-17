# B5-221 用户余额页面 (02.7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 套餐与积分页（`/_authed/settings/usage`）渲染 02.6 已交付的个人余额契约：账户类型、可用、已消费、已过期、进行中占用与待结算"未启用"占位，失败态不渲染 0，空态文案明确，且页面不携带任何账户标识参数。

**Architecture:** 服务端 `/api/billing/credits/summary` 已改为返回 `PersonalCreditBalance`（02.6 已验证集成，见 `server/src/billing/types.ts:494`），而 app 查询层仍映射旧 `{plan, rewards}` 形状——`summary.data?.plan ?? 0` 现在静默渲染 0。修复路径：查询层类型对齐新契约 → 新增 `PersonalBalanceCard` 组件（账户类型徽标 + 四个数字 + 待结算占位）→ 把页面主体从路由文件提取为 `UsageCreditsView`（repo 惯例，参照 `components/settings/model-access-authorizations.tsx`）以便无路由上下文测试。

**Tech Stack:** React + TanStack Router/Query + i18next（zh-CN/en 双语），bun:test + happy-dom + @testing-library/react。

**Spec:** 票 `docs/tickets/bifrost-5/issues/02.7-personal-balance-ui.md`；父 Spec `docs/specs/2026-10-14-bifrost-github-spec.md`（AC01/AC19）；ADR 0002/0003/0004；CONTEXT.md。

## Global Constraints

- 硬性禁止：git commit / push / stash（coordinator 纪律）。
- Write scope：`app/src/routes/_authed/settings/usage.tsx` 与相关 billing 组件、`app/src/lib/billing` 查询封装、对应 `app/tests` 测试。locale 中 `creditsPage`/`billing` 命名空间字符串随本页 UI 必然新增（先例：同 worktree 基线中 01.8/04.7 均随票改 settings.json/admin.json），报告中说明。
- 失败 ≠ 0：任何 summary 读取失败不得渲染数字余额（现有 `summary.data?.plan ?? 0` 即此 bug）。
- 待结算在组 06 前显示"未启用"，不是 0（服务端 `PendingSettlementSummary.enabled` 为字面量 `false`）。
- 页面请求不得包含 `userId`/`externalCustomerId`/`payerId`/`accountId`/`companyId`/`tenantId`（服务端 02.6 已对这些参数返回 400）。
- 专用测试库 `postgres://openbot:openbot@127.0.0.1:5432/openbot_b5_221`（已 createdb）；绝不触碰 live `openbot` 库。

## Review Focus

- 失败被渲染成 0：summary 请求 5xx/网络失败时，余额区块必须渲染 LoadError（role="alert" + 重试），`PersonalBalanceCard` 不得挂载 — Task 4 的失败态测试钉住。
- 待结算显示成 0：`pendingSettlement.enabled === false` 时显示"未启用"文案，`PersonalBalanceCard` 组件级测试钉住（Task 3）。
- 静默跨账户参数：捕获页面发出的全部请求 URL，断言不含任何账户标识键 — Task 4 的请求参数测试钉住。
- 空态误导：无任何 grant 且四项全 0 时，卡片附"暂无积分记录"说明，grant 区块渲染"暂无奖励积分。" — Task 4 空态测试钉住。
- 旧形状残留：`rewardsSummary` 行的 grantCount/remaining/held 改由 balance + grants 列表派生，不得再读 `summary.rewards`（字段已不存在）— 由 typecheck + 正常态测试共同钉住。

---

### Task 1: RED — 失败的界面测试

**Files:**
- Create: `app/tests/personal-credits-ui.test.tsx`

**Interfaces:**
- Consumes:（实现完成后）`UsageCreditsView`（`@/components/billing/usage-credits-view`，props `{range, page, onRangeChange, onPage}`）、`PersonalBalanceCard`（`@/components/billing/personal-balance-card`，props `{balance: PersonalCreditBalance}`）
- Produces: 本票验收的可执行证据（三态渲染 + 请求参数断言）。

- [ ] **Step 1: 写测试文件**。Harness 照抄 `app/tests/admin-gateway-readiness.test.tsx`：`GlobalRegistrator`、`mock.module("@/components/ui/dialog", …)` 简单 pass-through、`QueryClientProvider` + `render`（无 Router，组件直挂）、每测试 stub `globalThis.fetch`、zh-CN。fixture 类型照服务端 `PersonalCreditBalance`（accountType: "personal"、available/consumed/expired/held、grants[]、pendingSettlement `{enabled:false, available:0, consumed:0, expired:0}`）。stub 端点：`/api/billing/credits/summary`、`/api/billing/credits/grants`、`/api/billing/credits/consumption`、`/api/billing/entitlements`、`/api/billing/catalog`。

测试清单（名称即断言）：
1. `个人余额页渲染账户类型、可用/已消费/已过期与待结算未启用` — `[data-testid="account-type"]` 文本"个人账户"；卡片含 12.5 / 3.2 / 0.75 / 1（可用/已消费/已过期/进行中占用）；`[data-testid="pending-settlement"]` 含"待结算"与"未启用"且不含"待结算：0"；grant 行渲染"5/50积分"状态 pill；无裸 `{{`。
2. `接口失败时显示错误提示，不渲染 0 余额` — summary 500 `{error:"积分台账暂不可用"}`：`role="alert"` 出现且含该句；`[data-testid="personal-balance"]` 为 null；重试按钮"重试"存在。
3. `无发放记录时显示明确空态文案` — summary 全 0 + grants `[]`：`"暂无奖励积分。"` 出现；`[data-testid="empty-ledger"]` 含"还没有积分记录"。
4. `页面请求不携带任何账户标识参数` — 记录全部请求 URL，逐条断言不含（大小写不敏感）`userid|externalcustomerid|payerid|accountid|companyid|tenantid`。
5. `billing 未启用时显示部署不可用空态` — summary 404：出现"此部署未启用计费"，且无 personal-balance 卡。
6. `PersonalBalanceCard 把待结算占位渲染为未启用而不是 0` — 组件直挂，断言"未启用"出现、卡片文本不含"待结算"紧跟"0"的数字行、空台账说明出现。

- [ ] **Step 2: 运行确认 RED**

Run: `bun test app/tests/personal-credits-ui.test.tsx`
Expected: FAIL —— 模块 `@/components/billing/usage-credits-view` / `personal-balance-card` 不存在（解析错误），或断言失败。不是 typo 级错误。

### Task 2: GREEN — 查询层对齐 02.6 契约

**Files:**
- Modify: `app/src/lib/billing/credits.ts`

**Interfaces:**
- Produces: `PersonalCreditBalance`、`PendingSettlementSummary`（与服务端 `server/src/billing/types.ts:475-521` 同形）；`creditsSummaryQueryOptions` 返回类型改为 `PersonalCreditBalance`。

- [ ] **Step 1:** 用 `PersonalCreditBalance`（accountType `"personal"`、available/consumed/expired/held `number`、grants `CreditGrantEntry[]`、pendingSettlement）替换旧 `CreditSummary` 类型；`PendingSettlementSummary` 用字面量类型 `{enabled: false; available: 0; consumed: 0; expired: 0}`。注释注明镜像服务端 02.6 契约。query key 与路径不变。
- [ ] **Step 2:** typecheck 仍红（usage.tsx 读 `summary.plan`）——预期，Task 4 修。

### Task 3: GREEN — PersonalBalanceCard + 文案

**Files:**
- Create: `app/src/components/billing/personal-balance-card.tsx`
- Modify: `app/src/locales/zh-CN/settings.json`、`app/src/locales/en/settings.json`（仅 `creditsPage` 命名空间新增键）

**Interfaces:**
- Consumes: `PersonalCreditBalance`（Task 2）、`credits()` 格式化（`@/lib/billing/format`）。
- Produces: `PersonalBalanceCard({balance}: {balance: PersonalCreditBalance})`；testid：`personal-balance`、`account-type`、`pending-settlement`、`empty-ledger`。

- [ ] **Step 1:** locale 键（zh/en）：`personalAccountTitle` 个人积分账户/Personal credit account、`accountTypePersonal` 个人账户/Personal account、`statAvailable` 可用/Available、`statConsumed` 已消费/Consumed、`statExpired` 已过期/Expired、`statHeld` 进行中占用/In-progress holds、`pendingSettlement` 待结算/Pending settlement、`pendingSettlementDisabled` 未启用/Not enabled、`emptyLedger` 本账户还没有积分记录。/No credit records on this account yet.、`personalAccountDescription` 您本人账户的积分余额。/Your own account's credit balance.
- [ ] **Step 2:** 组件：账户徽标 + 四个 `<dt>/<dd>` 数字（`credits()` 格式化）+ 待结算行（`!balance.pendingSettlement.enabled` → "待结算：未启用"；组 06 启用后此处改渲染金额，注释说明）；`balance.grants.length === 0` 且四项均 0 时显示 `empty-ledger` 说明（0 仍如实显示，旁边有明确空态文案）。

### Task 4: GREEN — UsageCreditsView 提取与页面重接

**Files:**
- Create: `app/src/components/billing/usage-credits-view.tsx`
- Modify: `app/src/routes/_authed/settings/usage.tsx`
- Modify: `app/src/components/billing/plan-card.tsx`（`planCredits` 改可选，缺省时隐藏用量条——不伪造 0/0）

**Interfaces:**
- Produces: `UsageCreditsView({range, page, onRangeChange, onPage}: {range: ConsumptionRange; page: number; onRangeChange: (r: ConsumptionRange) => void; onPage: (p: number) => void})`；`RANGES`/`isRangeKey`/`windowFor` 随迁并被路由文件 `validateSearch` 导入。

- [ ] **Step 1:** 页面结构：WelcomeBanner → 订阅 PlanCard（planName/resetsAt 来自 entitlements，不再传 planCredits）→ 新 `PageSection` 个人积分账户（summary pending→Skeleton、error→LoadError、成功→`PersonalBalanceCard`）→ 购买积分（保留文案与按钮，删除读 `summary.rewards` 的数字行）→ 平台奖励（grants 为空→`PageEmpty`；`CreditGrantList` 的 count = grants 中 `status==="active" && remaining>0` 的派生值、remaining = `balance.available`、held = `balance.held`，三者仅在 summary+grants 都成功时渲染）→ ConsumptionTable（不变）。所有 `?? 0` 兜底数字随旧契约一并移除。
- [ ] **Step 2:** 路由文件变薄壳：validateSearch + `RouteComponent` 读 search/navigate 后委托 `UsageCreditsView`。
- [ ] **Step 3: 运行 Task 1 测试确认 GREEN**

Run: `bun test app/tests/personal-credits-ui.test.tsx` — Expected: 全绿。
Run: `bun test app/tests/billing-credits-ui.test.tsx` — Expected: 全绿（PlanCard 可选参数向后兼容）。

### Task 5: 全量验证

- [ ] `bun run --filter app typecheck`
- [ ] `bun run --filter app build`
- [ ] `bun run --filter server typecheck`
- [ ] `bunx biome lint --error-on-warnings` 于全部改动文件
- [ ] `bun test app/tests/personal-credits-ui.test.tsx app/tests/billing-credits-ui.test.tsx`
- [ ] 写 `.omc/reports/b5-221.md`（AC 逐条证据 + 检查点：git status 未提交 + 文件清单），发送 worker_done。
