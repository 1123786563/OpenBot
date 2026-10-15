# R5-3 Advisory Lock Timeout Review Repair Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct error-chain handling for PostgreSQL lock timeouts and Drizzle-wrapped SET/RESET fault errors.

**Architecture:** Keep the existing pinned-session lock timeout design. Add a small cause-chain utility for SQLSTATE extraction and use it to recognize `55P03`; update fault-injection assertions to verify the injected error is retained in the cause chain while continuing to assert session reuse/disposal and independent lock acquisition.

**Tech Stack:** TypeScript, Bun, PostgreSQL, Drizzle ORM 0.45.2, Postgres.js 3.4.9.

**Spec:** `docs/superpowers/plans/2026-10-12-mastra-r5-3-advisory-lock-timeout.md`; independent findings in `.superpowers/sdd/2026-10-12-mastra-r5-3-advisory-lock-timeout/reports/task-review.md`.

## Global Constraints

- Work only in `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`; preserve HEAD `b1532dbe4ec4d2e64b58fd31c57a7c1863ffd155`.
- No staging, commit, stash, reset, rebase, push, merge, or main-checkout edits.
- Own only `server/scripts/migration-runner.ts` and `server/tests/enterprise/schema-migration-r2.integration.test.ts`.
- Do not start or modify PostgreSQL. Database-backed verification is blocked until the user restores the approved local test service.
- Preserve timeout error duration and retain underlying Drizzle/PostgreSQL cause; keep failed/uncertain sessions fail-closed.

## Review Focus

- A nested `55P03` is found even when outer cause-chain objects carry unrelated codes; timeout errors retain the full database error chain.
- Injected SET and RESET failures survive Drizzle wrapping; assertions prove cause-chain retention while preserving existing safe reuse, pool shutdown, and lock probe behavior.
- Cyclic or malformed cause values cannot make error inspection loop forever or throw a new error.
- Non-timeout SQLSTATEs preserve their original error path.
- Tests requiring PostgreSQL remain explicitly unverified while the approved endpoint is unavailable.

## DAG and Task

Single task `R5-3-LOCK-TIMEOUT-REVIEW-REPAIR`; no downstream dependencies.

### Task 1: Handle wrapped timeout and fault errors

**Files:**
- Modify: `server/scripts/migration-runner.ts`
- Test: `server/tests/enterprise/schema-migration-r2.integration.test.ts`

**Interfaces:**
- Consumes: `migrateWithValidationBoundary(client, migrationsFolder, options?)` and the existing `isConnectionFailure(error)` cause-chain behavior.
- Produces: a safe helper that finds a string SQLSTATE in an error/cause chain (cycle-safe), used to detect `55P03` without discarding the original wrapped error; tests assert causes rather than impossible top-level identity.

- [ ] Add/adjust focused assertions first: wrapped `55P03` is classified even when an outer cause object has `code: 'ERR_QUERY'`, and the original nested cause is preserved; SET and RESET rejection retains the injected error somewhere in the rejection's cause chain. Confirm failure against the current implementation without requiring PostgreSQL.
- [ ] Implement cycle-safe matching of the requested SQLSTATE anywhere in the cause chain and route timeout recognition through it; preserve the complete wrapped Drizzle error as the timeout error's cause.
- [ ] Change SET/RESET and timeout integration assertions to check cause-chain containment across Drizzle's wrapper, retaining configured-duration, reservation reuse, pool disposal, no-DDL, and independent lock acquisition checks.
- [ ] Run focused DB-independent tests, all feasible same-revision checks, scoped type/lint/diff checks; record unavailable PostgreSQL integration evidence without retries.
- [ ] Freeze owned-file hashes and task-only patch; write implementation report.

## Validation and Review

- Required DB-independent focused assertions pass.
- PostgreSQL-backed assertions are not marked passed absent an available approved service.
- Independent task review and backend validation inspect the same frozen file hashes.
