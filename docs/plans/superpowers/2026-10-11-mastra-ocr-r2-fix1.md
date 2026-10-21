# Mastra OCR R2 Fix 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close R2-T1-REV-1 through REV-3 by serializing the intent/holder migration window and completing upgrade-path regression coverage.

**Architecture:** Keep migration 0063 atomic. Acquire transaction-held table locks on intents and holders before the preflight and hold them through conversion and constraint installation so application writes cannot change the validated relationship. Strengthen only the disposable migration fixture to prove blocked writers, explicit synthetic reconciliation, non-UUID rejection, and no partial repair.

**Tech Stack:** TypeScript, Bun, PostgreSQL 17, Drizzle ORM migrations.

**Spec:** Original R2 plan `docs/plans/superpowers/2026-10-11-mastra-ocr-r2-schema.md`; review `.superpowers/sdd/2026-10-11-mastra-ocr-r2-schema/reports/review.md`; frozen R2-T1-CP1 package `.superpowers/sdd/2026-10-11-mastra-ocr-r2-schema/reports/task-1.patch`.

## Global Constraints

- Do not rewrite historical SQL migrations.
- Do not infer historical Run ceilings or alter/discount usage outside explicit synthetic values in the disposable test fixture.
- Unresolved legacy data must abort migration without committing partial repairs or a 0063 journal entry.
- Only convert valid JSON string arrays of unique UUIDs whose values match holder rows; preserve native arrays and ordering.
- No application or migration write may persist an unvalidated holder relationship during the preflight-to-conversion interval.
- Use only reserved loopback PostgreSQL port 5434/database fixture; never ports 5432 or 5435.
- No commit, stash, reset, push, merge, or release.

## Review Focus

- A concurrent writer inserting a string-encoded intent with no matching holder while 0063 is between preflight and conversion must be blocked; after migration it must fail the newly installed array CHECK, and migration must not commit mismatched data.
- A successful upgrade fixture must explicitly reconcile legacy Run and reservation values before migration and prove those values persist unchanged.
- A blocked migration containing both an invalid string and a valid repairable string must leave the valid source encoded and leave the migration journal without index 63.
- A string array containing a non-UUID value must be counted and rejected before conversion.
- The two direct conversation-suite contract tests must create/use a real fixture conversation ID; they must not reference an undeclared test-local `threadId`.

---

## Task 1: Serialize the JSONB intent conversion window and close review gaps

**Depends on:** R2-T1-CP1 implementation. **Roles:** resume `backend_implementer` for fix round 1/5 → fresh `backend_validator` → independent scoped reviewer. One serial task; no commit.

**Files:** `server/drizzle/0063_restore_schema_invariants.sql`; `server/tests/enterprise/schema-migration-r2.integration.test.ts`; `server/tests/enterprise/conversations.integration.test.ts` (only the two R2 contract tests previously added at the end of the file).

**Consumes / produces:** Consumes frozen R2-T1-CP1 migration behavior and holder key `(tenant_id, thread_id, client_message_key)`. Produces migration-time locking compatible with the existing application write order (intent before holder) and behavioral upgrade tests for all review findings.

- [ ] Add a PostgreSQL writer-race regression using a task-local copy of the migration with a test-only pause immediately after preflight and before conversion. Start migration on the disposable upgraded clone; wait until it reaches the barrier; concurrently insert a JSONB-string intent with a UUID not present in its holder rows. Assert the migration commits only after holding both table locks, the writer does not commit during the critical section, and after migration the writer is rejected by the new array CHECK. Ensure the test-only delay is written only into a temporary migration copy and removed in `finally`.
- [ ] In migration 0063, acquire `SHARE ROW EXCLUSIVE` locks on `mastra_message_intents` and `mastra_message_intent_attachments` before the first preflight read; keep locks through conversion and checks. This lock mode must conflict with application `ROW EXCLUSIVE` writes while permitting read-only access; lock order must match observed application write order (`intent` then `holder`).
- [ ] Add an invalid UUID-string-array blocked case. In at least one blocked clone, seed both a repairable ordered string array with matching holder rows and a separate invalid string array; after migration fails, assert both raw source values are unchanged and migration 63 has no journal row.
- [ ] In the success clone, seed a synthetic zero-ceiling legacy Run plus over-limit reservation, explicitly reconcile them to fixture evidence values before invoking migration, and assert values remain as reconciled after successful upgrade. Keep this reconciliation inside the disposable fixture only.
- [ ] Run RED→GREEN for the new regression cases when the guarded 5434 fixture is available; then run migration integration, conversations integration, Biome, Drizzle check, and scoped diff-check. Record unavailable DB evidence without claiming success.
- [ ] Repair the existing R2 conversation integration tests by creating a scoped platform conversation in each contract case and using its `thread_id` for the Run/intent fixture; keep tenant and principal fixtures from `beforeAll`, and rely on existing tenant/workspace cleanup. Run both tests against the disposable DB.
- [ ] Freeze a new exact-hash checkpoint and patch; resume independent validation/review. No source/test change after freeze until a further numbered fix round is authorized by the review loop.

**Failure handling:** If a deterministic barrier test cannot be made reliable, use a temporary test migration that pauses after the preflight and assert with `pg_stat_activity`/lock wait state that a writer is blocked. Do not weaken the assertion to timing alone. If the guarded PostgreSQL service remains unavailable, leave the database acceptance gap explicit; static tests cannot close it.
