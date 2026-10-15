# T2 Continuation — Production Runner and SSE Cutover

> **For agentic workers:** execute the remaining Task 2 work from the approved parent plan using RED → GREEN → REFACTOR. Preserve all prior checkpoints and user changes. Do not commit, stage, stash, reset, rebase, start/probe/access a database, or begin Task 3.

**Goal:** Continue the existing Mastra Intelligence migration by completing the remaining production Task 2 wiring: authenticated request-scoped Runner composition, CopilotKit SSE cutover, and governed existing execution-source integration. This is continuation of `docs/plans/2026-10-11-mastra-intelligence-only-dag.md` Task 2, not a redesign.

**Source of truth:** Approved design `docs/superpowers/specs/2026-10-11-mastra-intelligence-only-design.md`; parent Task 2 plan and brief `docs/plans/2026-10-11-mastra-intelligence-only-dag.md`, `.superpowers/sdd/2026-10-11-mastra-intelligence-only-dag/task-2-brief.md`; active Ledger `.superpowers/sdd/2026-10-11-mastra-intelligence-only-dag/progress.md`; existing R10–R13 reports/plans; accepted AI SDK v3→ModelGateway adapter round 2; user-confirmed route/budget ruling.

**Confirmed route/budget ruling:** Resolve route only from the authenticated actor's authorized Bot effective model (`tenantPackage.model` plus existing deployment override behavior). Each Run requires explicit `forwardedProps.maxOutputTokens`, integer `1..2_147_483_647`; persist this exact value as aggregate Run ceiling and enforce model steps against remaining balance. No defaults or client-chosen model/provider/route. Unknown or unsupported remote provider enforcement/usage fails closed.

## Global Constraints

- Continue existing T2 interfaces and ownership; do not alter product Agent/tool/approval/pause/resume/recovery semantics or move execution to Mastra Agents.
- Preserve every existing user change, including migration 0065/0066, migration-runner, dirty integration suites, and all accepted T1/T2 checkpoints. Do not rewrite user-authored migration files.
- Reuse the existing Run lease/EventService, verified database capabilities, actor-scope resolution, ModelGateway adapter, and budget/capability services; inspect their current hashes before editing. Do not duplicate them.
- No production DB, service startup, URL/endpoint probing, migrations, commits, staging, stash/reset/rebase/merge/push/release, or Task 3 dispatch. Run DB integration only if the disposable database is explicitly configured and user-ready; absent it, defer and disclose.
- T2 acceptance remains incomplete until isolated DB migration/RLS/two-instance tests actually pass.

## Review Focus

- Mounted runtime uses CopilotKit SSE with the durable OpenBot `AgentRunner`; no Intelligence Runtime/socket/lock remains in active server/headless coordination.
- Every runner operation resolves authenticated actor and exact conversation scope from server-owned membership/data; never trust tenant/workspace selectors or client run IDs.
- Request-local request binding does not leak between concurrent Hono requests; disconnect releases only its own claim; explicit stop targets captured server Run/attempt.
- Run starts only from finalized Mastra message intent with matching actor/thread/key/digest/attachments/backend version; events persist before publish and replay/reconnect remain authorized.
- Built-in execution resolves the authorized Bot effective model, routes through strict `ModelGateway` adapter, passes explicit per-call cap, persists a per-step capability and settles authoritative usage or marks unknown. No direct provider bypass.
- Remote AG-UI/Mastra execution is explicitly refused unless verified upstream max-output enforcement and authoritative usage are present; callback/terminal events alone do not establish either.
- Headless consumers no longer use Intelligence history/thread locks/handoff, while preserving existing authorized execution-source behavior where governance can be proven.

## Task 1 — Finish production Task 2 composition

**Role:** backend_implementer. **Validator:** backend_validator. **Reviewer:** reviewer. **Dependency:** accepted existing Task 2 service/event/scope/model-adapter slices and R13 Fix2. R13 Fix2 is source/review verified; its PostgreSQL transaction/concurrency tests remain unverified due absent disposable DB. This task may continue non-DB implementation but must not claim those gates passed.

