# Mastra OCR R3 Fix 1 — Capability Lock Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Run/capability row-lock inversion while preserving one-use capability resolution and expired reserved capability renewal.

**Architecture:** `issue()` already locks the owner-scoped Run before renewing the capability. Change `resolve()` to read the digest binding without a row lock, lock the exact owner-scoped Run, then lock and revalidate the capability by its original row ID and digest before checking current attempt/expiry and consuming it. This gives all paths that need both locks a Run→capability order; status-only capability updates keep their existing single-row lock.

**Tech Stack:** TypeScript, Bun, Drizzle ORM, PostgreSQL 17.

**Spec:** `docs/plans/superpowers/2026-10-11-mastra-ocr-r3-run-governance.md` Task 1; accepted R3 review `R3-T1-REV-01` in `.superpowers/sdd/2026-10-11-mastra-ocr-r3-governance/reports/review.md`; user-approved R3 boundaries in `.superpowers/sdd/2026-10-11-mastra-ocr-r3-governance/progress.md`.

## Global Constraints

- Preserve exact tenant/workspace/principal/Run and attempt binding for every model capability.
- A capability can be consumed only once, while reserved and unexpired; renewal applies only to an expired reserved row after current Run/attempt validation.
- Renewal rotates the expiry-bound HMAC; the previous capability remains invalid.
- Lock order for a transaction that needs both rows is Run before capability.
- Do not change the 0064 least-privilege grant or historical migrations.
- Use only the existing disposable PostgreSQL 17 fixture on 127.0.0.1:5434; never access ports 5432 or 5435. No commits, stash, reset, push, or merge.

## Review Focus

- Renewal racing with resolution of the old capability must not expose PostgreSQL deadlock or lose the valid same-key retry; an expired old token remains unusable.
- Concurrent issue/resolve must still produce one-use semantics: only a current unexpired renewed token can be consumed.
- Same-tenant foreign workspace/principal, changed digest, consumed, unknown, and expired capabilities remain rejected without disclosure or budget refund.

---

### Task 1: Align model capability lock order

**Depends on:** R3 Task 1 checkpoint CP1; review finding `R3-T1-REV-01`. **Roles:** backend_implementer → fresh backend_validator → scoped independent reviewer. Serial; no commit.

**Files:** Modify `server/src/enterprise/runs/model-capability.ts` and add one focused concurrency case/helper in `server/tests/enterprise/runs.integration.test.ts`. Do not edit other R3 or R2 source paths.

**Interfaces:** Consume the existing trusted `PlatformScope`, capability digest, Run row, active attempt lease, and Task 1 issue/resolve APIs. Keep exported method signatures unchanged. `resolve()` first reads a candidate binding by full tenant/workspace/principal and digest with no row lock; it then locks the matching Run by full owner scope; then it selects the same capability row by ID, owner, Run, and original digest `FOR UPDATE`, rejecting if the row disappeared/rotated. Revalidate immutable binding, reserved status, expiry and current attempt before conditional consumption.

- [ ] **Step 1: RED — add deterministic deadlock regression.** Create an active Run and expired reserved capability; extend the Run and active-attempt leases beyond now. In a test-owned transaction, lock that Run row and hold it with a promise gate. Start renewal first and wait until one restricted runtime session is blocked on the Run row; start resolve using the old capability and wait until the second restricted session is blocked on that Run row. Release the gate. Assert renewal succeeds, neither operation surfaces SQLSTATE `40P01`, the old capability cannot resolve, and the returned renewed capability can resolve once. Bound the activity poll (5 seconds) and fail with a diagnostic if both statements do not reach the intended wait state.
- [ ] **Step 2: Verify RED.** Run only this case against the Task 1 CP1 source and disposable PostgreSQL fixture. Expected: current capability-first `resolve()` creates the deterministic Run/capability cycle; PostgreSQL aborts one transaction with deadlock SQLSTATE `40P01`.
- [ ] **Step 3: Implement lock order.** In `model-capability.ts`, split candidate lookup from row locking. Keep the first digest lookup nonlocking and owner-scoped. Lock Run before locking/re-reading the capability row. Re-read by full owner scope, candidate row ID, Run ID, and original digest with `FOR UPDATE`; verify owner, attempt, generation, route/request/maximum binding, reserved status and unexpired deadline against current DB values. If renewal changed the digest before lock acquisition, return the existing safe invalid-capability error. Preserve conditional reserved→consumed update and active-attempt lease validation. Do not change budget, migration, settlement, or provider behavior.
- [ ] **Step 4: GREEN and regression verification.** Run the concurrency case, then `bun test tests/enterprise/runs.integration.test.ts tests/enterprise/mastra-model.test.ts tests/enterprise/mastra-model.integration.test.ts` from `server/` against the same guarded fixture. All must pass. Run Biome on the two owned files and scoped `git diff --check`.
- [ ] **Step 5: Freeze and independent gates.** Record before/after hashes for the two owned files, increment patch, and exact report. A fresh backend validator reruns the concurrency and combined suites on the frozen checkpoint; then a scoped independent reviewer checks R3-T1-REV-01 closure and Task 1 invariants. Do not start R3 Task 2 until both gates pass.

**Failure handling:** If the controlled wait cannot be observed reliably, do not replace it with timing-only `Promise.all`; refine only the test harness until it proves the requested lock interleaving. Any expiry/digest race must fail closed without consuming, renewing, or disclosing a rotated capability. If a deadlock remains, trace actual SQL lock acquisition before changing production logic.
