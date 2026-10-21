# Durable Billing Usage Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure each completed model or code-run usage occurrence has a stable identity and a durable, independently retryable Lago and credit-ledger delivery record.

**Architecture:** Persist one immutable usage fact before attempting its downstream effects. Use a database outbox with independent Lago and credit delivery states so partial success can be retried without repeating the successful effect. Generate model-call identity once per `doStream` invocation; preserve the existing stable `runId` for code runs.

**Tech Stack:** TypeScript, Bun, Drizzle ORM, PostgreSQL, Lago client, Bun Test.

**Spec:** `docs/specs/superpowers/2026-10-11-billing-reliability-design.md`

## Global Constraints

- Keep token counts, scaled credit units, and charge arithmetic as integers.
- Reuse the same event identity for every retry of one usage occurrence.
- Persist before calling Lago or the credit writer; do not treat a failed durable write as a successful report.
- Keep Lago provider vocabulary inside `server/src/billing/lago.ts`.
- Integration tests use a dedicated `TEST_DATABASE_URL`; never use the application database.

---

### Task 1: Add the durable usage-outbox record and store

**Files:**
- Create: `server/src/db/schema/usage-outbox.ts`
- Modify: `server/src/db/schema/index.ts`
- Create: next generated migration under `server/drizzle/` and its Drizzle metadata
- Create: `server/src/billing/usage-outbox.ts`
- Test: `server/tests/billing-usage-outbox.integration.test.ts`

**Interfaces:**
- Produces `UsageOutbox.record(input): Promise<{ inserted: boolean }>` where `input` contains `eventId`, `source: "llm" | "code_run"`, `externalCustomerId`, `transactionId`, integer `inputTokens`/`outputTokens`, `model`, `client`, and `occurredAt`.
- Produces `UsageOutbox.pending(limit): Promise<readonly UsageOutboxRecord[]>`, `markLagoDelivered(eventId): Promise<void>`, `markCreditsDelivered(eventId): Promise<void>`, and `recordDeliveryFailure(eventId, target, failureCode): Promise<void>`.
- One row per `eventId`; a repeated `record` with identical immutable facts is a no-op. Reuse of an ID with different immutable facts is an explicit conflict error, not a silent overwrite.
- Each target has an independent state (`pending` or `delivered`); an outbox row is complete only when both targets are delivered.

- [x] **Step 1: Write the failing integration tests**

Add tests that insert an event, replay the same event, reject conflicting facts for the same event ID, and verify that marking Lago delivered leaves credits pending and vice versa.

```ts
const event = usageEvent(`${prefix}-event-1`);
expect(await outbox.record(event)).toEqual({ inserted: true });
expect(await outbox.record(event)).toEqual({ inserted: false });
await outbox.markLagoDelivered(event.eventId);
expect((await outbox.pending(10))[0]).toMatchObject({
  eventId: event.eventId,
  lagoStatus: "delivered",
  creditsStatus: "pending",
});
```

- [x] **Step 2: Run the integration test and verify the missing table/interface failure**

Run: `bun test server/tests/billing-usage-outbox.integration.test.ts`
Expected: FAIL because the outbox schema/store does not exist yet.

- [x] **Step 3: Add the Drizzle table, migration, and store implementation**

The table must have a primary or unique `event_id`, source, customer key, Lago `transaction_id`, non-negative token fields, occurrence time, target states, last target error codes, and created/updated timestamps. Index pending target states plus creation time. Generate the migration with `bun run --filter server db:generate`; inspect its SQL to verify the unique event identity and non-negative checks. Implement inserts with `ON CONFLICT` against the stable event ID and compare persisted immutable facts on conflict.

- [x] **Step 4: Run the store tests against PostgreSQL**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test server/tests/billing-usage-outbox.integration.test.ts`
Expected: PASS after the migration is applied to that dedicated database; duplicate facts are a no-op and conflicting facts fail visibly.

- [x] **Step 5: Commit the outbox unit**

```bash
git add server/src/db/schema/usage-outbox.ts server/src/db/schema/index.ts server/src/billing/usage-outbox.ts server/drizzle server/tests/billing-usage-outbox.integration.test.ts
git commit -m "feat(billing): add durable usage outbox" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Add independently retryable usage delivery

