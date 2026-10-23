# Mastra Intelligence-only Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Dispatch tasks serially in DAG order through specialized implementer, independent validator, and reviewer gates; preserve per-task uncommitted checkpoints.

**Goal:** Replace CopilotKit Intelligence persistence, memory, and learning services with self-hosted Mastra-backed services while preserving OpenBot’s existing Agent execution and run governance.

**Architecture:** CopilotKit SSE provides AG-UI transport/event adaptation. OpenBot owns an injected durable AgentRunner, thread/history APIs, authorization, event intents, run coordination, approvals, learning-job budgets, and skill lifecycle. A Mastra adapter owns durable thread messages and governed memory operations; the existing built-in, remote AG-UI, and remote Mastra execution implementations remain responsible for Agent behavior. This explicitly replaces the Intelligence Runtime's private runner, websocket, locks, and thread endpoints; no Intelligence Runtime/local-thread endpoint remains. History cutover is per-conversation and single-writer.

**Tech Stack:** TypeScript, Bun, Hono, Drizzle, PostgreSQL, existing CopilotKit/AG-UI execution integrations, pinned Mastra packages and storage. Exact supported Mastra APIs must be proven against the lockfile before implementation consumes them.

**Spec:** Mastra Intelligence-only design（原设计文件未随仓库保留）, approved by user 2026-10-11. Existing enterprise requirements remain governed by [enterprise AI platform design](../../../specs/2026-10-09-enterprise-ai-platform-design.md). No Issue was supplied; this plan uses the approved spec and current code as source. The previous [Mastra unified runtime plan](../../superpowers/2026-10-10-mastra-intelligence-migration.md) is superseded wherever it assigns product Agent execution, tools, HITL, or recovery to Mastra.

## Global Constraints

- Preserve the current built-in, remote AG-UI, and remote Mastra Agent execution mechanisms.
- Implement public AgentRunner `run/connect/stop/isRunning` using durable OpenBot Run/event coordination; never use CopilotKit InMemoryAgentRunner as production persistence or authoritative run state.
- OpenBot authenticated thread/history APIs are authoritative; do not expose unscoped CopilotKit local-thread endpoints or accept client-selected Mastra thread/resource identifiers.
- Use the locked CopilotKit SSE Runtime with an injected OpenBot AgentRunner. The locked Intelligence Runtime auto-constructs its own IntelligenceAgentRunner and rejects custom runner injection, so it cannot meet the ownership boundary.
- Implement the public AgentRunner `run/connect/stop/isRunning` contract using durable OpenBot Run/event coordination. Never use CopilotKit's default in-memory runner as production persistence or authoritative run state.
- OpenBot-owned authenticated thread/history APIs are authoritative; do not expose unscoped CopilotKit local-thread endpoints or accept client-selected Mastra thread/resource identifiers.
- Mastra Intelligence provides durable threads/messages, memory, and background memory/skill analysis only; it does not own product Agent execution, tool orchestration, approval, pause, or resume.
- OpenBot Conversation and ACL remain the directory and authorization source; thread/resource/storage mappings are generated from trusted scope.
- Mastra is the sole writable source for messages after per-conversation cutover; OpenBot event intents are a retry/replay projection, not a competing history store.
- Reads of required history/memory fail closed before execution; message writes retry durably and idempotently by stable message ID.
- Skill candidates require evaluation and explicit authorized approval before immutable publication; each Run pins a published skill version.
- Each foreground Run and each background learning job has a separate explicit ceiling and usage record; every model call supplies an explicit output cap.
- Deletion/revocation blocks recall immediately and reports completion only after message, derived memory, index, and projection cleanup is verified.
- Do not require Intelligence or Mastra SaaS accounts. Do not run production migrations, touch real provider accounts, commit, stash, push, merge, or publish.
- Preserve all existing user-authored changes and HEAD. Validation/reviewers do not edit product source or tests.

## Review Focus

1. Tenant, principal, conversation, and channel scopes cannot cross through forged thread/resource IDs or concurrent authorization changes (Tasks 2, 4, 8).
2. Agent success followed by storage failure cannot lose messages, duplicate them on retry, or trigger learning from unsynced data (Tasks 3, 6, 8).
3. Existing execution paths preserve Agent selection/behavior, approval, cancellation, pause/resume and unknown-side-effect reconciliation while Intelligence Runtime transport, runner, locks, and local-thread endpoints are replaced by SSE plus OpenBot Runner/API (Tasks 1, 2, 6, 7).
4. Revoked/deleted sources cannot reappear through semantic/observational memory or an already queued learning job (Tasks 4, 5).
5. Import/cutover cannot run with active work, incomplete attachments/tool results, concurrent writes, or a stale source digest (Task 8).

---

## Workspace and recovery record

**Worktree:** `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot` (already verified linked worktree). **Starting HEAD:** `8d6b9bd71a810556ab46b5dffa9f72f0427f5289`. Preserve this user-authored HEAD and all existing modifications. Plan review occurs before any implementation dispatch. The plan-specific SDD ledger is `.superpowers/sdd/2026-10-11-mastra-intelligence-only-dag/progress.md`; each task receives a before/after manifest, scoped patch including untracked files, implementation report, independent validator report, reviewer report, and checkpoint ID. No empty `BASE..HEAD` review package may stand in for uncommitted changes.

