# Request-Owned Run Failure Final-Fence and Test Determinism Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recheck the live Run lease at the last write boundary and make failure-contract tests deterministic and type-correct.

**Architecture:** Preserve the existing exact-lease fence and live owner/attempt checks. Add a tenant/run/generation-qualified `enterprise_runs` live lease predicate to the final attempt update, using `clock_timestamp()`, so a Run lease expiring after the Run update causes the attempt update to affect zero rows and the transaction to roll back. Generate valid test lease expiries at each test invocation and explicitly type imported scope contracts.

**Tech Stack:** TypeScript, Drizzle SQL, Bun tests.

**Spec:** `docs/plans/2026-10-13-mastra-run-request-failure-fix1.md`; source review `.superpowers/sdd/2026-10-13-mastra-run-request-failure/reports/fix1-reviewer-report.md`.

## Global Constraints

- No database access/start/reset/migration/DB-backed tests; real delayed-write/rollback timing remains a disposable-DB gate.
- Preserve pre-existing dirty source changes and only edit Fix1-owned files/test and Fix2 artifacts.
- No staging/commit/stash/reset/rebase/merge/push/release/PR/worktree deletion.
- Keep generic callbacks/cancel/stop semantics unchanged.

## Review Focus

- The final attempt update has a live Run lease condition for matching tenant, run ID, generation and active status.
- A missing/expired Run lease makes the atomic operation abort rather than commit Run-only failure.
- No fixed absolute future timestamp controls the success cases; every test constructs a live lease on demand.
- Test imports `PlatformScope` and compiles.
- Fix1 exact lease equality and live `clock_timestamp()` owner/attempt predicates remain intact.

### Task 1: Complete the final fence and stabilize tests

**Role:** backend_implementer. **Validator:** backend_validator. **Reviewer:** reviewer. **Dependencies:** Fix1 implementation checkpoint; reviewer findings in the cited report. **Commit strategy:** uncommitted checkpoint; do not commit.

**Files:**
- Modify: `server/src/enterprise/runs/store.ts`
- Modify: `server/tests/enterprise/run-failure-contract.test.ts`
- Create: `.superpowers/sdd/2026-10-13-mastra-run-request-failure/reports/fix2-implementer-report.md`, manifests and increment patch.

**Interfaces:**
- Add a production-used Drizzle SQL fragment for live matching Run lease: tenant, workspace, principal, Run ID, generation, active status and `lease_expires_at > clock_timestamp()`.
- Include that predicate in the final request-owned attempt update before clearing owner token/expiry. Keep transaction atomic: if no attempt update returns, throw so the prior Run failed update rolls back.
- Test the generated SQL shape against the exact production-used fragment; live time/rollback runtime remains explicitly deferred.
- Replace static lease fixture with `makeLease()` returning expiry `Date.now() + 60_000` at each test call; import `PlatformScope` for helper types.

- [ ] **Step 1: Freeze:** verify Fix1 patch and capture exact current before/protected hashes.
- [ ] **Step 2: RED:** add the SQL-fragment test requiring `clock_timestamp()` plus tenant/run/generation predicates and dynamic lease helper usage; demonstrate the missing fragment assertion fails before production changes.
- [ ] **Step 3: Implement:** create/use the matching live Run predicate in the final attempt update, convert success fixtures to per-test live leases, and import the correct type.
- [ ] **Step 4: GREEN:** rerun focused Bun tests, scoped Biome, changed-path type check if database-free and `git diff --check`. Do not access PostgreSQL.
- [ ] **Step 5: Freeze:** save exact Fix2 delta against Fix1 copies and record reports/outputs. No DB proof is claimed.

**Verification:** `bun test server/tests/enterprise/run-failure-contract.test.ts`; scoped Biome; focused typecheck if DB-free; `git diff --check`; verify final SQL fragment text/parameters.

**Acceptance:** Final transaction write rechecks a live exact Run lease; tests remain stable regardless of date and type-check; PostgreSQL delayed-expiry/rollback behavior is left pending.
