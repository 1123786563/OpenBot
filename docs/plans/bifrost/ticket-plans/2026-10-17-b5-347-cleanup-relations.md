# B5-347 (21.3) Cleanup Relations & Cascade Evaluation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For every 21.2 cleanup candidate, map its FK dependencies and reverse references from live data, evaluate what its deletion would cascade into, pull every candidate whose deletion would touch a retained (kept) object out of the cleanup set with a recorded reason, and list every live external subscription / open gateway order separately for human confirmation — all persisted as one deterministic manifest for 21.4.

**Architecture:** One read-only module `server/src/billing/cleanup-relations.ts` in the 21.1/21.2 pattern: a single `REPEATABLE READ, READ ONLY` transaction probes (a) the live catalog for every FK edge touching a legacy billing table — schema declaration and catalog are compared, and CASCADE/SET NULL/RESTRICT behavior drives evaluation, never assumption; (b) per-candidate row-level reverse-reference queries — the found rows ARE the evidence; (c) per-candidate cascade closure following live edges, where any retained record (company/personal/unknown_owner, live in-flight reservation, or unclassified row) in the closure or mutation set disqualifies the candidate; (d) live external subscription and open-order anchors, which are removed from the cleanup set and listed for manual disposition, never auto-cancelled. Consumes 21.2's `CleanupClassification` verdicts; produces `CleanupRelationsManifest` for 21.4.

**Tech Stack:** Bun + TypeScript, drizzle-orm (postgres-js), PostgreSQL catalog probes (`pg_constraint`), bun:test integration suite against a dedicated `TEST_DATABASE_URL` PostgreSQL.