**Owned files:** use only paths already owned by parent Task 2: `server/src/copilot.ts`, `server/src/intelligence-client.ts`, `server/src/index.ts`, `server/src/config.ts`, `server/src/agents/agent-resolver.ts`, the narrow existing built-in model adapter path identified by actual call graph, `server/src/enterprise/contracts.ts`, `server/src/enterprise/runs/service.ts`, `server/src/enterprise/runs/store.ts`, `server/src/enterprise/tenancy/connections.ts`, `server/src/enterprise/tenancy/store.ts`, and necessary mounted runtime/routes/test files. Only modify `server/src/db/schema/enterprise-runs.ts`, migration metadata, or a new migration if source inspection proves it is necessary; preserve existing 0065–0069 history and require an additive migration. Do not touch Task 3/4/etc or frontend Task 7 files.

**Consumes:** `ScopeResolver.resolveForThread`; verified DirectoryDatabase/DataDatabase capabilities; `RunService` lease, start, stop, admission, per-step capability and settlement; `EventService`; `createGovernedMastraModel` / strict gateway adapter; existing `resolveAgentForActor`; CopilotKit SSE `AgentRunner` signatures. Verify actual exported/runtime signatures and SHA checkpoint before coding.

1. **RED / preflight:** Record HEAD and complete owned/protected before manifests. Confirm accepted R10/R11/R13 evidence and current schemas. Add failing synthetic tests for request-local SSE runner lifecycle, no selector authority, finalized intent binding, authorized Bot route/cap propagation, built-in gateway-only invocation and usage settlement, remote fail-closed behavior, and headless event/history migration. Run only DB-free tests. Ensure each failure reflects a missing behavior.
2. **Compose:** Build one production composition entry point that verifies separately configured directory/data connection capabilities before mounting enterprise Runner; constructs scope/conversation/run/event/agent/model dependencies from existing services; returns safe unavailable errors rather than constructing tenant scopes from ambient deployment identity.
3. **Bind request lifecycle:** Inject the durable Runner into the locked CopilotKit SSE Runtime. Capture each Hono Request explicitly in request-scoped methods for `run/connect/isRunning/stop`; no process-wide mutable request context or cross-request AsyncLocalStorage leak. Use server Run ID/attempt as authority. Preserve disconnect-vs-stop semantics and event replay/subscription ordering.
4. **Bind governed execution:** Require a finalized matching Mastra message-intent receipt before Run admission. Resolve the actor-authorized Bot and effective model server-side. Use the accepted AI SDK v3 adapter → ModelGateway path and existing capability/budget service; each model step must hold explicit maxOutputTokens within remaining aggregate. Confirm authoritative usage once, otherwise mark unknown. Do not add an alternate provider invocation path. Fail closed for unverified remote AG-UI/Mastra budget/usage enforcement.
5. **Cut over server/headless consumers:** Replace only server Intelligence runtime/history/thread lock/handoff usage with OpenBot APIs and durable events; keep existing agent selection, tools, approvals, and learning semantics. Do not implement frontend Task 7 in this task.
6. **GREEN:** Run focused runner scope/event/request-context/runtime/adapter/model tests, copilot/runtime compatibility suites, changed-path TypeScript, scoped Biome and `git diff --check`. Run DB/RLS/two-instance/migration tests only against already-configured disposable test DBs without provisioning; otherwise mark unverified. Record known unrelated test/type diagnostics separately.
7. **Freeze:** Produce exact before/after manifests and task increment including additions/deletions, file hashes, commands/results and protected-path comparison; report at `.superpowers/sdd/2026-10-12-mastra-t2-production-cutover/reports/task-1-implementer-report.md`. Validator/reviewer inspect identical frozen hashes. T2 does not complete until mandatory DB gates pass.

**Acceptance:** All non-DB production Task 2 requirements above are implemented and independently reviewed; no active Intelligence server/headless orchestration remains; no governance bypass exists; output cap and usage semantics match the ruling; DB limitations are explicit. If any core behavior cannot be implemented without an unapproved policy/schema/authority assumption, stop and report evidence rather than guessing.
