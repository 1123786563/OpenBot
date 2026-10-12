# Credit Enforcement Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make credit admission, reservation/overdraft accounting, and user-visible balances follow one explicitly approved policy across model and code-run usage.

**Architecture:** The approved policy is a hard ceiling. Add integer-exact configured model/input-output and separate code-run rates plus per-model/per-run maximum reservations, reserving capacity atomically before work and settling actual cost/releasing unused capacity afterward. Missing rate or maximum-bound configuration fails closed; never substitute the old temporary rate. Exact remainders are accumulated per customer rather than rounding every event upward.

**Tech Stack:** TypeScript, Bun, Drizzle ORM, PostgreSQL, Hono, React Query types, Bun Test.

**Spec:** `docs/superpowers/specs/2026-10-11-billing-reliability-design.md`

## Global Constraints

- Do not silently choose hard-cap or overdraft semantics.
- All reservation and balance arithmetic uses integer scaled credit units (`CREDIT_SCALE = 100`).
- Preserve the existing transaction that writes the consumption ledger and updates grant usage.
- Apply the chosen rule to both LLM model calls and code runs.
- Integration tests use a dedicated `TEST_DATABASE_URL`; never use the application database.

---

### Task 1: Record approved credit policy and define deployment settings

**Files:**
- Modify: `docs/superpowers/specs/2026-10-11-billing-reliability-design.md`
- Create: `docs/superpowers/specs/adr/` decision record only if the repository's ADR convention is approved for this policy

**Interfaces:**
- Produces a validated typed configuration contract for model/input/output rational rates, code-run rational rate, per-model maximum reserved usage, and a per-run maximum reserved usage.
- The chosen policy is fixed: hard cap; reserve maximum before work; fail closed if rate/bound is missing or full capacity is unavailable; settle actual cost and release unused capacity.
- Do not provide default numeric rates. Deployment configuration must supply approved integer numerator/denominator values before the gate is enabled.

- [x] **Step 1: Encode the approved integer-rate and maximum-reservation shape**

Use exact rational configuration fields (integer numerator and denominator for each rate) so converting token counts to scaled credit units never depends on binary floating point. Define per-model input/output maxima and a code-run maximum; compute the maximum reservation with integer ceiling arithmetic. Missing, zero-denominator, negative, or out-of-range values return a typed unconfigured result.

- [x] **Step 2: Add fail-closed configuration tests**

Test a complete valid config, each missing model/run rate, missing maximum bound, zero denominator, and exact boundary arithmetic. Assert no default rate is synthesized.

- [x] **Step 3: Document operator-supplied numeric values**

Update the billing configuration documentation with the required key names and exact units, and state that billing work is rejected until values are supplied. Do not invent price numbers.

- [x] **Step 4: Verify parser and documentation**

Run the focused configuration tests and `bun run --filter server typecheck`; expected: valid config parses, missing values fail closed, no prices default.

### Task 2A: Implement hard-cap reservations (execute only if Task 1 selects hard cap)

**Files:**
- Create: `server/src/db/schema/credit-reservations.ts`
- Modify: `server/src/db/schema/index.ts`
- Create: next generated migration under `server/drizzle/`
- Modify: `server/src/billing/credits-writer.ts`
- Modify: `server/src/billing/payments/types.ts` only if shared billing result types need a reservation outcome
- Test: `server/tests/billing-credits-writer.integration.test.ts`
- Test: `server/tests/qa-batch2-credits-consume.integration.test.ts`

**Interfaces:**
- `CreditWriter.reserveCredits({ externalCustomerId, idempotencyKey, maximumCents, expiresAt }): Promise<{ reserved: true; reservationId: string } | { reserved: false; availableCents: number }>`
- `CreditWriter.settleReservation({ reservationId, actualCents }): Promise<{ appliedCents: number; releasedCents: number }>`
- `CreditWriter.releaseReservation(reservationId, reason): Promise<void>` is idempotent; expiry recovery releases only reservations still in `reserved` state.
- Reservation allocations identify each grant that funded the hold, allowing transactionally exact release across multiple grants.

- [x] **Step 1: Add a concurrent reservation integration test**

Seed a 1000-unit grant and issue two concurrent 700-unit reservations with different keys. Assert only one reserves and total reserved capacity never exceeds 1000.

