# Mastra Model Route Catalog Trust-Boundary Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce runtime-verified tenant scope and DataDatabase capabilities at the model-route catalog boundary, and make the tenant-predicate test meaningful.

**Architecture:** Keep the existing immutable catalog API and schema. Add the same runtime guards used by neighboring enterprise services before any tenant-derived query, and strengthen DB-free test seams so forged scopes and unverified database handles are rejected while query predicates are independently asserted.

**Tech Stack:** TypeScript, Bun tests, Drizzle SQL, existing tenancy WeakSet capability guards.

**Spec:** `docs/plans/2026-10-13-mastra-route-snapshot-catalog.md`, Task 1; independent findings in `.superpowers/sdd/2026-10-13-mastra-route-snapshot-catalog/reports/task-1-reviewer-report.md`.

## Global Constraints

- Do not start, probe, reset, modify, or access any database; no migrations or DB-backed tests.
- Preserve all pre-existing dirty paths; change only the catalog module, its focused test, and this plan's reports/ledger.
- Do not stage, commit, stash, reset, rebase, merge, push, release, create a PR, or delete a worktree.
- `assertTrustedScope` must run before canonicalization/transactions in both public store operations.
- `assertDataDatabase` must reject an unverified capability before the store retains it or issues SQL.

## Review Focus

- A forged/reconstructed scope is rejected by both `put` and `get` before any transaction or SQL.
- A structurally cast but unverified database handle is rejected by the constructor.
- Tenant predicate tests inspect catalog SQL/parameters, not merely tenant IDs present in `set_config`.
- Existing canonicalization, exact conflict, corruption, and missing-read tests continue to pass.
- The production capability guard does not create a test-only bypass path.

### Task 1: Close catalog runtime trust boundaries

**Role:** backend_implementer. **Validator:** backend_validator. **Reviewer:** reviewer. **Dependencies:** Task 1 catalog implementation checkpoint and review findings `HIGH`, `MEDIUM`, `LOW` in the cited reviewer report. **Commit strategy:** uncommitted checkpoint; do not commit.

**Files:**
- Modify: `server/src/enterprise/runs/model-route-catalog.ts`
- Modify: `server/tests/enterprise/model-route-catalog.test.ts`
- Create: `.superpowers/sdd/2026-10-13-mastra-route-snapshot-catalog/reports/fix1-implementer-report.md`, before/after manifests and increment patch.

**Interfaces:**
- Consume `assertDataDatabase(database: DataDatabase): void` from `server/src/enterprise/tenancy/connections.ts` and `assertTrustedScope(scope: PlatformScope): void` from `server/src/enterprise/tenancy/store.ts`.
- Preserve `ModelRouteCatalogStore` constructor, `put`, and `get` signatures. Constructor guards capability once; public operations guard scope before using `scope.tenantId`.
- No test-only production bypass or changes to the public store contract.

- [ ] **Step 1: Freeze scope:** record HEAD, source hashes, full task increment and protected dirty manifest; confirm previous checkpoint hashes and no concurrent edits.
- [ ] **Step 2: RED tests:** add focused tests that a structurally cast unverified DB object is rejected by the constructor; a forged `PlatformScope` is rejected by `put` and `get` before transaction invocation; and SQL capture asserts the INSERT and SELECT statements each contain explicit `tenant_id` predicates/values independently of the `set_config` call.
- [ ] **Step 3: Prove RED:** run `bun test server/tests/enterprise/model-route-catalog.test.ts`; confirm failures are due to missing runtime guards and inadequate predicate checks, not test setup.
- [ ] **Step 4: Implement minimally:** call `assertDataDatabase` in the constructor before retaining the handle; call `assertTrustedScope` first in `put` and `get`; improve the fake SQL executor/test assertions to validate actual catalog query shapes and bound tenant values without adding a bypass.
- [ ] **Step 5: Prove GREEN:** rerun focused Bun tests, scoped Biome, and `git diff --check`. Run typecheck only if it produces no database access; report unrelated existing failures precisely.
- [ ] **Step 6: Freeze:** record before/after manifests, patch/hash, source/test hashes, commands/results and unchanged protected paths. No DB activity.

**Verification:** `bun test server/tests/enterprise/model-route-catalog.test.ts`; scoped `./node_modules/.bin/biome check server/src/enterprise/runs/model-route-catalog.ts server/tests/enterprise/model-route-catalog.test.ts`; `git diff --check`.

**Acceptance:** All three reviewer findings are addressed with demonstrated tests; no database is accessed; the exact increment passes independent validation and Spec/code-quality review.

**Failure handling:** If the runtime guards cannot be tested without a database, preserve the public guard path and design a non-bypassable unit seam; do not weaken or skip runtime checks. Stop and report if protected files or pre-existing changes would need modification.
