# T2 Active Run Lookup Fix 3 — Isolated Lease Predicate Regression

> **For agentic workers:** close only M1-residual from Fix2 review. Keep the test DB-gated and do not access a database.

**Goal:** Independently prove that getActiveForThread excludes a Run with only an expired Run lease and a Run with only an expired current-attempt lease.

**Source of truth:** Active Run Lookup original plan, Fix1/Fix2 plans, Fix2 implementer report, and M1-residual in the Fix2 review report.

## Global Constraints

- Edit only the existing active lookup test block in server/tests/enterprise/runs.integration.test.ts.
- Never run the DB-backed suite or start/probe/access a database. Do not run migrations.
- No production/schema changes or unrelated integration edits.
- No commit/stage/stash/reset/rebase/merge/push/release/worktree deletion.
- Remain explicit that DB assertions are unexecuted and runtime-unverified.

## Review Focus

- Attempt-only expiry returns null while Run lease remains live.
- Attempt lease is restored and update count asserted; Run-only expiry then returns null.
- Every UPDATE identifies tenant + Run ID + attempt ID where applicable and asserts exactly one affected row.
- Current cleanup remains valid even when Run lease is expired.

## Task 1 — Split lease expiry assertions

**Role:** backend_implementer. **Validator:** backend_validator. **Reviewer:** reviewer. **Dependency:** Fix2. **Commit policy:** uncommitted checkpoint only.

**Owned file:** only the existing test block in server/tests/enterprise/runs.integration.test.ts.

1. Verify current file hash equals Fix2 checkpoint 7f999cfb10d1e592487b1086caeae387b9525e8ae1ae00af03dc4aa8cfb6576a; capture full before manifest.
2. In the test, update only the current replacement attempt lease to an expired value using tenant/run/attempt/generation predicates, use returning() and assert one row, then assert lookup returns null.
3. Restore only that attempt lease to a live value; use returning() and assert one row; assert lookup now returns the replacement attempt.
4. Expire only the Run lease, use returning() and assert one row, then assert lookup returns null. Keep user stop and terminal assertions in their existing valid order; cleanup must still run.
5. Run DB-free scoped Biome and diff checks only; save full manifests/increment/report under .superpowers/sdd/2026-10-12-mastra-t2-active-run-lookup-fix3/reports/.

**Acceptance:** A regression removing either individual SQL lease predicate makes the corresponding gated assertion fail. The test remains unexecuted until the designated disposable DB is explicitly ready.

**Failure handling:** If lease timestamps or helper semantics prevent safe restoration, stop before editing other files and report the exact blocker.
