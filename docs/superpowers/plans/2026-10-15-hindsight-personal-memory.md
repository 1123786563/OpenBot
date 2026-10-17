# Hindsight Personal Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace OpenBot's personal memory retrieval and inference path with a self-hosted Hindsight index while keeping OpenBot authoritative for approval, access, provenance, and deletion.

**Architecture:** The memory module accepts a server-derived tenant/user/workspace/Bot/source scope and stores reviewed facts in OpenBot PostgreSQL. A private Hindsight adapter indexes stable OpenBot document IDs and returns ranked IDs only; every result is reloaded and authorized from OpenBot. Durable jobs reconcile indexing and deletion. A shared Hindsight deployment uses distinct banks for common preferences and each restricted scope, plus server-signed tenant authentication and bank operation validation.

**Tech Stack:** Bun, TypeScript, Hono, Drizzle/PostgreSQL, React, self-hosted Hindsight, OpenBot's approved model gateway.

**Spec:** `docs/specs/2026-10-15-hindsight-personal-memory-design.md`; prerequisite: `docs/specs/2026-10-14-company-team-multitenancy-design.md`; architecture: `docs/adr/0005-self-hosted-hindsight-for-personal-memory.md`, `CONTEXT.md`.

## Global Constraints

- Production memory integration starts only after the approved company/team multitenancy plan supplies trusted tenant/workspace authorization and its full-system isolation gate passes. That project has its own plan and release criteria; this plan does not replace it.
- Never infer historical company ownership from a global user ID. Quarantine records without proven tenant ownership.
- Unreviewed candidates are invisible to every cross-session retrieval path, including SQL fallback and the originating Bot. Only confirmed inputs may support derived judgments; judgments require their own confirmation.
- Only explicitly designated common personal preferences may cross teams inside one company. No personal memory crosses companies.
- Hindsight output never directly enters a Bot response. Load confirmed OpenBot rows by ID and recheck current authorization, time validity, source status, and dependency status.
- No direct end-user or administrator access to the Hindsight API or UI. Tags are classification only; banks plus trusted authorization are the isolation boundary.
- Use the existing approved OpenBot model gateway. Background work is platform-paid, with company and user budgets; exhausted budgets queue work.
- For privacy, disable content-bearing Hindsight model tracing, configure completed-operation payload retention to one day, and configure controlled backups to at most 30 days. Verify actual purge before reporting controlled-copy cleanup complete.
- No production launch until live Hindsight isolation, deletion, observation linkage, backup-restore replay, and cross-entrypoint tests pass. Launch is for all eligible users after that gate.
- No commits, pushes, deployment, or release are authorized by this approved design. During execution use documented uncommitted checkpoints and review their actual diff.

## Review Focus

1. A single global user in two companies must not read or alter company A memory through company B; Task 1 tests both directions.
2. A source revoked between Hindsight recall and OpenBot hydration must produce no content; Task 5 tests this race.
3. A forgotten premise retried from an old job or restored backup must not resurrect itself or a derived judgment; Task 7 tests replay.
4. A remote hit with no current OpenBot row, or a shared/untagged Hindsight observation, must produce no Bot content; Tasks 4 and 5 test this.
5. A candidate produced by the same Bot must remain absent from both normal recall and Hindsight-outage SQL fallback; Task 2 tests this.

---

## Execution prerequisites and file map

Before Task 1, read the multitenancy project's implementation ledger and verify tenant/workspace columns, trusted scope APIs, migration ownership evidence, and the full-system isolation gate. If these are absent, stop production work at this dependency and do not ship a single-company Hindsight shortcut. As of this plan's creation, `server/src/db/schema/memory.ts` has no tenant/workspace columns; the multitenancy design alone is not implementation evidence.

