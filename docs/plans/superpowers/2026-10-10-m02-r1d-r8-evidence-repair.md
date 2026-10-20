# M02 R1D — R8 Behavioral Evidence Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax; each source checkpoint receives independent validation and review before the final R1C re-audit.

**Goal:** Close the three evidenced M02-R8 gaps with a read-only legacy conversation surface and direct request-facing, real tenant-store tests for persistence, scope/resource isolation, persisted backend dispatch, and Mastra attachment authorization.

**Architecture:** Remove the currently unused raw Mastra repository append capability for legacy `intelligence` rows; new message writes remain solely in the trusted `ConversationService.append` intent/fencing path. Add PostgreSQL integration evidence at the service boundary, with platform catalog/intents in the verified data database and Mastra messages in a provisioned restricted tenant store. The later Task 12 production cutover CAS/fence remains owned by Task 12; this repair tests the Task 2 persisted-backend dispatch contract, not an unimplemented migration API.

**Tech Stack:** TypeScript/Bun, Drizzle/PostgreSQL, Mastra PostgresStore, existing verified tenancy/provisioning fixtures.

**Spec:** Approved Mastra migration spec `docs/specs/superpowers/2026-10-10-mastra-intelligence-migration-design.md` §§4–5, 10; Task 2 brief `.superpowers/sdd/2026-10-10-mastra-intelligence-migration/task-2-brief.md`; R1C findings `.superpowers/sdd/2026-10-10-m02-r1c-behavioral-acceptance-audit/reports/m02-r1c-review.md`.

## Global Constraints

- Use only the dedicated synthetic PostgreSQL URLs from `m02-r1a-brief.md`; verify database/current roles/journal and never fall back to `DATABASE_URL`.
- Keep DB suites serial; use random tenant/thread/attachment identities and assert exact fixture cleanup.
- Preserve the current R1B R2 reconciler/test changes as the baseline; no commit/stash/reset, no unrelated edits.
- No real users, provider calls, cloud services, deployment, or external messages.
- All new messages remain single-writer Mastra messages; do not add writes through legacy Intelligence or `enterpriseMessages`.
- Keep public scope/thread/resource/tenant selection server-derived. Runtime tenant roles remain restricted and provisioning credentials remain separate.

## Review Focus

1. A real accepted public-service write must survive a newly constructed restricted tenant pool and return from public history without a platform message row.
2. Foreign principal, forged thread, and extra client `resourceId` inputs must not reach Mastra storage or writes.
3. Private resource identity must be principal-specific; channel bindings must be live-authorized, channel-specific, and disjoint from private IDs.
4. Mastra attachment authorization failures must leave no Mastra write, finalized intent, or attachment stamp.
5. A persisted backend change must govern the next service append; Task 12 alone owns production cutover CAS and in-flight cutover semantics.

---

### Task R1D: M02-R8 public write-boundary and integration evidence

**Depends on:** R1B verified; R1C audit reports recorded. **Roles:** `backend_implementer` → `backend_validator` → `reviewer`.

**Files:** Modify `server/src/mastra/conversations.ts`, `server/src/enterprise/conversations/service.ts` only if a focused behavior RED proves a needed correction, `server/tests/enterprise/conversations.integration.test.ts`, and `server/tests/enterprise/mastra-storage.integration.test.ts`. Do not modify schema/migrations, attachment production code, setup infrastructure, or other source/test files.

**Consumes:** Verified `createConversationService`, `createTenantMastraStorage`, `PostgresTenantProvisioner`, live membership/resource authorization, R1B intent/reconciler seam, and the exact R1C input snapshot.

**Produces:** Legacy Mastra repository supports authorized resolve/history only and has no append capability; real request-facing Mastra persistence/reopen evidence; direct adversarial binding/resource/attachment cases.

