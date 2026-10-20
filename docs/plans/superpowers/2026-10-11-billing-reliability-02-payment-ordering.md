# Payment Ordering and Settlement Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Serialize purchase creation across plans and channels and make provider acknowledgements depend on durable local settlement.

**Architecture:** Keep the existing immutable price snapshot, paid-fact unique index, and CAS transaction. Add a deployment-scoped pending-purchase constraint and conflict handling, then make settlement outcomes distinguish committed, duplicate, business-refused, and retryable storage failure. Preserve every confirmed payment fact; unresolved extra collections remain visible for operator/refund handling rather than silently activating another entitlement.

**Tech Stack:** TypeScript, Bun, Drizzle ORM, PostgreSQL, Hono, payment channel adapters, Bun Test.

**Spec:** `docs/specs/superpowers/2026-10-11-billing-reliability-design.md`

## Global Constraints

- Do not weaken the existing order version CAS, price snapshot, or paid-fact unique index.
- Use a database unique constraint as the one-open-order authority; service read-before-insert remains a fast path.
- A successful callback response requires a durable paid fact or a confirmed duplicate of that fact.
- Preserve CNY integer-cent comparisons and do not claim automatic refunds; no refund adapter is currently present.
- Integration tests use a dedicated `TEST_DATABASE_URL`; never use the application database.

---

### Task 1: Enforce one pending purchase per deployment

**Files:**
- Modify: `server/src/db/schema/payment.ts`
- Modify: `server/drizzle/` (append a generated migration)
- Modify: `server/src/billing/payments/types.ts`
- Modify: `server/src/billing/payments/store.ts`
- Modify: `server/src/billing/payments/service.ts`
- Test: `server/tests/payment-store.integration.test.ts`
- Test: `server/tests/payment-service.test.ts`

**Interfaces:**
- One open order is scoped to the current deployment database, consistent with the existing single deployment billing customer model.
- `PaymentStore.readPendingPurchase(): Promise<PaymentOrderRecord | null>` finds any pending order, regardless of plan or provider.
- `PaymentStore.insertOrder` returns `conflict: "pending-purchase"` when another plan/provider owns the pending slot.
- Same plan and provider replays the existing order; same-plan channel switch retains the current cancel-and-close behavior; a different-plan pending purchase returns an explicit conflict and creates no second order.

- [x] **Step 1: Add the competing plan/provider integration test**

Use the existing `orderInput()` helper in `payment-store.integration.test.ts`; create two orders with distinct plan codes/providers and assert only one can remain pending.

```ts
const first = await store.insertOrder(orderInput());
const second = await store.insertOrder({
  ...orderInput(),
  provider: "wechat",
});
expect(second.conflict).toBe("pending-purchase");
expect((await store.readPendingPurchase())?.id).toBe(first.order.id);
```

- [x] **Step 2: Run payment store tests and verify the current schema permits the conflict**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test server/tests/payment-store.integration.test.ts`
Expected: the new assertion fails because current uniqueness is only `(plan_code, provider)`.

- [x] **Step 3: Add the pending-scope invariant and service response**

Add a deployment scope column with a non-null default compatible with existing single-deployment rows, then append a partial unique index for one pending order per scope. Generate the migration with `bun run --filter server db:generate`; inspect its backfill/default and partial predicate. Update the store to catch only the named pending-scope conflict and return the winning order. Update service behavior for same-pair replay, channel switch, and different-plan refusal; if channel cancellation loses a race to payment, re-read and stop instead of opening another order.

- [x] **Step 4: Verify database and service semantics**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test server/tests/payment-store.integration.test.ts server/tests/payment-service.test.ts`
Expected: PASS; concurrent/different plan attempts converge to one open pending order or a clear refusal, while terminal orders free the slot.

- [x] **Step 5: Commit the serialization invariant**

