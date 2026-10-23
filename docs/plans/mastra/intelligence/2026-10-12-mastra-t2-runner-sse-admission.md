# T2 Runner/SSE Production Admission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this assigned Task. Steps use checkbox (`- [ ]`) syntax for tracking. Continue the approved parent Task 2; do not redesign or start Task 3.

**Goal:** Turn the already tested SSE/request-context and durable Run/Event helpers into one production-mounted, authenticated Runner admission path. This is a prerequisite vertical slice; it does not claim model execution or full T2 completion.

**Architecture:** Share the existing verified directory/data capabilities with Conversation, Run and Event services. Capture the Hono Request locally and inject an OpenBot durable AgentRunner into CopilotKit SSE. Server composition uses the same actor-authorized Bot for immutable Expert and agent-bound model-route issuance before Run admission; execution temporarily fails closed until the governed model slice.

**Tech Stack:** TypeScript, Bun, Hono, CopilotKit SSE, Drizzle/PostgreSQL, Mastra storage.

**Spec:** `docs/specs/superpowers/2026-10-11-mastra-intelligence-only-design.md`; parent DAG `docs/plans/mastra/intelligence/2026-10-11-mastra-intelligence-only-dag.md`.

**Source of truth:** Approved design `docs/specs/superpowers/2026-10-11-mastra-intelligence-only-design.md`; parent Task 2 plan/brief/Ledger; T2 production continuation plan and report; read-only architecture report `.superpowers/sdd/2026-10-12-mastra-t2-production-cutover/reports/next-slice-architecture.md`; current Fix4 remote fail-closed checkpoint.

**Confirmed policy:** Resolve scope only from authenticated actor, active membership and exact server-owned thread. Require finalized Mastra message intent bound to tenant/thread/actor/client key/digest/attachments/backend version. Server Run ID/attempt and explicit caller `forwardedProps.maxOutputTokens` are authoritative; no client runId/tenant/workspace selector. Run cap is integer `1..2_147_483_647`. Do not execute any model request from this slice unless the invocation goes through the approved Run capability/ModelGateway governance; this task may fail closed at the model boundary while that next slice is pending. Unsupported remote AG-UI/Mastra remain refused.

**Failure-settlement prerequisite:** Preflight found existing RunService cannot truthfully fail a just-admitted no-model attempt: stop/cancel records cancellation, and generic terminalization followed by request-lease release cannot clear the owner claim. Before Task 1 implementation resumes, complete reviewed prerequisite `docs/plans/mastra/intelligence/2026-10-13-mastra-run-request-failure.md`. Its contract is `RunService.fail(scope, { lease: RunnerRequestLease, errorCode: "MODEL_EXECUTION_UNAVAILABLE" }): Promise<boolean>`, atomically fencing/settling that attempt and clearing its request-owner claim. Do not substitute cancellation, generic terminalization, or a leaked active Run.

## Global Constraints

- Reuse existing `ScopeResolver`, conversation/run/event services, request-bound Runner helper, verified Directory/Data connection functions, and event migrations. Do not duplicate or replace these.
- Keep Hono Request capture request-local; do not use process-global mutable request identity or trust `RunAgentInput.runId`.
- Recheck authority for each operation. `connect/isRunning/stop` must use server Run/attempt identity. Transport disconnect releases only its own request claim; it does not cancel product Run.
- No schema or migration change unless source proof shows the existing accepted schema cannot support the required operation. Preserve user 0065/0066 and current T2 0067–0069.
- No DB startup/probe/access/migration, commit/staging/stash/reset/rebase, merge, release, or T3 dispatch. DB/RLS/row-lock/restart/two-instance acceptance remains unverified until the designated disposable DB is explicitly ready.

## Review Focus

- Production `mountCopilotRuntime`/Hono handler actually uses `CopilotSseRuntime` with the custom durable Runner; helper-only tests do not count.
- Production capability composition verifies DirectoryDatabase and DataDatabase before enabling enterprise Runner and safely fails unavailable if absent/wrong.
- The `run` operation admits only an exact finalized `mastra_message_intents` row; missing/pending/mismatched intent or cap creates no Run and invokes no agent/model.
- Run creation and request lease are bound to `ScopeResolver.resolveForThread` actor scope; client tenant/workspace/runId cannot choose them.
- `connect`, `isRunning`, and `stop` re-resolve scope and use persisted Run/attempt identity; no cross-request context leakage.
- Persisted event replay is authorized and durable; event write occurs before publish. Disconnect only releases its own owner token.
- No ungoverned model call is executed. The next task must complete the built-in ModelGateway path and then remove this temporary execution refusal.

## Task 1 — Compose and mount request-bound SSE Run admission

**Role:** backend_implementer. **Validator:** backend_validator. **Reviewer:** reviewer. **Dependencies:** Task 2 event, request lease, scope, intent validation, Run output ceiling, accepted ModelGateway adapter, and remote fail-closed fixes. No downstream task starts until this slice passes its independent code gates.

**Owned files:** new `server/src/enterprise/runs/runner.ts` (or a precise equivalent); focused new `server/tests/enterprise/runner-production.test.ts` and/or runtime test; narrow serial edits to `server/src/index.ts`, `server/src/copilot.ts`, and `server/src/app.ts` for wiring/mounting. Do not edit model adapter, Run/Event services, tenancy resolver, schema/migrations, `server/tests/copilot.test.ts`, or protected enterprise integration suites unless an evidence-backed interface defect requires a reviewed plan update.