`server/src/memory/` owns the public memory seam, policy, indexing adapter, jobs, and recall. `server/src/db/schema/memory.ts` and a new `server/drizzle/` migration own durable tenant, review, temporal, derivation, and sync state. `server/src/memory/routes.ts` and `server/src/memory/tools.ts` expose approved operations through trusted scope. `app/src/components/memory/memories.tsx` and `app/src/lib/memory.ts` own user review and controls. New deployment configuration beside the repository's existing service definitions owns the pinned Hindsight image, private network, extension, gateway and retention settings; select and record the tested image digest in that task, never use `latest`. Each worker checks the repository's actual paths before editing generated files.

### Task 1: Tenant-owned personal memory seam

**Role:** `backend_implementer`; independent validation: `backend_validator`, then `reviewer`. **Depends on:** verified multitenancy prerequisite.

**Files:** Modify `server/src/db/schema/memory.ts`, `server/src/memory/types.ts`, `server/src/memory/store.ts`, `server/src/memory/ingestion.ts`, `server/src/memory/routes.ts`, `server/src/memory/tools.ts`; create the matching `server/drizzle/` migration and targeted integration tests in `server/tests/`.

**Interfaces:** Consume the multitenancy project's trusted server-side authorization context. Produce `MemoryScope = { tenantId: string; ownerUserId: string; workspaceId: string | null; botId: string | null; authorizedSourceIds: readonly string[] }` and scope-based memory operations; callers cannot supply bank IDs.

- [ ] Write integration tests for the same `ownerUserId` in two tenants, team A versus B, company-admin versus owner, and a historical row with unprovable company ownership. Expect access denial or quarantine in each prohibited case.
- [ ] Run the targeted tests and record the expected failing assertions before implementation. Use `TEST_DATABASE_URL` against a dedicated disposable PostgreSQL database.
- [ ] Add tenant ownership and restricted workspace/source scope to memory and source rows, with constrained references and indexes; backfill only rows whose tenant provenance can be proven, and quarantine the rest.
- [ ] Replace owner-only memory calls with `MemoryScope` calls derived from trusted request/task identity; update every entrypoint and background source invocation.
- [ ] Run targeted integration tests, typecheck, and migration rollback/forward on disposable data. Expect no cross-tenant or cross-team row, and no unscoped callsite.

### Task 2: Review policy and SQL fallback

**Role:** `backend_implementer`; validation: `backend_validator`, then `reviewer`. **Depends on:** Task 1.

**Files:** Modify `server/src/memory/store.ts`, `server/src/memory/types.ts`, `server/src/memory/tools.ts`, `server/src/memory/ingestion.ts`; add `server/src/memory/policy.ts` and targeted tests.

**Interfaces:** Produce `isRecallEligible(memory, scope, at): boolean` and a local retrieval path returning only eligible confirmed OpenBot rows. Review transitions remain explicit store operations.

- [ ] Write failing tests: auto-observed/imported candidate invisible to its Bot and SQL fallback; explicit ordinary “remember” confirmed exactly as stated; secret refused; medical/financial/customer content remains a candidate requiring review; candidate expires at 30 days.
- [ ] Run tests to establish RED.
- [ ] Implement classification, review transition, expiry, and eligibility checks. Add `reviewState IN ('confirmed','edited')` to every SQL recall path, independent of Hindsight availability.
- [ ] Run targeted tests and typecheck. Expect the same approval rule on web, channel, scheduled task, and fallback callers.

### Task 3: Private Hindsight service and bank authorization

**Role:** `backend_implementer`; validation: `backend_validator`, then `reviewer`. **Depends on:** Task 1.

**Files:** Create `server/src/memory/hindsight/client.ts`, `server/src/memory/hindsight/banks.ts`, Hindsight extension/configuration and deployment files at the established repository locations, and live contract tests in `server/tests/`.

**Interfaces:** Produce `HindsightIndex` with `retain(scope, documentId, content)`, `recall(scope, query, limit)`, and `delete(scope, documentId)`; only the bank resolver converts server-validated scope to bank IDs. Return document IDs/rank/evidence metadata, never generated answer text.