**Spec:** ticket 21.3 (#347); parent spec `docs/specs/2026-10-14-bifrost-integration-design.md` (Q23/Q28/Q29, AC18); `docs/adr/0004-company-team-tenancy.md`; `CONTEXT.md`.

## Global Constraints

- Zero destructive operations: the module runs every query inside one `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY` transaction; the test seeds rows but never deletes anything outside its own fixture cleanup.
- Never point at the live `openbot` database: all runs use `TEST_DATABASE_URL` (dedicated `openbot_b5_347v` on port 5590).
- Attribution evidence comes from `payer_accounts` (02.2) and data linkages only; test evidence stays 21.2's registries — this ticket re-derives nothing and adds no new attribution vocabulary.
- Write scope: `server/src/billing/cleanup-relations.ts` + `server/tests/cleanup-relations.integration.test.ts` only.
- No git commit/push/stash; report via uncommitted checkpoint.
- Determinism for 21.4: stable table order (21.2's `TABLE_ORDER`), record-id sorting, no nondeterministic content besides `generatedAt` metadata.

## Review Focus

- A historical FK the drizzle schema does not declare (or a declared one the DB lost) must never silently change cascade semantics — the catalog probe is the truth, mismatches are recorded (`fkEdges.matchesDeclaration`), and this is pinned by the test asserting `usage_outbox` has NO FK edge and `credit_reservations.ledger_id` IS a SET NULL edge.
- A candidate whose deletion mutates (SET NULL) — not just deletes — a retained row must be pulled: pinned by the `ledger_id` test.
- A row absent from the passed classification (data drift) must default to protected, never to cleanable — pinned by the tampered-classification test.
- External live subscriptions and open gateway orders must remain visible after evaluation (listed, anchored, removed from the safe set) — pinned by the external-subscription test.

---

### Task 1: Failing integration test — the relations fixture and its expected verdicts

**Files:**
- Create: `server/tests/cleanup-relations.integration.test.ts`

**Interfaces:**
- Consumes: `classifyCleanup(database, evidence)` → `CleanupClassification` (21.2, existing); fixture seeding patterns from `cleanup-classification.integration.test.ts`.
- Produces: the test contract for `evaluateCleanupRelations` (Task 2's exact import surface).

- [ ] **Step 1: Write the failing test**

Fixture: four run-suffixed keys seeded with direct drizzle inserts (children-first teardown like the prior tests):

- `personal` + `company` keys with a live **active** subscription on the company key (must NOT appear in the external list — the list is scoped to candidate keys).
- `K1 legacy+evidenced, in-flight`: customer, `legacy_deployment` mapping (payer `deploy1`), promo grant `G` and spare grant `G2`, ledger `L` (settled reservation `RS`'s settlement row, `grant_id=G`) and ledger `L2`, reservation `R` **status='reserved'** with synthetic `ledger_id=L2`, allocation `A`(R,G) and `AS`(RS,G), settled `RS` (check-consistent numbers), remainder, subscription `S` **status='canceled'**, webhook `W` (object_id=S), usage_outbox `O` (no FK; `reservation_id=RS`), paid order `PO` (owner pair legacy_deployment/deploy1, registered in `testOrderIds`) + paid event `PE`.
  Expected: customer and mapping removed; `G` removed (CASCADE into retained allocation `A`); `L2` removed (SET NULL would mutate retained `R`); everything else of K1 — `G2`, `L`, `RS`, `AS`, `S`, `W`, `O`, `PO`, `PE` — stays safe. `O` proves the no-FK truth: not in the customer's cascade scope, safe as an independent candidate.
- `K2 legacy+evidenced, live external subscription`: customer, mapping (payer `deploy2`), grant `G3` (payout grant `plan:PO2`), **active** subscription `SA`, outbox, webhook (object_id=SA), order `PO2` (registered) + event `PE2`, remainder.
  Expected: `SA` listed in `externalActiveSubscriptions` AND removed (`external_subscription_anchor`); customer K2 removed (cascade closure contains anchor `SA`); mapping K2 removed (`attribution_basis_of_kept_records`); `G3`, outbox, webhook, `PO2`, `PE2`, remainder safe.
- `K3 legacy+evidenced, clean`: customer, mapping (payer `deploy3`), payout grant `G4` (`plan:PO3`), canceled subscription `S3`, settled reservation `RS3`+allocation `AS3`+ledger `L3`, remainder, outbox, webhook, order `PO3` **status='pending'** (unique `deploymentScope` = run value) + event `PE3`.
  Expected: `PO3` removed (`external_payment_order_open`, listed in `externalOpenOrders`), `PE3` removed with it (rides in the anchor's cascade subtree, evidence names `PO3`); mapping K3 removed (`attribution_basis_of_kept_records` — `PO3`/`PE3` stay); everything else safe, including mapping? NO — mapping removed as stated; customer K3 SAFE (orders are not FK'd to customers — the cascade never reaches `PO3`).

Assertions:

1. **FK protection (ticket step 4):** `G` removed with a retained impact naming `A` (effect `cascade_delete`, class `unknown_owner`); `L2` removed naming `R` (effect `set_null_mutate`); customer K1 removed naming `R` and `A`; `fkEdges` contains the 11 declared edges with catalog `onDelete` codes (CASCADE `c` / SET NULL `n`), all `matchesDeclaration: true`, and NO edge has `usage_outbox` as child; `summary.declarationMismatches === 0`.
2. **Cascade removal:** `safeCandidates` excludes exactly {customer K1, mapping K1, G, L2, customer K2, mapping K2, SA, PO3, PE3, mapping K3} and `removedCandidates` carries one reviewable reason each; `RS`/`AS`/`L`/`S`/`O`/`W`/`PO`/`PE`/`G2`/`G3`/`G4`/`S3`/`RS3`/`AS3`/`L3`/outboxes/webhooks remainders/events are safe.
3. **External subscription listed separately:** `externalActiveSubscriptions` is exactly [`SA`] (not canceled `S`/`S3`, not the company key's active subscription), carrying key, plan code, status; `SA` is absent from `safeCandidates`; `externalOpenOrders` is exactly [`PO3`].
4. **Manifest persistence + determinism:** the manifest is JSON-serializable; two evaluations normalize `generatedAt` and are deep-equal; `evaluations` covers every 21.2 candidate exactly once.
5. **Drift guards:** a classification naming a nonexistent candidate record → throws; a classification with one record deleted from `records` (allocation `A`) → that row is evaluated as `unclassified` and still protected (customer K1 stays removed).

- [ ] **Step 2: Run to verify RED**

Run: `cd server && TEST_DATABASE_URL=... bun test ./tests/cleanup-relations.integration.test.ts`
Expected: FAIL — `evaluateCleanupRelations` not exported by `../src/billing/cleanup-relations`.

### Task 2: Implement `server/src/billing/cleanup-relations.ts`

**Files:**
- Create: `server/src/billing/cleanup-relations.ts`

**Interfaces:**
- Consumes: `CleanupClassification`, `CleanupRecordClass` (21.2); `Database` (db/client).
- Produces:
  - `evaluateCleanupRelations(database: Database, classification: CleanupClassification): Promise<CleanupRelationsManifest>`
  - `CleanupRelationsManifest = { relationsVersion: 1, database, schema, generatedAt, basis: { classificationVersion, classificationDatabase, classificationGeneratedAt, evidenceSha256, candidatesIn }, fkEdges: RelationFkEdge[], observedLinks: ObservedLink[], evaluations: CandidateRelationEvaluation[], safeCandidates: { table, recordId }[], removedCandidates: RemovedCandidate[], externalActiveSubscriptions: ExternalActiveSubscription[], externalOpenOrders: ExternalOpenOrder[], summary }`
  - `RelationFkEdge = { childTable, childColumn, parentTable, parentColumn, constraintName, onDelete: 'cascade'|'set_null'|'restrict'|'no_action'|'set_default', matchesDeclaration, evidence }`
  - `CandidateRelationEvaluation = { table, recordId, externalCustomerId, outgoingReferences: RelationReference[], incomingReferences: RelationReference[], observedLinks, cascadeDeletionScope, setNullMutationScope, blockedBy, activeExternalSubscriptions, removed, removalReason, evidence }`
  - `RemovalReason = 'cascade_impact_on_retained' | 'external_subscription_anchor' | 'external_payment_order_open' | 'attribution_basis_of_kept_records' | 'deletion_blocked_by_retained_reference'`
  - `EXTERNAL_LIVE_SUBSCRIPTION_STATUSES = ['active', 'incomplete']` (not yet ended at the gateway).

- [ ] **Step 1: Catalog probe** — one `pg_constraint` query for every FK whose child OR parent is one of the 12 legacy tables (any counterpart); map `confdeltype` a/c/n/d/r; compare against the 11 declared edges (declaration list as a module constant); `matchesDeclaration` per edge, mismatches counted.
- [ ] **Step 2: Live state loads** — all reservation `(id, status)`, all allocation `(id, reservation_id)`, live subscriptions (`status IN EXTERNAL_LIVE_SUBSCRIPTION_STATUSES`), candidate-key membership; row-class lookup from `classification.records` (`table/recordId` map), missing → `unclassified`; protected = company_history ∪ personal_records ∪ unknown_owner ∪ unclassified ∪ live-reserved reservations ∪ their allocations ∪ external anchors.
- [ ] **Step 3: Guards** — candidate existence probes (per-table PK select, registry of 12 PK columns); classification record tables outside the known 12 → throw.
- [ ] **Step 4: Per-candidate evaluation** — edge-driven: outgoing/incoming reference row probes (data evidence strings cite found rows); CASCADE closure (transitive, visited-set) and SET NULL mutation sets; RESTRICT/NO ACTION referencing rows → `blockedBy`; anchors = live-subscription candidates + pending-order candidates; anchor cascade subtrees removed with the anchor; impact on protected rows → removal with reason; mapping rows removed when the key keeps any protected record beyond itself (`attribution_basis_of_kept_records`).
- [ ] **Step 5: Deterministic manifest assembly** — 21.2's `TABLE_ORDER`, record-id sort, summary counts; read-only fence `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`; `import.meta.main` operator entry printing the manifest for `DATABASE_URL`.

- [ ] **Step 3: Run to verify GREEN**

Run: `cd server && TEST_DATABASE_URL=... bun test ./tests/cleanup-relations.integration.test.ts`
Expected: PASS (all 5 assertion groups).

- [ ] **Step 4: Full verification**

Run: `cd server && bun run typecheck && TEST_DATABASE_URL=... bun test ./tests/cleanup-relations.integration.test.ts ./tests/cleanup-classification.integration.test.ts ./tests/cleanup-enumeration.integration.test.ts && bunx biome lint --error-on-warnings src/billing/cleanup-relations.ts tests/cleanup-relations.integration.test.ts`
Expected: typecheck clean, all cleanup tests green, lint clean.

- [ ] **Step 5: No commit (repo discipline)** — leave changes uncommitted; write `.omc/reports/b5-347.md` with file hashes and verification output.
