# T2 Active Run Lookup and Attempt Fencing

> **For agentic workers:** continue the approved parent Task 2 only. Preserve all existing work; do not start production SSE mounting, model execution, or Task 3.

**Goal:** Expose the persisted active Run and exact active attempt identity through the authorized RunService boundary, so reconnect, `isRunning`, and user stop can be implemented without trusting client run IDs, process-local state, or direct Runner database queries.

**Source of truth:** Approved design `docs/superpowers/specs/2026-10-11-mastra-intelligence-only-design.md`; parent DAG `docs/plans/2026-10-11-mastra-intelligence-only-dag.md`; parent Task 2 brief `.superpowers/sdd/2026-10-11-mastra-intelligence-only-dag/briefs/task-2.md`; current T2 Runner/SSE plan `docs/plans/2026-10-12-mastra-t2-runner-sse-admission.md`; implementation stop report `.superpowers/sdd/2026-10-12-mastra-t2-runner-sse-admission/reports/task-1-implementer-report.md`; architecture evidence `.superpowers/sdd/2026-10-12-mastra-t2-runner-sse-admission/reports/interface-architecture.md`.

## Global Constraints

- Use only `assertTrustedScope`-validated tenant/workspace/principal scope; query exact `threadId` under those three scope keys.
- `getActiveForThread` returns the persisted Run and the active attempt ID/generation from a single RLS-scoped DataDatabase transaction, joining attempts by tenant, run ID, and current Run generation. No request owner token is returned.
- Active means Run status is one of `queued`, `running`, `waiting_approval`, `suspended`, its Run lease is live, and its matching attempt is `active` with a live attempt lease. Ambiguity is a fail-closed domain error; no arbitrary “first” result.
- Stop remains `RunService.stop` with the server-derived Run ID, attempt ID, and generation. Do not use `cancel` for this path and do not accept client Run ID as authority.
- No schema/migration changes, no DB startup/probe/access, and no DB-backed test execution until the designated disposable database is explicitly ready. DB/RLS/locking/concurrency runtime remains unverified.
- Do not change route/model selection, production bootstrap, CopilotKit mounting, headless execution, or user-owned migration/integration files in this task.
- No commit, staging, stash, reset, rebase, merge, push, release, or worktree deletion.

## Review Focus

- Returned run and attempt are atomically tied to exact scope, thread, and current generation.
- Expired run/attempt leases, terminal states, absent attempts, duplicate active matches, and cross-scope/thread lookups fail closed or return `null` as specified.
- Stop uses server-derived generation and cannot cancel a newer attempt after lookup; existing transactional fence remains authoritative.
- The service API does not leak request owner tokens or introduce direct DB access into Runner callers.

## Task 1 — Add authorized active-run lookup

**Role:** backend_implementer. **Validator:** backend_validator. **Reviewer:** reviewer. **Dependencies:** Existing T2 Run lease/store and R13 Fix2 checkpoint. **Commit strategy:** uncommitted checkpoint; do not commit.

**Owned files:** `server/src/enterprise/contracts.ts`, `server/src/enterprise/runs/store.ts`, `server/src/enterprise/runs/service.ts`, and a focused new `server/tests/enterprise/run-active-lookup.test.ts` (plus existing `server/tests/enterprise/runs.integration.test.ts` only if a necessary DB-gated case can be added without altering unrelated user changes; prefer the new test file). No other files.

**Consumes:** trusted `PlatformScope`, `RunDTO`, current `enterpriseRuns` and `enterpriseRunAttempts` state, and existing fenced `RunService.stop` / `RunStore.cancel` behavior.

1. **RED / preflight:** Record exact HEAD, full tracked and task-owned untracked before-manifest, hashes of all owned files, and preserve unrelated dirty files. Inspect existing Run status, lease and RLS transaction patterns. Add focused tests for active result, no active result, terminal/expired state exclusion, mismatched generation exclusion, cross-tenant/workspace/principal/thread exclusion, and ambiguity rejection; demonstrate each new test fails before implementation where applicable.
2. **Contract:** Add `RunService.getActiveForThread(scope, threadId)` returning `Promise<{ run: RunDTO; attemptId: string; generation: number } | null>`. Validate trusted scope and bounded nonempty thread input before store access. Do not add ownerToken.
3. **Store:** Implement one transaction and select only rows matching exact tenant/workspace/principal/thread; join the matching active attempt on tenant/run/current generation; filter live leases and accepted active statuses. If no match return `null`; if more than one eligible active match, raise a stable `RUN_ACTIVE_AMBIGUOUS` domain error rather than selecting one. Convert the selected row with existing `toRunDTO`.
4. **Fencing check:** Preserve the lookup as informational, not a lock. Existing `stop` must re-check exact run ID, attempt ID and generation transactionally; test/document stale generation rejection using existing test seams. Do not weaken the stop fence or hold a transaction across SSE operations.
5. **GREEN:** Run the new DB-free focused tests and relevant existing unit tests, targeted TypeScript check for changed production paths, scoped Biome, and `git diff --check`. Do not start/probe/access a database. If active lookup cannot be tested without DB, add DB-gated assertions but mark them unverified and do not count them as passing runtime evidence.
6. **Freeze:** Save complete before/after manifests, task increment patch/hash, exact commands/results, source and test hashes, and report at `.superpowers/sdd/2026-10-12-mastra-t2-active-run-lookup/reports/task-1-implementer-report.md`. Independent validator and reviewer must inspect the same frozen increment and hashes; validators do not edit source/tests.

**Acceptance:** Trusted RunService callers can discover the exact currently active persisted Run/attempt for an authorized thread without client run IDs or memory state; stale stop fencing remains intact; DB-free tests and scoped static checks pass. This checkpoint does not finish T2 or authorize production SSE mounting.

**Failure handling:** If the transaction abstraction or existing active state cannot support the query safely without schema changes, stop before unrelated edits and record concrete evidence; do not bypass the service boundary.
