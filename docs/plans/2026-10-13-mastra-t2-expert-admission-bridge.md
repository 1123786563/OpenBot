# T2 Authorized Expert Admission Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind the actor-authorized selected built-in Bot to an immutable Expert version and an independent model route before OpenBot admits a Run.

**Architecture:** The existing actor resolver supplies an authorized Bot with evidenced provenance and exact normalized prompt. Server composition stores its immutable Expert definition and independently selects a model route; RunService receives both server-issued references, verifies the Expert inside its existing admission transaction, and retains finalized message-intent and caller cap guards. The production SSE Runner will consume this bridge in the following already approved slice.

**Tech Stack:** TypeScript, Bun, Drizzle PostgreSQL (injected DB-free tests now; isolated PostgreSQL gate later).

**Spec:** `docs/superpowers/specs/2026-10-11-mastra-intelligence-only-design.md`; parent Task 2 in `docs/plans/2026-10-11-mastra-intelligence-only-dag.md`; prerequisite `docs/plans/2026-10-13-mastra-t2-expert-version-prerequisite.md`; read-only reports `task-2-source-preflight.md` and `task-2-admission-architecture.md` under `.superpowers/sdd/2026-10-13-mastra-t2-expert-version-prerequisite/reports/`.

## Global Constraints

- Preserve existing worktree, all dirty user files and reviewed checkpoints. No stage/commit/stash/reset/rebase/merge/push/PR/publish/worktree deletion.
- Do not access, probe, start, reset or modify local or production databases. Actual RLS, transaction, migration and restart acceptance remains unverified until the isolated database is ready.
- Actor authorization uses the existing roster and scope boundaries. Client Bot/tenant/workspace selectors are never authority for an Expert version; client `expertVersionRef` and `routeRef` are not wire fields.
- Model route identity stays independent of Expert identity. Per-Run aggregate ceiling equals valid caller `forwardedProps.maxOutputTokens`; each model call cap remains a later governed execution requirement.
- Preserve finalized Mastra intent matching and budget reservation within Run creation, and preserve existing tool, approval, pause/recovery and remote fail-closed behavior.
- All changes use prospective RED → GREEN → REFACTOR, exact uncommitted checkpoint, backend validator, and independent Spec/quality reviewer. Tasks edit serially in this shared worktree. Subagents do not spawn agents.

## Review Focus

1. An off-roster, deleted, remote, malformed, or provenance-ambiguous Bot cannot mint a built-in Expert version.
2. Package ID, owner identity and Team Bot publication are read from trusted server rows; visibility/name/ID do not imply provenance.
3. The same trimmed prompt reaches the built-in runtime and immutable definition; profile display fields do not add a second prompt identity.
4. Run admission verifies Expert snapshot with the same transaction object that creates Run/attempt/budget and rejects missing/corrupt/cross-tenant refs.
5. Finalized intent and exact caller output ceiling still reject before Run/budget persistence; Expert ref and route ref stay distinct.

## Shared interface and ownership preflight

Fix3 request-owned Run failure is independently approved DB-free. Expert catalog Task 1/Fix2 is independently approved DB-free at source SHA256 `aaab8d84226459c5fd1a7edaaa8b09452cbf3eafedd1fe23eb42920b28e6d322` and test SHA256 `12fe4ccbae0f6221ef8fef77d68a35f3be4c2f332ca8579cc299ae5de1e8eeee`. Route catalog Fix2 remains approved DB-free and protected. No Issue was supplied. T2 Runner/SSE is downstream; T3–T10 remain pending. The code presently has no production immutable Expert producer, so this bridge is a prerequisite, not an alternate Agent implementation.

Task A owns runtime loader/resolver/Copilot type exposure and focused tests. Task B owns Expert catalog transaction reader, RunService/contract seam and focused tests. They have a real dependency: Task B consumes Task A's authorized built-in descriptor. `server/src/copilot.ts` is shared with later Runner work, so all edits are serial. Any source drift since this plan's recorded hashes requires a fresh Brief baseline, not overwriting another worker.

## Task A: Authorized built-in descriptor with evidenced provenance

**Depends on:** reviewed Expert catalog Task 1. **Owner:** backend_implementer. **Validator:** backend_validator. **Reviewer:** reviewer. **Owned files:** `server/src/agents/runtime-agents.ts`, `server/src/agents/agent-resolver.ts`, narrow `server/src/copilot.ts` built-in type/prompt exposure only if needed; focused new `server/tests/agents/expert-descriptor.test.ts` or existing resolver test, focused loader tests, and Task A checkpoint/report files. **Consumes:** actor roster loader and `AgentActor`. **Produces:** `resolveBuiltInBotForActor(actor, agentId, context): Promise<{ agent: AbstractAgent; definitionFacts: { agentId; source; systemPrompt } }>` or an equivalent typed, single-roster-read result. **Commit strategy:** uncommitted checkpoint.

