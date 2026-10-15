# T2 Active Run Lookup Fix 1 — Persisted Query Regression

> **For agentic workers:** repair only review finding M1 from `task-1-review-report.md`. Do not broaden implementation or access a database.

**Goal:** Add a database-gated integration regression proving the public `RunService.getActiveForThread` executes the scoped persisted query and that stale lookup identity cannot stop a replacement attempt.

**Source of truth:** Active Run Lookup plan `docs/plans/2026-10-12-mastra-t2-active-run-lookup.md`, implementation report, validation report, and M1 reviewer report `.superpowers/sdd/2026-10-12-mastra-t2-active-run-lookup/reports/task-1-review-report.md`.

## Global Constraints

- Fix M1 only. Keep the existing pure DB-free tests.
- Add a DB-gated case using the existing `runs.integration.test.ts` fixture/helpers; test is gated by the existing disposable DB URL contract and must not run unless the user explicitly says the disposable DB is ready.
- Do not start, probe, or access any database in this task. No schema/migration changes.
- Do not alter unrelated test contents or prior user changes. Make a minimal appended test only.
- No commit, stage, stash, reset, rebase, merge, push, release, or worktree deletion.

## Review Focus

- Test calls public `runs.getActiveForThread`, verifies returned run/attempt identity, and verifies absent or terminal outcomes when feasible using the established fixture.
- Test advances a run to a replacement attempt, then verifies `runs.stop` with old attempt/generation rejects as stale and replacement remains active.
- Test cleanup preserves suite isolation; it is gated and clearly marked unexecuted until DB is ready.

## Task 1 — Add DB-gated regression

**Role:** backend_implementer. **Validator:** backend_validator. **Reviewer:** reviewer. **Dependency:** original Active Run Lookup checkpoint and M1. **Commit policy:** uncommitted checkpoint only.

**Owned file:** `server/tests/enterprise/runs.integration.test.ts`, append exactly one focused integration test near existing Run lifecycle tests. No production file changes.

1. Record HEAD, complete before-manifest, and the exact current file hash; ensure the file hash matches the prior implementation report's protected-file hash before editing.
2. Add a test that calls existing `createRunInput`, starts a Run, asserts `getActiveForThread(scope, threadId)` returns the exact Run and original attempt ID/generation, expires/replaces the attempt with the existing `runStore.expireLease` test helper, then asserts the new lookup returns the replacement identity.
3. Assert `runs.stop` using old attempt ID/generation rejects with `RUN_ATTEMPT_STALE` and `runs.get` confirms the replacement Run remains active. Clean up with a scoped cancel in `finally` or matching suite conventions.
4. Do not run this integration suite or any command that opens DB connections. Run only DB-free affected tests, scoped Biome, static typecheck if available, and diff check. Report the DB-gated case as added but unexecuted/unverified.
5. Save before/after manifests, task increment/hash, exact checks and report under `.superpowers/sdd/2026-10-12-mastra-t2-active-run-lookup-fix1/reports/`.

**Acceptance:** The reviewer's M1 evidence gap is addressed by an integration regression that will exercise persisted lookup and stale stop fencing once the designated disposable database is ready; no claim of runtime pass is made now.

**Failure handling:** If the fixture cannot support the requested behavior with a one-test append, stop before editing unrelated test or production files and report the precise blocker.
