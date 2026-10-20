# R5-3-F1-B Connection-Pinning Repair Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the migration advisory lock bound to the same PostgreSQL backend across both Drizzle calls, even when Postgres.js connection lifetime expires during a long 0065 migration.

**Architecture:** Make the shared migration helper accept the Postgres.js pool client, reserve one connection for the complete operation, construct the Drizzle database on that reserved client, and run acquire/prefix/full/unlock through that single backend. A PostgreSQL integration regression configures a short pool lifetime, pauses migration 0065 after its changes but before commit, lets the lifetime expire, then proves that runner A reaches the 0066 barrier while runner B remains excluded.

**Tech Stack:** TypeScript, Bun, PostgreSQL, Postgres.js, Drizzle ORM 0.45.2.

**Spec:** `docs/specs/superpowers/2026-10-11-mastra-intelligence-only-design.md`; parent repair plan `docs/plans/superpowers/2026-10-11-mastra-r5-3-repair.md` Task R5-3-F1-B; prior implementation checkpoint recorded in `.superpowers/sdd/2026-10-11-mastra-r5-3-repair/progress.md` under R5-3-F1-B; finding `.superpowers/sdd/2026-10-11-mastra-r5-3-repair/reports/task-r5-3-f1-b-review.md` R5-3-F1-B-R1.

## Global Constraints

- Use only disposable PostgreSQL database `127.0.0.1:5434/openbot_enterprise_r2_codex_20261009`; unset `DATABASE_URL` for integration tests and use only the explicit approved URLs.
- Preserve HEAD `b1532dbe4ec4d2e64b58fd31c57a7c1863ffd155`, F1-A/F1-B accepted snapshots, unrelated changes, and all source migration SQL/metadata. No stage/commit, reset/rebase/stash, push/merge/deploy, or production/shared DB.
- Keep runner advisory key `(1330795348,1296641874)` held by the same reserved PostgreSQL session from acquisition through both Drizzle migrations and unlock. The session must remain reserved across the boundary after the 0065 Drizzle transaction commits.
- Preserve the helper's existing temporary prefix, original source journal, error behavior, one-connection deployment CLI, and F1-A native-array semantics.

## Review Focus

1. `max_lifetime` expiring during 0065 cannot move/close the reserved backend before 0066; runner B stays blocked until runner A has completed and unlocked.
2. Advisory unlock executes on the same reserved backend and reports a false/unheld unlock instead of silently claiming success.
3. Reserved connections are released on every success/failure path; pool shutdown remains clean after lifetime expiry.
4. The production CLI and all integration callers pass a Postgres.js client; Drizzle migrations and lock operations use the helper's reserved connection, not the ordinary pool client.

## Task DAG

| ID | Source | Acceptance | Depends on | Owner | Validator | Owned files | Interfaces | Verification | Status |
|---|---|---|---|---|---|---|---|---|---|
| R5-3-F1-B-F1 | `task-r5-3-f1-b-review.md` R5-3-F1-B-R1 | Helper reserves one session before acquiring the advisory lock; `drizzle(reserved)` runs both migration calls; unlock checks true and reserved connection releases in finally. A real loopback DB test with `max_lifetime=1s`, warm client, and dual 0065/0066 barriers waits beyond expiry inside 0065, then proves A reaches 0066 while B is still lock-blocked; DML succeeds during 0066; both complete once in order. Error path also unlocks/releases. | F1-B implemented and independently validated except this review finding | backend_implementer | backend_validator | `server/scripts/migration-runner.ts`, `server/scripts/migrate.ts`, `server/tests/enterprise/migration-entrypoints.test.ts`, `server/tests/enterprise/schema-migration-r2.integration.test.ts` | `migrateWithValidationBoundary(client: ReturnType<typeof postgres>, migrationsFolder: string): Promise<void>`; internally `await client.reserve()`, build `drizzle(reserved)`, then lock/migrate/unlock before `reserved.release()` | exact approved-DB migration suite, entrypoint/journal/Drizzle checks, strict scoped tsc, Biome and diff; test must expose non-reserved behavior | pending |

