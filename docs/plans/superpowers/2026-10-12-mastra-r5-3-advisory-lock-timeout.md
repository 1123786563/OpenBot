# R5-3 Migration Advisory Lock Timeout Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a deployment migration runner from waiting indefinitely for the session advisory lock.

**Architecture:** Add a positive millisecond timeout option to the private migration helper with a 30-second production default. Configure PostgreSQL's session `lock_timeout` on the pinned reserved backend immediately before lock acquisition, reset it immediately after the acquisition attempt, and terminate the dedicated pool whenever setting cleanup is uncertain. Keep the existing same-backend lock and migration invariant.

**Tech Stack:** TypeScript, Bun, PostgreSQL, Postgres.js 3.4.9, Drizzle ORM 0.45.2.

**Spec:** `docs/plans/superpowers/2026-10-11-mastra-r5-3-f1-b-pinned-client-adapter.md`; outer OCR finding in `.superpowers/sdd/2026-10-11-mastra-r5-3-repair/reports/ocr-workspace-r2.txt`.

## Global Constraints

- Work only in `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`; preserve HEAD `b1532dbe4ec4d2e64b58fd31c57a7c1863ffd155`.
- No staging, commit, stash, reset, rebase, push, merge, or main-checkout edits.
- Source ownership: `server/scripts/migration-runner.ts` and `server/tests/enterprise/schema-migration-r2.integration.test.ts` only.
- Only approved PostgreSQL base `127.0.0.1:5434/openbot_enterprise_r2_codex_20261009` and harness-created random databases. Integration unsets `DATABASE_URL` and uses only the four explicit URLs in the prior adapter brief.
- The lock, migration transactions, and unlock continue to use the same reserved backend. Lock timeout settings must be reset before migration DDL proceeds; reset uncertainty must force pool shutdown.

## Review Focus

- Runner A owns the lock: runner B reaches a finite lock timeout with an actionable error; B's uncertain acquisition path ends its dedicated pool and never returns the session.
- Runner A releases promptly before the timeout: runner B acquires the same key and normal migration continues with no leaked session `lock_timeout` setting.
- SET/RESET or timeout errors: preserve the primary cause; do not release a session whose configuration state is uncertain. If lock acquisition succeeded before RESET failed, still unlock on the pinned backend, then end the pool.
- Timeout values are validated as positive safe integers; no untrusted SQL interpolation is introduced.
- Server-side connection and shutdown SQLSTATEs (class `08`, `57P01`, `57P02`, `57P03`) count as connection loss so cleanup does not mask the original termination error with a futile rollback error.

## DAG and Task

Single task `R5-3-ADVISORY-LOCK-TIMEOUT` modifies the shared migration runner and its integration test. There are no downstream tasks or dependency cycles.

### Task 1: Bound migration lock acquisition

**Files:**
- Modify: `server/scripts/migration-runner.ts`
- Test: `server/tests/enterprise/schema-migration-r2.integration.test.ts`

**Interfaces:**
- Extend `migrateWithValidationBoundary(client, migrationsFolder)` with optional `{ lockTimeoutMs?: number }`; omission means 30,000 ms.
- Use a bound SQL value via `set_config('lock_timeout', '<N>ms', false)` on the pinned Drizzle client. Do not interpolate raw caller text.

- [ ] Add fixture test holding the migration-wide advisory key on a control connection; run a second helper call with a short positive timeout and verify a diagnostic timeout error, pool shutdown, and no schema migration activity.
- [ ] Run the new lock-timeout test RED against the current unbounded helper (bounded test wait must expire without resolving).
- [ ] Extract the timeout resolver used by the production `set_config` call; test that omitting options sends the exact bound value `30000ms` in the actual reserved-backend `set_config` query (a query-observing reserved wrapper may avoid a 30-second wait). Add parameter tests proving invalid values (0, negative, fractional, NaN, unsafe integer) reject before reserve.
- [ ] Implement option validation, session setting, advisory lock acquisition, immediate RESET, and safe-state tracking. On SQLSTATE `55P03`, report a clear timeout message including the configured duration while retaining the original error as cause.
- [ ] Add fault-injection tests for SET and RESET failures. A failed SET followed by successful RESET may release a clean reservation while retaining the SET error. If RESET fails, verify the primary/configuration errors remain observable, an acquired lock is unlocked through the pinned session when possible, the dedicated pool is ended, and an independent client can acquire the runner lock.
- [ ] Add SQLSTATE classification tests for class `08` and `57P01`/`57P02`/`57P03`, plus a non-connection SQLSTATE. In the existing backend-termination integration, assert the rejection preserves the connection-loss cause and does not aggregate a futile ROLLBACK error.
- [ ] Add a bounded success case where the control releases the key before expiry; verify the runner proceeds and later migration statements observe the normal lock timeout setting.
- [ ] Run the full approved R2 integration suite, migration entrypoints, journal tests, Drizzle check using the setup URL, strict scoped TypeScript, Biome lint-only, and scoped `git diff --check`.
- [ ] Freeze task-only patch and source hashes; record commands and exits. No stage/commit.

## Validation and Review

- Default production behavior waits at most 30,000 ms for the runner advisory lock; tests may inject a shorter validated timeout.
- Timeout never releases the reserved backend after lock acquisition was attempted but not confirmed. It terminates the dedicated pool, while a known successful lock is explicitly unlocked through the same backend.
- Successful acquisition resets `lock_timeout` before 0065/0066 migration SQL.
- Independent validator and reviewer inspect one frozen hash. Then rerun full-workspace OCR; the Medium finding must be resolved, and coverage complete.