Verified prior work is recorded in `.superpowers/sdd/2026-10-11-mastra-ocr-r3-governance/progress.md`; gateway Task 3 Fix1c has passed its validator and reviewer gates. The R3 committed-range OCR found three medium items; Fix2 is resolving them and the final workspace OCR remains pending. Do not mark R3 complete or run the migration final OCR until Fix2 is verified and full-scope OCR passes. Existing Mastra conversation/storage work is present in source and has prior reviews in the old migration ledger; revalidate against this spec and reuse only after exact hashes and behavior are checked. The R3 gateway remains a compatibility model route; it does not mean every Mastra background capability must call the gateway.

## DAG and acceptance mapping

| ID | Source | Acceptance | Depends on | Owner / validator | Owned files (initial boundary; inspect before dispatch) | Interface produced | Verification | Status |
|---|---|---|---|---|---|---|---|---|
| T1 | Spec §§2–3, 7 | Inventory exact existing execution and Intelligence seams; prove pinned CopilotKit SSE custom-AgentRunner and Mastra memory APIs; freeze interfaces and unsupported capabilities | — | backend_implementer / backend_validator | `server/src/mastra/compatibility.ts`, `server/tests/enterprise/mastra-compatibility.test.ts`, `server/tests/learning-mastra.test.ts`, compatibility report | `IntelligenceService` contract in `server/src/mastra/intelligence-contracts.ts`; exact SSE runtime constructor/AgentRunner evidence plus Mastra API evidence | Synthetic contract, signed binding authority, locked-package API probe; existing roster/learning tests | verified after R4-1 + R4-2-F1; final workspace OCR pending |
| T2 | §§3–5 | Replace Intelligence Runtime with CopilotKit SSE and inject OpenBot durable AgentRunner; implement its persistence, request lease, trusted production scope, server-owned conversation creation, Mastra storage composition and intent Run admission | T1 | backend_implementer / backend_validator | `server/src/copilot.ts`, `server/src/intelligence-client.ts`, `server/src/index.ts`, `server/src/app.ts`, `server/src/config.ts`, `server/src/mastra` runtime storage composition, `server/src/enterprise/contracts.ts`, tenancy connections/store, run service/store, `server/src/db/schema/enterprise-runs.ts`, conversation routes/bootstrap, new durable event module, additive migration and focused tests | Public AgentRunner run/connect/stop/isRunning backed by fenced Run attempts and ordered durable AG-UI events; authenticated actor + exact OpenBot thread resolves exactly one active membership/conversation under verified directory/data connections; server creates bound thread backed by configured TenantMastraStorage; Run admission accepts only a finalized, matching Mastra message intent; zero/ambiguous matches fail closed | contract/runner tests, authenticated thread-to-scope resolution and ambiguity tests, finalized-intent admission tests, owner contention/revocation/replay tests, mounted GET/POST with SPA fallback, Mastra storage fail-closed and successful controlled composition, migration/RLS and two-instance isolated PostgreSQL tests | running; R5 closes create-input and admission mismatch review items; GET routing and production MastraStorage composition remain open; full T2 pending |
| T3 | §§3–5 | Implement Mastra message repository and durable idempotent event-intent reconciliation; no dual writable history | T1,T2-SSE,T2-GOV (code checkpoints; DB acceptance separate) | backend_implementer / backend_validator | `server/src/mastra/contracts.ts`, `server/src/mastra/conversations.ts`, `server/src/mastra/tenant-storage.ts`, `server/src/enterprise/conversations/mastra-intent-reconciler.ts`, related schema/migration files, focused conversation tests | `IntelligenceService.history/append/flushPending` with stable message IDs and receipts | restart, duplicate retry, body conflict, delayed store, full parts/tool/attachment cases | pending |
| T4 | §§4,6 | Govern memory extraction/recall, source revocation, deletion and tenant isolation | T1,T3 | backend_implementer / backend_validator | `server/src/memory/store.ts`, `server/src/memory/routes.ts`, `server/src/memory/ingestion.ts`, new `server/src/mastra/memory.ts`, deletion tests and only required schema files | `MemoryService.context/submitSource/deleteSource/deleteConversation` | tenant/channel negative tests; deletion retry; denied source never recalled | pending |
| T5 | §§3,6 | Preserve skill learning through background Mastra analysis/evaluation and OpenBot candidate/review/publish lifecycle | T1,T3,T4 | backend_implementer / backend_validator | `server/src/learning/runtime.ts`, `server/src/learning/remote.ts`, `server/src/learning/routes.ts`, `server/src/learning/settings.ts`, new `server/src/mastra/learning.ts`, enterprise learning schema/routes/tests | `LearningService.enqueue/inspect/review/publish`; each job has stable ID, source digest, independent ceiling | learning disabled, duplicate retry, permission revoke, evaluation failure, approval required, immutable publish and Run version pin | pending |
| T6 | §§3,5,8 | Route existing execution implementations through OpenBot Intelligence APIs and SSE AgentRunner without changing Agent behavior or Run governance | T2,T3,T5 | backend_implementer / backend_validator | `server/src/copilot.ts`, `server/src/agents/plan-model.ts`, `server/src/agents/runtime-agents.ts`, existing enterprise runtime routes/callbacks and their focused tests | execution adapter consumes `IntelligenceService`; durable Runner reconnect resumes authorized events; tools and pause/resume remain existing service contracts | three execution-source contract suites; approval/pause/resume/cancel/reconciliation, event replay and message ordering | pending |
| T7 | §§4,8 | Replace frontend Intelligence thread/history reads with authenticated OpenBot thread/history/replay APIs | T3,T6 | frontend_implementer / frontend_validator | `app/src/lib/copilot/thread-messages.ts`, `app/src/lib/copilot/join-thread.ts`, `app/src/lib/copilot/bot-thread.ts`, channel components and owned tests; new platform thread client | `list/history/join(lastSeq)` client based on authenticated server DTO only; CopilotKit local-thread endpoints are not used | hydration, pagination, reconnect gap/dedupe, tool/activity/attachment display, account switch cache clearing | pending |
| T8 | §§4,7,8 | Import and per-conversation atomic cutover from Intelligence/legacy history to Mastra single-writer storage | T3,T4,T5 | backend_implementer / backend_validator | `server/src/enterprise/conversations/service.ts`, `store.ts`, import routes/schema, new import service and integration tests | preview/commit/cutover receipts freezing source digest, counts and CAS backend version | complete message/part/attachment/tool/skill references; active Run rejection; concurrency/failure preserves legacy source | pending |
| T9 | §§7–8 | Remove Intelligence SDK/account/license/service wiring and update setup/deployment/admin surfaces | T2,T6,T7,T8 | backend_implementer + frontend_implementer by disjoint subtask / role-specific validators | `server/package.json`, config/bootstrap/intelligence references, `app` learning/admin routes, desktop setup code as inventory confirms | self-hosted readiness/status and migrated settings | dependency scan, clean install without Intelligence secrets, web/desktop setup, all affected types/tests | pending |
| T10 | §§8–9 | End-to-end acceptance, independent full review, OCR and recovery record | T1–T9 | reviewer / role-specific validators | integration/E2E test paths only, deployment docs, plan ledger and review reports | verified cutover/readiness evidence | full required tests, typecheck/lint/build, Spec+quality review, complete workspace and committed-range OCR | pending |

