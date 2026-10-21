# T04-R3 Outer OCR Medium Finding Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three valid medium findings from the committed-range T04-R3 OCR while retaining the established Run/capability and migration invariants.

**Architecture:** Keep the invariant repair safe for both databases that have already recorded migration 0063 and fresh databases by adding a forward compatibility migration while retaining the guarded fresh-install path. Minimize time holding message-table write locks by moving unrelated invariant counts before those locks. Verify model capabilities against the server HMAC after digest lookup so data-plane writes to a digest cannot mint usable capabilities.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, PostgreSQL migrations, node:crypto.

**Spec:** The accepted Mastra-only Intelligence design keeps Run execution, budgets, and authorization in OpenBot. This repair scope is from `.superpowers/sdd/2026-10-11-mastra-ocr-r3-governance/reports/outer-ocr-committed-2026-10-11.md`; it applies the user-confirmed R3 review process recorded in `.superpowers/sdd/2026-10-11-mastra-ocr-r3-governance/progress.md`.

## Global Constraints

- Preserve OpenBot ownership of Run state, model capability authorization, usage confirmation, budgets, and migration safety.
- Do not run migrations against `DATABASE_URL`, a shared database, or any real environment; migration integration tests must use `enterpriseTestDatabaseUrlFrom()` and its explicit loopback/port checks.
- Keep history unchanged: no commit, reset, stash, push, merge, or deployment.
- Do not broaden data-plane table privileges; the fix must validate the existing HMAC with the server secret.
- Do not add a default output/budget value or alter model invocation semantics outside the reviewed findings.

## Review Focus

1. A database that already recorded 0063 must receive compatible forward behavior without relying on Drizzle re-running a changed historical migration; test a synthetic already-applied-0063 state.
2. Concurrent message-intent/attachment writes must not cross the invariant preflight/backfill boundary; keep the lock until the protected check/update completes and prove the writer outcome.
3. A caller able to rewrite `capability_digest` and `expires_at` must still be unable to resolve a capability without a valid server HMAC; test rejection before capability consumption.
4. Valid issued and renewed capabilities must continue to resolve after HMAC verification; test both original issuance and renewal.
5. Malformed or wrong-secret capability material must fail with the existing safe 401 error and must not expose secret or canonical binding data.

---

## Workspace and review scope

Execution worktree: `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`. Preserve the current user-authored HEAD `8d6b9bd71a810556ab46b5dffa9f72f0427f5289` and the pre-existing uncommitted Mastra contract/gateway changes. No commit is authorized. The outer OCR report SHA256 is `48085bf984c67f93a79aa1b7bbe2cfe80b1a13e6a9654bc4159969464a26a396` and contains three medium findings: immutable migration compatibility, lock duration, and data-plane digest tampering without HMAC verification. Low findings are recorded as deferred in the ledger; no production changes are planned for them.

## Task DAG and Acceptance Mapping

| ID | Source | Acceptance | Depends on | Owner | Validator | Owned files | Interfaces | Verification | Status |
|---|---|---|---|---|---|---|---|---|---|
| F2-1 | OCR finding: historical migration / lock duration | New migration safely covers the recorded-0063 state; fresh path retains atomic preflight/backfill protection; unrelated table scans do not extend message write-lock duration; isolated migration tests pass | none | backend_implementer | backend_validator | `server/drizzle/0063_restore_schema_invariants.sql`, `server/drizzle/0065_restore_schema_invariant_guards.sql`, `server/drizzle/meta/_journal.json`, `server/drizzle/meta/0065_snapshot.json`, `server/tests/enterprise/schema-migration-r2.integration.test.ts` | Consumes the Drizzle v7 journal and 0063 invariants; produces the same final schema invariant state for both recorded-0063 and fresh databases | Isolated synthetic PostgreSQL migration suite plus journal/snapshot consistency | verified |
| F2-2 | OCR finding: capability digest can be forged | `resolve()` recomputes and securely compares the HMAC using the configured server secret after reading the locked row; forged digest fails 401 without consuming it; legitimate issue/renew/resolve behavior stays valid | none | backend_implementer | backend_validator | `server/src/enterprise/runs/model-capability.ts`, `server/tests/enterprise/runs.integration.test.ts` | Consumes existing private `createCapability(secret, binding)` and `ModelInvocationError`; adds no exported interface | Isolated enterprise Run integration suite, typecheck, and Biome | verified |

### Shared-file/interface and task consistency preflight

- F2-1 exclusively owns the migration journal and 0065 snapshot; F2-2 does not modify migrations.
- F2-1 owns the migration integration suite; F2-2 owns Run capability assertions in the Run integration suite. Neither task edits the other task's files.
- F2-2 uses the already-injected `secret` captured by `createModelCapabilityService`; no new API surface or schema is introduced.
- Both tasks are independent in code ownership and interfaces; the controller executes them serially. The shared PostgreSQL fixture is never used concurrently by migration tests or Run tests.
- The historical 0063 behavior remains intact for fresh installations, with unrelated Run/reservation preflight counts moved before acquisition of the message-intent locks. A forward 0065 migration revalidates expected constraints/invariants for environments whose journal already records 0063 and never re-executes it.

---

### Task 1: Forward migration compatibility and shorter message-lock window (F2-1)

**Depends on:** none. **Roles:** backend_implementer → backend_validator → reviewer.

**Files / ownership:** Modify `server/drizzle/0063_restore_schema_invariants.sql`, `server/drizzle/meta/_journal.json`, and `server/tests/enterprise/schema-migration-r2.integration.test.ts`; create `server/drizzle/0065_restore_schema_invariant_guards.sql` and `server/drizzle/meta/0065_snapshot.json`.

