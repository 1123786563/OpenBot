# T04 Review Fixes R1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Tasks are executed serially in this worktree and each ends with an exact-checkpoint validator and reviewer.

**Goal:** Close T04 review findings by enforcing per-Run cumulative model usage, capability-bound model calls, lease fencing, durable outbox claims, correct provider protocols and existing model/credential integration.

**Architecture:** TS remains the authoritative run and usage ledger. A short-lived opaque model-invocation capability is issued for one run attempt and request, and its digest is bound in the database to the locked route, token claim and deadline. Model requests use that capability and existing TS provider/desktop-plan adapters; the Go runtime receives no database access or provider secret. Persistent outbox claims and database-time lease predicates fence duplicate dispatch and stale callbacks.

**Tech Stack:** TypeScript, Bun, Drizzle ORM, PostgreSQL RLS/advisory locks, existing CopilotKit model/provider and PlanModel adapters.

**Spec:** `docs/superpowers/specs/2026-10-09-trpc-intelligence-migration-design.md`; `docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md` §§ 8–10; parent implementation `docs/superpowers/plans/2026-10-09-trpc-intelligence-migration.md` Task 4; findings `.superpowers/sdd/2026-10-09-trpc-intelligence-migration/reports/task-4-review.md`.

## Global Constraints

- TS remains the only writer of enterprise run, budget, authorization and durable event state.
- Go receives only short-lived, narrow capabilities and has no business database connection or long-lived provider secret.
- Every capability binds tenant, run, attempt, fencing generation, locked route, deadline and token ceiling.
- Tool/model budgets use integer tokens and idempotent usage claims; usage is accounted per model attempt/request.
- Provider and model routing is platform-controlled; failures never silently fall back to an unapproved model.
- User ruling 2026-10-10: each Run has an independent configured token ceiling; all model attempts within that Run share its cumulative ceiling; other Runs do not consume that Run’s allowance.
- Ruling T04-R1-R01: preserve the configured ceiling on each Run's immutable `run-ceiling:<run_id>` reservation, while request claims account actual/in-flight spend only within that Run; do not apply a principal-wide aggregate admission pool. The route's own per-request maximum remains a separate upper bound. Keep ordinary `RunService.reserveModelBudget` idempotency under the distinct `run:<run_id>` key. This follows the user's per-Run ruling while avoiding a key collision with the public reservation API. Cost if wrong: admission/accounting semantics and R1 tests require revision.
- Never print real credentials or capability tokens. PostgreSQL integration tests use only fresh guarded `openbot_enterprise_r2_codex_20261009`, synthetic fixtures and transient least-privilege logins; never fall back to `DATABASE_URL`.
- Preserve T03 verified changes, all user-authored work and `.DS_Store`; no commit or stash.

## Review Focus

1. A replayed model request ID cannot spend tokens or call a provider twice; atomically consume the capability before dispatch and test duplicate resolution/consumption plus unknown upstream outcome.
2. Concurrent requests in one Run cannot reserve more than the Run ceiling, while two different Runs can each use their own full ceiling.
3. An attempt whose database lease has expired cannot commit even before a sweeper rotates its generation.
4. Concurrent outbox dispatchers cannot claim the same live lease; stale owners cannot acknowledge a reclaimed event; stable event IDs support at-least-once consumer dedupe.
5. Tool-call inputs, Anthropic usage frames, split-secret chunks and client cancellation preserve protocol semantics without exposing credentials.

---

### Task 1: Per-Run Usage Ledger and Model Invocation Capability

**Depends on:** T04 implementation checkpoint `T04-after-1`. **Role:** `backend_implementer` → `backend_validator` → `reviewer`.

**Files:**

- Create `server/src/enterprise/runs/model-capability.ts` and a new numbered Drizzle migration/snapshot.
- Modify `server/src/db/schema/enterprise-runs.ts`, `server/src/enterprise/models/budget.ts`, `server/src/enterprise/runs/service.ts`, `server/src/enterprise/runs/store.ts`, `server/tests/enterprise/runs.integration.test.ts`, schema registration and Drizzle journal/config as needed.

**Interfaces:**