### DAG validation

Explicit dependencies are none because no Issue dependency list was supplied. Inferred edges follow interface/data prerequisites: T1 freezes API facts; T2 removes old coordination only after the contract; T3 needs authorized bindings and a writer path; T4 needs persisted sources; T5 consumes governed history and memory; T6 wires existing execution only after stable adapters; T7 and T8 consume the history/event contracts; T9 removes legacy wiring only after all replacements; T10 covers the full delivery. Topological order: T1 → T2 → T3 → T4 → T5 → T6 → T7/T8 → T9 → T10, with T7 and T8 independent after their prerequisites when file ownership remains disjoint. No cycle or isolated acceptance is present. Each spec acceptance is mapped in the table; compatibility claims remain T1 evidence, not implied implementation.

## Shared interface and ownership preflight

| Tasks | Shared path/interface | Preflight result and ruling |
|---|---|---|
| T1 ↔ T3/T4/T5 | pinned Mastra APIs and IntelligenceService | T1 owns only contract/probe; downstream consumes frozen exports. Any unsupported API is recorded before dispatching T3–T5. |
| T2 ↔ T6 | copilot.ts and runtime coordination contract | Strict dependency: T2 changes ownership of lock/runner seams; T6 integrates execution sources later. Serial, no concurrent edits. |
| T3 ↔ T4/T5/T6/T7/T8 | history DTO, stable message ID, event intent | T3 freezes DTO/schema; all consumers use it. Sequential checkpoints avoid interface drift. |
| T5 ↔ T6/T8 | published skill version/source authorization | T5 exposes candidate/review/publish contract; T6 pins versions and T8 imports references only after verification. |
| T7 ↔ T9 | learning admin and conversation UI | T7 owns chat/history client; T9 owns admin/setup only. Disjoint files; if inventory reveals overlap, execute serially. |
| T8 ↔ T9/T10 | cutover state and compatibility mode | T8 produces migration state; T9 removes legacy wiring only after all cutovers validated; T10 reads receipts and never mutates production data. |
| T1 internal | compatibility probe and lockfile declarations | The probe must use installed lockfile APIs and synthetic storage/provider. It cannot wire Mastra Agent execution into product assembly. |
| T2 internal | auth, verified database capabilities, lease, event replay, bootstrap | Authenticate server identity first. Resolve the supplied OpenBot thread ID without client tenant/workspace authority: list the actor's active memberships through verified DirectoryDatabase; under verified DataDatabase RLS, look up that exact thread within each candidate tenant and require exactly one conversation owned by the matching principal. Zero or multiple matches fail closed. Only then issue branded PlatformScope and recheck membership/conversation/resource access in every operation. Never derive scope from `identifyActor`, deployment ID, caller-supplied Mastra IDs, or ordinary DATABASE_URL. Missing/mismatched DB capability fails closed. Disconnect cleanup is bounded and ownership-checked. |
| T2 request and admission | AgentRunner request, OpenBot conversation and Mastra message intent | The pinned runner request has no raw `Request`; capture request identity in a request-scoped Runner/runtime wrapper at the Hono boundary, and prove concurrent run/connect/stop requests cannot cross-contaminate identity. A client-provided AG-UI `runId` is never authority. Create conversations through a server-owned authenticated API and generate thread IDs on the server. Before Run admission, append the user message through `ConversationService.append`; accept only its finalized `mastra_message_intents` row matching tenant/thread, actor/principal, client key, digest, attachments and current backend version. Keep existing platform-history admission behavior for legacy conversations. Stop requires exact resolved scope and captured run/attempt; disconnect only releases its own transport/request claim and never cancels product Run. |
| T2 event ownership | durable AG-UI event identity and replay | Every event must be bound in the database to both its conversation (tenant and thread) and its exact Run ownership (tenant, run, workspace, principal, thread); create supporting unique keys before their composite FKs. Event append locks Run then attempt, revalidates owner token/status/generation/expiry in the same transaction, and holds locks through insert/commit so cancellation/takeover serializes with append. Tenant-only RLS is insufficient to prevent cross-conversation projection within one tenant. |
| T3 internal | intent transaction, Mastra append and receipt | Persist intent before delivery; stable identity and payload digest determine idempotence; body mismatch enters explicit conflict state. |
| T4 internal | memory source authorization and deletion | Revocation is checked on retrieval immediately; deletion is a resumable receipt and cannot claim success on partial cleanup. |
| T5 internal | job, budget, candidate, evaluation and publication | Source digest and job ID dedupe; model usage settles per job; publication rechecks ACL and learning setting. |
| T6 internal | all three existing execution sources | Shared request/event DTO remains owned by existing contract; no source may bypass Run/Tool/approval services. |
| T7 internal | cursor, hydration and live event order | Server DTO is sole contract; dedupe by event/message identity and clear tenant-bound caches on identity switch. |
| T8 internal | preview/import/staging/CAS | All counts and digests freeze in receipt; cutover requires no active Run and no active writes; failed CAS leaves source mode unchanged. |
| T9 internal | config removal and setup | Remove only references proven replaced; preserve provider model credentials and remote-Mastra-as-execution configuration. |
| T10 internal | evidence scope | OCR covers user-authored committed base through final HEAD and all uncommitted delivery files separately; known unrelated typecheck issue is reported until assigned/fixed. |

