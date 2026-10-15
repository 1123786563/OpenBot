# T04-R3 OCR Medium Finding Fix 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make database time the sole authority for model capability expiry during resolution, avoiding false rejection when the application clock runs ahead.

**Architecture:** Keep the existing SQL compare-and-swap expiry predicate (`expires_at > now()`) as the authoritative expiry check. Remove the redundant application-clock expiry precheck in `resolve()` while retaining status validation and database-time lease validation; persist `updatedAt` as before. Add a regression test proving a capability resolves while the application clock is ahead but database time still considers it valid, while the existing behind-clock test continues to prove genuinely database-expired capabilities are rejected.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-10-11-mastra-intelligence-only-design.md`; review source: `.superpowers/sdd/2026-10-11-mastra-ocr-r3-fix2-outer-ocr/reports/outer-ocr-committed-final-2026-10-11.md`, finding `model-capability.ts:586-589`.

## Global Constraints

- Preserve OpenBot ownership of Run state, model capability authorization, usage confirmation, budgets, and migration safety.
- Do not run migrations or tests against `DATABASE_URL`, a shared database, or any real environment; use only the dedicated loopback PostgreSQL test instance and explicit test variables.
- Keep history unchanged: no commit, reset, stash, push, merge, or deployment.
- Preserve the database `now()` expiry CAS and safe 409 behavior for capabilities expired according to database time.
- Do not modify renewal behavior or unrelated findings in this fix.

## Review Focus

1. Application clock ahead while database time remains within capability expiry must not reject a valid token.
2. Application clock behind while database time says capability expired must still reject it.
3. Status, HMAC, owner, lease, and single-consumption checks must remain unchanged.

---

## Task DAG and Acceptance Mapping

| ID | Source | Acceptance | Depends on | Owner | Validator | Owned files | Interfaces | Verification | Status |
|---|---|---|---|---|---|---|---|---|---|
| F3-1 | Final T04-R3 OCR medium finding: app-vs-database expiry clock in resolve | `resolve()` relies on database-time expiry CAS only; regression test resolves while app clock is +10 minutes and DB expiry is still live; existing DB-expired/clock-behind test continues to reject; all scoped checks pass | none | backend_implementer | backend_validator | `server/src/enterprise/runs/model-capability.ts`, `server/tests/enterprise/runs.integration.test.ts` | Preserve public capability service API and fixed 409 failure contract | Focused clock tests 3/3, full Run suite 20/20, Biome/diff pass; typecheck has known unrelated TS2345; independent reviewer PASS | verified |

### Shared-file/interface and task consistency preflight

- One backend task owns the capability implementation and its integration tests; no other task is active on these files.
- Existing SQL CAS uses Postgres `now()` and remains the source of truth. The new test manipulates only the JS application clock during resolve and relies on the live isolated database clock.
- Existing database-expiry-behind-clock coverage must stay unchanged and pass.

### Task 1: Database-authoritative capability resolution expiry (F3-1)

**Depends on:** none. **Roles:** backend_implementer → backend_validator → reviewer.

**Files / ownership:** Modify `server/src/enterprise/runs/model-capability.ts` and `server/tests/enterprise/runs.integration.test.ts` only.

**Interfaces:** Keep `resolve(scope, capability)` unchanged. Its locked-row checks continue to verify owner/binding, HMAC, run state, capability status, and active lease. Expiry is decided by the existing update predicate `expiresAt > now()` in PostgreSQL; unsuccessful CAS continues returning the fixed unavailable 409.

- [x] **Step 1 — RED:** Add a test issuing a capability with the application clock normal, then set a Date shim that advances no-argument `new Date()` and `Date.now()` by ten minutes during `resolve()`. Restore Date in `finally`; assert resolve succeeds and the capability is consumed. Keep DB-side time live.
- [x] **Step 2 — RED verification:** Run the isolated focused Run integration test and confirm it fails specifically with the current `MODEL_CAPABILITY_UNAVAILABLE` / 409 application-clock precheck.
- [x] **Step 3 — GREEN:** Remove only the `row.expiresAt <= now` application-clock predicate from `resolve()`; retain reserved-status check, `updatedAt`, active lease check, and SQL expiry CAS unchanged.
- [x] **Step 4 — GREEN verification:** Run both clock-specific tests and the full `bun test tests/enterprise/runs.integration.test.ts` suite using only the dedicated loopback test DB variables. Expect both ahead-clock valid resolution and behind-clock DB-expiry rejection to pass.
- [x] **Step 5 — Static checks:** Run Biome on the two owned files, `git diff --check`, and TypeScript check; record any unchanged baseline issue exactly.
- [x] **Step 6 — Self-review:** Confirm no renewal logic, HMAC validation, capability API, migration, or unrelated worktree changes were altered.

**Failure handling:** If Date shimming affects the DB driver or prevents deterministic behavior, use a test-local injected clock seam only if it can be added without public API changes; otherwise report the exact fixture limitation before changing the implementation strategy.

## Verification and completion gates

- The implementer report records exact RED and GREEN outputs and checkpoint hashes.
- Independent backend validation and task review bind to the same after-checkpoint content.
- The scoped fix report must close OCR medium finding F3 and introduce no new behavior breakage.
- After this fix is verified and independently reviewed, run workspace OCR covering all uncommitted delivery changes. Retain the already completed committed-range report because HEAD is unchanged. Resolve any valid critical/high/medium findings through a new scoped SDD repair plan before completion.