- Consumes verified `PlatformScope`, `RunService`, run/attempt rows, and `ModelGateway` boundary.
- Produces `RunService.issueModelInvocationCapability(scope, input)` returning `{ capability, model_request_id, maximum_tokens, expires_at }`; `ModelInvocationContext` resolved from the opaque bearer capability; per-request `reserve`, `confirmUsage`, `markUnknown`, and safe pre-dispatch `release` operations.

- [x] **Step 1 — RED:** Add live PostgreSQL tests proving multiple Runs each receive the full configured ceiling independently; same-Run requests share a cumulative ceiling across confirmed and in-flight claims; retries/attempts count against it; model request ID replay is idempotent; changed inputs conflict. Assert raw capabilities are absent from persisted rows and DTOs.
- [x] **Step 2 — Verify RED:** Use a fresh guarded PostgreSQL database. Expected failures must be limited to missing/incorrect capability and usage behavior.
- [x] **Step 3 — Implement:** Keep each Run's configured ceiling on immutable `run-ceiling:<run_id>` and preserve ordinary `run:<run_id>` reservation idempotency separately; never aggregate admission across distinct Runs. Store only a cryptographic digest of each random, short-lived, request-scoped capability. Bind its tenant/run/attempt/generation/route/request ID/token claim/expiry. Reserve under a transaction lock against that Run’s ceiling, including confirmed usage and unresolved in-flight/unknown claims, and enforce the locked route's per-request maximum. Resolution must atomically consume the capability before returning dispatch context; replay must fail, and release is allowed only before consumption. Confirm usage idempotently per attempt/request; same ID/same usage replays, changed usage conflicts. Unknown usage keeps its conservative reservation for reconciliation. Integrate issue/consume/usage interfaces without exposing a provider key to Go.
- [x] **Step 4 — GREEN:** Run focused integration tests on a fresh guarded DB; assert fixtures cleaned and DB/temporary roles removed. Run assigned TypeScript, Biome and diff checks.
- [x] **Step 5 — Snapshot and independent review:** Produce complete before/after manifest, package, hashes and self-review; validator and reviewer inspect the exact checkpoint.

**Acceptance:** resolves T04-R01 and establishes the secure contract needed for T04-R02. No run may spend beyond its configured cumulative token ceiling; confirmed usage remains accounted within that Run and does not reduce another Run’s budget.

### Task 2: Database-Time Lease Fencing and Durable Outbox Claims

**Depends on:** Task 1 (shared schema migration sequence and per-attempt usage contract). **Role:** `backend_implementer` → `backend_validator` → `reviewer`.

**Files:**

- Modify `server/src/db/schema/enterprise-runs.ts`, `server/src/enterprise/runs/store.ts`, `server/src/enterprise/runs/model-capability.ts`, `server/src/enterprise/runs/outbox.ts`, `server/tests/enterprise/runs.integration.test.ts`; append a new migration and snapshot; update journal.

**Interfaces:**

- Consumes current Run/attempt IDs, generation and lease from Task 1.
- Produces terminal CAS that checks both Run and active attempt lease using PostgreSQL `now()` in the atomic update, an exported DB-time active-attempt lease validator consumed by model-capability resolution, plus `claimPending(scope, { ownerId, batchSize, leaseMilliseconds }): Promise<RunOutboxClaim[]>` and `acknowledge(scope, { eventId, claimId, ownerId }): Promise<boolean>`. Each claim contains `{ claimId, ownerId, expiresAt, message }`; `message.id` is the stable event id. Ack succeeds only when ID/owner match and DB `now()` is earlier than claim expiry. `publishPending` remains the convenience composition over claim, publish and owner-checked ack.

