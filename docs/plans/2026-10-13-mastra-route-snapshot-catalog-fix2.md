# Mastra Model Route Catalog Transaction-Boundary Test Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the forged-scope regression test directly observe that no catalog transaction is entered.

**Architecture:** Keep production code unchanged. Extend only the DB-free test fixture so it exposes a transaction-entry counter distinct from the SQL executor counter, then assert both forged-scope operations leave that counter at zero.

**Tech Stack:** Bun tests, TypeScript.

**Spec:** Fix1 plan and brief; review finding in `.superpowers/sdd/2026-10-13-mastra-route-snapshot-catalog/reports/fix1-reviewer-report.md`.

## Global Constraints

- Do not start, probe, reset, modify, or access any database.
- Modify only `server/tests/enterprise/model-route-catalog.test.ts` and this plan's report artifacts.
- Preserve all other worktree changes; no staging, commits, or history operations.
- Keep the production scope guards and DB capability guard unchanged.

## Review Focus

- Counter increments at `database.transaction` entry, before invoking its callback.
- Both forged `put` and `get` reject with `UNVERIFIED_SCOPE` and transaction count remains zero.
- Existing SQL predicate/capability tests remain unaffected.

### Task 1: Observe transaction entry

**Role:** backend_implementer. **Validator:** backend_validator. **Reviewer:** reviewer. **Dependencies:** Fix1 checkpoint and LOW reviewer finding. **Commit strategy:** uncommitted checkpoint; do not commit.

**Files:**
- Modify: `server/tests/enterprise/model-route-catalog.test.ts`
- Create: `.superpowers/sdd/2026-10-13-mastra-route-snapshot-catalog/reports/fix2-implementer-report.md`, manifests and increment patch.

**Interfaces:** Keep production APIs unchanged. Extend `storeWithExecutor` to return the store and a transaction-entry counter, or an equivalent test-only fixture result.

- [ ] **Step 1: Freeze:** verify Fix1 hashes and capture a fresh test-file before manifest.
- [ ] **Step 2: RED:** change the forged-scope test to assert a transaction counter at the DB `transaction` method boundary; demonstrate current helper cannot satisfy the new assertion or add the assertion before helper implementation.
- [ ] **Step 3: GREEN:** increment the counter immediately upon entry to `database.transaction`, return it from the helper, then assert rejected `put` and `get` leave it at zero.
- [ ] **Step 4: Verify:** run `bun test server/tests/enterprise/model-route-catalog.test.ts`, scoped Biome and `git diff --check`; no DB operations.
- [ ] **Step 5: Freeze:** save exact test patch, hashes, before/after manifests and command outputs.

**Acceptance:** Test directly proves no transaction callback is entered for either forged-scope call; focused checks pass; production files and unrelated paths remain unchanged.