**Interfaces:** Consumes current Drizzle v7 journal format and the 0063 invariant definitions. Produces a 0065 forward check that is valid after an environment has recorded the original 0063, and preserves fresh migration outcomes for arrays, legacy JSON string arrays, and invalid legacy values.

- [x] **Step 1 — RED:** Add a synthetic legacy migration test that applies 0063 without its later-added locks, records migration 0063 as applied, then applies 0064 and the new 0065. Assert the forward path succeeds and required attachment/token/run constraints exist. Do not connect to any non-test database.
- [x] **Step 2 — RED:** Extend the guarded fresh-migration test to assert the two Run/reservation invariant counts happen before the two message-table locks, while the intent/holder scan and backfill remain protected. Capture the pre-fix ordering assertion failure; add forward writer coverage and correct the copied-journal range and JSONB fixture after live integration exposed those fixture defects.
- [x] **Step 3 — Implement:** Add 0065 to the journal and matching snapshot. It uses transaction-safe message locks, rechecks post-0063 invariants for already-applied environments, and avoids duplicate unconditional DDL. Keep the corrected fresh path in 0063; move only unrelated Run/reservation counts before message-table locks; retain both locks through intent/holder preflight, backfill, and invariant establishment.
- [x] **Step 4 — GREEN:** Run `ENTERPRISE_TEST_R2_MIGRATION_MODE=fresh bun test ./tests/enterprise/schema-migration-r2.integration.test.ts` from `server/` against the dedicated loopback:5434 test database. Result: 2 passed, 0 failed, 74 assertions; this includes the original 0063 concurrency case and recorded-0063 forward migration plus 0065 blocked-writer/commit case.
- [x] **Step 5 — Check generated metadata:** `bun test server/tests/migration-journal.test.ts` passed 8/8; Drizzle check passed in the implementation checkpoint. Journal idx 65/tag and 0065 snapshot linkage/schema payload were inspected.
- [x] **Step 6 — Self-review:** Inspected the five owned deliverables and all three fix-only test rounds. No migration was run against the reserved database itself; the suite created and cleaned temporary synthetic databases. No commit, real database migration, or production environment was used.

**Failure handling:** If Drizzle cannot represent the synthetic already-applied state in the existing integration harness, change only the isolated fixture helper; do not edit shared database state or relax the forward-compatibility assertion.

### Task 2: Revalidate model capabilities with the server HMAC (F2-2)

**Depends on:** none; independent of F2-1. **Roles:** backend_implementer → backend_validator → reviewer.

**Files / ownership:** Modify `server/src/enterprise/runs/model-capability.ts` and `server/tests/enterprise/runs.integration.test.ts` only.

**Interfaces:** Consumes the existing `createCapability(secret, binding)` and `ModelInvocationError` contracts. Produces no exported interface: a private fixed-length HMAC comparison used by `resolve()` after the row is locked and its binding is validated, before transitioning `reserved` to `consumed`.

- [x] **Step 1 — RED:** Add tests that (a) issue then resolve a valid token, (b) renew an expired token then resolve the renewed token, and (c) as the restricted `ob_ent_data` role replace the stored digest with the digest of an arbitrary well-formed 43-character token and extend expiry, then assert `resolve()` rejects with `MODEL_CAPABILITY_INVALID` / 401 and row status remains `reserved`.
- [x] **Step 2 — RED:** Run the focused Run integration tests with the explicit test database setting and prove the forged-digest case fails because it is accepted before the implementation.
- [x] **Step 3 — Implement:** In `resolve()`, reconstruct the canonical HMAC from the locked row and injected `secret`, compare it with the supplied capability using constant-time equality over equal-length byte buffers, and reject with the existing fixed 401 error before any consume/update. Retain the digest lookup as a candidate filter and preserve current ownership, status, expiry, lease, and one-use checks.
- [x] **Step 4 — GREEN:** Run `cd server && bun test tests/enterprise/runs.integration.test.ts`; expected: all capability issue/renew/resolve, forged digest, scope, lease, and usage tests pass.
- [x] **Step 5 — Type/lint:** Run `cd server && bunx tsc --noEmit --pretty false` and `cd server && bunx biome check src/enterprise/runs/model-capability.ts tests/enterprise/runs.integration.test.ts`. If the known unowned `server/scripts/enterprise-runtime-probe.ts:63:26` TS2345 remains the sole typecheck failure, record it exactly and separately confirm no Task F2-2 diagnostics.
- [x] **Step 6 — Self-review:** Inspect only the two owned source/test files and confirm no capability secret, canonical payload, or HMAC diagnostic is returned or logged.

**Failure handling:** If the restricted-role integration fixture cannot exercise an authorized digest rewrite, retain its direct grant assertion and add a test-only SQL mutation under the role session already used by `runs.integration.test.ts`; do not widen production privileges.

---

## Verification and completion gates

- Each task has its own before/after workspace manifests and exact task increment package; validators and reviewers bind to the same after-manifest SHA.
- F2-1 and F2-2 each require independent review. Their source work is independent; the controller runs them serially because validation uses an isolated PostgreSQL fixture.
- F2-2 requires focused test, type/lint evidence, and independent review before final R3 OCR.
- Re-run OCR on the complete uncommitted workspace after these fixes, retaining the full committed-range report and every finding ruling; then rerun the committed BASE-to-current-HEAD range if user-authored HEAD advances.
- The R3 repair is complete only when the final report covers the committed and uncommitted delivery scope, has exit code 0, has no coverage gaps, and no valid critical/high/medium finding remains.
