# R5-3 Pinned Adapter Review Repair Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close both medium findings from the independent review of the pinned Postgres.js migration adapter.

**Architecture:** Preserve the existing reserved-backend adapter and transaction/lock cleanup rules. Move adapter construction inside the resource cleanup guard, then add the missing disposable-database regression that terminates the reserved backend while migration 0066 is paused.

**Tech Stack:** TypeScript, Bun, PostgreSQL, Postgres.js 3.4.9, Drizzle ORM 0.45.2.

**Spec:** `docs/plans/superpowers/2026-10-11-mastra-r5-3-f1-b-pinned-client-adapter.md`; independent findings in `.superpowers/sdd/2026-10-11-mastra-r5-3-f1-b-pinned-client-adapter/reports/task-review.md`.

## Global Constraints

- Work only in `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`; preserve HEAD `b1532dbe4ec4d2e64b58fd31c57a7c1863ffd155`.
- Do not stage, commit, push, merge, reset, rebase, or stash.
- Use only the approved disposable PostgreSQL base and test harness-created random databases; unset `DATABASE_URL` for integration runs and set only the four URLs in the adapter task brief.
- Preserve separate 0065 and 0066 migration invocations and the same reserved backend for lock and migration SQL.
- Source ownership remains `server/scripts/migration-runner.ts` and `server/tests/enterprise/schema-migration-r2.integration.test.ts`; do not revert unrelated worktree changes.

## Review Focus

- Adapter construction throws after reservation but before Drizzle setup: release the clean reservation and prove bounded same-pool reuse.
- Reserved backend is terminated during the 0066 barrier: migration fails, its pool is disposed, no uncommitted 0066 journal entry remains, and the waiting runner cannot proceed while A is still executing.
- Fixture cleanup runs on all paths and affects only harness-created random databases.

## DAG and Task

Single task `R5-3-F1-B-F1-ADAPTER-REPAIR` covers findings R5-3-F1-B-F1-ADAPTER-R1 and R2. The findings share the same migration helper and integration suite; splitting them would require two reviews of overlapping failure-state behavior. No dependency cycle or uncovered acceptance remains.

### Task 1: Guard adapter construction and test backend termination

**Files:**
- Modify: `server/scripts/migration-runner.ts`
- Test: `server/tests/enterprise/schema-migration-r2.integration.test.ts`
- Record: `.superpowers/sdd/2026-10-11-mastra-r5-3-f1-b-pinned-client-adapter-repair/`

**Interfaces:**
- Consumes `migrateWithValidationBoundary(client, migrationsFolder)` and the existing barrier fixture/test helpers.
- Produces the same exported helper contract; all failures after `client.reserve()` flow through one cleanup path whose safe-release predicate remains `transactionClean && (!lockAttempted || (lockAcquired && unlockConfirmed))`.

- [ ] Add a fault-injection test that makes pinned adapter construction fail immediately after reservation, expects the injected error, and proves a bounded query succeeds through the same `max: 1` pool.
- [ ] Run the focused construction-failure test and confirm it fails before the guard change due to leaked reservation or absent cleanup.
- [ ] Move reserved adapter property access/assignment into the guarded operation. Any construction exception must leave transaction clean and lock unattempted, then call `reserved.release()`; a failed release must end the dedicated pool.
- [ ] Add a barrier test with A, B, and the control connection on one shared harness-created random fixture database. Attach rejection handlers to A and B immediately. Pause A during 0066, record A's reserved PID, and prove B's distinct PID waits on the exact runner-lock key in that database before termination. Terminate only A's PID through the control connection. Keep the control-held 0066 barrier closed while verifying A's backend is gone, A rejects, A's pool rejects a bounded query, and 0066 has no journal row. Define A stopped by server-side backend death/transaction abort; only then release the barrier and require B to finish within a bound. Settle both runner promises and release barriers in `finally`.
- [ ] Run the complete approved R2 integration suite, migration entrypoint tests, migration journal tests, scoped strict TypeScript, Biome lint-only, Drizzle check with setup URL, and scoped `git diff --check`.
- [ ] Freeze before/after manifests and task delta; record exact hashes and command exit codes in implementation report. Do not stage or commit.

## Validation and Review

- `cd server && env -u DATABASE_URL` plus only the four approved `ENTERPRISE_TEST_*_DATABASE_URL` values and `ENTERPRISE_TEST_R2_MIGRATION_MODE=fresh bun test tests/enterprise/schema-migration-r2.integration.test.ts` must pass, including the two new fault paths.
- `cd server && bun test tests/enterprise/migration-entrypoints.test.ts` passes 2 tests; `cd server && bun test tests/migration-journal.test.ts` passes 8 tests.
- Use the exact scoped commands from the parent adapter implementation report for Drizzle check, strict TypeScript, Biome lint-only, and `git diff --check`.
- Independent backend validation and independent task review must inspect the same frozen hash. Any finding requires a scoped repair and re-review before outer OCR.
