# Request-Owned Run Failure Fencing Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the request-lease expiry fencing gaps and add DB-free tests for the public Run failure API before resuming Runner/SSE admission.

**Architecture:** Preserve the request-owned failure transaction and generic terminal callbacks. A failure claim must match the exact supplied lease snapshot, including expiry, not merely a token that a renewal preserved. On the request-owned path use live PostgreSQL time (`clock_timestamp()`) for Run, attempt, and owner expiry predicates at each lock/update boundary. Extract a small production-shared service operation so DB-free tests can prove scope-before-delegation, exact lease forwarding, and false fencing-result propagation; no production bypass is introduced.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, Bun tests, existing run service/store.

**Spec:** `docs/plans/2026-10-13-mastra-run-request-failure.md`, Task 1; reviewer report `.superpowers/sdd/2026-10-13-mastra-run-request-failure/reports/task-1-reviewer-report.md`.

## Global Constraints

- No database startup/access/migration/DB-backed tests; PostgreSQL behavior remains deferred to the configured disposable DB.
- Preserve pre-existing dirty changes in the three owned source files; make only the new failure-path corrections and do not reformat unrelated hunks.
- Do not edit schema/migrations or existing dirty integration suites.
- Do not stage, commit, stash, reset, rebase, merge, push, release, create PR, or delete worktrees.
- Never treat caller wall clock alone as lease authority; database live time plus exact stored lease snapshot is authoritative.

## Review Focus

- A pre-renewal lease with the same owner token cannot settle a renewed claim because its expiry snapshot differs.
- An expired supplied lease is rejected, and DB predicates use live wall clock rather than transaction-start `now()` on the request-owned failure branch.
- Generic successful/model-failure callbacks and cancel/stop behavior remain unchanged.
- DB-free tests exercise the production-shared `RunService.fail` operation: trusted scope guard precedes store delegation, exact lease/code is forwarded, and false remains false.
- The earlier missed RED step is not misreported; record any reconstructed-baseline evidence separately from prospective Fix1 RED/GREEN.

### Task 1: Fence exact live failure lease and exercise service boundary

**Role:** backend_implementer. **Validator:** backend_validator. **Reviewer:** reviewer. **Dependencies:** Initial failure API checkpoint and valid findings in its reviewer report. **Commit strategy:** uncommitted checkpoint; no commit.

**Files:**
- Modify: `server/src/enterprise/contracts.ts` only if needed for the refined exact snapshot contract.
- Modify: `server/src/enterprise/runs/service.ts`
- Modify: `server/src/enterprise/runs/store.ts`
- Modify: `server/tests/enterprise/run-failure-contract.test.ts`
- Create: `.superpowers/sdd/2026-10-13-mastra-run-request-failure/reports/fix1-implementer-report.md`, manifests and increment patch.

**Interfaces:**
- Preserve `RunService.fail(scope, { lease: RunnerRequestLease, errorCode: "MODEL_EXECUTION_UNAVAILABLE" }): Promise<boolean>`.
- `validateRunFailureInput` rejects invalid, non-finite, or expired lease snapshots.
- A production-shared operation/helper accepts the internal transition function, applies `assertTrustedScope`, validates, and propagates exact boolean. `createRunService.fail` delegates through it.
- Request-owned `transitionTerminal` compares input lease expiry with the locked database request-owner expiry and requires live `clock_timestamp()` bounds for run, attempt, and owner predicates, including final update predicates. Preserve non-request transition behavior and existing status/outbox semantics.

- [ ] **Step 1: Freeze baseline:** record HEAD, complete full worktree list/hash, current owned source/test hashes, and protected paths; verify the initial failure patch and all pre-existing dirty diffs remain attributable.
- [ ] **Step 2: RED:** add test cases for expired lease, renewed same-token but changed-expiry lease snapshot, forged-scope no delegation, exact lease/code forwarding, and false-return propagation through the production-shared service operation. Run the focused test against current code and capture expected failures.
- [ ] **Step 3: Implement minimal fix:** reject expired input lease, compare supplied expiry to the locked owner expiry, use `clock_timestamp()` for the request-owned Run/attempt/owner bounds, and route the public `RunService.fail` through the tested shared operation. Keep generic callbacks untouched.
- [ ] **Step 4: GREEN:** rerun focused Bun tests, scoped Biome, changed-path typecheck if database-free, and `git diff --check`. Do not run DB tests.
- [ ] **Step 5: Freeze/report:** save only Fix1 delta against the precise pre-Fix1 files (separately record pre-existing owned changes); hash manifests/patch/outputs. Explicitly mark database behavior unverified and preserve the initial RED deviation history.

**Verification:** `bun test server/tests/enterprise/run-failure-contract.test.ts`; scoped Biome on changed TypeScript; scoped typecheck if database-free; `git diff --check`; report static exact expiry and `clock_timestamp()` checks. No DB access.

**Acceptance:** The exact live owner claim is required and cannot be replayed from a stale renewed tuple; tested service boundary rejects forged scopes and preserves false stale results; generic terminal/cancel paths remain unchanged. PostgreSQL runtime, lock timing, rollback, RLS and concurrent cancellation remain pending.

**Failure handling:** If service behavior cannot be tested without a test-only production bypass, extract only the production-shared delegation function. If meaningful DB lease-timing guarantees cannot be established without executing against PostgreSQL, preserve the safe SQL implementation, record the live-DB gate as pending, and do not overclaim.