**Files:**
- Create: `server/src/billing/usage-delivery.ts`
- Modify: `server/src/billing/usage-outbox.ts`
- Modify: `server/src/billing/maintenance.ts` (create this file if no billing maintenance module exists)
- Test: `server/tests/billing-usage-delivery.test.ts`
- Test: `server/tests/billing-usage-outbox.integration.test.ts`

**Interfaces:**
- Consumes the `UsageOutbox` contract from Task 1 and two injected target functions: `sendToLago(record): Promise<void>` and `chargeCredits(record): Promise<void>`.
- Produces `UsageDelivery.runBatch(limit): Promise<{ examined: number; delivered: number; failed: number }>`; it must not mark one target delivered until that target succeeds.
- Lago delivery must use a delivery-grade service method whose success means the provider accepted or deduplicated the event. The existing best-effort `BillingService.recordUsage` catches/logs errors and must not be used as this success signal; preserve that existing contract for any other caller.

- [x] **Step 1: Write tests for independent target retries**

Use in-memory outbox and target stubs. Prove that Lago success plus credit failure retries only credits; the inverse retries only Lago; a fully delivered row is not sent again.

```ts
expect(await delivery.runBatch(10)).toMatchObject({ examined: 1, failed: 1 });
expect(lagoCalls).toBe(1);
expect(creditCalls).toBe(1);
creditFails = false;
await delivery.runBatch(10);
expect(lagoCalls).toBe(1);
expect(creditCalls).toBe(2);
```

- [x] **Step 2: Run the targeted test and verify it fails**

Run: `bun test server/tests/billing-usage-delivery.test.ts`
Expected: FAIL because `createUsageDelivery` does not exist.

- [x] **Step 3: Implement the delivery coordinator and retry recording**

For Lago, call a new delivery-grade billing service method with the outbox `transactionId`, metric `llm_tokens` or `code_run_tokens`, and the persisted token/model/source properties; it must propagate missing-subscription, provider-refusal, and transient failure outcomes rather than resolving after a warning. Keep existing `BillingService.recordUsage` best-effort behavior unchanged. For credits, call `CreditWriter.consumeCredits` using the exact configured rate formula approved in the credit-policy decision (plan 03) and `idempotencyKey = "usage:" + eventId`. Do not invent a per-token rate in this task. Persist one target's result before trying to mark the other. Log a stable failure code and event ID without logging credentials or raw payloads.

- [x] **Step 4: Test partial success, replay, and failure recording**

Run: `bun test server/tests/billing-usage-delivery.test.ts server/tests/billing-usage-outbox.integration.test.ts`
Expected: PASS; a failed target remains pending while its successful sibling remains delivered.

- [x] **Step 5: Commit the delivery unit**

```bash
git add server/src/billing/usage-delivery.ts server/src/billing/usage-outbox.ts server/src/billing/maintenance.ts server/tests/billing-usage-delivery.test.ts server/tests/billing-usage-outbox.integration.test.ts
git commit -m "feat(billing): retry usage deliveries independently" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Wire model and code-run usage to the outbox

**Files:**
- Modify: `server/src/copilot.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/workshop/metering.ts`
- Test: `server/tests/copilot-usage-meter.test.ts`
- Test: `server/tests/workshop-metering.test.ts`

**Interfaces:**
- Extend the model meter callback input with `eventId: string`; `meteredModel` creates one UUID before invoking the wrapped model and passes that same ID with its finish usage.
- Keep the code-run `runId` as source identity; derive its event ID as `code-run:<runId>`.
- Consumers write facts through `UsageOutbox.record`; only the delivery worker calls Lago and the credit writer.

- [x] **Step 1: Add model identity assertions to the stream-level test**

Extend the existing LLMock test to capture two completed calls. Assert each callback has a non-empty distinct event ID, and each callback reports its own usage.

```ts
expect(seen).toHaveLength(2);
expect(seen[0]?.eventId).toBeTruthy();
expect(seen[0]?.eventId).not.toBe(seen[1]?.eventId);
```

- [x] **Step 2: Run the model usage test and verify it fails on the new event ID contract**

Run: `bun test server/tests/copilot-usage-meter.test.ts`
Expected: FAIL because current meter callbacks contain only input/output token counts.

- [x] **Step 3: Replace fire-and-forget direct billing writes with outbox writes**

Generate the model call ID once in `meteredModel`, include it in the callback, and insert a usage fact from the assembly callback in `server/src/index.ts`. Change the code-run reporter to record the same immutable facts under `code-run:<runId>`. Start the delivery sweep from the existing billing assembly; keep model execution successful when downstream providers are unavailable, but surface outbox insertion failures through the runtime's established logger and metric path rather than an empty catch.

- [x] **Step 4: Verify model and code-run paths**

Run: `bun test server/tests/copilot-usage-meter.test.ts server/tests/workshop-metering.test.ts server/tests/billing-usage-delivery.test.ts`
Expected: PASS; model event IDs differ across calls, code-run retries reuse the run identity, and neither path sends usage directly around the outbox.

- [x] **Step 5: Commit the wiring**

```bash
git add server/src/copilot.ts server/src/index.ts server/src/workshop/metering.ts server/tests/copilot-usage-meter.test.ts server/tests/workshop-metering.test.ts
git commit -m "fix(billing): persist model and code-run usage before delivery" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Add recovery evidence for usage backlog

