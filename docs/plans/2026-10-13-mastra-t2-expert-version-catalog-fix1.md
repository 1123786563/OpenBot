# T2 Expert Catalog Storage Contract Fix1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the independent Medium finding by behaviorally exercising Expert catalog `putOrGet` and `resolve` against an injected, verified DataDatabase test adapter.

**Architecture:** Reuse the verified fake database pattern in `server/tests/enterprise/model-route-catalog.test.ts`. Inspect compiled SQL and transaction entry, return controlled rows, and assert safe behavior through the public catalog API. Keep the reviewed catalog source and 0071 migration stable unless a new test exposes an actual defect.

**Tech Stack:** TypeScript, Bun test, Drizzle `PgDialect`.

**Spec:** Approved Mastra design; parent T2 prerequisite `docs/plans/2026-10-13-mastra-t2-expert-version-prerequisite.md`; reviewer finding in `.superpowers/sdd/2026-10-13-mastra-t2-expert-version-prerequisite/reports/task-1-reviewer-report.md`.

## Global Constraints

- Work only in the existing dirty worktree; preserve all user changes. No stage/commit/stash/reset/rebase/merge/push/PR/publish/worktree deletion.
- Do not access, probe, start, reset or modify any database service. Use the injected capability fake, not PostgreSQL.
- Own only `server/tests/enterprise/expert-version-catalog.test.ts` and this Fix1 report/checkpoint area. The implementation source, schema, migration, journal and route catalog are protected. If a test reveals a real source defect, stop and request a revised narrow source ownership plan; do not silently edit production.
- This is a test evidence repair. Task 1 already recorded prospective RED before its production implementation. Run new public-catalog tests before any production change. They may pass against the existing correct implementation; report the observed result honestly instead of manufacturing a failure.

## Review Focus

1. A forged scope performs zero transactions; valid scope uses a verified data capability and transaction-local tenant setting before catalog SQL.
2. Insert returns a matching row or conflict re-read with byte-equivalent canonical payload; changed payload/ref/schema/agent/tenant is rejected.
3. Resolve returns the stored definition, returns null only for a genuinely missing row, and rejects corrupt row metadata/payload.
4. A reference from another tenant cannot expose that tenant's row through current tenant's transaction.
5. Test assertions observe the public API and compiled SQL, not only helper functions or a mock's own behavior.

## Task 1: Add public catalog storage behavior tests

**Depends on:** Expert catalog Task 1 frozen checkpoint and review. **Owner:** backend_implementer (test evidence within backend-owned task). **Validator:** backend_validator. **Reviewer:** reviewer. **Owned files:** focused test and Fix1 report/checkpoint only. **Consumes:** `ExpertVersionCatalog`, `verifyDataDatabase`, `createScopeResolver`, `PgDialect`. **Produces:** DB-free behavioral evidence for the catalog contract. **Commit strategy:** uncommitted checkpoint.

- [ ] **Preflight:** Confirm HEAD, source/test/migration/journal hashes from Task 1 manifest, save complete owned/protected before content and status. Preserve the implementation source hash `aaab8d84226459c5fd1a7edaaa8b09452cbf3eafedd1fe23eb42920b28e6d322` and initial test hash `b2dcd75d7060f17cef8a3c370a4f2f45eb1e73e99b2b86d5fe811d0a594a3261`.
- [ ] **Test first:** Add a verified fake `DataDatabase` and trusted `PlatformScope` fixture using the established model-route catalog test pattern. The fake increments transaction count before invoking callbacks, captures `PgDialect.sqlToQuery` text/params, and returns controlled rows keyed by tenant/ref. Write tests for successful insert; idempotent conflict read; conflict with altered snapshot/metadata; missing row; corrupt resolved row; cross-tenant ref; forged scope; malformed ref. Assert transaction count, tenant `set_config` order and public return/error behavior.
- [ ] **Run focused tests:** `bun test server/tests/enterprise/expert-version-catalog.test.ts`. Record exit and each named test. If a new test fails because production violates the contract, stop and report exact evidence for a source fix plan; if it passes, preserve source unchanged. The historical Task 1 missing-module RED remains the implementation RED; do not label this test-only run as a new RED unless it truly fails for a product defect.
- [ ] **Verify:** Run scoped Biome, `git diff --check`, verify protected source/schema/migration/journal hashes, and compare the full before/after file inventory. No DB tests. Record typecheck only if relevant to changed test.
- [ ] **Freeze and review:** Save exact test-only increment including before/after hashes, command outputs, protected equality and report. Backend validator repeats the focused tests and reviewer returns separate Spec and quality verdicts. Any valid finding requires Fix2 plan; no silent waiver.

**Acceptance:** The public catalog storage behavior has DB-free evidence for the finding's listed cases; source remains byte-identical, and PostgreSQL/RLS/concurrency/restart behavior stays explicitly unverified.
