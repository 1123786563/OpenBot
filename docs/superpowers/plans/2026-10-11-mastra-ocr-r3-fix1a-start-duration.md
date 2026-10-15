# Mastra OCR R3 Fix 1a — Assert Configured Run Start Duration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close `R3-T2-REV-01` by proving a Run service configured for a 90,000 ms lease starts its Run and initial attempt with that configured duration.

**Architecture:** Keep the Task 2 production implementation unchanged. Strengthen the existing lease integration case with a bounded wall-clock assertion around `configuredRuns.start`, checking both persisted Run and attempt expiries against the 90,000 ms offset.

**Tech Stack:** TypeScript, Bun, Drizzle ORM, PostgreSQL 17.

**Spec:** `docs/superpowers/plans/2026-10-11-mastra-ocr-r3-run-governance.md` Task 2 and review finding `R3-T2-REV-01` in `.superpowers/sdd/2026-10-11-mastra-ocr-r3-governance/reports/task-2-review.md`.

## Global Constraints

- Preserve Task 2 production behavior and the existing exact owner, fencing, budget and capability invariants.
- Use only the disposable PostgreSQL 17 fixture on `127.0.0.1:5434`; never access ports 5432 or 5435.
- No commits, stash, reset, push, or merge. Preserve the user-authored HEAD.
- Change only the Task 2 lease test case in `server/tests/enterprise/runs.integration.test.ts`.

## Review Focus

- A regression where `createRunService({ leaseMilliseconds: 90_000 })` starts both Run and attempt with the 30-second default must fail the test.
- Test timing must allow database/request execution time while still distinguish a 30-second expiry from the configured 90-second expiry.

---

### Task 1: Assert configured start duration

**Depends on:** R3 Task 2 frozen implementation and `R3-T2-REV-01`. **Roles:** backend_implementer → fresh backend_validator → independent reviewer. Serial; no commit.

**Files:** Modify only the existing Task 2 lease behavior case in `server/tests/enterprise/runs.integration.test.ts`.

**Interfaces:** Consume `createRunService({ leaseMilliseconds: 90_000 }).start(...)`, the persisted Run row, and `currentAttempt(scope, runId)`. No production API changes.

- [ ] **Step 1 — RED:** Add `startBefore = Date.now()` immediately before the configured service call and `startAfter = Date.now()` immediately after it resolves. Fetch the persisted Run and initial attempt. Assert each expiry is at least `startBefore + 90_000` and at most `startAfter + 90_000`; retain the equality assertion between Run and attempt expiries. These bounds tolerate operation latency and fail if both use 30,000 ms.
- [ ] **Step 2 — Verify:** Run the named lease test against the disposable fixture. The strengthened assertion must pass against the Task 2 implementation; confirm its discriminating property by checking the same bounds reject `startBefore/startAfter + 30_000` (without editing production source).
- [ ] **Step 3 — GREEN:** Run the entire `server/tests/enterprise/runs.integration.test.ts` file against the same fixture. Run Biome on the owned test file and scoped `git diff --check`.
- [ ] **Step 4 — Freeze:** Record HEAD, baseline and after source hashes, exact incremental patch and SHA256, validation commands/results, and review finding closure in this plan's `.superpowers/sdd/2026-10-11-mastra-ocr-r3-fix1a-start-duration/` ledger. No edits after freeze.
- [ ] **Step 5 — Independent gates:** Fresh backend validator repeats focused/full checks; independent reviewer reports Spec compliance and Code quality and closes `R3-T2-REV-01`. Task 3 remains gated until both pass.

**Failure handling:** If wall-clock bounds prove flaky, use a deterministic injected clock only if already supported by the Run service without changing production scope; otherwise widen the upper bound while keeping the 30-second default outside the accepted interval. Do not alter production behavior to satisfy the test.