```ts
const results = await Promise.all([reserve("r1", 700), reserve("r2", 700)]);
expect(results.filter((result) => result.reserved)).toHaveLength(1);
expect(await writer.availableBalance(customer)).toBe(300);
```

- [x] **Step 2: Run the reservation test and verify it fails**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test server/tests/billing-credits-writer.integration.test.ts`
Expected: FAIL because reservation APIs/tables do not exist.

- [x] **Step 3: Implement reservation records, allocations, and transactional settlement**

Add a reservation state and child allocations so one reservation can span expiring grants. Lock grant rows in expiry order, account for all live reservations when computing capacity, persist allocation and reservation rows in one transaction, and settle by converting the actual amount into the existing `credit_ledger` record while releasing unused allocation. Repeated settle/release requests must return the first terminal result.

- [x] **Step 4: Verify concurrency, replay, expiry, and exact balance**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test server/tests/billing-credits-writer.integration.test.ts server/tests/qa-batch2-credits-consume.integration.test.ts`
Expected: PASS; neither concurrent reservations nor settlements can allocate more than live grant capacity.

- [x] **Step 5: Commit the hard-cap reservation store**

```bash
git add server/src/db/schema/credit-reservations.ts server/src/db/schema/index.ts server/drizzle server/src/billing/credits-writer.ts server/tests/billing-credits-writer.integration.test.ts server/tests/qa-batch2-credits-consume.integration.test.ts
git commit -m "feat(billing): reserve credit capacity transactionally" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3A: Wire hard-cap admission into model and code-run work (execute only if Task 1 selects hard cap)

**Files:**
- Modify: `server/src/copilot.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/workshop/metering.ts`
- Modify: `server/src/codesandbox/gateway.ts`
- Modify: `server/src/codesandbox/client.ts` and the sandbox service's run contract if it supports an enforceable token ceiling
- Test: `server/tests/copilot-usage-meter.test.ts`
- Test: `server/tests/workshop-metering.test.ts`
- Test: `server/tests/codesandbox-gateway.test.ts`

**Interfaces:**
- The metered model obtains a policy-approved `maximumCents` before `inner.doStream`; after the finish usage arrives it calls `settleReservation`; stream failure calls `releaseReservation`.
- The code-run gateway performs the corresponding reservation before invoking the sandbox and settles/releases by `runId`. A reservation alone does not cap sandbox consumption: pass an enforceable input/output token budget to the sandbox and verify the sandbox honors it before enabling code-run billing.
- The current server-side sandbox contract exposes timeout seconds but no token ceiling. If the configured sandbox cannot enforce a token budget, fail closed before the sandbox request; do not pretend a timeout or credit reservation is a token ceiling.
- The estimator and rate are the exact ones approved in Task 1; no implicit unlimited maximum is permitted.

- [x] **Step 1: Test missing configuration and zero-capacity model/code-run rejection**

Make reservation return `{ reserved: false }` and assert the model provider is not called. Test an unavailable sandbox token-budget capability and assert the code-run sandbox is not started.

- [x] **Step 2: Run both targeted runtime tests and verify the current gate is insufficient**

Run: `bun test server/tests/copilot-usage-meter.test.ts server/tests/workshop-metering.test.ts`
Expected: FAIL because the current model gate reads a cached balance and the code-run path has no pre-call reservation.

- [x] **Step 3: Wire reserve/settle/release to the metering lifecycle**

Replace the cached zero-only admission decision with an atomic reservation; settle it using the durable event identity from plan 01 and actual token costs; release on model/sandbox failure. Add a sandbox budget contract and enforce the configured maximum token budget remotely. Do not downgrade missing pricing/budget support or a failed reservation lookup into an allowed call. If the sandbox deployment does not yet implement the enforcement contract, leave code-run admission closed while still recording an explicit refusal.

- [x] **Step 4: Verify runtime admission and release**

Run: `bun test server/tests/copilot-usage-meter.test.ts server/tests/workshop-metering.test.ts server/tests/billing-usage-delivery.test.ts`
Expected: PASS; rejected work never reaches its provider, and successful/failed work settles/releases exactly once.

- [x] **Step 5: Commit the hard-cap runtime integration**

```bash
git add server/src/copilot.ts server/src/index.ts server/src/workshop/metering.ts server/tests/copilot-usage-meter.test.ts server/tests/workshop-metering.test.ts
git commit -m "fix(billing): enforce reservations before metered work" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2B: Historical alternative — explicit overdraft accounting (DO NOT EXECUTE)

