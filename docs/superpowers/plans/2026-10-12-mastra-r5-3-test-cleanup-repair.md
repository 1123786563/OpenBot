# R5-3 Migration Regression Cleanup Repair Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound failure-path cleanup in the new adapter and backend-termination regressions without masking their primary assertion failures.

**Architecture:** Keep production behavior unchanged. Add bounded cleanup to the termination test so unsuccessful barrier release shuts down runner pools before promise settlement; wrap the adapter-construction test client in its own `try/finally`.

**Tech Stack:** Bun test, TypeScript, Postgres.js 3.4.9.

**Spec:** `docs/superpowers/plans/2026-10-12-mastra-r5-3-adapter-review-repair.md`; independent task finding `.superpowers/sdd/2026-10-11-mastra-r5-3-f1-b-pinned-client-adapter-repair/reports/task-review.md`.

## Global Constraints

- Exact worktree: `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`; preserve HEAD `b1532dbe4ec4d2e64b58fd31c57a7c1863ffd155`.
- Modify only `server/tests/enterprise/schema-migration-r2.integration.test.ts`; preserve other worktree edits.
- No stage, commit, stash, reset, rebase, push, or merge.
- Any DB run uses only the approved disposable base and harness-created random databases with the four explicit URLs and `DATABASE_URL` unset.

## Review Focus

- Barrier unlock fails or a runner remains blocked: close dedicated pools under a bound, settle runner promises under a bound, and preserve the original test failure.
- Adapter setup/reuse assertion fails: close the separate max:1 test client in `finally`.
- If test assertions pass but cleanup fails, fail the test; if both fail, preserve the body error and report cleanup errors as secondary evidence.

## DAG and Task

One task `R5-3-TEST-CLEANUP-REPAIR` addresses the reviewer Medium unbounded-finally finding and Low test-client leak. Both are isolated changes within the same test and share cleanup helpers; no dependency cycle or acceptance gap.

### Task 1: Bound test-only cleanup

**Files:**
- Test: `server/tests/enterprise/schema-migration-r2.integration.test.ts`

**Interfaces:**
- Consume existing `terminationA` and `terminationB` promises, each immediately wrapped to resolve to a fulfilled/rejected outcome.
- Preserve the existing barrier, PID, pool-disposal, and journal assertions; do not alter production migration code.

- [ ] Add bounded cleanup utilities for runner settlement and pool shutdown. Execute every cleanup step independently so one failure never skips later pool closes; treat false advisory unlock as failure. Capture body and cleanup errors separately: preserve the original body error when it exists, and fail on cleanup errors when the test body succeeded.
- [ ] Make termination-test cleanup attempt bounded barrier unlock; if unlock errors, times out, or returns false, close both dedicated runner pools immediately to release waiters. Bound A/B settlement and every pool close, including control connection shutdown.
- [ ] Wrap `adapterConstructionClient` assertions in its own `try/finally`; always bound `end({ timeout: 5 })`, preserving body failure and failing a successful test if client cleanup fails.
- [ ] Add focused helper tests for false/rejected unlock, stalled settlement, independent pool-close attempts, preservation of the body error when both body and cleanup fail, and failure when cleanup alone fails after a successful body.
- [ ] Run the exact approved R2 integration suite, entrypoint and journal tests, scoped strict TypeScript, Biome lint-only, Drizzle check with setup URL, and scoped `git diff --check`. Preserve database URL isolation.
- [ ] Freeze a task-only delta and hashes; record evidence in the task report without stage/commit.

## Validation and Review

- The repaired cleanup has no unbounded `await` of runner promises in `finally`.
- The original primary test failure remains visible even when cleanup also fails.
- Cleanup failure is fatal when the test body otherwise passed.
- Focused tests prove false/rejected unlock, stalled settlement, and independent pool-close behavior within fixed deadlines.
- Focused tests prove both error-precedence cases: body failure remains observable with cleanup failure, and cleanup failure makes an otherwise successful body fail.
- Independent review must verify bounded behavior and exact frozen hash.