- [ ] Pin a tested Hindsight image digest and verify its extension API, document delete API, recall document IDs, observation scope behavior, and gateway integration in a disposable self-hosted instance; record the digest and observed behavior in the test report.
- [ ] Write failing contract tests for forged tenant identity, guessed bank ID, wrong team/source, untagged/shared observation, and admin content access. Expect deny or no content.
- [ ] Implement OpenBot-signed service identity, `TenantExtension`, `OperationValidatorExtension`, bank naming and allowed-bank checks. Keep API/UI private; disable shared observations where they would cross a restricted boundary.
- [ ] Configure approved gateway, disabled model trace, one-day completed-operation retention and at-most-30-day backup retention. Validate runtime effective settings, not only environment text.
- [ ] Run live contract tests and confirm wrong-bank calls fail before indexing/retrieval. Preserve the exact image digest, config and test output as deployment evidence.

### Task 4: Durable indexing and migration

**Role:** `backend_implementer`; validation: `backend_validator`, then `reviewer`. **Depends on:** Tasks 1–3.

**Files:** Modify `server/src/db/schema/memory.ts`, `server/src/memory/store.ts`; create `server/src/memory/hindsight/sync.ts`, its migration and tests; update the established worker registration.

**Interfaces:** Consume `HindsightIndex` and confirmed scoped rows. Produce durable sync state keyed by `(tenantId, memoryId, generation)` and stable `documentId = memoryId`; a job records indexed, pending, retry or delete-pending status.

- [ ] Write failing tests for idempotent duplicate jobs, edit generation ordering, index failure/retry, budget exhaustion and rowless Hindsight/Intelligence content. Expect no unconfirmed or rowless item indexed or migrated.
- [ ] Run tests to establish RED.
- [ ] Persist an outbox in the same transaction as confirm/edit/delete. Workers reread current row and scope before retain, use stable document IDs, and fence stale generations. Meter per-user and per-company background model budgets through the approved platform accounting seam.
- [ ] Migrate only tenant-proven, confirmed OpenBot rows; retain unreviewed rows as candidates and deliberately omit Intelligence-only content. Reconcile counts and sample provenance before cutover.
- [ ] Run integration tests, worker retry test and migration reconciliation. Expect no duplicate active document and no claim that pending work is indexed.

### Task 5: Authorized recall and temporal evidence

**Role:** `backend_implementer`; validation: `backend_validator`, then `reviewer`. **Depends on:** Tasks 2–4.

**Files:** Modify `server/src/memory/store.ts`, `server/src/memory/ingestion.ts`, `server/src/memory/tools.ts`; create `server/src/memory/recall.ts`; update tests in `server/tests/`.

**Interfaces:** Produce `recallApproved(scope, query, at): Promise<ApprovedMemoryHit[]>`, where each hit carries confirmed OpenBot text, source/effective-time evidence and authorized basis IDs. Hindsight supplies ordering IDs only.

- [ ] Write failing tests for old Friday/current Monday meeting facts, source revocation between remote recall and hydration, missing SQL row, unauthorized bank, candidate in outage fallback, and a paused-use account. Expect only current authorized facts or authorized historical facts for a historical question.
- [ ] Run tests to establish RED.
- [ ] Query only authorized banks; reload each hit from OpenBot, check tenant/team/source/Bot authorization and effective time at hydration; drop missing or incomplete evidence. Fall back to the Task 2 SQL path on Hindsight outage.
- [ ] Remove Intelligence-only recall and direct Hindsight observations/reflect text from Bot context. Preserve attribution in `quoteMemoryContext` without treating source text as instructions.
- [ ] Run targeted tests, typecheck, and an entrypoint smoke test for web, channel and scheduled Bot runs.

### Task 6: Derived judgments and user review

**Role:** backend task `backend_implementer`, then frontend task `frontend_implementer`; validation: corresponding validators and `reviewer`. **Depends on:** Tasks 2, 4, 5. **Boundary:** backend API and types are reviewed before frontend work.

**Files:** Modify `server/src/db/schema/memory.ts`, `server/src/memory/routes.ts`, `server/src/memory/types.ts`, `app/src/lib/memory.ts`, `app/src/components/memory/memories.tsx`, relevant translations and tests.