**Consumes:** `createRequestBoundAgentRunner`, `createCopilotSseRuntime`; `ScopeResolver.resolveForThread`; `ConversationService.resolveBackend/resolveMastraBinding`; `RunService.start`, `RunService.fail` (after verified prerequisite), acquire/renew/release, stop/get; `EventService.append/replay/subscribe`; existing separate Directory/Data capability verifiers; Mastra intent persistence/finalization.

**Verified prerequisite amendment (2026-10-13):** request failure Fix3 and Expert bridge Task A/Fix1 and Task B passed independent DB-free validation and Spec/quality review. Consume `RunService.start(scope, admission: TrustedRunAdmission): Promise<RunDTO>`, where admission contains `{ input: StartRunInput, agentId, expertVersionRef, routeRef }`; public `StartRunInput` has no client authority refs. `RunServiceDependencies.expertVersions` consumes `ExpertVersionCatalog.resolveInTransaction`; `modelRouteFor(scope, threadId)` returns only `{ routeRef, maximumTokens }`. Preserve all Task B files as frozen prerequisites.

**Produces:** request-owned Runner factory implementing pinned `AgentRunner.run/connect/isRunning/stop`, injected into the actual browser SSE mount; production unavailable capability handler; same-Bot server admission producer. `run` selects the server-authorized Bot from the pinned runtime request's existing Agent selection field, calls `resolveBuiltInBotForActor` for that actor, persists its `ExpertDefinitionV1` through `ExpertVersionCatalog.putOrGet`, and independently issues the model route snapshot with that exact descriptor `agentId`. Bind the route-selection closure to that request's resolved scope/thread/Bot and reject mismatches; use no global mutable route/actor holder. Reuse existing effective tenant-package/deployment model selection. Never read Expert/route authority from forwardedProps.

**Message interface:** validate cap and authority before writes, map the current submitted user message to existing `AppendMessageInput`, call `ConversationService.append`, and use the shared `messageDigest` helper from `enterprise/conversations/store.ts` over the same normalized content and ordered attachment IDs. Supply the same stable clientMessageKey/digest/attachment refs to `TrustedRunAdmission.input`; the unchanged Run store checks the finalized intent atomically. Reject unsupported or ambiguous message shapes rather than lossy conversion. Do not add a second intent query outside Run admission.

- [ ] **Step 1 — RED / preflight:** Record exact HEAD and complete before/protected manifests, including dirty user paths. Inspect current signatures and call order for R10/R11/R13 and Task B. Add DB-free tests against injected service adapters for two concurrent authenticated requests, selector/runId non-authority, same-Bot Expert/route issuance, missing/pending/mismatched finalized intent rejection, explicit-cap invalid rejection before any append/Run creation, and unavailable capability. Add mounted GET/POST SSE assertions so helper-only evidence cannot pass. Run `bun test tests/enterprise/runner-production.test.ts` from `server/`; Expected: new behavior assertions FAIL before implementation. Preserve output and do not weaken assertions.
- [ ] **Step 2 — Compose capabilities:** Refactor production index initialization so the already-verified DirectoryDatabase/DataDatabase are shared by authenticated ScopeResolver, ConversationService, RunService, EventService and Runner. Missing/invalid capabilities do not create a permissive fallback; runtime reports safe unavailable.
- [ ] **Step 3 — Implement Runner admission:** `run` derives actor/thread scope from current Hono Request; verify the finalized intent using durable fields and exact attachment refs; start the Run with explicit `forwardedProps.maxOutputTokens`; acquire an owner-bound request lease; persist/publish lifecycle events in order. Until governed built-in execution is available, refuse before `request.agent.run()` or any model side effect, call `RunService.fail` with the exact lease and fixed `MODEL_EXECUTION_UNAVAILABLE` code, and treat a stale `false` result as a failure rather than success. Do not falsely report completed model execution.
- [ ] **Step 4 — Implement other Runner operations:** `connect` replays then subscribes to durable events using validated thread scope; `isRunning` reports only an authorized persisted active Run; `stop` resolves and stops only the exact persisted Run/attempt under that scope. Observable teardown releases only its captured request lease. Handle abort/error to avoid leaked leases or unknown Run state.
- [ ] **Step 5 — Mount production SSE:** `mountCopilotRuntime` constructs an SSE runtime and handler with request-bound custom Runner, replacing the active server Intelligence Runtime/socket/lock path only after the production dependencies are present. No use of client tenant/workspace/run IDs as scope authority. Do not remove headless Intelligence in this slice; that remains a following task.
- [ ] **Step 6 — GREEN:** Run mounted-runtime/Runner/scope/event/request-context and existing Copilot tests; target TypeScript for changed production paths; scoped Biome and `git diff --check`. Do not connect to DB. If disposable DB URLs are absent, record migration/RLS/restart/two-instance checks as unverified.
- [ ] **Step 7 — Freeze:** Capture exact before/after hashes, task increment, report and all test outputs at `.superpowers/sdd/2026-10-12-mastra-t2-runner-sse-admission/reports/task-1-continuation-implementer-report.md`. Validator and reviewer inspect the same hashes.

**Acceptance:** The production mounted browser server path is genuinely CopilotKit SSE and delegates admission/lifecycle to OpenBot's authorized durable Runner; no model executes outside Run governance; request/scope isolation and fail-closed tests pass. This does not complete T2: governed built-in ModelGateway execution, headless routine/responsibility/handoff migration, frontend Task 7, and isolated DB/RLS/two-instance evidence remain required.

**Failure handling:** If Run/attempt/event lifecycle semantics cannot be composed without changing accepted service interfaces, stop with exact evidence and create a scoped interface plan; do not use Intelligence or direct agent execution as fallback.
