# R10-01 Event Append Lock-Wait Regression Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the R10 predicate-only PostgreSQL demonstration with an isolated-database regression that proves `EventService.append` rejects an expired request lease after waiting for the actual Run row lock and leaves no event row.

**Architecture:** Keep the production `clock_timestamp()` predicates and Run→attempt lock order unchanged unless a failing real append test proves them wrong. Exercise the repository-backed EventService against the existing disposable enterprise database, using server-issued scope, a synthetic conversation, a real Run/attempt lease, and two transactions; use an explicit per-test timeout long enough for fixture setup plus lock expiry. Clean up synthetic tenant data through the validated setup role, never the least-privilege operator role; never provision or access any other database.

**Tech Stack:** Bun tests, TypeScript, Drizzle ORM, PostgreSQL; existing `enterpriseRuntimeDatabaseUrlFrom`, capability verifiers, scope resolver, RunService, EventService, and synthetic deployment fixture.

**Spec:** `docs/specs/superpowers/2026-10-11-mastra-intelligence-only-design.md` §§3–5, 8; R10-01 from `.superpowers/sdd/2026-10-11-mastra-intelligence-only-dag/reports/task-2-r10-review.md`.

## Global Constraints

- Preserve current Agent execution, tool/HITL, pause/resume and OpenBot Run ownership.
- Each business Run has its own budget; output ceiling is explicit and server-owned.
- Stream-boundary failures cancel the stream and settle usage as unknown.
- Use only explicitly configured disposable loopback enterprise test databases; never fall back to `DATABASE_URL`.
- Never start, reset, provision, migrate, or modify any database service; when the test URL is absent, do not connect and record the database gate as unverified.
- Do not edit the pre-existing dirty `server/tests/enterprise/runs.integration.test.ts` or `schema-migration-r2.integration.test.ts`.
- Do not stage, commit, stash, reset, rebase, merge, push, publish or delete the worktree.

## Review Focus

- Lock contention outlasts the owner lease: assert append rejects and event count remains unchanged.
- Test uses a real Run row and attempt row, not an advisory-lock timing surrogate; its explicit timeout exceeds setup, lease expiry, lock polling and cleanup.
- Test uses only the verified `ob_ent_data` runtime and explicitly configured disposable DB URL.
- Synchronization proves append is waiting on the Run row before the lease deadline is crossed.
- Cleanup removes only synthetic rows created by this test, including on assertion failure.

---

### Task 1: Exercise real append rejection after Run-row lock wait

**Files:**
- Modify: `server/tests/enterprise/runner-events.integration.test.ts`
- Read-only inputs: `server/src/enterprise/runs/events.ts`, `server/src/enterprise/runs/service.ts`, `server/tests/enterprise/runs.integration.test.ts`, `server/tests/support/enterprise-database.ts`

**Interfaces:**
- Consumes: `createDrizzleRunnerEventRepository(data)`, `createRunnerEventService(...)`, `RunService.start/acquireRequestLease`, `createScopeResolver`, and the reserved enterprise DB URL/role verifiers.
- Produces: one integration test `event_append_rejects_after_run_lock_wait_crosses_request_lease` that seeds through existing enterprise services, calls real `EventService.append`, expects `RUN_ATTEMPT_STALE`, and verifies no corresponding event row exists.

- [ ] **Step 1: Write the failing database integration test.** Create synthetic actor, tenant, workspace and conversation using the existing isolated enterprise fixture pattern. Start a Run and acquire its real request-owner lease. On one verified data connection, lock that exact `enterprise_runs` row in a transaction; on a second verified data connection, call the repository-backed `EventService.append` with the captured lease. Use PostgreSQL lock-wait introspection to confirm the append transaction is blocked on the Run row before waiting beyond the request-owner expiry. Release the lock; assert append rejects `RUN_ATTEMPT_STALE` and query the synthetic thread/run event rows to prove no insertion occurred. Set an explicit 30-second per-test timeout and a request lease with sufficient pre-expiry polling margin. Cleanup tenant-owned rows through `ENTERPRISE_TEST_SETUP_DATABASE_URL`, then principals/users, and close every connection even if cleanup fails; do not delete through `ob_ent_operator`.
- [ ] **Step 2: Run the isolated test only when explicitly configured.** Run `bun test tests/enterprise/runner-events.integration.test.ts --test-name-pattern event_append_rejects_after_run_lock_wait_crosses_request_lease` with `ENTERPRISE_TEST_DATA_DATABASE_URL` and required test roles supplied only by the user/controller. If no URL is configured, do not invoke the test with any fallback URL; leave it skipped and record the gate as unverified. No service startup, DB setup, or migration command is allowed.
- [ ] **Step 3: Refine test synchronization only.** If the behavioral test exposes a production defect, preserve the failure and report exact evidence/call sites; do not modify production code in this test-only task. The controller will create a separate scoped SDD fix plan. If the test fails from fixture/synchronization noise, repair synchronization without weakening the behavior assertion.
- [ ] **Step 4: Run focused verification.** Run the event unit suite, the integration test under the safe skip condition if no isolated DB is available, scoped Biome, and `git diff --check`. Record exact commands, whether the integration behavior ran or skipped, and why.
- [ ] **Step 5: Freeze and review.** Capture before/after file hashes and an increment package; require backend validation and independent Spec/code-quality review against the same content. Keep PostgreSQL behavior unverified unless the actual test ran successfully against the designated disposable DB.

**Acceptance:** The actual EventService append transaction is shown to wait on the exact Run row, evaluate expiry after the lock is released, reject the expired lease, and leave no event row. Without the configured disposable database, this task remains pending DB verification and cannot close R10-01's behavioral gate.
