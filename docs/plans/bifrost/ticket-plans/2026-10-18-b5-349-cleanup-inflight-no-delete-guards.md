# B5-349 (21.5) Cleanup In-Flight Check & No-Delete Guards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans / test-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The cleanup safety gate (AC18): before anything is deleted, prove programmatically — not by operator care — that (1) every object carrying in-flight settlement responsibility (unsettled `reserved` hold, `unknown` hold per 06.8, or a not-yet-delivered 08.1 RecoveryItem's source row) is out of the cleanup scope and the hits are recorded; (2) company billing history and all users/bots/sessions/knowledge-base objects are undeletable by the cleanup program (hard estate allowlist + class assertions); (3) `unknown_owner` records stay isolated, unreachable by the cleanup program.

**Architecture:** One module `server/src/billing/cleanup-guards.ts` in the 21.1–21.4 pattern. `guardCleanupDeletion(database, evidence, { targets? })` re-derives 21.2's classification and 21.3's relations **fresh from the live data itself** (no caller-supplied manifests to trust), then runs four hard stages per target: estate table allowlist → fresh classification class refusal → fresh verified-scope membership → fresh in-flight probe (upward cascade/mutation closure from every live `reserved|unknown` reservation over the catalog's own FK edges). The report records every in-flight hit with evidence and never deletes anything. The in-flight predicate itself is widened in 21.2/21.3 (`reserved` only → `reserved|unknown`) so the review scope (dry-run) already tells the truth — ticket step 1 ("未结算预留、unknown") made that explicit. 08.1's RecoveryItem storage does not exist in this workspace; unknown holds ARE its source rows (08.1: "为每条未知记录生成 RecoveryItem"), so probing reserved+unknown reservations covers every row a RecoveryItem could reference — recorded in the report's `enforced.recoveryItems` note, no stub fabricated.

**Tech Stack:** Bun + TypeScript, drizzle-orm (postgres-js), bun:test integration against dedicated `TEST_DATABASE_URL` PostgreSQL (5594 container `b5-verify-pg2`, fresh database `b5_349_verify`; never 5432/5435/55432, never the live `openbot` db).

**Spec:** ticket 21.5 (#349); parent spec `docs/specs/2026-10-14-bifrost-github-spec.md` (AC18/AC19) and `docs/specs/2026-10-14-bifrost-integration-design.md` (Q28/Q29); `docs/adr/0004-company-team-tenancy.md`; `CONTEXT.md`.

## Global Constraints

- Write scope: `server/src/billing/cleanup-guards.ts` (new), in-flight predicate widening in `server/src/billing/cleanup-classification.ts` + `server/src/billing/cleanup-relations.ts` (minimal diffs), `server/tests/cleanup-guards.integration.test.ts` (new). Anything else = stop and report.
- The guard is read-only by construction: its own probe runs in one `REPEATABLE READ, READ ONLY` fence; test pins data invariance with full-table snapshots before/after.
- Hard constraints live in code (allowlist + assertions), never in documentation or operator discipline (resume hint).
- No git commit/push; uncommitted checkpoint + sha256 manifest in the ticket and `.omc/reports/b5-349.md`.
- No migration needed (program-level constraint; no schema change). Migration counter stays at 0146; if one becomes necessary it must start at 0147.

## Review Focus

- Independence: a refusal must survive a stale/tampered caller — the guard derives classification/relations itself; the fresh in-flight probe reads live reservation status, not manifest verdicts.
- Transitive in-flight reach: deleting a parent (customer → reservation; grant → allocation of an in-flight reservation) must refuse, not just deleting the reservation row itself.
- The estate wall: any table outside the 12 legacy billing tables is refused before any row is probed (users/bots/sessions/KB are unreachable by construction, existence leaks impossible).
- Determinism: two guard runs on unchanged data agree modulo `generatedAt`.

---

### Task 1: RED — failing integration test

**Files:** Create `server/tests/cleanup-guards.integration.test.ts`

- [ ] **Step 1: Write the failing tests** — fixture (run-suffixed, children-first teardown):

  - `companyKey` (mapping kind=company): customer, grant, pending order carrying BOTH test markers (registered order id + registered creator) via `owner_payer_kind='company'` → `company_history`.
  - `legacyKey` (legacy_deployment + evidence): customer, mapping, registered paid order (payout-grant linkage `plan:<orderId>`) + event, active subscription + webhook hit, outbox row, remainder, **settled** hold+allocation (safe), **reserved** hold+allocation, **unknown** hold+allocation (`markReservationUnknown`).
  - `flightKey` (legacy_deployment + evidence, ONLY in-flight is the unknown hold): customer, mapping, registered paid order via payout grant + event, outbox row, grant (the allocation's source), one reservation flipped to `unknown` with its allocation.
  - `unknownKey` (mapping kind=unknown_owner): customer, mapping, grant → quarantined.

  Tests:
  1. **Classification pins unknown holds as in-flight** — `flightKey`'s unknown reservation + allocation: `inFlight: true`, class `unknown_owner`, `isolationReason: "in_flight_reservation"` (RED: current code only knows `reserved`).
  2. **Relations pull the unknown hold's estate** — fresh `evaluateCleanupRelations`: `flightKey` customer/mapping/grant/ledger removed (cascade reaches the unknown reservation / its allocation), reservation+allocation quarantined; order/event/outbox still safe (RED for same reason).
  3. **Guard default scope is clean** — `guardCleanupDeletion` with no targets: `refused` empty; `deletable` ≡ fresh safeCandidates; contains the settled hold; contains NO company row, NO `unknownKey` row, NO in-flight row, NO `flightKey` customer/mapping/grant/reservation/allocation.
  4. **Estate wall** — targets `{table:"users"|"bot_services"|"enterprise_conversations", …}` refused `table_outside_cleanup_estate` with no row probe.
  5. **Company wall** — `{billing_customers, companyKey}`, `{payer_accounts, companyMappingId}`, `{credit_grants, companyGrantId}` refused `company_billing_history` (ADR 0004).
  6. **Unknown isolation** — `{payer_accounts, unknownMappingId}`, `{credit_grants, unknownGrantId}` refused `unknown_owner_isolated`.
  7. **Fresh in-flight probe** — targets = reserved hold id, unknown hold ids + both allocations refused `in_flight_responsibility`, evidence names the reservation ids and statuses; also `{credit_grants, flightKeyPlanGrantId}` refused (its deletion cascades into the unknown hold's allocation); contrast: the settled hold's ledger row is deletable.
  8. **Ghost** — `{billing_customers, "…-ghost"}` refused `not_a_classification_candidate`.
  9. **`assertCleanupDeletionAllowed`** throws naming reasons on a refused report, passes on the clean report.
  10. **Read-only + determinism** — full legacy-table row counts and fixture dumps identical before/after; two guard runs equal modulo `generatedAt`.

- [ ] **Step 2: Verify RED** — `cd server && TEST_DATABASE_URL=…5594/b5_349_verify bun test ./tests/cleanup-guards.integration.test.ts` → FAIL: `../src/billing/cleanup-guards` unresolvable. Save to `.omc/reports/b5-349-red.log`.

### Task 2: GREEN — `server/src/billing/cleanup-guards.ts`

- [ ] **Step 1:** Export `IN_FLIGHT_RESERVATION_STATUSES = ["reserved","unknown"]` from `cleanup-classification.ts`; use in both `inFlight` predicates; same predicate in `cleanup-relations.ts` `isLiveInFlight`.
- [ ] **Step 2:** Implement the guard module (estate allowlist `CLEANUP_ESTATE_TABLES` re-exported from the classification's table set, four-stage refusal engine, fresh in-flight probe with upward cascade closure over live catalog edges, `CleanupDeletionGuardReport`, `assertCleanupDeletionAllowed`).
- [ ] **Step 3:** Verify GREEN on the dedicated database; then full-suite, typecheck, biome lint.

### Task 3: REFACTOR + verification + report

- [ ] Re-run all four cleanup integration suites (21.1–21.4 behavior unchanged) + smoke `settle-idempotency` 29-green.
- [ ] `bun run --filter server typecheck`; `bunx biome lint --error-on-warnings` on changed files.
- [ ] Write `.omc/reports/b5-349.md` + ticket Checkpoint (uncommitted HEAD sha256 manifest).
