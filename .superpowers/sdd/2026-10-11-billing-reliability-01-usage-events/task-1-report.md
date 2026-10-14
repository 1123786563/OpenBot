# Plan 01 Task 1 — Durable Usage Outbox

## Implemented

- Added `usage_outbox` with `event_id` as the primary identity and a separate unique `transaction_id`.
- Persisted all immutable event facts: source, customer key, transaction ID, integer input/output tokens, model, client, and occurrence time.
- Added database checks for supported sources, non-negative token counts, and valid per-target delivery states.
- Added independent Lago and credits delivery states, per-target last error codes, timestamps, and pending-state/creation-time indexes.
- Added `createUsageOutbox` with durable insert/replay, immutable-fact conflict detection, pending reads, independent delivery updates, and target-specific delivery-failure recording.
- Added integration tests for initial insert and replay, conflicts across every immutable fact, independent target progress/completion, and failure state.
- Added the schema to the shared export and Drizzle generation config. Generated migration `server/drizzle/0075_volatile_tag.sql` and its journal/snapshot metadata using the documented generation command with a non-live placeholder URL.

## TDD and verification

**Red — before implementation**

Command: `bun test server/tests/billing-usage-outbox.integration.test.ts`

Output: `Cannot find module '../src/billing/usage-outbox'`; `0 pass, 1 fail, 1 error` (exit 1). This was the expected missing-interface failure.

**Database integration attempt**

Command: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test server/tests/billing-usage-outbox.integration.test.ts`

Result: could not start because `TEST_DATABASE_URL` is unset. The test guard reported: `TEST_DATABASE_URL must point at a dedicated PostgreSQL test database. Do not rely on DATABASE_URL`. No database was connected and the migration was not applied.

**Green checks**

- `bun run --filter server typecheck` — passed (exit 0).
- `bunx biome check server/src/billing/usage-outbox.ts server/src/db/schema/usage-outbox.ts server/src/db/schema/index.ts server/tests/billing-usage-outbox.integration.test.ts` — passed (exit 0).
- `git diff --check` — passed (exit 0).
- Inspected generated migration SQL and metadata: they contain the primary event identity, unique transaction ID, non-negative token checks, and both delivery indexes.

## Limitation

PostgreSQL integration assertions remain unverified until a dedicated `TEST_DATABASE_URL` is available. The application `DATABASE_URL` was not used.

## Review fix — late delivery failures (2026-10-11)

Commit subject: `fix(billing): preserve delivered usage outbox targets`.

- Made failure recording an atomic `UPDATE ... WHERE event_id = ... AND <target>_status = 'pending'`. It no longer writes target status. A late failure is a no-op after delivery, preserving the delivery state, error code, and update timestamp.
- Retained the typed missing-event error by checking existence only when the conditional update affects no row.
- Added regressions for both Lago and credits: complete delivery, report a late failure, assert the persisted row is unchanged, and verify it is absent from pending work.
- The first database run exposed existing cross-test contamination: pending assertions saw earlier tests' unfinished rows (`4 pass, 2 fail`). Moved prefix-scoped cleanup to `afterEach`, retaining pool closure in `afterAll`. No application rows are deleted.

### Verification evidence

Before a dedicated database was supplied, both pre-fix and post-fix attempts of `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test server/tests/billing-usage-outbox.integration.test.ts` stopped at the missing `TEST_DATABASE_URL` guard (`0 pass, 1 fail, 1 error`).

The user then supplied an isolated, migrated PostgreSQL database at `127.0.0.1:55432/billing_test`; no application `DATABASE_URL` was used.

- **Red:** With the original unconditional update temporarily restored, `bun test server/tests/billing-usage-outbox.integration.test.ts -t 'a late'` against that dedicated database failed: `0 pass, 4 filtered out, 2 fail`. Both regressions observed changed rows: delivered status reset to pending, the late error written, and the update timestamp changed.
- **Green:** After restoring the conditional fix, `bun test server/tests/billing-usage-outbox.integration.test.ts` against the same database passed: `6 pass, 0 fail, 20 expect() calls`.
- `bun run --filter server typecheck` — `server typecheck: Exited with code 0`.
- `bunx biome check server/src/billing/usage-outbox.ts server/tests/billing-usage-outbox.integration.test.ts` — `Checked 2 files. No fixes applied.` (exit 0).
- `git diff --check` — passed (exit 0).

The initial database-verification limitation above is now resolved for this focused integration suite.
