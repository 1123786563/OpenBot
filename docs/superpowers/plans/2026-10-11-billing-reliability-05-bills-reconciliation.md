# Historical Bills and Billing Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make historical bills stable, apply an explicit read-access scope, and extend reconciliation to cover unpaid entitlements, grant payouts, usage delivery, and payment evidence.

**Architecture:** Treat each payment order as the source of its own historical statement snapshot. Keep provider current-period data for the current plan view only. Add a distinct paid timestamp and immutable bill fields, then extend the read-only reconciler with stable findings over committed order, event, grant, and usage facts.

**Tech Stack:** TypeScript, Bun, Hono, Drizzle ORM, PostgreSQL, React Query types, Bun Test.

**Spec:** `docs/superpowers/specs/2026-10-11-billing-reliability-design.md`

## Global Constraints

- Preserve integer-cent bill amounts and integer-scaled credit facts.
- Historical statements must not be rewritten from the current subscription period.
- Do not change billing visibility or ownership filters until the selected scope is recorded in the spec.
- Reconciliation is read-only and must never repair or erase the evidence it reports.
- Integration tests use a dedicated `TEST_DATABASE_URL`; never use the application database.

---

### Task 1: Record approved billing visibility and duplicate disposition

**Files:**
- Modify: `docs/superpowers/specs/2026-10-11-billing-reliability-design.md`
- Create: `docs/superpowers/specs/adr/` decision record only if the repository's ADR convention is approved for these policies

**Interfaces:**
- The approved visibility rule is user-scoped: an authenticated actor reads only invoices/orders whose `createdBy` matches that actor's stable user ID. The current auth actor has `id` but no tenant ID; do not invent a tenant column absent an established tenant-bearing purchase contract.
- The approved duplicate-collection disposition is manual resolution: retain every paid fact, do not refund automatically, and do not issue the same entitlement twice.
- Verify the existing `AuthenticatedActor.id` / `payment_orders.created_by` contract; these decisions are already recorded in the design.

- [x] **Step 1: Verify the selected owner key in the auth and payment contracts**

Read `AuthenticatedActor.id`, the purchase route's `createdBy: context.var.actor.id`, and `payment_orders.created_by`. Confirm this is the stable owner key available to invoice and purchase reads; if an established tenant-bearing actor contract is found, use it instead and record why.

- [x] **Step 2: Record access and duplicate-payment decisions**

Record user-scoped owner reads and manual handling of later collections in the design. State explicitly that there is no automatic refund or second entitlement payout.

- [x] **Step 3: Verify no decision gate remains open**

Expected: Task 3 can apply `createdBy` ownership checks consistently; no route authorization or paid-order disposition is based on an unspecified policy.

### Task 2: Make invoice periods and payment time order-specific

**Files:**
- Modify: `server/src/db/schema/payment.ts`
- Modify: `server/drizzle/` (append a generated migration)
- Modify: `server/src/billing/payments/types.ts`
- Modify: `server/src/billing/payments/store.ts`
- Modify: `server/src/billing/payments/service.ts`
- Modify: `server/src/billing/statements.ts`
- Modify: `server/src/billing/types.ts`
- Modify: `app/src/lib/billing/invoices.ts`
- Test: `server/tests/billing-statements.test.ts`
- Test: `server/tests/payment-store.integration.test.ts`

**Interfaces:**
- `payment_orders.paid_at` is set only when the paid transition commits; old paid rows backfill `paid_at = terminal_at`, and non-paid rows keep `paid_at = NULL`.
- Invoice `settledAt` maps to `paidAt`, never generic `terminalAt`.
- Invoice period fields come from the matching order snapshot. `providerPeriodOf()` is removed from invoice rendering and remains available to current plan usage only.
- Add immutable `plan_name_snapshot` if product requires historical display names; store the fallback plan code at order creation when no configured localized name is available.

- [x] **Step 1: Add two-order historical-period and terminal-status tests**

Use the `fakeOrders` helper in `billing-statements.test.ts` with two paid orders from distinct months and an active subscription in a third period. Assert each invoice keeps its own stored period; assert an expired/canceled order has null paid settlement time.

```ts
expect(page.invoices.map((invoice) => invoice.periodStart)).toEqual([
  "2026-08-01T00:00:00.000Z",
  "2026-09-01T00:00:00.000Z",
]);
expect(expiredInvoice?.settledAt).toBeNull();
```