**Files:**
- Modify: `server/src/billing/reconcile.ts`
- Modify: `server/src/billing/types.ts`
- Modify: `server/src/billing/routes.ts`
- Test: `server/tests/billing-reconcile.integration.test.ts`
- Test: `server/tests/billing-routes.test.ts`

**Interfaces:**
- Reconciliation reports pending delivery counts by target and age; it does not mutate usage or claim that a target succeeded.
- Finding subjects are usage event IDs; details include target, attempt age, and last stable failure code.

- [x] **Step 1: Add a real-table test for a pending usage target**

Insert an outbox event with one delivered target and one pending target; assert the report identifies the pending target and event ID.

- [x] **Step 2: Run reconciliation tests and verify the new finding is absent**

Run: `bun test server/tests/billing-reconcile.integration.test.ts`
Expected: FAIL because the report does not read outbox state.

- [x] **Step 3: Add read-only outbox checks to reconciliation**

Count pending target states and return stable findings. Keep `reconcile()` read-only and keep the existing payment and credit identity checks intact.

- [x] **Step 4: Verify reconciliation and admin route output**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test server/tests/billing-reconcile.integration.test.ts server/tests/billing-routes.test.ts`
Expected: PASS; pending usage is visible and reconciliation creates no delivery side effects.

- [x] **Step 5: Commit the reconciliation extension**

```bash
git add server/src/billing/reconcile.ts server/src/billing/types.ts server/src/billing/routes.ts server/tests/billing-reconcile.integration.test.ts server/tests/billing-routes.test.ts
git commit -m "feat(billing): reconcile pending usage delivery" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## As-built notes (2026-10-13 audit, F7)

The plan text above keeps its original intent; the delivered mechanism differs in two named places:

- **Credit delivery is a reservation settlement, not `consumeCredits`.** Task 2's interface
  paragraph names `CreditWriter.consumeCredits` with `idempotencyKey = "usage:" + eventId` for
  the credits target. As built (commit `b616ccaa`, "enforce reservations before metered work"),
  the credits target calls `CreditWriter.settleReservation` on the reservation the model gate
  opened at admission: the `usage:<eventId>` key belongs to the **reservation** (it is what
  `reserveCredits` receives), and the settlement's own idempotency is `reservation:<id>` — a
  replayed delivery settles the same hold once and answers the first result. Per-target
  idempotency is unchanged: each target marks its own state on the outbox row.
- **Pending retry order rotates by `updated_at`, not creation time.** Task 1's table
  requirements say "index pending target states plus creation time". As built (commit
  `195ca54b`, "rotate pending usage retries"), the pending read orders by `updated_at` (event
  id as tiebreak): every failed attempt refreshes `updated_at`, so a hot-failing event rotates
  to the back of the batch instead of starving every younger event behind it. Creation time
  stays on the row as a fact; it is not the retry order.