## Task details

### Task 1: Freeze current execution boundary and Mastra Intelligence contract

**Files:** Create `server/src/mastra/intelligence-contracts.ts`, `server/tests/enterprise/intelligence-contracts.test.ts`; modify only compatibility probe/tests as evidence requires.

**Interfaces:** Consumes existing PlatformScope, conversation authorization and locked Mastra packages. Produces `IntelligenceService.resolve(scope, conversationId)`, `history(scope, conversationId, cursor, limit)`, `append(scope, conversationId, messages)`, `context(scope, conversationId, query)`, `enqueueLearning(scope, conversationId, sourceReceipt)`; exact DTOs include signed binding, stable IDs, full message parts, source digest, cursor, and explicit result/error unions. No Agent execute/run/tool methods are part of this interface.

- [x] RED: `mastra_memory_api_works_without_agent_run`; `client_cannot_choose_binding`; `append_requires_stable_message_identity`; assert real locked exports or report unsupported API.
- [x] Confirm RED against current implementation with synthetic storage; retain exact assertion failure and package versions.
- [x] Implement contract and smallest real API compatibility probe. If Mastra Memory cannot be used independently of Agent execution in the pinned version, report the exact blocker/API and provide a governed background adapter seam; do not switch product execution to Mastra.
- [x] GREEN: `bun test server/tests/enterprise/intelligence-contracts.test.ts server/tests/enterprise/mastra-compatibility.test.ts server/tests/mastra-roster.test.ts server/tests/learning-mastra.test.ts`; Biome, scoped diff and affected typecheck. Expected all named assertions pass without real credentials/provider.
- [x] Freeze checkpoint artifacts and pass independent backend validation plus Spec/quality review before T2.

**Acceptance:** spec §§2–3; compatibility evidence is explicit and no product Agent loop is introduced.

### Task 2: Replace Intelligence Runtime with SSE and OpenBot AgentRunner

**Files:** Modify `server/src/copilot.ts`, `server/src/intelligence-client.ts`, `server/src/index.ts`, `server/src/config.ts`, `server/src/agents/agent-resolver.ts`, the existing built-in model adapter used by `BuiltInAgent` (select the narrowest existing adapter after inspecting its actual call graph), `server/src/enterprise/contracts.ts`, `server/src/enterprise/runs/service.ts`, `server/src/enterprise/runs/store.ts`, `server/src/enterprise/tenancy/connections.ts`, `server/src/enterprise/tenancy/store.ts`, `server/src/db/schema/enterprise-runs.ts`, `server/drizzle/meta/_journal.json`, and the migration snapshot corresponding to the next unused index; create a production Runner composition module only if it owns verified DB capabilities and safely composes Conversation/Run/Event services. Create `server/src/enterprise/runs/events.ts`, `server/tests/enterprise/runner-events.test.ts`, `server/tests/enterprise/runner-scope.test.ts`, `server/tests/enterprise/runner-events.integration.test.ts`, focused tests for authorized agent/model capability propagation and mounted runtime lifecycle, and the additive migration at the next unused index. Preserve existing user edits to 0065/0066 and their tests/runner; never overwrite user-authored files.