- [x] **Step 2: Run statement tests and verify the current-period override**

Run: `bun test server/tests/billing-statements.test.ts`
Expected: FAIL because current provider period is applied to every row and terminal time is used for all statuses.

- [x] **Step 3: Add paid timestamp and preserve order period snapshots**

Set `paidAt` in the same CAS update that moves an order to paid. Generate an additive migration with an explicit backfill for existing paid orders. Ensure the period snapshot uses the exact period returned by Lago activation when available; retain a clearly marked order-time fallback only if the provider gives no period. Remove `providerPeriod` from `invoiceOf`.

- [x] **Step 4: Verify statements and old-data migration behavior**

Run: `bun test server/tests/billing-statements.test.ts server/tests/payment-service.test.ts`
Expected: PASS; historical order periods do not change when the current subscription period changes, and only paid orders expose `settledAt`.

- [x] **Step 5: Commit invoice snapshot semantics**

```bash
git add server/src/db/schema/payment.ts server/drizzle server/src/billing/payments/types.ts server/src/billing/payments/store.ts server/src/billing/payments/service.ts server/src/billing/statements.ts server/src/billing/types.ts app/src/lib/billing/invoices.ts server/tests/billing-statements.test.ts server/tests/payment-store.integration.test.ts
git commit -m "fix(billing): preserve historical invoice periods and paid time" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Apply the approved invoice and order access policy

**Files:**
- Modify: `server/src/billing/routes.ts`
- Modify: `server/src/billing/payments/routes.ts`
- Modify: `server/src/billing/statements.ts`
- Modify: `server/src/billing/payments/store.ts`
- Modify: `server/src/db/schema/payment.ts` and migration only if the chosen policy needs a durable owner/tenant key
- Test: `server/tests/billing-statements.test.ts`
- Test: `server/tests/payment-routes.test.ts`
- Test: `server/tests/billing-routes.test.ts`

**Interfaces:**
- Every read route uses one policy helper for user-scoped access; invoice list, invoice detail, order detail, current pending order, and checkout QR all enforce the same rule.
- User-scoped policy filters invoice and order queries by authenticated `actor.id` mapped to `payment_orders.created_by`, and returns 404 for rows outside that scope to avoid leaking existence.
- Pending checkout payload is returned only when the pending order's `createdBy` matches the authenticated actor; mutating routes remain admin-only.

- [x] **Step 1: Add route tests for the selected policy**

Seed two owners and assert each can read only invoices/orders and checkout material created by that actor, receiving 404 for the other's IDs. Assert admin-only mutating routes remain admin-only.

- [x] **Step 2: Run route tests and verify the current visibility**

Run: `bun test server/tests/billing-statements.test.ts server/tests/payment-routes.test.ts server/tests/billing-routes.test.ts`
Expected: FAIL for the selected policy's prohibited read.

- [x] **Step 3: Implement one scope predicate at the store/read seam**

Pass the authenticated actor/scope from routes into the statement/order read methods. Do not filter only in the UI. Keep admin authorization for create/cancel actions, independent of read scope.

- [x] **Step 4: Verify list/detail/checkout access**

Run: `bun test server/tests/billing-statements.test.ts server/tests/payment-routes.test.ts server/tests/billing-routes.test.ts`
Expected: PASS; list, detail, and QR visibility all follow the same approved policy.

- [x] **Step 5: Commit access-scope enforcement**

```bash
git add server/src/billing/routes.ts server/src/billing/payments/routes.ts server/src/billing/statements.ts server/src/billing/payments/store.ts server/src/db/schema/payment.ts server/drizzle server/tests/billing-statements.test.ts server/tests/payment-routes.test.ts server/tests/billing-routes.test.ts
git commit -m "fix(billing): enforce approved bill access scope" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Reconcile expected plan-credit payout and activation backlog

**Files:**
- Modify: `server/src/billing/reconcile.ts`
- Modify: `server/src/billing/types.ts`
- Modify: `server/src/index.ts`
- Test: `server/tests/billing-reconcile.integration.test.ts`

**Interfaces:**
- `createReconciler(database, externalCustomerKey, expectedPlanCredits)` receives plan allowances in scaled integer units.
- Report findings for paid orders whose activation remains pending/failed beyond a named age threshold, and paid/applied orders whose expected `plan:<orderId>` grant is absent or has a different amount.
- Preserve current checks for paid facts, transaction mismatch, live subscription presence, and credit identity.

