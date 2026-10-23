# R5-3-F1-B Pinned Postgres.js Client Adapter Repair Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run both Drizzle migration phases on the same PostgreSQL backend that owns the session advisory lock, despite Postgres.js 3.4.9 returning a runtime reserved client without Drizzle's required `options` and `begin` members.

**Architecture:** Keep one Postgres.js reservation from lock acquisition through both migration phases and unlock. Add a private, migration-only compatibility adapter that forwards the pool's exact options object and implements the top-level transaction method by issuing `BEGIN`, `COMMIT`, or `ROLLBACK` through the reserved SQL function itself. Never delegate transactions to the pool. Drizzle 0.45.2 then runs the existing migration transactions on the reserved backend. Preserve the independently verified two-call 0065 commit boundary.

**Tech Stack:** TypeScript, Bun, PostgreSQL, Postgres.js 3.4.9, Drizzle ORM 0.45.2.

**Spec and sources:** `docs/specs/superpowers/2026-10-11-mastra-intelligence-only-design.md`; parent repair `.archive/runs/legacy-plans/superpowers-briefs/2026-10-11-mastra-r5-3-repair.md` Task R5-3-F1-B; prior R1 and same-PID review `docs/plans/superpowers/2026-10-11-mastra-r5-3-f1-b-connection-pinning.md`; High finding `.superpowers/sdd/2026-10-11-mastra-r5-3-repair/reports/task-r5-3-f1-b-review.md` R5-3-F1-B-R1; locked-version blocker `.superpowers/sdd/2026-10-11-mastra-r5-3-f1-b-connection-pinning/reports/implementation.md`; read-only compatibility review `.superpowers/sdd/2026-10-11-mastra-r5-3-f1-b-connection-pinning/reports/lock-architecture-review.md`.

## Global Constraints

- Use only disposable PostgreSQL database `127.0.0.1:5434/openbot_enterprise_r2_codex_20261009`; integration suite may create/drop only its random disposable test databases through its existing fixture cleanup. Unset `DATABASE_URL` for integration tests and set only the four explicit approved URLs in the brief. `drizzle-kit check` uses setup URL only.
- Preserve HEAD `b1532dbe4ec4d2e64b58fd31c57a7c1863ffd155`; no staging, commits, push, merge, reset, rebase, stash, or primary-checkout edits.
- Preserve SQL `0065_restore_schema_invariant_guards.sql`, `0066_validate_enterprise_schema_invariant_guards.sql`, journal and snapshots unchanged in this repair.
- Limit source ownership to `server/scripts/migration-runner.ts`, `server/scripts/migrate.ts`, `server/tests/enterprise/migration-entrypoints.test.ts`, and `server/tests/enterprise/schema-migration-r2.integration.test.ts`.
- Use two Drizzle migration invocations: through 0065 commits before full-folder invocation begins 0066 validation. Do not put both phases inside one outer transaction.
- Reserve one backend and use it for the advisory lock, Drizzle's migration transactions, unlock, and release. The adapter's `begin` must issue every transaction statement using the reserved SQL handler; delegating to the original pool would violate the invariant.
- Keep cleanup failures observable alongside a primary migration/transaction error. Unlock must return true; false fails visibly. Release only when the backend is known transaction-clean and either lock acquisition was never attempted or acquisition succeeded and unlock returned true. If BEGIN/COMMIT is uncertain, ROLLBACK fails, an attempted lock acquisition or unlock is uncertain, or release fails, fail closed by terminating the owned migration pool (`end({ timeout: 0 })`) instead of returning the reserved backend to the pool. The CLI pool is dedicated to this migration command.

## Review Focus

- Compatibility is limited to the pinned dependency behavior. Confirm the runtime reserved object lacks `options` and `begin`; ensure adapter supplies `options` and a correct Drizzle-required top-level transaction without calling `pool.begin`.
- Same-PID evidence must identify the lock owner and migration statement at both 0065 and 0066 barriers; runner B must remain blocked on the runner key. A PID match or waiter observation alone is insufficient.
- Demonstrate 0065 commits while 0066 validation is paused (bounded valid writer succeeds), then failure in 0066 leaves 0065 committed, rolls back 0066, releases the lock/reservation, and allows retry.
- Review transaction error handling, false unlock, callback rollback, safe release versus pool disposal, adapter-construction cleanup, test cleanup, and exact database isolation.

## Task and interfaces

**Task R5-3-F1-B-F1-ADAPTER**