**Interfaces:** Produce candidate list/review endpoints containing proposed text, source, observed/effective times and complete ordered basis IDs; frontend consumes only this API. Review accepts confirm/edit/reject and explicit designation of a common preference.

- [ ] Write failing backend tests: judgment with unconfirmed, cross-source or inaccessible premise rejected; same-source and common-bank confirmed premises allowed as pending judgment; basis deletion disables judgment. Run for RED.
- [ ] Persist basis edges and one-source synthesis scope; accept Hindsight observations only when every premise maps to current approved rows. Require explicit judgment confirmation before recall.
- [ ] Run backend tests and contract verification. Record the response shape for the frontend task.
- [ ] Write failing UI tests for candidate evidence, sensitive extra review, confirm/edit/reject, common-preference designation and accessible loading/error states. Run for RED.
- [ ] Implement review controls and expandable answer evidence; run UI tests, typecheck and a responsive/accessibility check.

### Task 7: Forgetting, revocation and copy cleanup

**Role:** `backend_implementer`, then `frontend_implementer` for status display; validation: both validators and `reviewer`. **Depends on:** Tasks 4–6.

**Files:** Modify memory store/routes/UI; create `server/src/memory/hindsight/deletion.ts`, durable deletion schema/migration and focused tests.

**Interfaces:** Produce two distinct statuses: `useBlockedAt` and `controlledCopiesClearedAt`; only verified cleanup may set the latter.

- [ ] Write failing tests for immediate SQL/Hindsight-use fencing, derived-judgment cascade, stale sync job, remote delete retry, and backup-restore replay. Run for RED.
- [ ] On forget or source revocation, transactionally block origin and dependent judgments before any remote call. Persist tombstone and enqueue Hindsight document/observation deletion; retain fencing across retries and restores.
- [ ] Record active-data deletion, actual completed-operation cleanup and backup expiry/restore evidence separately; set controlled-copy completion only when all controlled copies are evidenced. Verify approved gateway/provider logs separately.
- [ ] Add UI statuses and tests; run integration, restore drill and UI checks. Expect forgotten content absent even while remote deletion is pending.

### Task 8: User controls, operations and release gate

**Role:** backend `backend_implementer`, frontend `frontend_implementer`; validation: both validators and `reviewer`. **Depends on:** Tasks 1–7.

**Files:** Modify memory routes/tools/UI and established settings, admin-health, worker and deployment files; add end-to-end acceptance tests.

**Interfaces:** Produce independent `learningPaused` and `usagePaused` settings; admin health exposes counts, backlog and spend only, never personal content.

- [ ] Write failing tests for both pause controls across all entrypoints, queue-on-budget-exhaustion, admin health redaction and company/team isolation in the acceptance scenario. Run for RED.
- [ ] Implement settings, worker throttling, admin metrics and UI controls. Eliminate remaining Intelligence personal-memory authority after reconciliation.
- [ ] Run focused tests, full applicable typecheck/lint/build, live self-hosted Hindsight contracts, migration rehearsal, backup/restore drill, and the Spec's five acceptance scenarios. Record each result against the exact code/config snapshot.
- [ ] Run independent task review and a whole-delivery review. Do not open the all-user gate unless the multitenancy full-system gate, privacy evidence, deletion proof, budget behavior and every acceptance scenario are verified.

## Plan self-check and handoff

The eight tasks cover tenant ownership, policy, Hindsight isolation, durable sync, recall/time, derived review, forgetting, controls, operations and release. The dependency graph is acyclic: prerequisite → 1 → 2/3 → 4 → 5 → 6 → 7 → 8. Shared backend API/types precede frontend work; the same memory records and migration files are edited serially. The implementation coordinator should assign one writable task at a time and use uncommitted checkpoint review packages because commits are not authorized. Database integration tests require `TEST_DATABASE_URL` pointing to a dedicated test database; at planning time it was absent, so the baseline integration test could not run. A standalone memory source test passed 3/3. No production code has been changed under this plan.
