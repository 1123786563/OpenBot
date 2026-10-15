# Mastra OCR R2 Schema Invariants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Drizzle schema chain, Run token ceiling, budget reservation totals, and Mastra intent attachment JSONB representation coherent through a forward-only migration that refuses unverifiable legacy data.

**Architecture:** Add migration 0063 only after verifying the current journal and generated predecessor chain. Enforce positive Run ceilings without a database default, prevent confirmed usage from exceeding its reservation, and normalize only demonstrably valid double-encoded intent arrays whose attachment-holder relation agrees. Migration preflight must fail atomically with bounded non-secret diagnostics for unresolved historical state; it must never infer historical route values or alter usage totals.

**Tech Stack:** TypeScript, Bun, Drizzle ORM/Kit, PostgreSQL 17, Bun integration tests.

**Spec:** `docs/superpowers/specs/2026-10-10-mastra-intelligence-migration-design.md`; inherited tenancy contract `docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md`; source adjudication `.superpowers/sdd/2026-10-10-mastra-intelligence-migration/reports/adjudication-schema.md`; R2 repair DAG `.superpowers/sdd/2026-10-10-mastra-intelligence-migration/ocr-repair-dag.md`; read-only design evidence `.superpowers/sdd/2026-10-10-mastra-intelligence-migration/reports/r2-schema-architecture-advice.md`; parent plan `docs/superpowers/plans/2026-10-11-mastra-ocr-repair.md` Task 3.

## Global Constraints

- Do not rewrite historical SQL migrations; only repair the proven generated 0056 `prevId` and append migration 0063 artifacts.
- Do not invent a historical `model_route_maximum_tokens` value from current routes, invocation capabilities, the total Run ceiling, or an arbitrary constant.
- Do not clamp `confirmed_tokens`, increase `token_limit`, or delete/discount usage to satisfy a new constraint.
- Existing unresolved rows must stop the migration before schema/data changes are committed; diagnostics may include safe row keys and aggregate counts, never attachment payloads or credentials.
- Convert only valid stringified JSON arrays of UUIDs whose ordered values exactly match the holder rows as a set with no duplicate IDs; preserve already-native arrays and their ordering.
- Use the existing `server/src/db/schema/json.ts` Bun-safe custom JSONB mapping; do not introduce native Drizzle `jsonb()` on application writes.
- Integration fixtures may use explicit synthetic reconciliation values solely inside an isolated, reserved disposable database. Never use the shared application databases on ports 5432 or 5435 as migration targets.
- Preserve tenant/RLS policy and established attachment ordering; do not rewrite `0055` through `0062` SQL.
- No commit, stash, reset, push, merge, or release.

## Review Focus

- Historical Runs with the `0059`-introduced zero ceiling must block migration unless individually reconciled from trusted evidence; test atomic rollback and absence of 0063 journal application.
- A reservation with `confirmed_tokens > token_limit` must block migration without changing either value; test atomic rollback.
- A JSONB string that is malformed, non-array, contains non-UUID/duplicate values, or disagrees with holder rows must block migration without data loss; test each class.
- Native JSONB arrays and valid stringified UUID arrays must preserve order and holder membership; test direct SQL shape and a Bun application insert.
- Omitted/zero Run maxima and over-limit confirmations must be rejected by PostgreSQL after successful migration.

---

## Task 1: Restore schema invariants with a fail-closed forward migration

**Depends on:** R1 verified. **Roles:** `backend_implementer` → `backend_validator` → independent `reviewer`. **Execution:** one serial task, no commits; use a hash-bound uncommitted checkpoint.

**Files:**
- Modify: `server/src/db/schema/enterprise-runs.ts`
- Modify: `server/src/db/schema/mastra-message-intents.ts`
- Modify: `server/src/db/schema/json.ts` only as needed to accurately type JSON arrays without weakening current object call sites
- Modify: `server/drizzle/meta/0056_snapshot.json` (only `prevId`)
- Create: `server/drizzle/0063_*.sql`
- Create: `server/drizzle/meta/0063_snapshot.json`; update `server/drizzle/meta/_journal.json`
- Test: focused enterprise schema/migration tests, including `server/tests/enterprise/conversations.integration.test.ts` and existing Run fixtures
- Test: create/extend a focused migration-upgrade integration test under `server/tests/enterprise/`
- Modify: deployment/development docs only if needed to explain the migration's preflight/legacy reconciliation gate

**Interfaces:**
- Consumes: current migration journal ending at index 62/tag `0062_mastra_message_intents`; verified R1 role bootstrap and reserved PostgreSQL harness; Run schema fields `modelRouteMaximumTokens`, budget fields `tokenLimit`/`confirmedTokens`; intent holder relation keyed by `(tenant_id, thread_id, client_message_key, attachment_id)`.
- Produces: schema `model_route_maximum_tokens integer NOT NULL CHECK (> 0)` with no default; reservation check `token_limit > 0 AND confirmed_tokens >= 0 AND confirmed_tokens <= token_limit`; `attachment_ids` using repository custom JSONB mapping with application-level `string[]` data type; migration index 63, tag beginning `0063_`, snapshot chain where 0056.prevId equals 0055.id and 0063.prevId equals the existing 0062 snapshot ID.
- Migration behavior: read counts before editing; first perform a read-only target-database inventory when an authorized representative URL is available. If no representative deployment database is configured, record that fact and rely on fail-closed migration tests; do not claim production counts. On migration execution, detect unresolved Run ceilings, reservation totals, and irreparable attachment encodings before committing any repair/constraint changes. For Run and reservation violations, abort and preserve data. For repairable string JSON, validate UUID array syntax, duplicates, order, and holder membership before conversion; any invalid row aborts the whole migration. Diagnostics must identify category and count and may include tenant/thread/client key for repair triage, but not attachment values or raw JSON.

