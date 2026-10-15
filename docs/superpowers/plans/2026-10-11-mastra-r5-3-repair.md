# R5-3 Migration Compatibility and Lock-Window Repair Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close R5-3 review findings by preserving 0063's skip semantics for already-native JSON arrays and committing migration 0065 before deployment validates its constraints in 0066.

**Architecture:** First narrow 0065's set-based legacy diagnostics to string-encoded rows, with a regression fixture for a native array that historical migrations accepted. Then extract the deployment migration orchestration into a shared helper: when the folder contains the 0065/0066 boundary, run Drizzle once with a temporary coherent journal/fileset through 0065, await its commit, and run the original complete folder. Keep Drizzle responsible for journal ordering, hashes, and per-call transactionality.

**Tech Stack:** TypeScript, Bun, PostgreSQL, Drizzle ORM 0.45.2.

**Spec:** `docs/superpowers/specs/2026-10-11-mastra-intelligence-only-design.md`; parent repair source `docs/superpowers/plans/2026-10-11-mastra-ocr-r5-boundary-migration-fixes.md` Task 3; findings `.superpowers/sdd/2026-10-11-mastra-ocr-r5-boundary-migration-fixes/reports/task-r5-3-review.md`; root-cause evidence `.superpowers/sdd/2026-10-11-mastra-ocr-r5-boundary-migration-fixes/reports/r5-3-root-cause-research.md`.

## Global Constraints

- Use only the isolated loopback PostgreSQL database `127.0.0.1:5434/openbot_enterprise_r2_codex_20261009`; unset `DATABASE_URL` for Bun integration suites and set only explicit approved test URLs; generator/check commands may use only the exact setup URL.
- Do not reset, amend, rebase, stash, commit, push, merge, deploy, or touch production/shared databases. Preserve the observed workspace HEAD and all unrelated R5 changes.
- Preserve historical 0063 behavior: rows whose `attachment_ids` are already JSON arrays are skipped by legacy UUID/duplicate/holder diagnostics; string-encoded rows retain all existing diagnostics and are backfilled.
- Preserve historical migration files other than the reviewed 0065 correction, journal entry order, existing constraints, lock order, and Drizzle transaction/hash behavior. The 0065 hash must naturally reflect its final SQL bytes. Never edit the production journal to create a boundary.
- R5-3-F1-A must be independently verified and reviewed before R5-3-F1-B starts. Each checkpoint uses exact before/after file hashes, manifests, patch, and review package.

## Review Focus

1. Native arrays with duplicate/non-UUID elements or absent holder rows remain accepted by historical 0063 semantics; native non-array values and encoded strings that decode to non-arrays still fail their 0065 diagnostic.
2. A normal deployment starting at index 64 commits 0065 before entering 0066; valid DML completes while 0066 validation is deterministically paused.
3. A second deployment runner waits on the migration-wide session advisory lock across both calls; after the first runner finishes, it observes the committed journal and does not replay 0066.
4. A 0066 failure leaves the committed 0065 migration/journal state intact and retry applies 0066 without corrupting order.
5. Folders without the 0065→0066 boundary still use one normal Drizzle migration call; copied temporary journals exactly match copied SQL files and are removed on success/failure.
6. CLI, container, CI, and enterprise-test entry points still use the same guarded deployment runner and the approved test database only.

## Task DAG and Acceptance Mapping

| ID | Source | Acceptance | Depends on | Owner | Validator | Owned files | Interfaces | Verification | Status |
|---|---|---|---|---|---|---|---|---|---|
| R5-3-F1-A | `task-r5-3-review.md` R5-3-R2 | Skip native arrays only; retain native/encoded non-array classification; restrict UUID/duplicate and holder validation to `was_encoded`; test native-array compatibility and keep encoded diagnostics green | R5-3 review | backend_implementer | backend_validator | `server/drizzle/0065_restore_schema_invariant_guards.sql`; `server/tests/enterprise/schema-migration-r2.integration.test.ts` | Existing 0065 diagnostics/backfill and migration test fixture APIs | Exact isolated migration suite, SQL structure, Biome, `git diff --check` | verified (2 pass/174 assertions; reviewer + validator PASS) |
| R5-3-F1-B | `task-r5-3-review.md` R5-3-R1 | Shared deployment helper serializes callers with session lock `(1330795348, 1296641874)` and commits after 0065; CLI and tests use it; a second runner waits and then observes index 66 exactly once; valid DML succeeds while 0066 is paused; failure/retry keeps journal coherent | R5-3-F1-A verified | backend_implementer | backend_validator | Create `server/scripts/migration-runner.ts`; modify `server/scripts/migrate.ts`, `server/tests/enterprise/schema-migration-r2.integration.test.ts`, and `server/tests/enterprise/migration-entrypoints.test.ts` | `migrateWithValidationBoundary<TSchema extends Record<string, unknown>>(database: PostgresJsDatabase<TSchema>, migrationsFolder: string): Promise<void>`; acquire/release namespaced session lock, stage coherent prefix through idx 65, then call Drizzle on prefix and original folder | Deployment entrypoint and concurrency tests, exact isolated migration suite, Drizzle journal checks, strict scoped tsc, Biome, diff | running |

## Task Briefs

### Task R5-3-F1-A — Preserve native attachment-array semantics

