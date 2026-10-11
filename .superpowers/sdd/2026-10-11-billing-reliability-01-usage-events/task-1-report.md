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
