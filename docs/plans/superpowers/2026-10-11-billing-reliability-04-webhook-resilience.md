# Lago Webhook Retry Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure a Lago webhook is acknowledged as processed only after its authoritative projection refresh and inbox event are durably recorded.

**Architecture:** Preserve signature verification, raw-body handling, event deduplication, and authoritative object re-read. Classify provider/projection/inbox failures at the service boundary; return a retryable response for transient storage/provider failures and record the inbox event only after all required refresh work succeeds.

**Tech Stack:** TypeScript, Bun, Hono, Drizzle ORM, PostgreSQL, Lago client, Bun Test.

**Spec:** `docs/specs/superpowers/2026-10-11-billing-reliability-design.md`

## Global Constraints

- Verify signatures over the original capped request body before processing an event.
- Retain the current authoritative re-read behavior; do not trust the webhook payload as the subscription projection.
- A webhook inbox row means all work associated with that delivery completed.
- Return only fixed, credential-free error responses.
- Integration tests use a dedicated `TEST_DATABASE_URL`; never use the application database.

---

### Task 1: Classify webhook projection and inbox failures for retries

**Files:**
- Modify: `server/src/billing/service.ts`
- Modify: `server/src/billing/types.ts`
- Modify: `server/src/billing/store.ts`
- Test: `server/tests/billing-webhook.test.ts`
- Test: `server/tests/billing-store.integration.test.ts`

**Interfaces:**
- Add a typed `BillingPersistenceError` (or equivalent typed store result) that distinguishes retryable persistence failure from invalid verified delivery data.
- `handleWebhook` answers 503 for retryable Lago read or database write failures; it writes no inbox row on failure.
- A successful duplicate inbox insert race returns 200 duplicate only after the projection refresh was completed or another worker has already completed it.

- [x] **Step 1: Add tests for projection and inbox write failures**

Wrap the existing `memoryBillingStore()` and make `upsertSubscription` throw once; assert the first delivery returns 503, inbox remains empty, and retry returns 200 with projection and inbox present. Add a second test where `recordWebhookEvent` throws once after refresh and verify a retry re-runs the idempotent refresh and records the inbox.

```ts
expect(first.status).toBe(503);
expect(store.inbox.size).toBe(0);
expect(retry.status).toBe(200);
expect(store.inbox.size).toBe(1);
```

- [x] **Step 2: Run webhook tests and verify failure handling is incorrect**

Run: `bun test server/tests/billing-webhook.test.ts`
Expected: FAIL because generic store errors are not classified as retryable webhook failures.

- [x] **Step 3: Type persistence failures at the store/service seam**

Wrap database operation failures as `BillingPersistenceError` at `createBillingStore` methods used in webhook refresh and inbox writes. In `handleWebhook`, translate that type to fixed 503 output, leave the inbox untouched, and log the stable code. Keep signature/shape failures as 401/400 and do not blanket-convert all service bugs into retries.

- [x] **Step 4: Verify failure, replay, and out-of-order tests**

Run: `bun test server/tests/billing-webhook.test.ts server/tests/billing-store.integration.test.ts`
Expected: PASS; both storage-failure paths retry, known completed events do not re-read, and out-of-order deliveries still refresh from current provider state.

- [x] **Step 5: Commit the webhook retry behavior**

```bash
git add server/src/billing/service.ts server/src/billing/types.ts server/src/billing/store.ts server/tests/billing-webhook.test.ts server/tests/billing-store.integration.test.ts
git commit -m "fix(billing): retry webhook persistence failures" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Make projection refresh and inbox completion transaction-aware

**Files:**
- Modify: `server/src/billing/store.ts`
- Modify: `server/src/billing/service.ts`
- Modify: `server/src/db/client.ts` only if a transaction-capable store dependency needs a narrower type
- Test: `server/tests/billing-store.integration.test.ts`
- Test: `server/tests/billing-webhook.test.ts`

**Interfaces:**
- Add `BillingStore.applyWebhookProjection(input): Promise<"processed" | "duplicate">` only if projection writes and inbox insertion can safely share a local transaction; external Lago reads remain outside that transaction.
- The atomic transaction contains the local customer/subscription upserts and inbox insertion, so concurrent duplicate deliveries do not leave a completed inbox record without the projection.
- If an object type has no local projection work, recording its inbox event is still a valid completed result.

- [x] **Step 1: Add a real database failure/atomicity test**

Use a transaction-scoped test to force the final inbox insertion to fail after staging subscription updates. After rollback, assert neither new subscription projection nor inbox row committed.

- [x] **Step 2: Run the store integration test and verify current writes are split**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test server/tests/billing-store.integration.test.ts`
Expected: FAIL because projection upserts and inbox insert currently use separate database operations.

- [x] **Step 3: Put local projection updates and inbox insert in one transaction**

Keep Lago customer/subscription reads before the database transaction. Pass the authoritative projection records and event identity to one store operation. Use `ON CONFLICT` for duplicate event IDs, then return the durable winner result.

- [x] **Step 4: Verify rollback and replay**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test server/tests/billing-store.integration.test.ts server/tests/billing-webhook.test.ts`
Expected: PASS; transaction failures leave no partial local projection/inbox state and retries converge.

- [x] **Step 5: Commit the atomic projection/inbox operation**

```bash
git add server/src/billing/store.ts server/src/billing/service.ts server/src/db/client.ts server/tests/billing-store.integration.test.ts server/tests/billing-webhook.test.ts
git commit -m "refactor(billing): commit webhook projection with inbox" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
