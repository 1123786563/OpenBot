# M02-R1B-R2 Fair Reconciliation and Real Storage Verification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. This focused repair has one serial backend task because the implementation and both integration suites share the intent reconciler and reserved PostgreSQL test database. No commits, stashes, or parallel implementation.

**Goal:** Close the two findings from the M02-R1B-R1 gate by ensuring unresolved old intents cannot starve later accepted messages and by exercising the production tenant-storage inspection seam against a provisioned restricted tenant.

**Architecture:** Reuse the existing `mastra_message_intents.updated_at` field and pending index as durable retry progress: order bounded scans by oldest update time and advance only still-pending absent/mismatched candidates after inspection. Keep exact-only finalization and existing lock order. Add one integration case that calls the real `TenantMastraStorage.inspectIntentMessage` over the provisioned tenant role and real Mastra PostgresStore.

**Tech Stack:** TypeScript, Bun, Drizzle/PostgreSQL, Mastra `PostgresStore`.

**Spec:** Approved Mastra design §§5–7; main migration plan Task 2 and Global Constraints; original R1B review/validation; R1B-R1 review `reports/m02-r1b-r1-review.md` (SHA256 `f4647a68c60d98a42d026d848dc677d6acba8170d4c37df4d8654ed6bd48036e`) and validation `reports/m02-r1b-r1-validation.md` (SHA256 `2ef960ba55471e0c16e7b74db2960cdb4979634686bb3ffed1030313009a6719`).

## Global Constraints

- “禁止 OpenBot 消息表与 Mastra Memory 同时成为新的可写消息主存储。”
- “从可信 scope 生成，不接受客户端替换。”
- “未知副作用进入对账”；reconciliation only inspects and finalizes an exact already-written Mastra message; it never calls `saveMessages`.
- “DB tests 只使用显式校验 TEST_DATABASE_URL 的专用合成库，不能回退 DATABASE_URL 或 openbot。”
- Keep reconciliation bounded to a validated limit and scoped to the requested tenant; unresolved/malformed rows remain pending and must not block later rows forever.
- Preserve established lock order (attachment-channel locks, conversation advisory lock, intent row, then tenant Mastra thread lock); no migration or public route is introduced.
- Run DB suites serially against the verified reserved PG17 test database. Do not drop/reset/truncate it or clean unowned schemas, roles, or fixture rows.
- No commit, stash, reset, history rewrite, or edits outside the registered owned paths and this plan's evidence files.

## Review Focus

1. More than one bounded page of absent/mismatched pending intents cannot starve a later exact accepted write; test at least three unresolved intents with `limit=2`, then an exact later intent, and assert it is finalized on a subsequent bounded call without another Mastra write.
2. Advancing retry order never changes an absent/mismatched intent's state or attachment ownership; assert those rows remain pending and their attachments stay unstamped.
3. The production tenant-storage inspection uses the trusted provisioned runtime role and real PostgresStore; exact, absent, and each identity mismatch return the expected result without writing messages.
4. Concurrent reconciliation remains serialized by the existing locks; exact finalization remains atomic for attachment stamps, pending-reference removal, and state transition.

## Task 1: Fair bounded intent reconciliation and production inspection coverage

**Depends on:** R1B-R1 implementation checkpoint; R1B-R1 independent review and backend validation are complete but failed the gate. **Roles:** `backend_implementer` → `backend_validator` → `reviewer`.

**Files / ownership:** Modify `server/src/enterprise/conversations/mastra-intent-reconciler.ts`, `server/tests/enterprise/conversations.integration.test.ts`, and `server/tests/enterprise/mastra-storage.integration.test.ts`. Do not edit `service.ts`, `tenant-storage.ts`, schema, migrations, or unrelated tests unless the controller first records an exact new path and before hash. Save implementation report/package and gate reports under `.superpowers/sdd/2026-10-10-mastra-intelligence-migration/`.

**Interfaces:** Preserve `createMastraMessageIntentReconciler({data, mastraStorage}).reconcilePendingForTenant(tenantId, limit): Promise<ReconcileOutcome>` and `TenantMastraStorage.inspectIntentMessage(binding, expected): Promise<"absent" | "exact" | "mismatch">`. Use `mastra_message_intents.updated_at` as durable retry progress; no schema migration or scheduler contract change is in scope.