**Interfaces:** Consumes Task 1 binding authority and locked CopilotKit SSE `AgentRunner` interface. Produces `ScopeResolver.resolveForThread(request, threadId)` (or equivalent strongly typed method): authenticate server identity; enumerate active candidate memberships via verified DirectoryDatabase; look up the exact OpenBot thread under each candidate tenant's verified DataDatabase RLS context; require exactly one conversation with the matching principal; issue a branded PlatformScope only after this check; reject zero/ambiguous matches. Recheck membership/conversation/resource access for each operation. Also produces server-generated conversation creation through the authenticated Conversation API; a request-scoped Runner context that captures the Hono Request for run/connect/stop/isRunning without cross-request AsyncLocalStorage leakage; and Mastra-backed Run admission that accepts only an already-finalized `mastra_message_intents` row matching tenant/thread, actor/principal, client key, digest, attachments and backend version. The client AG-UI `runId` is never authoritative; server Run ID and attempt identity replace it. Also produces Run-service atomic request ownership `{runId, attemptId, generation, ownerToken, expiresAt}` with owner-checked renew/release; `EventService.append/replay/subscribe` over stable event IDs, per-thread cursors, attempt fencing and persist-before-publish; and a durable OpenBot `AgentRunner` implementing `run`, `connect`, `isRunning`, and `stop`. Configure directory/data database URLs separately from general DATABASE_URL, verify both capability roles before enterprise Runner becomes available, and fail Runner requests closed on missing/mismatched capability. Do not accept tenant/workspace selectors or client-supplied Mastra IDs as authority. Preserve the lifecycle outbox for lifecycle notifications; do not repurpose it as the replay log. Transport disconnect releases only its own request claim and does not cancel product Run; explicit stop targets the captured run/attempt under the resolved scope.

**Confirmed Run-budget source (user ruling, 2026-10-12):** Resolve the model route from the already-authorized Bot's existing effective model configuration (`tenantPackage.model` plus the current deployment model override behavior); do not introduce a second route config. Require the caller to explicitly provide `forwardedProps.maxOutputTokens` on each run as a positive integer within the existing persisted budget range `1..2_147_483_647`. Validate it before creating the Run; set that Run's aggregate token ceiling to exactly this value and persist it with the existing Run/capability records. Each model invocation must still carry an explicit per-call `maxOutputTokens` no greater than the remaining persisted Run ceiling. Never default, round, or accept an absent/invalid cap; no client model/provider/route override is authoritative. Remote AG-UI/Mastra execution remains fail-closed until its provider side can enforce this ceiling and return verifiable usage. No schema widening is needed or authorized for this contract.

- [ ] **Step 1: Write failing tests** for Run request-lease contention and owner-only renew/release, stale attempt fencing, exact-run stop race, event idempotence/body conflict and persist-before-publish, restart replay and replay/live cursor handoff, revocation before renew/delivery, authenticated bootstrap deriving scope only after membership, rejected cross-tenant selector, and missing/wrong DB capability fail-closed. Add the SSE/custom-runner and unchanged execution-source tests. Add explicit Run-budget tests: missing, non-integer, non-positive, over-32-bit and malformed forwarded caps reject before Run persistence; a valid cap is persisted as the aggregate Run ceiling and each invocation is bounded by remaining budget.
- [ ] **Step 2: Run focused RED tests** against existing service and synthetic adapters; assert each new contract fails for the missing operation (no DB service startup). For database/RLS behaviors, write tests against the explicitly configured disposable enterprise fixture and defer their execution if it is not available.
- [ ] **Step 3: Implement atomic Runner request ownership** in existing Run service/store using attempt generation fencing; disconnect releases only its request claim and does not cancel the product Run. Implement the new tenant-scoped event table/service with stable source event identity, ordered cursor, attempt/generation, schema version and full BaseEvent payload; persist before publish, reject changed-body retries, and close replay/live handoff via durable cursor polling.
- [ ] **Step 4: Implement production capability and thread-scope composition** using separately configured directory/data database connections verified by `verifyDirectoryDatabase`/`verifyDataDatabase`; authenticate from the established session, enumerate that actor's active memberships through the directory, search the exact OpenBot thread under each tenant's data-RLS context, require one matching conversation/principal, then issue PlatformScope. Zero or ambiguous matches fail closed. `identifyActor` anonymous fallback and deployment identity must not mint scope.
- [ ] **Step 5: Inject the durable Runner into CopilotKit SSE** and remove only Intelligence Runtime/socket/lock calls and local-thread routes. Preserve Agent selection/execution, existing Run budgets, tools, approvals, pause/resume and reconciliation.
- [ ] **Step 5a: Close R9-F1 lease-time fencing** by evaluating all lease expirations using wall-clock time sampled after Run and attempt row locks (not transaction-start `now()`); add a database-independent regression for query semantics and a disposable PostgreSQL lock-wait test that proves an append rejects after expiry without inserting.
- [ ] **Step 5b: Complete governed production execution composition**. Reuse per-actor authorized agent resolution and the existing three execution sources; resolve the built-in route from the authorized Bot's existing effective model configuration. Require explicit `forwardedProps.maxOutputTokens` per Run as a positive integer within `1..2_147_483_647`, validate it before persistence, and use that exact value as the Run aggregate token ceiling; no default or browser-selected route/model is permitted. Every built-in AI SDK v3 model call also carries an explicit cap no greater than remaining Run budget. Use the existing AI SDK v3 `LanguageModel` boundary with a dedicated, tested adapter to the strict OpenBot ModelGateway; raw OpenAI SDK fetch customization is incompatible with its canonical request/stream contract. Mint and consume a separate persisted invocation capability for each model step, preserve cancellation, and settle authoritative gateway usage or fail closed on unknown usage. Start/reserve the Run before execution, settle or fence the exact attempt on error/cancel/stop, and fail closed for remote sources unless their upstream model calls enforce the Run ceiling and provide verifiable usage; callback signatures and AG-UI terminal events alone are not sufficient. Replace browser SSE and headless `agentFor`/history/thread-lock/handoff consumers as one production cutover; no Intelligence runner/socket/lock consumer may remain active.
- [ ] **Step 6: Run GREEN** focused runner/event/scope tests, copilot tests, runtime callback and execution compatibility tests, plus Biome, scoped diff and targeted typecheck. Run migration/RLS and two-instance integration tests only against explicitly configured disposable loopback enterprise test databases; if unavailable, report those acceptance checks unverified and do not mark T2 verified.
- [ ] **Step 7: Freeze exact checkpoint** with before/after SHA manifests, increment package, command outputs and report; require independent backend validation and Spec/quality review against the same hashes.

