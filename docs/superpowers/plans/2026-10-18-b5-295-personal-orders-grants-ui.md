# Bifrost 10.6 个人订单与 Grant 追溯页面 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. NOTE (worker dispatch): git commit/push is FORBIDDEN for this ticket — every "checkpoint" step is a verification step only; the working tree stays uncommitted per the dispatch constraints.

**Goal:** A signed-in user can trace every credit they hold back to its source order or granting action — orders list with live status, subscription/plan face, and every grant with its source (plan purchase / check-in / promo-admin) and expiry — and nothing on the surface can name another person's account.

**Architecture:** The server already answers every read this page needs, all scoped server-side to the session's own personal payer (10.1's `billingReadScopeOf`, 02.6's `resolvePayerForPersonalUser`, the credits routes' 400-on-any-account-parameter guard). So this ticket is an app-side slice only: one new settings route `/settings/orders`, a lifted view component (the `UsageCreditsView` seam, testable without a router), a small pure trace module that derives "which order funded this grant" from the grant contract the server already ships, and a `CreditGrantRow` extraction from the existing grant-list component so both the rewards block and this page render one row shape. i18n en + zh-CN in lockstep.

**Tech Stack:** React + TanStack Router (file routes) + @tanstack/react-query, existing `client`/`tryClient` transport, i18next (en source-of-truth typed keys), bun test + happy-dom + testing-library.

**Spec:** docs/tickets/bifrost-5/issues/10.6-personal-orders-and-grants-ui.md (AC14/AC19 of docs/specs/2026-10-14-bifrost-github-spec.md; Q27 of docs/specs/2026-10-14-bifrost-integration-design.md; ADR 0004; CONTEXT.md 订单/订阅/Grant 术语)

## Global Constraints

- Write scope: 个人订单与 Grant 页面及查询封装 + 对应 app/tests。Server files are read-only for this ticket (their scoping is already delivered by 10.1–10.5); touching any other module needs an orchestration ask first.
- 禁止 git commit / push / stash；禁止触碰其他 worktree；不启用网关能力；不部署。
- The page never sends an account identifier of any kind — the account is resolved server-side from the session; a client-named account is answered 400 by design (02.4). The client must not even ask.
- i18n: en bundle is the source of truth and the key checker (`i18next.d.ts`); zh-CN must carry the same key set.
- No secrets, no raw channel payloads, no provider credentials in any UI response this page renders (AC19).
- Billing pages branch pending → error → empty → rows and may use the billing family's Skeleton pattern (usage/invoices precedent).

## Review Focus

- A `plan`-source grant whose reason does NOT match the server's exact payout string (`plan allowance · <planCode> · order <orderId>`) must render with no trace chip, not a guessed order — pinned by the "source & expiry consistency" test with an off-format reason.
- An orders read that fails must render an error + retry, never an empty table dressed as "no orders" (the billing-page rule); pinned by the render test's error stub.
- The page's requested URLs must carry zero account-identifying query params (`userId`, `externalCustomerId`, `payerId`, `accountId`, `companyId`, `tenantId`, any casing) — pinned by the cross-account test asserting on the recorded fetch URLs.
- An unauthenticated/404 deployment (billing absent) renders the unavailable empty state, not an error loop — covered by reusing the `BillingUnavailableError` read the invoices page uses.
- Order status drift (pending → paid) must reach the screen on refresh without a code change per status — pinned by the status-transition test mutating the fetch stub.

---

## Background facts (verified against the working tree — do not re-derive)

- Server reads this page consumes (all exist, all personal-scoped server-side):
  - `GET /api/billing/invoices?from&to&page` → `BillingInvoicePage` (server/src/billing/routes.ts `createBillingStatementRoutes`, scope = `billingReadScopeOf(context)`; store filters `ownerScopeCondition`). App wrapper EXISTS: `invoicesQueryOptions(window, page)` in app/src/lib/billing/invoices.ts.
  - `GET /api/billing/credits/summary` → `PersonalCreditBalance` with `grants: CreditGrantEntry[]` — ALL grants incl. `source: "plan"`, each with `reason`, `grantedAt`, `expiresAt`, `status`, `expiringSoon`. Wrapper EXISTS: `creditsSummaryQueryOptions` in app/src/lib/billing/credits.ts.
  - `GET /api/billing/entitlements` → `BillingEntitlements` (plan code, subscription period). Wrapper EXISTS: `entitlementsQueryOptions` in app/src/lib/billing/queries.ts.
  - `GET /api/billing/catalog` → plan display catalog. Wrapper EXISTS: `catalogQueryOptions` in app/src/lib/billing/credits.ts.