**Files:** migration 0065 and migration R2 integration suite only.

- [ ] Add a through-64 legacy fixture containing a native JSON array with a duplicate or non-UUID member and no matching holder rows; assert migration through 0065 succeeds and leaves that array unchanged. Add native object/scalar and encoded JSON string decoding to non-array fixtures; both retain `non_array_intent_count=1` failures. Retain encoded UUID/duplicate/holder cases.
- [ ] Run the focused suite before changing SQL and record the RED failure against the current broad native-array diagnostics.
- [ ] Keep `non_array` true for any successfully parsed non-array, whether native or decoded from an encoded string; keep malformed JSON limited to encoded strings. Carry `was_encoded` through element expansion and scope UUID/duplicate and holder matching diagnostics to encoded arrays only. Native arrays are skipped exactly as 0063 did. Preserve encoded backfill and counters.
- [ ] Run the exact isolated suite from `server/` with `env -u DATABASE_URL`, `ENTERPRISE_TEST_R2_MIGRATION_MODE=fresh`, and all four URLs targeting only `127.0.0.1:5434/openbot_enterprise_r2_codex_20261009`.
- [ ] Run scoped SQL structure assertions, `bunx biome check tests/enterprise/schema-migration-r2.integration.test.ts`, and scoped `git diff --check`; freeze the exact two-file before/after snapshot, manifest, patch, hashes, and command outputs.

**Expected:** The new native-array case fails before SQL narrowing and passes afterward; encoded diagnostics and 0065 backfill tests remain green.

### Task R5-3-F1-B — Commit 0065 before validating 0066 in deployment

**Files:** create `server/scripts/migration-runner.ts`; modify `server/scripts/migrate.ts`, `server/tests/enterprise/schema-migration-r2.integration.test.ts`, and `server/tests/enterprise/migration-entrypoints.test.ts`.

- [ ] Add a failing entrypoint assertion that `scripts/migrate.ts` delegates to one exported shared helper and does not call Drizzle `migrate()` directly. Add helper unit/fixture assertions for no-boundary folders, a coherent prefix through idx 65, journal/file parity, and temporary-folder cleanup on both resolve/reject.
- [ ] Add an isolated through-64 integration case that calls the shared helper used by the deployment CLI, with 0066 modified only in a copied fixture to pause on a test-only session advisory lock immediately before `VALIDATE CONSTRAINT`. Hold that key from a control connection, start the actual helper, and wait until PostgreSQL reports the migrator blocked at the 0066 barrier.
- [ ] During the barrier, execute a valid `UPDATE enterprise_runs` through a separate connection and require completion before releasing 0066. This DML assertion must fail if the 0065 locks remain in the outer migration transaction. Release the barrier, await the helper, then assert journal indexes 0–66 are applied and all three named constraints are validated.
- [ ] Add a concurrent second helper/client while the first is paused. Assert it waits on the distinct migration-wide advisory lock `(1330795348, 1296641874)`; release 0066 and require both invocations to resolve with exactly one index-66 journal row and validated constraints.
- [ ] Add a failure/retry variant: a copied 0066 raises after 0065 commits; assert 0065 remains in the database journal, 0066 does not, and retry with the valid copied folder completes. Always release advisory locks, end connections, and await settled promises before dropping fixtures.
- [ ] Implement `migrateWithValidationBoundary<TSchema extends Record<string, unknown>>(database: PostgresJsDatabase<TSchema>, migrationsFolder: string): Promise<void>` in `server/scripts/migration-runner.ts`. Acquire the namespaced PostgreSQL session advisory lock `(1330795348, 1296641874)` through the supplied single-connection database before migration metadata decisions; hold it across both Drizzle calls and release it in `finally`. If the journal contains idx 65 and a later validation migration at idx 66, create a unique temp directory with SQL files and journal entries through 65, call Drizzle `migrate` on the prefix, await that transaction commit, then call Drizzle `migrate` on the original folder. For folders without that boundary call Drizzle once. Never mutate the source journal; remove temp files in `finally`. Keep the test-only 0066 barrier advisory key distinct from the runner lock key.
- [ ] Change `scripts/migrate.ts` to call the shared helper after role preconditions; preserve the one-connection client and enterprise role bootstrap ordering. Update entrypoint tests to lock that call path.
- [ ] Run entrypoint tests and the exact isolated migration integration suite. Run migration-journal tests, `DATABASE_URL='<approved setup URL>' bunx drizzle-kit check --config=drizzle.config.ts`, strict scoped TypeScript, Biome on owned TypeScript files, and scoped `git diff --check`. Record actual commands/results and freeze exact snapshots/hashes/patch.

**Expected:** The migration helper serializes concurrent deployment invocations, resolves the 0065 transaction before invoking the full folder, and permits valid DML while 0066 is deterministically blocked. A 0066 failure leaves only 0065 committed, and a retry completes in journal order.

**Failure handling:** If Drizzle migration discovery or journal matching cannot be preserved by the temporary-prefix helper, stop and report the failing evidence rather than hand-editing journal semantics. If the advisory-lock test does not observe an actual 0066 wait or writer success, it is not acceptance evidence. Never substitute a sleep-only test. Do not claim 0063's original runtime/database state was inspected.