**Acceptance:** spec §§2–5; SSE adapts transport; OpenBot owns durable Run request leases and replayable events; authenticated identity plus an unambiguous, server-side membership/conversation lookup is the only path to PlatformScope; production Runner uses separately verified least-privilege directory/data connections; current per-actor agent selection and built-in, remote AG-UI, and remote Mastra execution remain active under per-Run budget and explicit output-ceiling governance. The per-Run aggregate budget equals the validated caller-supplied `forwardedProps.maxOutputTokens`; every model step is independently capped within the remaining aggregate; unsupported/unknown remote enforcement refuses execution. Browser and headless paths no longer depend on Intelligence. T2 cannot be marked verified without isolated migration/RLS/two-instance DB acceptance.

### Task 3: Make Mastra the single writable message-history store

**Files:** Modify `server/src/mastra/contracts.ts`, `server/src/mastra/conversations.ts`, `server/src/mastra/tenant-storage.ts`, `server/src/enterprise/conversations/mastra-intent-reconciler.ts`, required intent schema/migration, and corresponding integration tests only as evidence justifies.

**Interfaces:** Implements Task 1 `history/append/flushPending` using Task 2 trusted binding. `append` takes stable message identity, full message/parts/tool/activity/attachment metadata and payload digest; returns persisted receipt or conflict. Reconciler claims and retries durable OpenBot intents and marks them complete only after Mastra confirms the same payload digest.

- [ ] RED: `append_pending_before_external_store_write`; `retry_after_restart_does_not_duplicate`; `same_id_different_payload_conflicts`; `attachment_and_tool_result_round_trip`; `store_unavailable_does_not_mark_synced_or_learning_eligible`.
- [ ] Implement intent receipt/outbox and Mastra repository. Keep OpenBot events as replay projection only. Store credentials/tenant selection stay server-side and schema constrained.
- [ ] GREEN: `bun test server/tests/enterprise/mastra-storage.integration.test.ts server/tests/enterprise/conversations.integration.test.ts server/tests/enterprise/mastra-intent-reconciler.test.ts`; use only disposable synthetic PostgreSQL configured explicitly; Biome/diff/typecheck.
- [ ] Freeze checkpoint and require independent backend validation/review.

**Acceptance:** spec §§4–5; exactly one writable message history after cutover and retry-safe persistence.

### Task 4: Govern memory recall, learning sources and deletion

**Files:** Modify `server/src/memory/store.ts`, `server/src/memory/routes.ts`, `server/src/memory/ingestion.ts`; create `server/src/mastra/memory.ts`, `server/src/mastra/deletion.ts`, and focused integration tests; own only necessary memory schema changes.

**Interfaces:** `MemoryService.context(scope, conversationId, query)`, `submitSource(scope, conversationId, persistedReceipt)`, `deleteSource(scope, sourceId)`, `deleteConversation(scope, conversationId)`. Context returns only authorized thread/resource memories plus source IDs and version. Deletion returns durable per-layer receipt/status.

- [ ] RED: `forged_resource_denied`; `revoked_source_not_recalled_before_cleanup`; `delete_retry_covers_messages_derived_memory_index_and_projection`; `partial_delete_not_reported_complete`; `context_read_failure_is_retryable_and_fails_closed`.
- [ ] Implement thread-default recall, explicitly authorized cross-thread resource scope, and deletion worker with per-layer status. Invalidate access before asynchronous cleanup begins.
- [ ] GREEN: `bun test server/tests/enterprise/mastra-memory.integration.test.ts server/tests/memory-runtime.test.ts server/tests/memory-store.integration.test.ts`; disposable DB only; Biome/diff/typecheck.
- [ ] Freeze checkpoint and require independent backend validation/review.

**Acceptance:** spec §§4,6; revocation immediately prevents recall and cleanup is verifiable.

### Task 5: Preserve skill learning with Mastra background analysis