## Task R5-3-F1-B-F1 — Pin the backend session

**Files:** Modify only the four F1-B owned files listed in the DAG. No migration SQL or metadata.

- [ ] Add regression setup first. In the copied migration folder insert distinct test-only session advisory barriers: one at the final 0065 SQL boundary before the Drizzle transaction commits, and one immediately before the first 0066 `VALIDATE CONSTRAINT`. Keep both distinct from runner lock `(1330795348,1296641874)`.
- [ ] Use a runner-A Postgres.js client configured `max: 1, max_lifetime: 1`, warm its initial connection, and call the production helper. Observe A blocked at the copied 0065 barrier using `pg_stat_activity`. Start runner B through an independent `max:1` client and assert it waits on the runner advisory key. Wait on PostgreSQL `pg_sleep(1.5)` while the 0065 barrier remains held, proving A's pool lifetime elapsed; then release 0065.
- [ ] Record A’s `pg_backend_pid()` while PostgreSQL reports it blocked at copied 0065. Require the copied 0066 barrier to report that same PID, require that PID to hold the runner advisory lock, and require B’s distinct PID still waits on the runner advisory lock without issuing migration SQL. This disambiguates A from B if the old helper loses its session lock after connection recycling. Execute the existing valid `enterprise_runs` update with bounded `lock_timeout` and verify the stored value before releasing 0066. Release the 0066 barrier; require both helpers to complete, with one 0065/0066 journal entry and validated constraints.
- [ ] Add failure cleanup assertion: with copied 0066 deliberately failing, require helper rejection, 0065 committed and 0066 absent. Keep the original `max:1` base client open; require a bounded ordinary query on that same client to complete. From a separate client require `pg_try_advisory_lock` on the runner key to succeed, then unlock it. Only after these observations retry the valid folder and close both base clients. Exercise these checks in RED and GREEN so pool shutdown cannot hide a leaked reservation or lock.
- [ ] Implement exact API `migrateWithValidationBoundary(client: ReturnType<typeof postgres>, migrationsFolder: string): Promise<void>` in `server/scripts/migration-runner.ts`. At entry reserve with `const reserved = await client.reserve()`, construct Drizzle via `drizzle(reserved)`, and use this database for advisory acquisition, both Drizzle migrate calls, and unlock. Keep the reservation until the unlock attempt finishes, then `reserved.release()` in a final cleanup path even when prefix cleanup or unlock errors. Include `AS unlocked` and reject a false result. Preserve original error when adding cleanup errors (do not silently swallow unlock/release failures).
- [ ] Change the CLI and all integration callers to pass the same base Postgres.js client to the helper; ensure each pool uses `max: 1`. Preserve role-check ordering and existing client end cleanup.
- [ ] Run RED first with the old non-reserved helper against the new short-lifetime test; expected failure is that the PID waiting at 0066 differs from A’s 0065 PID, A no longer holds the runner lock, or B ceases waiting before the valid 0066 boundary. The failure-cleanup checks must also fail if the original single-connection pool cannot be reused or a separate client cannot acquire the released runner lock. Restore current exact F1-B baseline and run GREEN on the reserved helper.
- [ ] Run exact approved loopback migration suite, entrypoint 2-test suite, journal 8-test suite, Drizzle check with the exact setup DB, strict scoped tsc, Biome on four owned files, and scoped `git diff --check`. Freeze this task-only patch against the F1-B after snapshot; no F1-B baseline/F1-A content may appear in the patch.

**Failure handling:** If Postgres.js reserved-client support cannot be passed to Drizzle with the locked version, stop and report evidence before changing the interface further. Do not claim connection identity from `max:1` alone. Never use sleep-only synchronization; `pg_sleep` only establishes that the connection lifetime elapsed while PostgreSQL reports A at the 0065 barrier, and the lock/barrier/writer observations remain the acceptance evidence.