```bash
git add server/src/db/schema/payment.ts server/drizzle server/src/billing/payments/types.ts server/src/billing/payments/store.ts server/src/billing/payments/service.ts server/tests/payment-store.integration.test.ts server/tests/payment-service.test.ts
git commit -m "fix(payments): serialize pending purchases per deployment" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Make settlement outcomes explicit and retry-safe

**Files:**
- Modify: `server/src/billing/payments/service.ts`
- Modify: `server/src/billing/payments/types.ts`
- Modify: `server/src/billing/payments/routes.ts`
- Test: `server/tests/payment-service.test.ts`
- Test: `server/tests/payment-routes.test.ts`

**Interfaces:**
- `settlePaidFact` returns a discriminated result: `{ kind: "claimed" }`, `{ kind: "duplicate" }`, `{ kind: "refused"; reason: "amount-mismatch" | "blocked" | "late" }`, or `{ kind: "retryable-failure" }`.
- `CallbackOutcome` adds the settlement result needed for callback grading; only committed or known duplicate settlement maps to a successful channel acknowledgement.
- The store's unique-index duplicate remains a normal idempotent result; unknown database failures are not converted into a false non-claim.

- [x] **Step 1: Add a callback test for a failed durable confirm**

Use the payment service fixture and make `confirmPaid` throw. Assert `handleCallback` returns `store-failure` and the route answers HTTP 500 / provider failure rather than success text or success JSON.

- [x] **Step 2: Run callback tests and verify the unsafe acknowledgement**

Run: `bun test server/tests/payment-service.test.ts server/tests/payment-routes.test.ts`
Expected: the new assertion fails because `settlePaidFact` swallows the storage error and callback handling returns `success`.

- [x] **Step 3: Propagate persistence failure without changing business-refusal behavior**

Stop catching `confirmPaid` exceptions inside `settlePaidFact`; map them to `store-failure` at the callback boundary. For amount mismatch, unreadable amount, and blocked/late cases, acknowledge only after the corresponding block/anomaly evidence is durable; if that write fails, return store failure. Keep same-fact replay acknowledged only after the fact lookup proves it already exists.

- [x] **Step 4: Verify callback result mapping**

Run: `bun test server/tests/payment-service.test.ts server/tests/payment-routes.test.ts`
Expected: PASS; only durable claim/replay returns the provider's success acknowledgement, and storage failures request a retry.

- [x] **Step 5: Commit the callback settlement change**

```bash
git add server/src/billing/payments/service.ts server/src/billing/payments/types.ts server/src/billing/payments/routes.ts server/tests/payment-service.test.ts server/tests/payment-routes.test.ts
git commit -m "fix(payments): acknowledge callbacks after durable settlement" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Prevent duplicate entitlement activation and surface extra collection

**Files:**
- Modify: `server/src/billing/payments/service.ts`
- Modify: `server/src/billing/payments/store.ts`
- Modify: `server/src/db/schema/payment.ts` only if the selected duplicate-payment policy needs a durable disposition field
- Modify: `server/drizzle/` only if Task 2 determines a durable disposition column is required
- Test: `server/tests/payment-service.test.ts`
- Test: `server/tests/payment-store.integration.test.ts`

**Interfaces:**
- A paid fact remains immutable even when another payment for the same entitlement arrives.
- A duplicate collection does not start another plan-credit payout or claim a second entitlement. It produces a durable `duplicate_paid` finding with both order and channel transaction IDs.
- No refund is issued automatically until a refund provider operation and the duplicate-payment policy are designed.

- [x] **Step 1: Add a concurrent second-payment activation test**

Create two pending orders for the same plan on different channels, settle both with different transaction IDs, and assert both payment facts remain but only one order can activate and the other has a durable duplicate-payment finding.

- [x] **Step 2: Run duplicate payment tests and establish the current activation behavior**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test server/tests/payment-store.integration.test.ts`
Expected: FAIL if the second activation is not held or its transaction evidence is not durable.

- [x] **Step 3: Gate activation on entitlement ownership and retain every collection fact**

Before the second plan-credit payout, atomically verify the order is the sole eligible paid order for the plan/scope. Record the duplicate disposition and stop activation when another order already owns that entitlement. Keep the paid fact and order paid state unchanged so money evidence is not erased.

- [x] **Step 4: Verify sequential and concurrent duplicate cases**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test server/tests/payment-service.test.ts server/tests/payment-store.integration.test.ts`
Expected: PASS; first valid payment activates once, later collections remain visible and do not create a second allowance.

- [x] **Step 5: Commit the duplicate-activation guard**

```bash
git add server/src/billing/payments/service.ts server/src/billing/payments/store.ts server/src/db/schema/payment.ts server/drizzle server/tests/payment-service.test.ts server/tests/payment-store.integration.test.ts
git commit -m "fix(payments): hold duplicate collection from activation" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