**Files:** Modify `server/src/learning/runtime.ts`, `server/src/learning/remote.ts`, `server/src/learning/routes.ts`, `server/src/learning/settings.ts`; create `server/src/mastra/learning.ts`, `server/src/enterprise/learning/service.ts`, required enterprise learning schema and integration tests.

**Interfaces:** `LearningService.enqueue(scope, conversationId, sourceReceipt)`, `inspect(scope, jobId)`, `review(scope, candidateId, decision)`, `publish(scope, candidateId, expectedDigest)`. Job identity is stable per source digest and has an explicit output cap and separate budget. Published SkillSnapshot is immutable and resolvable by pinned version.

- [ ] RED: `disabled_learning_creates_no_job`; `same_source_retry_deduplicates`; `revoked_source_job_cannot_publish`; `eval_failure_preserves_candidate_state`; `publish_requires_authorized_review`; `run_keeps_start_version_after_new_publish`; `usage_settles_or_becomes_unknown_once`.
- [ ] Use Mastra for governed background memory/skill analysis and Evals only where locked APIs were proven in T1. OpenBot keeps candidate, approval, audit and immutable publication. Remove SkillRegistry/Intelligence inspector dependencies without changing skill read-tool names/semantics.
- [ ] GREEN: `bun test server/tests/enterprise/mastra-learning.integration.test.ts server/tests/learning-runtime.test.ts server/tests/learning-routes.test.ts server/tests/learning-mastra.test.ts`; Biome/diff/typecheck.
- [ ] Freeze checkpoint and require independent backend validation/review.

**Acceptance:** spec §§3,6; no automatic publication and disabled settings are preserved.

### Task 6: Integrate existing execution sources with OpenBot APIs and SSE AgentRunner

**Files:** Modify `server/src/copilot.ts`, `server/src/agents/plan-model.ts`, `server/src/agents/runtime-agents.ts`, and exact runtime callback/route files found by T1/T2; focused contract and integration tests.

**Interfaces:** Existing execution sources consume Task 1 `IntelligenceService`, Task 2 durable AgentRunner/coordinator and Task 3 persisted receipts. Existing ToolService, RunService, approval and recovery interfaces remain the only path for product tools and run states.

- [ ] RED: each execution source reads authorized history; SSE connect replays durable authorized events; messages persist before replay publication; approval pause/resume/cancel behavior unchanged; unknown side effects reconcile before retry; per-Run explicit output ceiling unchanged; no Intelligence network/auth calls.
- [ ] Implement adapter wiring and event-to-message identity projection only. Never construct a product Mastra Agent or delegate tool/HITL/recovery ownership.
- [ ] GREEN: `bun test server/tests/copilot.test.ts server/tests/enterprise/runtime-callback.test.ts server/tests/enterprise/mastra-execution-compatibility.test.ts server/tests/enterprise/runs.integration.test.ts`; Biome/diff/typecheck.
- [ ] Freeze and require backend validator plus reviewer.

**Acceptance:** spec §§3,5,8; all three source types retain their current runtime contracts.

### Task 7: Move chat history UI to OpenBot thread APIs and remove local-thread coupling

**Files:** Modify `app/src/lib/copilot/thread-messages.ts`, `join-thread.ts`, `bot-thread.ts` and channel components that currently call Intelligence; create `app/src/lib/copilot/platform-threads.ts` and `app/tests/mastra-chat-history.test.tsx`.

**Interfaces:** Client consumes only authenticated server DTOs from Tasks 1,3,6: `list(cursor)`, `history(threadId,before)`, `join(threadId,lastSeq)`. The client may display opaque conversation/thread references but cannot select resource scope. It does not call CopilotKit Intelligence or local-thread endpoints. It does not call CopilotKit Intelligence or local-thread endpoints.

- [ ] RED: `history_hydrates_text_tools_activity_attachments`; `pagination_preserves_order`; `replay_then_live_has_no_gap_or_duplicate`; `identity_switch_clears_cache_and_subscription`; `storage_sync_pending_is_visible`.
- [ ] Replace Intelligence-backed thread/history fetch while preserving existing React components and keyboard/accessibility behavior. Tear down SSE stream and thread cache on tenant/account change.
- [ ] GREEN: `bun test app/tests/mastra-chat-history.test.tsx app/tests/copilot-thread.test.tsx`; `bun run --filter app typecheck`; owned Biome/diff.
- [ ] Freeze and require frontend validator plus reviewer.

**Acceptance:** spec §§4,8; historical and live messages render without loss or duplication.

### Task 8: Import history and atomically cut over per conversation

**Files:** Modify `server/src/enterprise/conversations/service.ts`, `store.ts`, relevant route/schema files; create `server/src/enterprise/conversations/import.ts` and `server/tests/enterprise/mastra-import.integration.test.ts`.

**Interfaces:** `preview(scope, conversationId, source): ImportReceipt` freezes source digest and counts; `commit(scope, receiptId)` imports into isolated staging; `cutover(scope, receiptId, expectedBackendVersion)` performs CAS. Cutover rejects active Run, changed ACL/source digest, incomplete references, active Mastra writes and already changed backend version.