- [ ] **Step 1 — RED:** Add a contract test asserting the legacy `createMastraConversationRepository` exposes `resolve`/`history` but no `append`; run it against the current export and capture the expected failure. Add focused named tests for real-store public append→close/recreate pool→public history, foreign/forged thread/resource zero writes, principal/channel/tenant resource separation, persisted backend dispatch after a controlled row version change, Mastra attachment denial, and revoked legacy mapping denial. Record any environment-only failure separately from product RED.
- [ ] **Step 2 — Boundary correction:** Remove `append` from `MastraConversationRepository` and `createMastraConversationRepository`; preserve `resolve`, authorized `history`, and `readMastraHistory`. Confirm repository search has no production caller of the removed write API. All new writes must use `ConversationService.append`.
- [ ] **Step 3 — Real tenant store integration:** In `mastra-storage.integration.test.ts`, use a verified `DataDatabase`, authenticated `PlatformScope`, existing provisioner/registry fixture, and a real restricted tenant `PostgresStore`. Public `ConversationService.getOrCreate/append/history` must store one message with expected ID/content/seq and zero `enterpriseMessages`. Fully close the first tenant storage; create a fresh lookup/storage/service and read the same accepted message via public history; verify storage still has one message. Cleanup exact generated platform rows, runtime schemas/roles, credentials, and registry fixture entries, with readback assertions.
- [ ] **Step 4 — Identity and denial coverage:** In the public conversations integration suite, prove a foreign principal cannot resolve, append to, or read the owner’s Mastra thread and causes zero calls to tenant storage/write. Pass an extra forged `resourceId` field and prove it is ignored/rejected and the service derives the exact trusted resource. Assert repeated binding for the owner is stable, another principal has a different private resource, two authorized legacy channels resolve to their own `channel:<id>` identities distinct from private scope, and another provisioned tenant uses a different storage key/schema identity. Revoking a legacy channel’s membership/read grant must make resolve/history fail.
- [ ] **Step 5 — Persisted backend and attachment cases:** After a controlled test-fixture change from a legacy/platform row to persisted `mastra` plus incremented `backendVersion`, prove the next `ConversationService.append` performs one Mastra write and zero platform writes; a stale legacy repository has no write method. On a Mastra conversation, a foreign/revoked/deleted-channel attachment must reject before Mastra save, keep no finalized intent, and leave `attachedAt` unchanged. Do not claim this fixture mutation proves Task 12’s production CAS or in-flight cutover race; those stay explicitly assigned to Task 12.
- [ ] **Step 6 — GREEN and cleanup:** Run the focused R1D tests, then serially run `bun test --timeout 60000 --max-concurrency 1 tests/enterprise/mastra-storage.integration.test.ts`, `bun test --timeout 60000 --max-concurrency 1 tests/enterprise/conversations.integration.test.ts`, `bun test --max-concurrency 1 tests/attachment-store.test.ts`, and `bun test --max-concurrency 1 tests/attachment-sweeper.test.ts`, with the exact four synthetic URLs and no fallback. Run targeted Biome, `git diff --check`, and server typecheck; record the existing unowned M17 probe diagnostic separately if it persists.
- [ ] **Step 7 — Checkpoint:** Create exact fix package against `snapshots/m02-r1d-before.json`, append command/results and all hashes to the implementation report, and stop. Controller independently verifies the full increment and dispatches validator/reviewer on the same frozen package.

**Acceptance:** M02-R1C-01, M02-R1C-02, M02-R1C-03 addressed by direct evidence; R1C re-audit may close M02-R8 only after validator PASS and reviewer Spec/Code PASS. Task 12 remains responsible for the real authorized import/cutover CAS, pending-intent gate, and synchronized production cutover race.

## Pre-dispatch consistency

| Node | Owned boundary | Consumes / produces | Dependency | Verification |
|---|---|---|---|---|
| R1D | Repository write capability, ConversationService integration tests and Mastra storage tests | Consumes R1B service/saga/store interfaces; produces no new product API | R1B verified; R1C audit findings | RED legacy writer contract; real restricted-store reopen; adversarial binding/resource/attachment and persisted backend tests; serial suites; independent review/validation |

DAG: one unique task, no dependencies inside the node, no cycle, all three R1C findings mapped, Task 12 cutover acceptance kept external and explicit. Tests share one reserved PostgreSQL database, therefore the implementation and validator must run all database commands serially.
