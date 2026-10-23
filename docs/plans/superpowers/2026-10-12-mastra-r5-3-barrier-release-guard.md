# R5-3 Normal Barrier Release Guard Repair Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure a false normal-path advisory unlock is reported and leaves the termination test's cleanup state marked as held.

**Architecture:** Add one test-local release helper that checks the SQL boolean before clearing the held flag. Use it in the real termination-test success path and in a focused false-result regression that proves the cleanup callback runs afterward.

**Tech Stack:** Bun test, TypeScript, Postgres.js.

**Spec:** `.archive/runs/legacy-plans/superpowers-briefs/2026-10-12-mastra-r5-3-test-cleanup-repair.md`; finding in `.superpowers/sdd/2026-10-12-mastra-r5-3-test-cleanup-repair/reports/task-review.md`.

## Global Constraints

- Exact worktree `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`; preserve HEAD `b1532dbe4ec4d2e64b58fd31c57a7c1863ffd155`.
- Modify only `server/tests/enterprise/schema-migration-r2.integration.test.ts`; no stage/commit/stash/reset/rebase/push/merge.
- Preserve DB isolation and do not touch any other worktree changes.

## Review Focus

- Normal unlock returns false: throw, keep held state true, run cleanup retry, and report any cleanup failure.
- Normal unlock returns true: only then clear held state and continue runner B.

## DAG and Task

One task `R5-3-BARRIER-RELEASE-GUARD` addresses the single Medium review finding at the normal-path call site. No other acceptance criteria change.

### Task 1: Guard normal-path unlock result

**Files:**
- Test: `server/tests/enterprise/schema-migration-r2.integration.test.ts`

**Interfaces:**
- Retain existing cleanup helper and barrier state.
- Add/use a local helper accepting `unlock: () => Promise<boolean>` and `markReleased: () => void`; call `markReleased` only after unlock returns `true`, otherwise throw.

- [ ] Add focused test proving a false normal-path unlock throws, does not clear held state, and the cleanup callback retries. Verify a true cleanup retry clears held state; false/rejected retry leaves it held and is reported.
- [ ] Run the focused test RED, implement the helper, then run it GREEN.
- [ ] Replace the integration success path's unchecked unlock query with the guarded helper.
- [ ] Run the full approved R2 integration suite, migration entrypoint tests, migration journal tests, Drizzle check with setup URL, strict scoped TypeScript, Biome lint-only, and scoped `git diff --check`; use approved database URLs only.
- [ ] Freeze the task-only delta and hashes; record report. No staging or commit.

## Validation and Review

- `terminationBarrierHeld` becomes false only after a checked true result.
- A false normal-path result reaches `runBodyWithCleanup`, allowing the cleanup branch to retry. The held flag changes to false only after either normal or cleanup unlock returns true; false/rejected retries leave it true and remain observable as failures.
- Independent reviewer approves the exact frozen hash.