- The only writer of `source: "plan"` grants is the plan-allowance payout (server/src/index.ts `grantor.grantPlanCredits`), whose reason is EXACTLY `` `plan allowance · ${planCode} · order ${orderId}` `` and whose idempotency key is `plan:<orderId>`. Admin handouts use `promo`/`signin`; reward claims use `signin`. This fixed string is the trace contract the page parses.
- Billing family renders with Skeleton in pending branches and tables under `PageSection` (invoices.tsx precedent), overriding the newer "no placeholder" rule for this family.

## File Structure

- Create `app/src/lib/billing/trace.ts` — pure derivation: `orderIdOfPlanGrant(grant)`, `grantCountSummary`. No I/O; the seam tests and the page share.
- Create `app/src/components/billing/orders-view.tsx` — the lifted `OrdersGrantsView` (queries + sections), and `PersonalOrdersTable` (reuses `InvoiceStatusPill`, `InvoiceMethodLabel`, `BillingPager`).
- Modify `app/src/components/billing/credit-grant-list.tsx` — extract + export `CreditGrantRow` (row body with optional `sourceLabel` and `trace` slots); `CreditGrantList` keeps its exact current output by delegating to it.
- Create `app/src/routes/_authed/settings/orders.tsx` — route file; URL contract `?page=`; hands props down (usage.tsx pattern).
- Modify `app/src/components/settings/settings-sidebar.tsx` — one entry `sidebar.orders` (icon `IconListDetails`), between 套餐与积分 and 账单管理.
- Modify `app/src/locales/en/settings.json` + `app/src/locales/zh-CN/settings.json` — `sidebar.orders`, `ordersPage.*`, `creditsPage.grantSource.*`.
- Test: `app/tests/personal-orders-ui.test.tsx` (the ticket's named file).

---

### Task 1: RED — the trace module contract (pure functions)

**Files:**
- Create: `app/src/lib/billing/trace.ts`
- Test: `app/tests/personal-orders-ui.test.tsx` (first tests only; fetch stub arrives in Task 2)

**Interfaces:**
- Consumes: `CreditGrantEntry` type from `@/lib/billing/credits` (`{ id, source: "plan"|"promo"|"signin", reason: string|null, ... }`).
- Produces: `orderIdOfPlanGrant(grant: Pick<CreditGrantEntry, "source"|"reason">): string | null` — the order id iff `source === "plan"` AND `reason` matches `/^plan allowance · .+ · order (.+)$/`, else `null`.

- [ ] **Step 1: Write the failing tests** (append to the new test file, component-free):

```tsx
import { orderIdOfPlanGrant } from "@/lib/billing/trace";

test("orderIdOfPlanGrant traces a plan grant to its funding order", () => {
  expect(
    orderIdOfPlanGrant({
      source: "plan",
      reason: "plan allowance · plan_pro · order po_123",
    }),
  ).toBe("po_123");
});

test("orderIdOfPlanGrant refuses to guess for non-plan or off-format reasons", () => {
  expect(orderIdOfPlanGrant({ source: "signin", reason: "coupon for order po_x" })).toBeNull();
  expect(orderIdOfPlanGrant({ source: "plan", reason: "管理员调整" })).toBeNull();
  expect(orderIdOfPlanGrant({ source: "plan", reason: null })).toBeNull();
});
```

- [ ] **Step 2: Run to verify RED** — `cd app && bun test ./tests/personal-orders-ui.test.tsx` → FAIL (module `@/lib/billing/trace` not found).
- [ ] **Step 3: Implement `trace.ts`** with exactly the documented signature and the anchored regex.
- [ ] **Step 4: Run to verify GREEN** — same command, these two tests PASS.

### Task 2: RED — the page's render, cross-account and traceability tests (fetch stub)

**Files:**
- Test: `app/tests/personal-orders-ui.test.tsx`

**Interfaces:**
- Consumes: `OrdersGrantsView` (props `{ page: number; onPage: (next: number) => void }`) — to be created in Task 3; `BillingInvoicePage`/`PersonalCreditBalance`/`BillingEntitlements` shapes from the existing lib modules; the dialog mock + `installFetchStub` pattern of tests/personal-credits-ui.test.tsx (records every URL in `requestedUrls`).
- Produces: the five behavioral pins the ticket names.

- [ ] **Step 1: Write the failing tests** (following tests/personal-credits-ui.test.tsx: GlobalRegistrator, dialog mock.module, QueryClientProvider with `retry: false`, zh-CN, `settleReactWork` in afterAll). Fixtures:

```tsx
const INVOICE_PAGE = {
  invoices: [
    { invoiceId: "po_123", planCode: "plan_pro", periodStart: "2026-10-01T00:00:00.000Z",
      periodEnd: "2026-11-01T00:00:00.000Z", amountCents: 19900, currency: "CNY",
      status: "pending", method: "alipay", issuedAt: "2026-10-01T00:00:00.000Z",
      settledAt: null, channelTransactionId: null },
    { invoiceId: "po_100", planCode: "plan_basic", periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-10-01T00:00:00.000Z", amountCents: 9900, currency: "CNY",
      status: "paid", method: "wechat", issuedAt: "2026-09-01T00:00:00.000Z",
      settledAt: "2026-09-01T00:01:00.000Z", channelTransactionId: "ch_1" },
  ],
  pagination: { totalCount: 2, totalPages: 1, currentPage: 1, nextPage: null },
};
const BALANCE = { /* 02.6 contract shape, personal */
  accountType: "personal", available: 88, consumed: 12, expired: 0, held: 0,
  grants: [
    { id: "cg-plan", source: "plan", reason: "plan allowance · plan_pro · order po_123",
      total: 100, used: 12, remaining: 88, grantedAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2026-11-01T00:00:00.000Z", status: "active", expiringSoon: false },
    { id: "cg-signin", source: "signin", reason: "每日签到奖励", total: 1, used: 0,
      remaining: 1, grantedAt: "2026-10-17T00:00:00.000Z",
      expiresAt: "2027-10-17T00:00:00.000Z", status: "active", expiringSoon: false },
    { id: "cg-promo", source: "promo", reason: "运营活动补发", total: 5, used: 5,
      remaining: 0, grantedAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-09-15T00:00:00.000Z", status: "expired", expiringSoon: false },
  ],
  pendingSettlement: { enabled: false, available: 0, consumed: 0, expired: 0 },
};
```

Stub `/api/billing/invoices*` → INVOICE_PAGE, `/api/billing/credits/summary` → BALANCE, `/api/billing/entitlements` → `{ active: true, planCode: "plan_pro", codes: [], subscription: { status: "active", currentPeriodStart: "2026-10-01T00:00:00.000Z", currentPeriodEnd: "2026-11-01T00:00:00.000Z" } }`, `/api/billing/catalog` → `{}`; everything else 404. The stub keeps a mutable `currentInvoices` cell so Task 5's status test can flip it.

1. `test("订单与积分追溯页渲染本人订单、订阅与 Grant（状态、来源、有效期、追溯到订单）")` — asserts: both order ids render; `等待支付` (pending pill) and `已支付` render; plan name renders; grant rows render `套餐` / `签到奖励` / `活动/管理员发放` source chips (i18n `creditsPage.grantSource.*`); the plan grant row carries its expiry (formatted from expiresAt) AND a trace chip naming `po_123`; the off-format grants render NO trace chip; no `{{` template leak.
2. `test("页面不携带任何账户标识，仅请求本人作用域读取")` — asserts every entry of `requestedUrls` starts with one of the four scoped paths AND matches none of `/userId=|externalCustomerId=|payerId=|accountId=|companyId=|tenantId=/i`.
3. `test("订单读取失败时显示错误与重试，不渲染空表")` — invoices stub answers `{ error: "…" }` 503 → error text + retry button visible, `po_123` absent.
4. `test("计费未启用的部署显示不可用空态")` — all billing paths 404 → unavailable copy, no crash.
5. `test("Grant 过期状态与服务器一致")` — the promo grant renders `已过期` and the active plan grant `使用中` (expiry/status derived from the server answer, not recomputed).

- [ ] **Step 2: Run to verify RED** — `cd app && bun test ./tests/personal-orders-ui.test.tsx` → component tests FAIL (`OrdersGrantsView` not exported), Task 1 tests still PASS.
- [ ] **Step 3: Commit — FORBIDDEN (dispatch). Skip; checkpoint = green Task-1 tests still standing.**

### Task 3: GREEN — OrdersGrantsView + route + sidebar + i18n

**Files:**
- Create: `app/src/components/billing/orders-view.tsx`, `app/src/routes/_authed/settings/orders.tsx`
- Modify: `app/src/components/billing/credit-grant-list.tsx`, `app/src/components/settings/settings-sidebar.tsx`, `app/src/locales/en/settings.json`, `app/src/locales/zh-CN/settings.json`

**Interfaces:**
- Consumes: the four existing queryOptions factories (exact names above); `orderIdOfPlanGrant`; `CreditBar`, `InvoiceStatusPill`, `InvoiceMethodLabel`, `BillingPager`, `PlanCard`, `PageShell`/`PageSection`.
- Produces: `OrdersGrantsView({ page, onPage })`; exported `CreditGrantRow({ grant, sourceLabel?, trace? })` (renders exactly today's row when both optionals are absent); route `/settings/orders` with `validateSearch` → `{ page: number }`; i18n keys `ordersPage.title/description/refresh/ordersTitle/ordersEmpty/ordersUnavailable/retry/subscriptionTitle/grantsTitle/grantsDescription/grantsSummary/grantSource.plan|signin|promo/traceOrder/traceNoOrder/columnPlan/columnAmount/columnStatus/columnNumber/columnCreated`, `sidebar.orders`, `creditsPage.grantSource.plan|signin|promo`.

- [ ] **Step 1: Extract `CreditGrantRow`** in credit-grant-list.tsx — move the row JSX verbatim; add optional `sourceLabel?: string` (a chip before the status pill) and `trace?: React.ReactNode` (rendered after the reason line). `CreditGrantList` delegates; its output is unchanged.
- [ ] **Step 2: Implement `OrdersGrantsView`** — pending → Skeleton (billing family), error → message + retry (invoices precedent), empty → `ordersEmpty`; sections: 订单记录 (table: plan+period / amount / `InvoiceStatusPill` / order id / created; `BillingPager`), 订阅计划 (`PlanCard`, no upgrade callback), 积分入账 (`CreditGrantRow` per summary grant, `sourceLabel` from `creditsPage.grantSource`, `trace` chip = linked order id + its status from the loaded invoice list, or bare order id when the order is outside the current page). Reads: `invoicesQueryOptions({}, page)`, `creditsSummaryQueryOptions`, `entitlementsQueryOptions`, `catalogQueryOptions`. `unavailable` empty state when the summary read fails with `BillingUnavailableError`.
- [ ] **Step 3: Route + sidebar + i18n** — orders.tsx mirrors usage.tsx's `validateSearch`/navigate pattern; sidebar entry between plansUsage and invoices; add all keys to BOTH locale files (en first — it is the type source).
- [ ] **Step 4: Run to verify GREEN** — `cd app && bun test ./tests/personal-orders-ui.test.tsx` → all PASS.
- [ ] **Step 5: Regenerate route tree + typecheck** — `bun run --filter app build` (regenerates routeTree.gen.ts) then `bun run --filter app typecheck && bun run --filter server typecheck` → both clean.

### Task 4: Status-change reflection + lint/build gate

- [ ] **Step 1: RED first** — `test("订单状态变化在页面正确反映：pending → paid 经刷新后更新")`: render with `currentInvoices` pending; click 刷新; stub now serves po_123 as `paid` (+ settledAt); assert `已支付` replaces `等待支付` for po_123. Run → FAIL (no refresh wiring yet).
- [ ] **Step 2: GREEN** — add the `action` refresh button on the PageShell (icon `IconRefresh`, `invoices.refetch()`, i18n `ordersPage.refresh`), same as invoices.tsx.
- [ ] **Step 3: Full gates** —
  ```bash
  bun test app/tests/personal-orders-ui.test.tsx
  bun run --filter app build
  bun run --filter server typecheck
  bun run --filter app typecheck
  bunx biome check --error-on-warnings app/src/lib/billing/trace.ts app/src/components/billing/orders-view.tsx app/src/components/billing/credit-grant-list.tsx app/src/routes/_authed/settings/orders.tsx app/src/components/settings/settings-sidebar.tsx app/tests/personal-orders-ui.test.tsx
  ```
  All green; `git status` stays uncommitted (checkpoint).

## Self-review

- AC1 (trace every credit): orders table + grant rows with `orderIdOfPlanGrant` trace chip — Task 1/2/3.
- AC2 (no cross-account read): server scoping consumed as-is; client sends no identifier — Task 2 test 2.
- AC3 (grant source & expiry consistent with backend): source chips + expiry + status straight from the 02.6 answer — Task 2 tests 1/5.
- AC4 (order status changes reflected): refresh refetch test — Task 4.
- Types consistent: `CreditGrantRow` props vs both call sites; `OrdersGrantsView` props vs route — checked.
- Review Focus items each pinned by a named test — done above.
