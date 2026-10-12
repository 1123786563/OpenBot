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