- [ ] RED: `preview_detects_all_parts_and_references`; `active_run_rejects_cutover`; `concurrent_cutovers_only_one_wins`; `source_change_after_preview_rejected`; `commit_failure_keeps_legacy_active`; `successful_cutover_forbids_legacy_append`.
- [ ] Implement stage→verify→CAS. Do not export real user data. On any mismatch preserve old read mode and expose retryable state.
- [ ] GREEN: `bun test server/tests/enterprise/mastra-import.integration.test.ts server/tests/enterprise/conversations.integration.test.ts`; disposable DB only; Biome/diff/typecheck.
- [ ] Freeze and require independent backend validation/review.

**Acceptance:** spec §§4,7,8; no active conversation has two writable message backends.

### Task 9: Remove Intelligence dependency and update setup surfaces

**Files:** After T8 inventory, modify only remaining `server/package.json`, lockfile, config/bootstrap, learning admin and desktop setup references to Intelligence; preserve remote-Mastra execution configuration and model provider keys. Split server and frontend owned files into separate serial briefs and use backend/frontend role pairings.

**Interfaces:** Server readiness reports Mastra store and background learning dependencies without exposing tenant DSNs. Admin UI consumes OpenBot learning job/candidate APIs. Desktop setup no longer requests Intelligence credentials.

- [ ] RED: `startup_without_intelligence_secrets`; config_schema_rejects_legacy_credential_dependency; admin settings/candidates use owned APIs; desktop onboarding no Intelligence fields; remote Mastra Bot remains selectable as execution source.
- [ ] Remove SDK/account/license/runtime network dependencies only after all call sites have migrated. Preserve learning enabled/disabled and provider credential settings.
- [ ] GREEN: run all affected server/app tests, install/lockfile check, both typechecks, lints/builds and `rg` dependency scan; each command recorded independently.
- [ ] Freeze server and frontend checkpoints, each with role-appropriate validators and shared reviewer.

**Acceptance:** spec §§1,7–8; clean setup requires no Intelligence configuration.

### Task 10: Complete end-to-end acceptance and outer review

**Files:** integration coverage and plan-specific evidence only; no broad refactor.

- [ ] Exercise fresh conversation, all three execution sources, messages/tools/attachments, restart/reconnect, memory recall, learning job, candidate evaluation/review/publication, source revoke/delete and per-conversation import/cutover using synthetic tenants.
- [ ] Run all relevant tests, `bun run --filter server typecheck`, `bun run --filter app typecheck`, lint and production builds; identify and fix only owned-scope regressions. Report known unrelated diagnostics with file and evidence.
- [ ] Independent reviewer returns separate Spec compliance and code quality conclusions on exact final checkpoint.
- [ ] Run required OCR against the actual original committed base→final HEAD and full uncommitted workspace. Save reports, exit statuses, coverage warnings, hashes, findings and rulings. For any critical/high/medium finding, create a scoped SDD repair plan, validate and re-review, then rerun full OCR.
- [ ] Record final evidence in this plan ledger; use finishing-a-development-branch instructions only after every required gate passes.

**Acceptance:** all spec §8 criteria are evidenced; no effective critical/high/medium finding remains; final diff contains only authorized migration work.

## Execution notes

Task-level dependencies are strictly serial through T6 because `copilot.ts`, run/event interfaces and conversation DTOs cross these tasks. T7 and T8 can run as separate branches only if their file ownership and API contract are frozen and separate worktrees are used; default execution remains serial. T9 backend and frontend edits are separate ownership tasks and must not be dispatched as one generic cross-role task. Task 10 cannot begin final OCR until all prior checkpoints have independent validator and reviewer PASS and the pending R3 Fix2 work plus required outer OCR has been completed and recorded.

## Execution DAG refinement — T2/T3 packaging cycle (2026-10-13)

The original aggregate order is superseded for the history/headless seam by source-backed ruling at `.superpowers/sdd/2026-10-12-mastra-t2-production-cutover/reports/headless-history-dependency-ruling-evidence.md` (SHA256 `044ecb1eac2308321a8d955cb48ff161311702cb918337609f711eb1a5337312`). Explicit cycle: `T2 aggregate requires headless cutover → headless requires full-parts T3 history → original T3 requires T2 aggregate`. Current text-only MessageDTO and user-only Mastra writer do not satisfy headless tool/activity fidelity.

Refined execution dependencies: `T1 → T2-SSE → T2-GOV → T3-CORE → T2-HEADLESS`; T2-HEADLESS also directly consumes T2-GOV. T3-CORE consumes the reviewed binding, scope, intent and durable event interfaces, not the headless consumer. T2 aggregate contains SSE/GOV/HEADLESS acceptance and remains unverified until all components and isolated PostgreSQL gates pass. T3 aggregate contains full-parts history/intents and its database gates. T4–T10 retain their original interface dependencies and acceptance mapping; T6 retains all three execution-source contract suites. Every original requirement remains mapped; headless consumer preservation cannot be discharged by temporary fail-closed refusal.

Task identities for the continuation Ledger: T2-SSE (existing Runner/SSE slice), T2-GOV (gateway adapter/Run outcome/model route rebind), T3-CORE (existing parent T3 full-parts implementation), T2-HEADLESS (existing parent T2 headless half). All are backend ownership with independent backend validation and Spec/quality review. Shared copilot/index/contracts edits are serial. Code checkpoints may be reviewed and consumed without DB only in this serial worktree; actual RLS/durability/migration/two-instance acceptance remains explicitly unverified. Topological order of these four code slices is acyclic and every referenced prerequisite exists.
