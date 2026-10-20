# Request-Owned Run Failure Post-Update Fence Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an authorized request-owned failure transition commit while retaining the final live lease and scope fence.

**Architecture:** The transaction updates `enterprise_runs.status` to `failed` before it completes the attempt. The final attempt predicate must inspect that post-update state, while verifying the same tenant, workspace, principal, Run, generation, fixed failure code, and live Run lease. A zero-row attempt update still throws inside the transaction and rolls back the earlier Run update.

**Tech Stack:** TypeScript, Drizzle PostgreSQL SQL, Bun test. No database access in this task.

**Spec:** Approved `docs/specs/superpowers/2026-10-11-mastra-intelligence-only-design.md`; parent T2 `docs/plans/2026-10-11-mastra-intelligence-only-dag.md`; failure API plan and Fix1/Fix2; finding in `.superpowers/sdd/2026-10-13-mastra-run-request-failure/reports/fix2-reviewer-report.md`.

## Global Constraints

- Existing worktree and HEAD `b1532dbe4ec4d2e64b58fd31c57a7c1863ffd155`. Do not stage, commit, stash, reset, rebase, merge, push, publish, or delete the worktree.
- Preserve all existing dirty user files. Only edit `server/src/enterprise/runs/store.ts`, `server/tests/enterprise/run-failure-contract.test.ts`, and this repair's report/checkpoint files.
- Do not start, reset, modify, probe, or access a database service. PostgreSQL transaction visibility, RLS, concurrency, and rollback remain unverified until the isolated test database is ready.
- Keep generic terminal, callback, stop, and cancellation paths unchanged. Do not implement Runner/SSE in this repair.

## Review Focus

1. The post-update Run predicate recognizes the `failed` state written earlier in the same transaction, with the fixed `MODEL_EXECUTION_UNAVAILABLE` code.
2. The final fence retains exact trusted scope, Run ID, generation, and `lease_expires_at > clock_timestamp()`.
3. Expiry, stale owner token, and zero-row completion still abort atomically.
4. The focused test fails on the current source before implementation and checks the production-used fragment's post-update assumption.

## Dependency and ownership preflight

The route catalog Fix2 checkpoint is separately verified for DB-free scope and does not share owned files. Failure API Fix2 is the baseline, **not** an accepted result: production `store.ts` SHA256 `5394210ecae3d531ddfcd860ffea287fc56ee521be557f5cbb94778ed92005da`; test SHA256 `e3b024f4c68a63dc62fe90229099f0145b643fe9949bbb5887ae75bb25643c04`; increment SHA256 `473d09dc54fde0f0dda2948124b4d821317902924ca66559765ee8cc6dc00142`. The `runFailureRunLeaseFence` fragment currently requires active status after the Run update, which is impossible. The Runner/SSE admission task depends on a verified repair checkpoint. No other task may edit these two files concurrently.

## Task 1: Repair request-owned final Run fence

**Source issues:** Fix2 reviewer High finding. **Depends on:** Fix2 frozen baseline. **Owner:** backend_implementer. **Validator:** backend_validator. **Reviewer:** reviewer. **Owned files:** two files named above and `.superpowers/sdd/2026-10-13-mastra-run-request-failure/reports/fix3-*`. **Commit strategy:** uncommitted checkpoint only.

**Consumes:** `RunStore.transitionTerminal`, `RunnerRequestLease`, `PlatformScope`, exact Fix2 snapshot. **Produces:** final Run predicate usable after the first transaction write; exact patch/manifests and test evidence.

- [ ] **Preflight:** Confirm HEAD and both source/test hashes; record a complete status list, staged/unstaged diff, owned before copies and hashes, untracked content hashes, and protected file hashes. Stop and report any unexpected drift before editing.
- [ ] **RED:** In `server/tests/enterprise/run-failure-contract.test.ts`, change the final fence assertion to require `"enterprise_runs"."status" =` and params containing `failed` and `MODEL_EXECUTION_UNAVAILABLE`; retain tenant/workspace/principal/Run/generation and `clock_timestamp()` assertions. Render the production fragment with `PgDialect` as the existing test does. Run `bun test server/tests/enterprise/run-failure-contract.test.ts`; expect this test to FAIL because current SQL requires active status and has no fixed error code. A test that merely mirrors a renamed helper is insufficient.
- [ ] **GREEN:** In `server/src/enterprise/runs/store.ts`, change only the SQL fragment used after the Run update: replace the active-status `in (...)` condition with equality to `failed`, and add equality to the fixed `MODEL_EXECUTION_UNAVAILABLE` error code. Preserve the exact trusted scope, Run ID, generation, and live lease predicate. Keep its use only in the request-owned final attempt update. Preserve the thrown zero-row rollback path and generic transition behavior.
- [ ] **REFACTOR/verify:** Rerun the focused test; run scoped Biome and `git diff --check`. Run a DB-free changed-path type check if available; record the known unrelated `server/scripts/enterprise-runtime-probe.ts:63` diagnostic separately. Inspect both transaction writes in sequence to confirm the final predicate matches the value written by the first.
- [ ] **Freeze:** Capture exact before/after tracked and untracked content, per-file SHA256, task-only patch (including untracked files), commands and exit codes in `fix3-implementer-report.md`. Compare protected hashes; no unrelated change is permitted. Freeze the checkpoint for independent validator and reviewer without further edits.

**Acceptance:** Focused RED fails for the present defect; GREEN passes, the two transaction writes agree on post-update Run state, and exact-scope/live-lease rollback behavior remains. This is DB-free acceptance only. If a live transaction test is needed to establish behavior, mark it pending for the isolated database gate.

**Failure handling:** If the current hashes differ, stop and request coordinator reconciliation. If the RED test fails for environment reasons instead of the intended assertion, repair the test setup before touching production. If a new independent High/Medium finding remains, create a numbered Fix4 plan and rerun the same SDD gates; do not self-approve.

## Continuation DAG

`F3 repair → F3 validation → F3 independent review → T2 Runner/SSE admission → T2 governed built-in execution → T2 headless cutover → T2 isolated-DB gates → T3–T10 per parent DAG → complete workspace OCR`. Read-only planning for later disjoint tasks may run in parallel with F3. Editing shared T2 source or running DB-backed validation may not.