- [x] **Step 1: Add real-table tests for missing and mismatched plan grants**

Create a paid order with an expected allowance but no matching idempotency key, and another with the key but wrong amount. Assert distinct stable finding codes and order IDs.

- [x] **Step 2: Run the reconciliation integration test and verify these findings are absent**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test server/tests/billing-reconcile.integration.test.ts`
Expected: FAIL because current reconciliation does not inspect expected plan payout or activation age.

- [x] **Step 3: Extend the reconciler with exact expected-grant joins**

Pass the parsed plan catalog from assembly, multiply whole credits by `CREDIT_SCALE` using integer arithmetic, and match `credit_grants.idempotency_key = "plan:" || payment_orders.id`. Return a missing or amount-mismatch finding. Add a configurable, documented activation-age threshold; do not mark young retries as incidents.

- [x] **Step 4: Verify new and existing payment findings**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test server/tests/billing-reconcile.integration.test.ts server/tests/payment-service.test.ts`
Expected: PASS; the report identifies missing/mismatched grants and retains all existing payment three-way findings.

- [x] **Step 5: Commit activation/grant reconciliation**

```bash
git add server/src/billing/reconcile.ts server/src/billing/types.ts server/src/index.ts server/tests/billing-reconcile.integration.test.ts
git commit -m "feat(billing): reconcile paid plan credit payouts" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 5: Expand reconciliation for payment evidence and usage delivery

**Files:**
- Modify: `server/src/billing/reconcile.ts`
- Modify: `server/src/billing/types.ts`
- Modify: `server/src/billing/routes.ts`
- Test: `server/tests/billing-reconcile.integration.test.ts`
- Test: `server/tests/billing-routes.test.ts`

**Interfaces:**
- Add stable findings for duplicate paid orders requiring the selected disposition, payment facts whose amount/currency differs from their order snapshot, and usage events whose Lago or credit delivery remains pending beyond the selected age threshold.
- Aggregate count conversion remains exact: sums returned from PostgreSQL use decimal strings and `BigInt`, not `Number` over unbounded `SUM(bigint)`.
- Reconciliation remains read-only and includes checked counts by category so an empty findings array is meaningful.

- [x] **Step 1: Add one integration test per finding category**

Seed two paid orders for one plan, a mismatched payment fact amount/currency if those facts are stored, and a usage outbox row with an old pending target. Assert each finding names the order/event IDs.

- [x] **Step 2: Run reconciliation tests and verify findings are missing**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test server/tests/billing-reconcile.integration.test.ts`
Expected: FAIL because current findings cover only paid-fact linkage, live-subscription presence, and grant/ledger sum equality.

- [x] **Step 3: Implement read-only evidence checks**

Join paid facts to orders and compare stored integer money facts; detect more than one paid order per plan/scope; read the usage outbox target states; change grant/ledger aggregates to `BigInt` comparisons. Map duplicate-paid findings to the policy chosen in Task 1 without issuing a refund or mutation.

- [x] **Step 4: Verify findings and route response**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test server/tests/billing-reconcile.integration.test.ts server/tests/billing-routes.test.ts`
Expected: PASS; each injected mismatch yields one stable finding, aggregate totals remain exact, and database rows are unchanged by reconcile.

- [x] **Step 5: Commit expanded reconciliation**

```bash
git add server/src/billing/reconcile.ts server/src/billing/types.ts server/src/billing/routes.ts server/tests/billing-reconcile.integration.test.ts server/tests/billing-routes.test.ts
git commit -m "feat(billing): reconcile payment and usage evidence" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## As-built notes (2026-10-13 audit, F7)

The plan text above keeps its original intent; the delivered mechanism differs in one named place:

- **Duplicate collections are surfaced from `duplicate_paid` anomaly rows, not counted per
  plan/scope.** Task 4's reconciliation bullet says "detect more than one paid order per
  plan/scope". As built (commit `c3c2a206`, "reconcile payment and usage evidence"), the
  callback/activation path records the overlap as a `payment_events` anomaly row with code
  `duplicate_paid` at write time (it wins the paid-fact idempotency race against the owned
  order), and reconciliation reads those rows and reports each as a `duplicate_paid_order`
  finding. Reading recorded evidence instead of counting paid orders keeps legitimate
  sequential repurchases (expire, then buy the same plan again) out of the findings — a count
  cannot tell a second concurrent entitlement from a second subscription period.