- [ ] **Step 1: Add failing schema and migration contract tests.** Add direct SQL cases asserting an omitted or zero Run ceiling is rejected; `confirmed_tokens > token_limit` is rejected; and a Bun/Drizzle intent insert stores `jsonb_typeof(attachment_ids) = 'array'`. Add isolated upgrade fixtures for a zero historical Run, over-limit reservation, malformed/non-array/duplicate/mismatched intent values, native array, and valid string-encoded UUID array. Each unresolved fixture must assert no 0063 migration record, no committed partial data repair, and unchanged source values.
- [ ] **Step 2: Run focused tests against the frozen task-start checkpoint.** Use the reserved disposable enterprise database at `127.0.0.1:5434` and exact URL guard from `server/tests/support/enterprise-database.ts`; provision only the task-owned container/database. Expected: the invariant cases demonstrate current default/constraint/serialization defects; unresolved upgrade cases cannot pass until migration behavior exists. Do not access ports 5432/5435.
- [ ] **Step 3: Inspect migration target and record evidence.** Confirm `0055_snapshot.json.id`, `0056_snapshot.json.prevId`, `0062_snapshot.json.id`, final journal index/tag, and `drizzle-kit check`. Query only an explicitly supplied representative deployment database read-only when available; otherwise record “no representative deployment URL available” and do not invent counts. Confirm no migration file after 0062 exists before generating index 63.
- [ ] **Step 4: Update schema types and constraints.** Remove `.default(0)` from `modelRouteMaximumTokens`; add the positive check. Extend the budget token check with `confirmedTokens <= tokenLimit`. Replace native Drizzle JSONB for `attachmentIds` with the repository custom `jsonb` and a type that accepts ordered UUID strings while keeping other custom JSONB object call sites type-safe.
- [ ] **Step 5: Repair only generated chain metadata and add 0063.** Set only `0056_snapshot.json.prevId` to the actual committed 0055 snapshot ID. Generate the new migration/snapshot with the lockfile-pinned Drizzle Kit; ensure migration 0063 is forward-only. Migration must preflight all legacy categories before mutation, abort with safe counts when any unresolved budget row exists, and only convert string JSON arrays after robust parsing, UUID validation, duplicate detection, and exact holder-set verification. In one migration transaction, convert valid strings and add the array-type check plus Run/reservation checks; ensure any error leaves both data and migration journal unchanged. Never encode an automatic Run/usage backfill.
- [ ] **Step 6: Run RED→GREEN and upgrade success tests.** In a disposable fixture, prove unresolved legacy values block atomically. In a separate fixture only, explicitly reconcile synthetic test Run values and usage totals before migration, then prove upgrade succeeds; verify attachment arrays keep order, holder rows remain unchanged, native arrays remain byte/value-equivalent, and invalid direct writes fail afterward.
- [ ] **Step 7: Run complete owned verification and freeze CP1.** Run `bun x drizzle-kit check` from `server`, focused schema/Run/conversation integration suites, the migration entry-point tests, Biome on owned TS files, YAML/JSON validation if generated artifacts warrant, and scoped `git diff --check`. Record exact commands, exit codes, PG fixture identity/teardown, counts and expectations, before/after hashes, exact task patch hash, and any environment limits in the task report and SDD ledger. Freeze owned file hashes and stop editing before validation.
- [ ] **Step 8: Independent gates.** `backend_validator` verifies acceptance and exact hashes without changing product code/tests; independent `reviewer` returns separate Spec compliance and Code Quality conclusions. Repair only actionable findings through numbered SDD repair plans/checkpoints and repeat affected validation/review before R2 can be marked verified.

**Failure handling:** If legacy Run/usage rows are present and no immutable evidence-backed reconciliation exists, the migration must stop. Record safe counts and the exact required operator evidence; keep R2 code fail-closed and do not release R3 until the schema task's operational upgrade contract is independently accepted. If valid attachment strings cannot be distinguished robustly in PostgreSQL, fail closed rather than cast or replace with `[]`. If the live reserved PostgreSQL harness is unavailable, do not substitute a shared database; report the environmental gate and continue only checks that do not mutate databases.

## Preflight consistency check

- One task has one backend owner and one validator; migrations, snapshots, schema definitions, and tests are tightly coupled and stay serial.
- The plan covers every R2 source finding: broken 0055→0056 generated predecessor metadata; implicit zero Run ceiling; over-limit confirmed reservation; Bun double-encoded attachment JSONB.
- No downstream interface is invented: R3/R4 consume only the persisted Run/budget/intent constraints and custom JSONB type.
- Task-start HEAD remains `2054397cd9c4fb1b161086c9f991c15a11f6d4fe`; existing uncommitted R1 and other user work is baseline and out of R2 ownership.
- Representative deployment data counts and historical route proof are unavailable in current local facts; this plan encodes a safe failure gate rather than treating that absence as zero.