- `source_issues`: parent Mastra migration design and review finding R5-3-F1-B-R1.
- `depends_on`: F1-B implementation/review/validation checkpoint; blocked direct-reserved attempt and source baseline recorded in `.superpowers/sdd/2026-10-11-mastra-r5-3-f1-b-pinned-client-adapter/progress.md`.
- `owner_role`: `backend_implementer`; `validator_role`: `backend_validator`; independent reviewer: `reviewer`.
- `owned_files`: the four source files listed above.
- **Consumes:** client pool `ReturnType<typeof postgres>` and migration folder; locked `drizzle` + `migrate`; approved disposable DB URLs.
- **Produces:** a private adapter inside `migration-runner.ts` accepted by `drizzle()`, with the pool options object and transaction boundary bound to the reserved SQL function; guarded prefix/full migration helper; deterministic integration regression; source-level entrypoint assertions; task patch/report and immutable hashes under `.superpowers/sdd/2026-10-11-mastra-r5-3-f1-b-pinned-client-adapter/`.
- **Acceptance:** (1) adapter transaction backend PID equals reserved/lock-owner PID; (2) 0065 and 0066 migration activity uses that same backend despite `max_lifetime:1`; (3) runner B remains blocked until A unlocks; (4) valid writer completes during 0066 wait; (5) 0066 failure preserves 0065, rolls back 0066, returns the reservation to the same pool, unlocks visibly, and retry succeeds; (6) existing entrypoint, journal, validation and migration semantics remain green.
- **Verification:** isolated migration integration suite; entrypoint 2 tests; journal 8 tests; Drizzle check with setup URL; strict scoped TypeScript; Biome on owned files; scoped `git diff --check`; frozen task-only patch and separate validator/reviewer conclusions.
- **Status:** pending plan review.

## Implementation Steps

- [ ] Verify all four hashes in `snapshots/before/files.sha256` before editing. The exact snapshot contains the first, blocked direct-reserved attempt; use its task-only delta as the implementation baseline and keep original F1-B baseline `snapshots/f1-before/` intact for eventual full-scope review.
- [ ] Add/adjust the runtime compatibility and short-lifetime integration assertions before changing adapter code. The prior recorded RED in `reports/implementation.md` is evidence that the unchanged F1-B helper loses the backend session after the 0065 barrier; preserve that evidence and make the revised test explicitly assert backend PID and lock ownership at both barriers.
- [ ] Implement a private pinned client wrapper in `migration-runner.ts`. Use the reserved callable for Drizzle queries and raw transaction statements. Supply `options: pool.options` so the locked Drizzle constructor can set parsers/serializers. Implement only the callback transaction form Drizzle migrator calls: issue `BEGIN`; invoke callback with the same wrapper; issue `COMMIT`; on callback failure issue `ROLLBACK`, preserving both primary and cleanup errors. A BEGIN or COMMIT error is outcome-uncertain; a failed ROLLBACK means the session may be aborted. Mark these paths unsafe. Never call `pool.begin`. Document the narrow compatibility reason in code.
- [ ] Keep helper lock acquisition, prefix `migrate()`, full-folder `migrate()`, and unlock on the Drizzle database built from this wrapper. Keep the reservation until unlock has been checked. In `finally`, call `release()` only if transaction state is known clean and (lock acquisition was never attempted, or acquisition succeeded and unlock returned true); otherwise terminate the owned pool with `end({ timeout: 0 })` and never return the session to the pool. Unlock SQL must select `pg_advisory_unlock(...) AS unlocked` and false must throw.
- [ ] Maintain the production CLI role preflight ordering and single migration helper entrypoint. Adapt source assertions to describe the wrapper rather than assuming raw `drizzle(reserved)` works.
- [ ] In the copied short-lifetime test, configure A with `max:1,max_lifetime:1`, observe its reserved backend blocking at copied 0065, record PID and granted runner-lock owner, allow lifetime expiry, release 0065, and require that same PID/lock owner at copied 0066 while B's distinct PID remains blocked without issuing migration SQL. During the 0066 barrier require the existing valid writer update to finish. Assert the lock owner's PID equals both migration barrier PIDs.
- [ ] On copied 0066 SQL failure with successful ROLLBACK, verify original error is visible, 0065 journal row persists and 0066 row is absent; before ending A's pool, require a bounded same-pool query to succeed and a separate client to `pg_try_advisory_lock`/unlock successfully. Retry valid migration. Add fault injection for (a) Drizzle construction failure after reservation, proving clean release and same-pool reuse; (b) backend termination while A is paused inside the 0066 transaction, proving rollback/unlock uncertainty causes immediate owned-pool disposal and never returns the session to the pool; and (c) injected COMMIT/ROLLBACK query failures in the transaction adapter, proving unsafe classification and preservation of all errors. Close every fixture/pool/reservation on all paths.
- [ ] Run approved integration suite, entrypoint 2-test suite, journal 8-test suite, Drizzle check, strict scoped `tsc`, four-file Biome, and scoped `git diff --check`. Capture outputs/exit codes and source hashes, freeze the task-only patch against `snapshots/before/`; later independent full R5-3 review uses `snapshots/f1-before/` through final workspace.

## Failure handling

- Do not use the proposed separate lock-only pool design unless a new reviewed plan proves it can detect loss and stop in-flight migration work; this task keeps lock and migration SQL on one reserved backend.
- Do not rely on the inaccurate `ReservedSql extends Sql` type declaration as proof of runtime shape. A failed compatibility contract test, unsupported Drizzle transaction call shape, or any path that can return an uncertain session to the pool is a blocker: record evidence and revise this plan before implementation expands.
- Use only barrier/lock/backend observations for concurrency evidence; `pg_sleep` may only establish connection-lifetime expiry while the activity and lock observations remain true.