- [ ] **Step 1 — RED:** Add DB cases where an expired attempt tries success before any sweeper call and must lose; capability consumption rejects an expired DB-time lease even if the application clock is behind; two owners concurrently call `claimPending` and receive disjoint live event IDs; after the first claim expires, another owner reclaims it and the old `(eventId, claimId, ownerId)` ack returns false while the new owner's ack succeeds; failed publish is retryable after expiry with the same stable `message.id`.
- [ ] **Step 2 — Verify RED:** Fresh guarded DB; each new assertion fails for the reviewed reason, without setup failures.
- [ ] **Step 3 — Implement:** Put lease checks inside the atomic terminal-state CAS and use DB time; lock/update Run and attempt consistently with cancellation and rotation. Persist outbox `claim_id`, `claim_expires_at`, and attempt/generation if required; atomically claim with `SKIP LOCKED`, publish outside the DB transaction, and acknowledge only by matching live claim. Preserve at-least-once semantics and stable consumer dedupe; do not claim impossible exactly-once external delivery.
- [ ] **Step 4 — GREEN:** Run focused guarded PostgreSQL suite and assigned static checks; verify all fixture counts zero and drop the reserved database/transient roles.
- [ ] **Step 5 — Snapshot and independent review:** Bind validation and review to the exact after hashes.

**Acceptance:** resolves T04-R03 and T04-R04; expired workers never commit terminal state; concurrent dispatchers do not hold duplicate valid claims and stale owners cannot ack reclaimed work.

### Task 3: Provider Protocol, Streaming, and Existing Model/Plan Adapters

**Depends on:** Tasks 1–2. **Role:** `backend_implementer` → `backend_validator` → `reviewer`.

**Files:**

- Create `server/src/enterprise/models/runtime-adapter.ts`.
- Modify `server/src/enterprise/models/gateway.ts`, `server/tests/enterprise/model-gateway.test.ts`, and run integration tests only where capability flow requires it. Consume (do not fork) `runtimeModelForEnvironment`, `resolveModelApiKey`, the model credential reader and `PlanModel` / `planModelForEnvironment`.

**Interfaces:**

- Consumes a single authenticated invocation resolver seam that returns the one-time consumed `ModelInvocationContext` from Task 1 plus opaque usage settlement methods; the resolver owns its trusted scope and raw capability and never derives tenant/principal/run/route/token authority from the body. Also consumes DB-time active-attempt lease validation from Task 2, provider route selection and existing model/credential interfaces.
- Produces an authenticated `ModelGateway.handle(request)` that obtains route, model and token ceiling only from the validated capability; accepts no caller-selected provider/endpoint. If a Go OpenAI client must send a model field, it is only a compatibility hint checked against the locked route and never used for selection. Existing consumers receive equivalent canonical response events for OpenAI, Anthropic and the explicit desktop plan adapter.

- [ ] **Step 1 — RED:** Add provider request/response tests for OpenAI, Anthropic assistant tool calls, tool results, usage frames, and desktop PlanModel route; add true streaming test proving first caller chunk arrives before upstream completion, split-secret redaction, request-abort propagation, and no secret in errors/logs; test body route/token substitution and expired capability rejection.
- [ ] **Step 2 — Verify RED:** Run the targeted unit suite and guarded integration test; expected failures must isolate missing protocol/capability behavior.
- [ ] **Step 3 — Implement:** Translate supported canonical chat/tool messages faithfully to each provider and normalize responses back to the Go-facing wire format. Reject malformed/unsupported shapes. Stream through a bounded parser/redactor with cancellation and deadline propagation; capture final provider usage into the Task 1 idempotent ledger, and conservatively mark unknown if a sent request ends without authoritative usage. Use `runtimeModelForEnvironment` plus `resolveModelApiKey` and the existing credential reader for API-key providers. Route explicit desktop plans through existing `PlanModel` rather than treating a harness token as a provider key. Never persist or log raw keys/tokens.
- [ ] **Step 4 — GREEN:** Run gateway tests and guarded run/model integration tests, strict assigned typecheck, Biome, Drizzle check/generation consistency and `git diff --check`.
- [ ] **Step 5 — Snapshot and independent review:** Produce exact package/snapshot and independent Spec/quality verdicts.

**Acceptance:** resolves T04-R02, R05, R06 and R07; approved model route and quota cannot be changed by request body; existing provider and desktop plan seams are exercised; SSE is incremental and cancellation-safe. Endpoint mounting and independent Go service-auth composition remain T06-owned; T06 must use a Runs-owned capability authorizer that safely resolves tenant scope without trusting Go-supplied tenant/principal/run fields.

