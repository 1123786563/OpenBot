# Mastra Runner Request-Owned Failure Transition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a request-owner-fenced Run failure transition so a fail-closed Runner can settle an admitted attempt truthfully without reporting cancellation or leaving an active claim.

**Architecture:** Expose a narrow `RunService.fail` operation for the Runner's single intentional no-model refusal. It accepts the trusted scope and exact current `RunnerRequestLease`, allows only a server-owned error code, and delegates to a RunStore transaction that locks/fences the same Run and active attempt, writes `failed`, marks the attempt terminal, clears its owner claim, and appends one `run.failed` outbox event atomically. Existing generic `transitionTerminal` behavior for model callback outcomes stays unchanged.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, Bun tests, existing Run/attempt lease and outbox contracts.

**Spec:** `docs/superpowers/specs/2026-10-11-mastra-intelligence-only-design.md`; parent T2 plan/brief; architecture ruling `.superpowers/sdd/2026-10-12-mastra-t2-runner-sse-admission/reports/failure-api-architecture.md`.

## Global Constraints

- Keep OpenBot authoritative for Run lifecycle, request leases, and cancellation; Mastra does not own Run state.
- Never report intentional fail-closed model unavailability as user cancellation, timeout, or supersession.
- Only terminalize the exact currently active, unexpired Run/attempt/generation and matching request owner token.
- Clear owner token and expiry in the same transaction as failed Run state, terminal attempt state, and outbox event; never release before fencing.
- Persist only the literal `MODEL_EXECUTION_UNAVAILABLE`; never persist exception text or caller-selected codes.
- No schema or migration change is needed; Run carries `failed`, attempt status `completed` denotes terminal, and existing outbox supports `run.failed`.
- No DB startup/access/migration/DB-backed test, and no staging/commit/stash/reset/rebase/merge/push/release/PR/worktree deletion. Preserve all pre-existing dirty user changes.

## Review Focus

- Wrong owner token, stale/expired lease, wrong attempt/generation, or inactive Run cannot settle or clear a different owner claim.
- A successful failure transaction emits exactly one `run.failed` event and atomically clears only the matching request claim.
- Existing `transitionTerminal` success and ordinary model failure paths retain their current semantics when no request lease is supplied.
- Arbitrary/unsafe error codes and forged scopes fail before persistence.
- No test or production path treats `false` from fencing as a successful refusal.

### Task 1: Add request-owned failure transition

**Role:** backend_implementer. **Validator:** backend_validator. **Reviewer:** reviewer. **Dependencies:** Existing RunService and RunStore transition-terminal logic; architecture ruling cited above. **Commit strategy:** uncommitted checkpoint; do not commit.

**Files:**
- Modify: `server/src/enterprise/contracts.ts`
- Modify: `server/src/enterprise/runs/service.ts`
- Modify: `server/src/enterprise/runs/store.ts`
- Create: `server/tests/enterprise/run-failure-contract.test.ts` (DB-free public API/error validation/fencing-result behavior only).
- Create: `.superpowers/sdd/2026-10-13-mastra-run-request-failure/reports/task-1-implementer-report.md`, manifests and increment patch.

**Interfaces:**
- Add `RunFailureCode = "MODEL_EXECUTION_UNAVAILABLE"`.
- Add `RunService.fail(scope: PlatformScope, input: { lease: RunnerRequestLease; errorCode: RunFailureCode }): Promise<boolean>`.
- Require `assertTrustedScope` and validate all lease IDs, generation, owner token, expiry, and exact literal code before delegating.
- Extend existing `RunStore.transitionTerminal` only via optional owner-fenced input for this failure case, or create a narrow dedicated store method if it avoids changing generic callback semantics. Store transaction must lock Run then exact active attempt, include request owner token and live request-owner expiry predicates, preserve existing Run/attempt lease/generation predicates, atomically write `failed` and stable error code, set attempt terminal (`completed`) and clear owner token/expiry, and append one `run.failed` outbox event. Return `false` on stale/competing ownership without partial writes.
- No client error strings, generalized cancellation reason, schema change, or failure text is permitted.

- [ ] **Step 1: Freeze:** record HEAD, complete owned/unowned manifest, and protected dirty-path hashes; verify current Run contracts/store/service hashes and no concurrent edits.
- [ ] **Step 2: RED tests:** add DB-free tests for `RunService.fail` scope guard, exact safe-code allowlist, exact lease tuple validation, store fencing result propagation, and guarantee false is not converted to success. Test only public behavior or small pure validators; do not introduce a production bypass.
- [ ] **Step 3: Prove RED:** run `bun test server/tests/enterprise/run-failure-contract.test.ts` and capture expected missing-interface failures.
- [ ] **Step 4: Implement:** add typed service API and atomic request-owned failure path; keep generic callback terminal transitions unchanged and use existing `run.failed` outbox event.
- [ ] **Step 5: GREEN/static:** run focused Bun tests, scoped Biome, changed-path type check if it avoids DB access, `git diff --check`. Do not run integration tests or connect to DB.
- [ ] **Step 6: Freeze/report:** capture exact increment, before/after/protected manifests, hashes and verification evidence. Explicitly state PostgreSQL/RLS/concurrency/rollback behavior is unverified until the disposable DB phase.

**Verification:** `bun test server/tests/enterprise/run-failure-contract.test.ts`; scoped `./node_modules/.bin/biome check` on changed TypeScript; changed-path TypeScript check if database-free; `git diff --check`.

**Acceptance:** A trusted Runner lease can fail only its exact active Run/attempt once, persist stable safe failure state/event, and clear its own owner token atomically; stale owners cannot mutate newer attempts; existing callback/cancel semantics are unchanged. Live PostgreSQL behavior remains explicitly pending.

**Failure handling:** If the transactional fencing cannot be verified without editing protected user files or invoking DB operations, stop at last safe point and report the exact limitation; do not substitute cancellation or non-atomic lease release.
