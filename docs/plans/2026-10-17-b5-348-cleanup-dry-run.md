# B5-348 (21.4) Cleanup Dry-Run Output & Scope Hash — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce the admin-reviewable dry-run report for the legacy billing cleanup: the three lists (to-delete / to-retain / quarantine) with row counts and deterministic samples, external anchors carried for human confirmation, and a scope hash bound to the full manifest content and versions — so a changed manifest invalidates every prior confirmation. Strictly read-only, repeatable byte-for-byte on unchanged data.

**Architecture:** One read-only module `server/src/billing/cleanup-dry-run.ts` in the 21.1–21.3 pattern. It consumes 21.2's `CleanupClassification` and 21.3's `CleanupRelationsManifest` (the safe/removed candidate verdicts), never re-derives a verdict, and projects them through a sanitizer that copies only opaque review identifiers (table, recordId, externalCustomerId, class, reason, marker names) — never amounts, payloads, unique keys or payer ids. The scope hash is sha256 over a canonical (key-sorted) JSON of every scope-deciding content: manifest versions, database+schema, classification rules/registries/records, relations edges/evaluations/anchors/summary — with every `generatedAt` excluded, so unchanged data hashes identically across runs while any content or version change (even a version bump alone) changes the hash. `buildCleanupDryRun` orchestrates the existing read-only chain; `assembleCleanupDryRunReport` is the pure seam 21.5+ re-derives with; `verifyCleanupScopeConfirmation` is the invalidation check downstream confirmations call.

**Tech Stack:** Bun + TypeScript, drizzle-orm (postgres-js), node:crypto sha256, bun:test integration suite against a dedicated `TEST_DATABASE_URL` PostgreSQL.

