# Payment Ordering Plan — Task 1 Report

## Outcome

Implemented deployment-scoped serialization for pending purchases. The schema and store enforce
one pending-order slot per deployment scope, independent of plan and provider. Same-pair retries
still replay the current order; a same-plan channel switch still cancels and closes the prior
order; a different-plan pending order produces an explicit 409 refusal without opening another
provider session. If cancellation loses a race to payment, the service re-reads and returns the
paid order.

Order amount/currency snapshots, version-CAS state transitions, and paid-fact uniqueness were left
unchanged. Later duplicate collections remain durable and manual; no refund behavior was added.

## TDD

1. Added the cross-plan/provider store integration assertion first.
2. Added service tests for an existing other-plan pending order and for a cancellation/payment race.
3. Ran `bun test server/tests/payment-service.test.ts` before production changes. The two new service
   tests failed as expected: the different-plan request resolved instead of refusing, and the
   channel switch returned a new order instead of the order that had just been paid. The existing
   tests passed.
4. Implemented the schema/store/service/route changes and added coverage for an insert-time
   serialization conflict.
5. The service, route, and dependent QA tests then passed.

The integration RED/GREEN database cycle could not be completed: `TEST_DATABASE_URL` was unset and
`127.0.0.1:55432` was not accepting connections. The integration test aborts in its test database
guard before test cases execute; no application database was used.

## Implementation and migration

- Added `payment_orders.deployment_scope`, `NOT NULL DEFAULT 'default'`, so existing rows receive a
  compatible deployment scope.
- Generated `server/drizzle/0076_productive_nextwave.sql` and its snapshot/journal metadata with
  `bun run --filter server db:generate`, supplying only `TEST_DATABASE_URL` for the Drizzle config.
- Reviewed the generated SQL:

  ```sql
  DROP INDEX "payment_orders_pending_pair_unique_idx";
  ALTER TABLE "payment_orders" ADD COLUMN "deployment_scope" text DEFAULT 'default' NOT NULL;
  CREATE UNIQUE INDEX "payment_orders_pending_scope_unique_idx"
    ON "payment_orders" USING btree ("deployment_scope")
    WHERE "payment_orders"."status" = 'pending';
  ```

  The old pair-only uniqueness is replaced by the deployment-scope partial unique index. The
  store's insert targets that partial index specifically, classifies a winning row as a same-pair
  replay or a competing purchase, and retries only a named primary-key collision.
- Updated Drizzle config selection so an explicitly supplied `TEST_DATABASE_URL` takes precedence
  during generation.
- No applied migration was edited. The generated migration was **not applied**: the dedicated test
  DB endpoint was unavailable, so applying it safely was not possible.

## Verification

| Command | Result |
|---|---|
| `bun test server/tests/payment-service.test.ts server/tests/payment-routes.test.ts server/tests/qa-batch1-payment-service.test.ts` | PASS — 68 tests, 0 failures |
| `bun run --filter server typecheck` | PASS |
| Targeted `bunx biome lint --error-on-warnings` on payment schema/store/types/service/routes, the integration and route tests, and `server/drizzle.config.ts` | PASS — 8 files |
| `git diff --check` | PASS |
| Full changed-file `bunx biome format` check | Existing formatting diffs were reported, including `service.ts:293`, which is outside the changed hunks; no automatic formatting was applied. |
| `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test server/tests/payment-store.integration.test.ts` | BLOCKED — `TEST_DATABASE_URL` unset; test guard aborted before DB access |
| Full changed-file Biome lint | Existing findings remain in the baseline: `qa-batch1-payment-service.test.ts` has a `let` that can be `const`, and `payment-service.test.ts` has a duplicate `cycle` key. Both locations are outside this change; they were not altered. |

## Commit

`fix(payments): serialize pending purchases per deployment`

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>

## Review fix round 1 — legacy upgrade safety and collision retry

### Migration status and authorized exception

The operator confirmed that `0076_productive_nextwave.sql` had reached **only the local disposable
PostgreSQL 17 test database**, and had not reached production or any shared/deployed database.
Repository history shows it was introduced by Task 1's local commit `70cf3d7`. Under the user's
explicit clarification for this fix round, the test-only generated migration was amended in place
to add the preflight **before** its index drop or column addition. This is a deliberate exception
for an undeployed generated migration, not permission to rewrite deployed migration history.