### R2 Review Fix Round 1: Database-Authoritative Capability Expiry and Publisher Composition

**Depends on:** T04-R2 checkpoint `T04-R2-after-1`; scope is only findings R2-F01 (Important) and R2-F02 (Minor). **Role:** `backend_implementer` → `backend_validator` → `reviewer`.

**Files:** Modify `server/src/enterprise/runs/model-capability.ts` and `server/tests/enterprise/runs.integration.test.ts`; save implementation, validation and review reports under this plan's SDD report directory.

**Interfaces:** Keep existing capability resolve and `publishPending` public signatures. Capability status consumption must atomically require `expires_at > now()` in PostgreSQL. Publisher failure must be exercised by calling `publishPending`; its documented result is zero acknowledgements and an expired claim remains reclaimable with the same stable event ID.

- [ ] **Step 1 — RED:** Create a capability, keep Run and attempt leases live, set only capability expiry into the past, move application `Date` ten minutes behind, and assert resolution rejects. Route the failed-publish/reclaim test through `publishPending` with a throwing publisher, assert zero acknowledgements, then reclaim after expiry and assert the same stable event ID.
- [ ] **Step 2 — Verify RED:** Run the focused test in a fresh guarded PostgreSQL database; expiry must be accepted before the fix and public composition behavior must be absent/unverified as appropriate. Record cleanup evidence.
- [ ] **Step 3 — Implement:** Remove application-clock authority from capability consumption; add DB `now()` expiry to the conditional reserved-to-consumed update while retaining Run/attempt database-time lease validation and one-use CAS. Test `publishPending`'s existing catch/ack/retry composition without changing its public contract.
- [ ] **Step 4 — GREEN:** Run focused guarded integration suite; verify fixture counts and cleanup; run Biome, Drizzle and diff checks.
- [ ] **Step 5 — Exact checkpoint review:** Snapshot before/after, generate incremental package bound to file hashes, then obtain independent backend validation and scoped code re-review of R2-F01/F02.

**Acceptance:** an app clock behind cannot extend the capability's own deadline; public publish composition leaves failed events unacknowledged and retryable with stable IDs.

### R2 Review Fix Round 2: Prove Public Failed-Publish Delivery Attempt

**Depends on:** R2 fix round 1 checkpoint; scope is only residual R2-F02 test-quality finding. **Role:** `backend_implementer` → `backend_validator` → `reviewer`.

**Files:** Modify only `server/tests/enterprise/runs.integration.test.ts`; save fresh RED/GREEN output and reports in this plan's SDD report directory.

**Interfaces:** Production `publishPending` API remains unchanged. The test must not call `claimPending` for the target event before `publishPending`. The throwing callback captures visited message IDs in test state; assertions execute only after `publishPending` returns because production intentionally catches publisher failures.

- [ ] **Step 1 — Test sensitivity:** Remove the pre-claim for the target event and capture publisher call IDs. Since this is a test-only coverage fix and production behavior should already pass, demonstrate the new post-return visitation assertion with a temporary test-only negative control (publisher callback does not record the target); verify it fails, then restore the intended callback and record hashes. Do not alter production behavior to manufacture a RED.
- [ ] **Step 2 — GREEN:** Let `publishPending` make the first claim; run the guarded PostgreSQL integration test and verify the target is called and later reclaimed under the same stable ID.
- [ ] **Step 3 — Evidence:** Save the full post-change GREEN output to a new fix2-specific report artifact (do not reuse stale R2 10/62 output), verify fixture/database/role cleanup, Biome and diff checks, and bind hashes to a fix2 package.
- [ ] **Step 4 — Independent gates:** Exact-checkpoint backend validation and scoped re-review; no production code changes.

**Acceptance:** the test fails if `publishPending` never invokes the target publisher, if it acknowledges failure, or if the same event is not retryable after lease expiry.

## DAG / Execution Order

`Task 1 → Task 2 → Task 3`. Only the dependent downstream task starts after the previous exact checkpoint has passed validator and reviewer and its changes remain present in the same worktree. After all three verify, update the parent T04 node. OCR remains the outer review gate after all original migration tasks T01–T20 complete.
