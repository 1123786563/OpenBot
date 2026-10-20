# R2-1C Test Cleanup Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the RLS integration fixture attempts every fallback cleanup action even when one restoration or deletion fails.

**Architecture:** Keep cleanup in the integration test module and add a small sequential cleanup runner that records failures while proceeding through all registered actions. Use the runner for ownership restoration, direct-grant revocation, fixture deletes, and verify it independently with a focused test.

**Tech Stack:** Bun test, TypeScript, Drizzle ORM, PostgreSQL integration tests.

**Spec:** Approved R2-1B repair plan `docs/plans/superpowers/2026-10-09-trpc-intelligence-task2-review-fixes-round2.md`; independent review finding `reports/task-2-r1b-review.md`; original tenancy contract `docs/plans/superpowers/2026-10-09-enterprise-ai-02-tenancy.md` (T1-B/T1-C).

## Global Constraints

- Preserve the isolated worktree and do not commit, stash, or alter the original checkout.
- No database operations are needed for this focused cleanup-runner change.
- Cleanup actions remain sequential so parent fixture rows are deleted only after dependent rows.
- Every cleanup action is attempted; collected failures are surfaced together after the sequence.
- Preserve exception-safe restoration of the table owner and revocation of the direct grant.

## Review Focus

- A failed owner restoration must not prevent direct-grant revocation or synthetic fixture deletion; test that every later action executes and failures are surfaced.
- Cleanup order must remain dependency-safe for tenant fixture records; retain the existing child-before-parent ordering.
- Cleanup state flags must only clear after their restoration/revocation action succeeds, allowing final reporting to reflect incomplete cleanup.

---

### Task 1: Attempt every RLS fixture cleanup action

**Files:**
- Modify: `server/tests/enterprise/tenancy-rls.integration.test.ts`

**Interfaces:**
- Consumes: Existing `setup`, `temporarilyTransferredToDataLogin`, `originalResourceOwner`, and `directlyGrantedDataLogin` fixture state.
- Produces: Local `runCleanupActions(actions: Array<() => Promise<void>>): Promise<void>` helper used by `afterAll`; it attempts actions sequentially and throws one `AggregateError` after all attempts if any action failed.
- Owner role: `backend_implementer`
- Validator role: `backend_validator`
- Verification: focused RED/GREEN cleanup-runner test, offline related tests, scoped TSC, Biome, `git diff --check`.

- [x] **Step 1: Write a focused test** named `runs every cleanup action after a failed action`; provide three actions with the first rejecting, then assert all three ran in order and the returned rejection is an `AggregateError` containing the first error.
- [x] **Step 2: Run the focused test** with `bun --no-env-file test tests/enterprise/tenancy-rls.integration.test.ts -t 'runs every cleanup action'`; on the baseline it must fail because the cleanup runner does not exist.
- [x] **Step 3: Implement the runner** and route each afterAll restoration, revocation, and dependent fixture deletion through separate sequential actions. Clear restoration/revocation state only after its action succeeds.
- [x] **Step 4: Run the focused test and assigned offline checks**; all actions must execute, the error must surface, existing RLS integration checks must remain unchanged, and types/lint/diff checks must pass.
- [x] **Step 5: Capture uncommitted before/after checkpoint manifests and a full-content package**, then report exact hashes and test evidence. Do not commit.

**Failure handling:** If the focused test fails for any reason other than the missing runner, correct the test and repeat RED before implementation. If an assigned check fails after the change, fix the owned test harness and repeat all affected checks. No downstream node proceeds until validation and task review pass on the same checkpoint.