The current `billing_test` database remains post-0076. Its migration history was not reset,
rewritten, or reapplied. Legacy upgrade tests instead create a separate randomly named schema
**inside a rollback-only transaction** in that dedicated database. Each fixture has its own
legacy `payment_orders` and the old pending-pair unique index; `SET LOCAL search_path` keeps
the migration's unqualified names within that schema. A fixture rollback removes every
table/index/row/schema, and every test explicitly verifies its schema no longer exists.

### Fail-closed upgrade precondition and operator procedure

The deployment must have **at most one pending order across all plan/provider pairs** before
0076 can proceed. The first statement now:

1. Takes an `ACCESS EXCLUSIVE` table lock, held through the migration transaction, so no new
   purchase can race the count and subsequent index replacement.
2. Counts all legacy pending orders, not one plan/provider pair.
3. Raises an actionable `P0001` exception if more than one exists, before dropping any index
   or altering schema.

The error's hint and migration comments require operators to pause checkout, reconcile all
open provider sessions, close/cancel unpaid sessions at their providers and via the existing
CAS-backed local cancellation flow, preserve paid facts/order price snapshots/anomaly evidence,
then verify that no more than one pending order remains before rerunning transactionally.
The migration neither auto-cancels orders nor chooses a winner: outstanding remote sessions
can still collect money, and paid evidence remains durable for manual resolution.

### TDD evidence

- Added the migration preflight integration test before changing the migration. Against the old
  SQL, executing the migration's **first statement** resolved (it dropped the old index) rather
  than producing the expected actionable refusal. This was the expected RED failure.
- Added a real primary-key collision test before changing store error handling. The test inserts
  a terminal row, makes the generator emit that existing ID followed by a fresh ID, and calls
  the real store/PostgreSQL insert. RED surfaced a wrapped `DrizzleQueryError`, whose Bun SQL
  cause uses `errno: "23505"` and `constraint: "payment_orders_pkey"`. The old detector looked
  only at outer `code`/`constraint_name`, so it failed to retry.
- Updated the detector to traverse the cause chain safely, recognizing only the named order
  primary-key constraint and SQLSTATE `23505`, using Bun SQL and postgres.js field spellings.
  Other errors are still propagated; immutable price snapshots, CAS and paid-fact uniqueness
  were untouched.
- GREEN: competing legacy orders now fail before any destructive migration statement; the old
  index, lack of deployment scope column, pending rows and amounts remain intact. A reconciled
  legacy fixture upgrades successfully and preserves the remaining pending order's price
  snapshot. The forced primary-key collision retries and persists the fresh order.
- Initial fixture execution exposed Bun's lazy SQL-query behavior when passed directly into
  `expect(...).rejects`; wrapping it with `Promise.resolve` made the query execute and produced
  the actual RED result. No production change was made to accommodate test-only behavior.

### Validation and isolation

Used fresh disposable test-only credentials created solely in `openbot-billing-test-postgres`
at `127.0.0.1:55432`, supplied only through `TEST_DATABASE_URL`. No application DB or copied
application credentials were used.

- `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test server/tests/payment-ordering-migration.integration.test.ts server/tests/payment-store.integration.test.ts server/tests/payment-service.test.ts`
  — PASS: **59 tests, 0 failures**.
- `bun run --filter server typecheck` — PASS.
- `bunx biome lint --error-on-warnings server/src/billing/payments/store.ts server/tests/payment-store.integration.test.ts server/tests/payment-ordering-migration.integration.test.ts`
  — PASS, three files.
- `bunx biome format server/src/billing/payments/store.ts server/tests/payment-store.integration.test.ts server/tests/payment-ordering-migration.integration.test.ts`
  — PASS, three files; `git diff --check` — PASS.
- Final expanded regression:
  `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test server/tests/payment-ordering-migration.integration.test.ts server/tests/payment-store.integration.test.ts server/tests/payment-service.test.ts server/tests/payment-routes.test.ts server/tests/qa-batch1-payment-service.test.ts`
  — PASS: **81 tests, 0 failures, 246 assertions**.
- Dedicated DB checks confirmed **zero** `payment_upgrade_%` schemas remaining, the public
  `payment_orders_pending_scope_unique_idx` intact, and migration history still **77 entries**.
- After the final test run, the fresh disposable credential role was dropped successfully.
  Neither the existing test DB nor its public migration history was reset.

Self-review: no automatic financial disposition was added; all destructive DDL remains after
the preflight; the migration lock closes the preflight/write race; fixtures cannot change the
public migration history; and the primary-key retry is constrained to the real PostgreSQL
constraint rather than a generic uniqueness error.