**Spec:** ticket 21.4 (#348); parent spec `docs/specs/2026-10-14-bifrost-integration-design.md` (Q23/Q28/Q29, AC18); `docs/adr/0004-company-team-tenancy.md`; `CONTEXT.md`.

## Global Constraints

- Zero destructive operations: the dry-run runs inside 21.2/21.3's `REPEATABLE READ, READ ONLY` fences and its own assembly is pure; the test pins data invariance with before/after full-table snapshots.
- Never point at the live `openbot` database: all runs use `TEST_DATABASE_URL` (dedicated `openbot_b5_348` on port 5590). Never port 5432.
- Write scope: `server/src/billing/cleanup-dry-run.ts` + `server/tests/cleanup-dry-run.integration.test.ts` only.
- No git commit/push/stash; report via uncommitted checkpoint.
- The hash covers manifest CONTENT (registries, records, edges, evaluations, safe/removed sets, anchors, versions, database) — never just a timestamp (ticket resume hint).

## Review Focus

- Hash repeatability: two runs on unchanged data must produce identical `scopeHash` — any timestamp leaking into the hash input breaks the confirmation contract.
- Hash coverage: a change in an UNSAMPLED row must still change the hash (hash input is the full manifests, never the sampled report).
- Cross-database replay: a confirmation taken on one database must not verify on another (database is in the hash and compared at verification).
- Sanitization by construction: the report type has no field that could carry amounts, checkout payloads, provider unique keys, body hashes or payer ids — pinned by marker-absence assertions on the serialized report.

---

### Task 1: Failing integration test — dry-run fixture and expected report

**Files:**
- Create: `server/tests/cleanup-dry-run.integration.test.ts`

**Interfaces:**
- Consumes: `classifyCleanup` (21.2), `evaluateCleanupRelations` (21.3), seeding/teardown patterns from `cleanup-relations.integration.test.ts`.
- Produces: the test contract for `buildCleanupDryRun`, `assembleCleanupDryRunReport`, `computeCleanupScopeHash`, `verifyCleanupScopeConfirmation` (Task 2's exact import surface).

- [ ] **Step 1: Write the failing test**

Fixture: seven run-suffixed keys, direct drizzle inserts, children-first teardown:

- `company`: mapping kind=company (payer `b348-co-tenant-<run>`), grant + ledger + settled reservation + allocation → 6 `company_history` rows.
- `personal`: mapping kind=personal (payer `b348-personal-user-<run>` — the sensitive marker), grant → 3 `personal_records` rows.
- `clean` (legacy_deployment + evidenced): full 12-row chain, all safe → to-delete. Seeded sensitive markers: paid order `amountCents: 987654321` + `checkoutPayload: qr-secret-<run>`; webhook `lagoUniqueKey: lago-unique-secret-<run>`; paid event `amountCents: 987654321`.
- `unknown` (legacy_deployment, NO evidence): customer + mapping + grant → 3 `unknown_owner` (insufficient_test_evidence) rows.
- `flight` (legacy + evidenced, in-flight): paid registered order + event are safe; customer/mapping/grant/ledger pulled; RESERVED reservation + allocation quarantined (in_flight_reservation).
- `activeSub` (legacy + evidenced): ACTIVE subscription anchor — listed externally, customer/mapping/subscription pulled; order/event/outbox safe.
- `openOrder` (legacy + evidenced): PENDING order anchor — listed externally, order/event/customer/mapping pulled; outbox safe.

Expected totals: 43 classified records, 29 candidates, 18 safe, 11 pulled, 20 retained, 5 quarantined.

Assertions:
1. **Read-only:** full row counts of all 12 legacy tables + fixture-scoped row dumps are deep-equal before and after two dry-runs.
2. **Repeatable:** two reports strip-`generatedAt` deep-equal; `scopeHash` strictly identical.
3. **Three lists:** to-delete records ≡ relations.safeCandidates, counts per table, key footprint grouped; retained = company+personal + pulled candidates with 21.3 reasons; quarantined by isolation reason; the three totals partition all classified records.
4. **Hash binding:** unchanged data → confirmation verifies; +1 candidate row → hash changes, old confirmation invalid (scope hash difference); registry change → invalid; version bump (cast) → invalid with version named; foreign database → invalid; `generatedAt` mutation → hash unchanged.
5. **Sanitization:** `JSON.stringify(report)` contains no sensitive marker, no `987654321`, none of the field names `amountCents/checkoutPayload/lagoUniqueKey/bodyHash/channelTransactionId/payerId`; delete-list entries carry only `{table, recordId, externalCustomerId}`.
6. **Consistency guard:** classification/relations with mismatched `evidenceSha256` → assemble throws.

- [ ] **Step 2: Run to verify RED**

Run: `cd server && TEST_DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5590/openbot_b5_348 bun test ./tests/cleanup-dry-run.integration.test.ts`
Expected: FAIL — `../src/billing/cleanup-dry-run` does not exist. Save output to `.omc/reports/b5-348-red.log`.

### Task 2: Implement `server/src/billing/cleanup-dry-run.ts`

**Files:**
- Create: `server/src/billing/cleanup-dry-run.ts`

**Interfaces (produced):**
- `buildCleanupDryRun(database, evidence, options?: { enumeration?, sampleLimit? }): Promise<CleanupDryRunReport>` — orchestrates classify → relations → assemble.
- `assembleCleanupDryRunReport(classification, relations, options?): CleanupDryRunReport` — pure; cross-contract guards (evidenceSha256, candidatesIn, version) throw on drift.
- `computeCleanupScopeHash(classification, relations): string` — sha256 over canonical JSON of scope-deciding content (versions, database, schema, rules, registries+sha, records, edges, observed links, evaluations, safe/removed, anchors minus amounts, summary; NO generatedAt).
- `verifyCleanupScopeConfirmation(confirmation, freshReport): { valid, differences }` — compares hash version, algorithm, manifest versions, database, schema, scopeHash; every mismatch named.
- Types: `CleanupDryRunReport`, `CleanupScopeBinding`, `DryRunGroup`, `DRY_RUN_VERSION = 1`, `SCOPE_HASH_VERSION = "cleanup-scope-v1"`, `DEFAULT_SAMPLE_LIMIT = 5`.

- [ ] **Step 1: Canonical JSON + hash**
- [ ] **Step 2: Sanitizing assembly (three lists, groups, samples, anchors, binding)**
- [ ] **Step 3: Verification + orchestrated builder + operator entry (`import.meta.main`, sibling pattern)**

### Task 3: GREEN + verification

- [ ] Targeted test green on the dedicated database; typecheck; biome lint on changed files; record evidence in `.omc/reports/b5-348.md`.

## Scale finding (carried, out of scope)

21.2 reads every legacy row into memory and 21.3 probes per candidate (N+1 by design); 21.4's hash canonicalizes the full O(N) manifests. Quantified on the fixture in the report; mitigation (streaming hash / batched manifests) belongs to 21.5+/21.6, not this ticket.