- [ ] **Preflight:** Freeze exact owned/protected hashes and complete dirty/untracked inventory. Read the source-preflight report and verify the selected row projection still contains only ID/name/type/config/presentation fields. Read `team_bot_publications` and package/profile schema before touching code.
- [ ] **RED provenance tests:** Use a DB-free injected row/query fixture or a pure classifier plus query-shape assertion to show package ID → `tenant_package`, otherwise publication → `team_bot`, otherwise owner ID → `user_profile`; contradictory/missing evidence rejects. Ensure the publication fact comes from the trusted table and actor filtering is unchanged. Run focused tests to capture intended failure before implementation.
- [ ] **RED authorization tests:** Off-roster ID, tombstoned/unavailable, remote AG-UI/Mastra, malformed built-in prompt and ambiguous source cannot return a descriptor. An authorized built-in returns exactly the trimmed `systemPrompt` used by the built Agent; name/title/roleDescription are not independently appended. Run focused tests before implementation.
- [ ] **GREEN:** Add only the trusted provenance projection and a dedicated resolver method reusing `loadAgents(actor)`, existing roster membership check and the same single-Bot build path. Keep `resolveAgentForActor` and all current execution source behavior stable. Do not create a parallel Bot registry or allow remote sources to masquerade as built-ins.
- [ ] **Verify/freeze:** Run focused resolver/loader/Copilot tests, scoped Biome, changed-path TypeScript and diff check; save exact before/after manifests, patch and report. Independent backend validation and Spec/quality review inspect the same hashes. Database-backed actor filter/provenance query behavior is pending isolated DB.

**Acceptance:** an actor-authorized, classified built-in descriptor exists and carries exact executable prompt bytes; all denied classes fail closed. It does not create a Run or change production mount.

## Task B: In-transaction Expert verification and distinct Run refs

**Depends on:** Task A reviewed checkpoint and reviewed Expert catalog Task 1. **Owner:** backend_implementer. **Validator:** backend_validator. **Reviewer:** reviewer. **Owned files:** `server/src/enterprise/experts/version-catalog.ts` only for a transaction-aware verified read, `server/src/enterprise/runs/service.ts`, minimal internal `server/src/enterprise/contracts.ts` types if necessary, focused `server/tests/enterprise/expert-run-admission.test.ts` and affected Run fixtures, plus Task B checkpoint/report files. Protect `server/src/enterprise/runs/store.ts`, route catalog, schema/migrations and Copilot mount unless a test proves a narrow interface defect and a reviewed scope revision is recorded.

**Consumes:** Task A authorized descriptor, `ExpertVersionCatalog.putOrGet/resolve`, independent model-route catalog, existing `RunService.start`/`createRunInTransaction`, `runOutputCeilingFromInput`. **Produces:** server-only `TrustedRunAdmission` (public `StartRunInput` + independently issued `expertVersionRef` and `routeRef`) and a RunService admission method that persists those refs distinctly after same-transaction Expert verification. Existing `modelRouteFor` must cease issuing Expert identity; route selection returns only route ref/policy.

- [ ] **Preflight:** Freeze exact owned/protected hashes and current `RunService.start`, catalog and `StartRunInput` signatures. Confirm no production callsite currently creates `RunService`; preserve current integration fixture behavior with explicit adaptation tests.
- [ ] **RED:** Test missing/malformed/cross-tenant/corrupt Expert ref and route/Bot identity mismatch reject before Run/budget. Use a recording transaction fake to assert the Expert verifier receives the same transaction handle passed to `createRunInTransaction` and budget reserve. Test absent/invalid caller cap and missing/pending/mismatched finalized intent still persist nothing. Test valid admission persists distinct Expert and route refs and exact caller ceiling. Run focused tests before implementation and record intended failures.
- [ ] **GREEN catalog seam:** Add `resolveInTransaction(scope, tx, ref)` (or equivalent) that validates the ref, trusted scope, transaction-local tenant context and recomputed canonical row identity using the supplied transaction. Reuse the existing verifier; do not alter immutable payload or schema. Keep standalone `resolve` behavior and its frozen tests passing.
- [ ] **GREEN RunService seam:** Create the server-only trusted admission wrapper after Task A resolver and catalog `putOrGet` have issued the Expert ref and independent route selector has issued the route ref. Do not add refs to client/wire input. Validate caller cap as today. Within existing `store.transaction`, re-read/verify Expert and selected agent ID/tenant before `createRunInTransaction`; then retain exact finalized intent validation and budget reservation in that transaction. Do not derive Expert from route or `agents.updatedAt`. A failed Run may leave an unreferenced content-addressed Expert row; it grants no authority.
- [ ] **Verify/freeze:** Run catalog/Run/admission/intent/budget DB-free tests, scoped Biome, changed-path TypeScript and diff; capture exact increment and protected hashes. Independent backend validation and Spec/quality review inspect same checkpoint. Actual PostgreSQL atomicity/RLS/restart remains pending isolated DB.

**Acceptance:** trusted actor-selected Expert and route refs are independently issued and persisted; Expert is verified in the Run transaction; caller cap, finalized intent and budget guards remain. This does not mount SSE or complete T2.

## Failure handling and continuation

If Task A exposes a provenance classification conflict, stop that Task's source edits and record exact row facts for a scoped plan correction; never guess source from visibility. If Task B cannot reuse the current Run transaction handle, stop instead of accepting a separate pre-read as equivalent. Valid review findings get numbered repair plans and fresh same-hash gates. After Task B's reviewed checkpoint, update the existing `docs/plans/2026-10-12-mastra-t2-runner-sse-admission.md` Brief to consume the trusted bridge, then resume Runner/SSE production mounting. Isolated database gates remain unverified until the user-configured test database is ready.