**Files:**
- Modify: `server/src/db/schema/credits.ts` only if the approved policy requires a new durable debt disposition
- Modify: `server/src/billing/credits-writer.ts`
- Modify: `server/src/billing/credits.ts`
- Modify: `server/src/billing/types.ts`
- Modify: `server/src/billing/routes.ts`
- Modify: `app/src/lib/billing/credits.ts`
- Modify: the billing settings view consuming `CreditSummary`
- Test: `server/tests/billing-credits-writer.integration.test.ts`
- Test: `server/tests/billing-credits.test.ts`
- Test: `app/tests/billing-credits-ui.test.tsx`

This branch is retained only to document the rejected alternative. The approved policy is a hard ceiling; do not implement or dispatch this task.

**Interfaces:**
- The existing ledger `credits` remains actual cost and `applied` remains the grant-funded portion.
- Credit summary adds exact integer-derived `overdrawn` (returned in credits after scaling) and a policy state; it must not infer debt by subtracting independently rounded floating-point UI numbers.
- Future grants follow the exact debt recovery rule approved in Task 1.

- [ ] **Step 1: Add writer and summary tests for overdraw and grant recovery**

Create one draw where `credits > applied`; assert the resulting summary reports the difference as debt. Add the chosen policy's future-grant scenario and assert both debt and spendable balance.

- [ ] **Step 2: Run targeted writer and summary tests and verify they fail**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test server/tests/billing-credits-writer.integration.test.ts server/tests/billing-credits.test.ts`
Expected: FAIL because the public summary currently omits the outstanding difference.

- [ ] **Step 3: Implement the approved debt and grant-allocation rule**

Compute debt from integer ledger values or persist a debt disposition only if the selected recovery behavior cannot be derived. Apply grants to debt before exposing spendable allowance only if the policy record requires it. Keep all changes in the credit writer and summary factory rather than duplicating arithmetic in routes or UI.

- [ ] **Step 4: Verify integer accounting and UI display**

Run: `bun test server/tests/billing-credits-writer.integration.test.ts server/tests/billing-credits.test.ts app/tests/billing-credits-ui.test.tsx`
Expected: PASS; overdraw and recovery display exactly and existing plan/reward totals retain their meaning.

- [ ] **Step 5: Commit the overdraft-policy implementation**

```bash
git add server/src/db/schema/credits.ts server/drizzle server/src/billing/credits-writer.ts server/src/billing/credits.ts server/src/billing/types.ts server/src/billing/routes.ts app/src/lib/billing/credits.ts app/tests/billing-credits-ui.test.tsx
git commit -m "feat(billing): expose approved credit overdraft policy" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Reconcile held credit capacity or explicit debt

**Files:**
- Modify: `server/src/billing/reconcile.ts`
- Modify: `server/src/billing/types.ts`
- Test: `server/tests/billing-reconcile.integration.test.ts`

**Interfaces:**
- Hard-cap branch reports expired/stuck reservations and reservation allocation imbalance.
- Overdraft branch reports positive unpaid debt and validates the approved future-grant recovery rule.
- Both branches preserve `Σ credit_grants.used == Σ credit_ledger.applied` after settlement; active reservations are reported separately until converted into ledger entries.

- [x] **Step 1: Add one real-table finding test for the chosen branch**

For hard cap, seed an expired reserved allocation and assert a reservation finding. For overdraft, seed `credits > applied` and assert a debt finding.

- [x] **Step 2: Run the reconciliation integration test and verify the selected finding is missing**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test server/tests/billing-reconcile.integration.test.ts`
Expected: FAIL because the current reconciler has no reservation/debt finding.

- [x] **Step 3: Add the read-only check for the selected credit policy**

Include stable reservation/debt identifiers, exact integer deltas, and the policy's remediation status. Do not automatically release or forgive funds during reconciliation.

- [x] **Step 4: Verify reconciliation remains read-only**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test server/tests/billing-reconcile.integration.test.ts`
Expected: PASS; the finding is returned and the seeded ledger/grants/reservation rows are unchanged.

- [x] **Step 5: Commit the policy reconciliation check**

```bash
git add server/src/billing/reconcile.ts server/src/billing/types.ts server/tests/billing-reconcile.integration.test.ts
git commit -m "feat(billing): reconcile credit policy state" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