- [ ] **Step 1 — RED, starvation:** Add `reconciler advances past multiple unresolved batches and finalizes a later exact intent`. Seed at least three older pending intents whose inspections return absent/mismatch, followed by an exact stored-message intent; call with `limit=2` for bounded successive scans. Assert an exact later candidate finalizes without another `saveMessages`, while unresolved candidates stay pending. Run the focused test against the current created-at scan and capture the repeated first-page starvation as RED.
- [ ] **Step 2 — RED, real adapter seam:** In `mastra-storage.integration.test.ts`, use its provisioned tenant A restricted runtime role, real `createTenantMastraStorage`, and real Mastra PostgresStore. Save a synthetic message with valid tenant-private resource and the OpenBot digest/sequence/client-key/attachment metadata; assert inspection returns `exact`, a nonexistent ID returns `absent`, and wrong resource/digest/sequence/client key/attachment list return `mismatch`. Run before implementation and save the observed result; if the current adapter already passes, record this as new coverage with a passing characterization test rather than manufacturing a failure.
- [ ] **Step 3 — GREEN, bounded fairness:** Change pending candidate order to stable oldest `updatedAt` with deterministic tie-breakers. For every still-pending absent/mismatch outcome—including malformed persisted attachment identity—advance `updatedAt` in the same platform transaction using database time and a strictly increasing per-row timestamp; keep the intent pending, preserve attachments/references, and report the existing outcome counts. Do not change exact finalization or acquire locks in a different order. If a concurrent worker already finalized/deleted the candidate, do not rotate it.
- [ ] **Step 4 — GREEN, real inspection:** Keep the tenant-storage implementation read-only. The new provisioned-role test must exercise its real `getStore`, restricted role checks, thread lock and `listMessagesById`; no fake `inspectIntentMessage`, `as never`, `saveMessages` spy-injection workaround, or public route is allowed for this case.
- [ ] **Step 5 — Verify:** Verify the synthetic TEST_DATABASE_URL tuple and migration head before running DB tests. Run serially: `bun test --timeout 60000 --max-concurrency 1 server/tests/enterprise/conversations.integration.test.ts`; `bun test --timeout 60000 --max-concurrency 1 server/tests/enterprise/mastra-storage.integration.test.ts`; existing attachment sweeper/store suites; migration journal suite. Run targeted Biome, `bun run --filter server typecheck`, and `git diff --check`. Only the previously recorded M17 `server/scripts/enterprise-runtime-probe.ts:63` diagnostic may remain in server typecheck; no new task-owned diagnostic is acceptable. Verify exact cleanup of this task's fixtures and registry records without touching unowned legacy data.
- [ ] **Step 6 — Checkpoint:** Record actual RED/GREEN evidence, commands/results, DB identity/head, exact cleanup evidence, concerns, and source hashes. Controller verifies the increment against the immutable before snapshot before dispatching validator, then reviewer, each against the same after hashes. The reviewer must re-evaluate both R1B-R1 findings and all original R1B acceptance; all valid High/Medium findings must be closed before R1B can become verified.

**Acceptance / failure handling:** Fairness test proves a later exact accepted write is eventually finalized across bounded calls while unresolved rows remain pending; real adapter test proves exact/absent/mismatch against provisioned PostgresStore under the restricted runtime role; no write is issued by reconciliation; existing R1B tests and serial suites pass. Any remaining finding keeps R1B and all dependent tasks pending.

## Plan self-review

- **Coverage:** The plan addresses both R1B-R1 review findings and reasserts exact-only recovery and original R1B behavior; no unrelated Task 2 functionality is added.
- **DAG:** One independently testable backend slice; no dependency edge or cycle; all two review findings map to Task 1.
- **Interface consistency:** Existing reconciler and storage signatures stay stable; only `updated_at` ordering changes and no public scheduler/API contract is invented.
- **Ownership / shared state:** One implementation owner owns the reconciler plus two test files; DB suites stay serial. Validator and reviewer run only after frozen package verification.
- **Submission:** No commits or stash; check-point evidence binds the exact uncommitted content hashes.
