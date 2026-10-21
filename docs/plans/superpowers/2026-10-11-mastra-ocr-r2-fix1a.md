# R2 Conversation Fixture Cleanup Repair Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the R2 JSONB-array contract test from leaving tenant-visible pending intent state that contaminates subsequent reconciler integration tests.

**Architecture:** Keep the production reconciler unchanged. Give the contract test explicit, exception-safe cleanup of only the intent row it creates, keyed by tenant, thread and client message key.

**Tech Stack:** Bun test, Drizzle ORM, PostgreSQL integration fixture.

**Spec:** Parent R2 repair plan `docs/plans/superpowers/2026-10-11-mastra-ocr-r2-fix1.md`; independent Fix1 validator report `.superpowers/sdd/2026-10-11-mastra-ocr-r2-fix1/reports/validation.md` (SHA256 `6951dcd4b4d14be1970510f056855ef82deb5c703d6809d2238396e236a02562`). The validator reproduced 34/36 full-suite pass and proved the new JSON-array test's pending row adds one mismatch to later tenant-wide reconciliations; excluding that test makes the other 35 pass.

## Global Constraints

- Do not change production behavior or reconciler semantics for this fixture-isolation defect.
- Limit source ownership to the appended test `Bun and Drizzle persist intent attachment IDs as a JSON array` in `server/tests/enterprise/conversations.integration.test.ts`.
- Cleanup must execute on both assertion success and failure, and delete only the row created by this test.
- Do not commit or alter shared database containers; use only the disposable R2 database on guarded port 5434.

## Review Focus

- Assertion failure after insertion still removes the pending row before later tests run.
- Cleanup predicate cannot remove another test's intent.
- The entire conversation suite, including reconciler tests, passes after cleanup.

---

### Task 1: Isolate the JSON-array fixture

**Depends on:** Fix1 Task 1 implementation checkpoint and independent validation report above. **Roles:** existing `backend_implementer` `/root/r2_schema_impl` (repair round 2/5) → fresh `backend_validator` → fresh scoped `reviewer`. No commits.

**Files:**
- Modify: `server/tests/enterprise/conversations.integration.test.ts`, only the appended JSON-array intent contract test.
- Report: `.superpowers/sdd/2026-10-11-mastra-ocr-r2-fix1a/reports/task-1-report.md`

**Interfaces:**
- Consumes: the existing `mastraMessageIntents` Drizzle table, `tenantId`, the test's created `threadId`, and `clientMessageKey`.
- Produces: an exception-safe `finally` cleanup deleting precisely the test row by `(tenant_id, thread_id, client_message_key)`; production reconciler API is unchanged.

- [ ] Add/structure the regression so the contract assertion remains inside `try`, and `finally` deletes the inserted row using all three identifying keys; ensure cleanup is reached if insertion or assertion fails.
- [ ] Run the focused JSON-array test and verify its persisted `jsonb_typeof(attachment_ids)` remains `array`.
- [ ] Run the entire conversations integration suite against the disposable guarded database; expected: all tests pass, including both reconciler cases formerly reporting +1 mismatch.
- [ ] Run migration integration suite, Biome on the owned file, Drizzle check, and scoped diff check; report exact commands and outcomes.
- [ ] Freeze source hashes, after-manifest, and complete Fix1a increment patch; make no further source changes until fresh independent validation and review complete.

**Failure handling:** If test teardown cannot use a scoped delete due schema constraints, trace the row's ownership and remove only dependent rows created by this test. Do not change tenant-wide reconciler selection or relax expected counts. If port 5434 is occupied or the disposable service is unavailable, do not touch 5432/5435; record the database gate as unresolved.
