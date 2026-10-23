# T2 Immutable Expert Version Prerequisite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Supply a trusted, immutable `expertVersionRef` for the actor-authorized selected built-in Bot before production Run admission.

**Architecture:** Preserve existing Agent authorization and model-route catalog. An Expert catalog stores a tenant-scoped canonical snapshot of the selected Bot's execution definition; its content reference is separate from `routeRef`. Run admission consumes both references, and restart resolves the stored Expert reference without reading mutable current Bot configuration.

**Tech Stack:** TypeScript, Bun, Drizzle PostgreSQL, Hono; isolated PostgreSQL verification deferred until the user-provided test database is ready.

**Spec:** `docs/specs/superpowers/2026-10-11-mastra-intelligence-only-design.md`; parent Task 2 in `docs/plans/2026-10-11-mastra-intelligence-only-dag.md`; evidence `.superpowers/sdd/2026-10-12-mastra-t2-runner-sse-admission/reports/expert-version-source-evidence.md` and `expert-version-prerequisite-architecture.md` in the same directory.

## Global Constraints

- Preserve current worktree and all dirty user changes. No stage, commit, stash, reset, rebase, merge, push, PR, publish, or worktree deletion.
- Do not start, reset, modify, probe or access the local database service or a production database. Use only DB-free tests and static migration checks now. Record PostgreSQL/RLS/restart/concurrency acceptance as unverified.
- Preserve OpenBot execution/tool/approval/pause/recovery ownership, existing skill learning, and model route catalog. Do not create a second Agent registry or route configuration.
- `expertVersionRef` must identify the selected Bot execution definition, while `routeRef` identifies model routing; both are tenant-scoped and independently persisted. The later SkillSnapshot pin is a separate identity.
- The selected Bot must come from the existing actor-authorized resolver. No client Bot ID, mutable timestamp, raw credential, model override or fixture constant is trusted as an Expert version.
- Task implementation is serial in this shared worktree. Each Task needs prospective RED, GREEN, exact uncommitted checkpoint, backend validator and independent Spec/quality reviewer. Subagents do not spawn agents.

## Review Focus

1. The catalog rejects malformed/unknown schema, extra fields and cross-tenant refs before any storage access.
2. Changed executable prompt or behavior version changes Expert ref; display-only fields and model-route changes do not.
3. A restarted resolver reads the immutable snapshot or fails closed; it never substitutes current mutable Bot configuration.
4. Actor authorization precedes snapshot creation, and unavailable/remote Bots cannot mint a built-in Expert ref.
5. Existing Run admission keeps exact finalized intent, explicit caller output cap and transactional budget checks when both refs are supplied.

## Recovery and ownership preflight

At planning, HEAD is `b1532dbe4ec4d2e64b58fd31c57a7c1863ffd155`; Fix3 failure store/test checkpoint is separately reviewed at SHA256 `3f4bda646ba1d9f8458d3dc86bd63b08085c6a2dd449a7ba42caed0f581b9053` / `35ccc742a4a4496cea2ba2080423c5073d34deb156bf4719194c7f39392c6ef9`. Model route catalog Fix2 is reviewed for DB-free scope. The Drizzle journal ends at index 70. Before edits, recheck current HEAD, all owned file hashes and journal index, and capture complete tracked staged/unstaged plus task-range untracked content and protected hashes. Existing migrations 0065–0070 and route catalog sources are protected. If another actor changes the journal or owned files, stop for coordinator reconciliation rather than overwrite.

No Issue was supplied. This Task implements the approved T2 admission interface prerequisite, not a new parent business requirement. T2 Runner/SSE consumes Task 2 below; T3–T10 remain pending. The next migration index is 0071 only if the preflight still shows 0070 as the tip. The only current catalog pattern is `server/drizzle/0070_enterprise_model_route_catalog.sql` with tenant RLS, FORCE RLS and SELECT/INSERT grant to `ob_ent_data`.

## Task 1: Persist and resolve immutable Expert definitions

**Depends on:** verified route catalog Fix2. **Owner:** backend_implementer. **Validator:** backend_validator. **Reviewer:** reviewer. **Owned files:** create `server/src/enterprise/experts/version-catalog.ts`, `server/src/db/schema/enterprise-expert-versions.ts`, `server/tests/enterprise/expert-version-catalog.test.ts`, additive `server/drizzle/0071_enterprise_expert_versions.sql` and matching journal/snapshot, modify only `server/src/db/schema/index.ts` for export, plus Task 1 report/checkpoint files. **Commit strategy:** uncommitted checkpoint.

**Consumes:** `PlatformScope`, `assertTrustedScope`, verified `DataDatabase`, the 0070 tenant/RLS/catalog pattern. **Produces:** `ExpertDefinitionV1`, `ExpertVersionRef`, `ExpertVersionCatalog.putOrGet(scope, definition)`, `resolve(scope, ref)` and a stable canonicalizer. The definition includes `schemaVersion:1`, `agentId`, `source`, `agentType:'built_in'`, normalized `systemPrompt`, and explicit built-in `behaviorVersion`. Exclude credentials, mutable authorization, SkillSnapshot and model route.

- [ ] **RED:** Add tests that a fixed authorized definition yields the same `expert:v1:<sha256>` reference across key order/process instances; changing prompt, agent ID, source, behavior version or tenant changes ref; extra/malformed fields, remote type, empty prompt, unknown version, forged/mismatched storage row and cross-tenant reference fail closed. A display-only field is rejected instead of silently changing identity. Run `bun test server/tests/enterprise/expert-version-catalog.test.ts` and record failure on missing catalog API before implementation.
- [ ] **GREEN canonicalization:** Implement strict allowlist, normalized prompt exactly matching `registeredAgentFromRow` and built-in constructor consumption, deterministic JSON and domain-separated SHA-256 using trusted scope tenant. `putOrGet` recomputes the ref; no caller-supplied digest. `resolve` recomputes digest from stored payload and checks tenant/ref/schema, returning unavailable for absence and throwing on corrupt mismatch.
- [ ] **GREEN persistence:** Add tenant-keyed `enterprise_expert_versions` with `(tenant_id, expert_version_ref)` primary key, schema version, agent ID, snapshot JSON and created timestamp. Use tenant FK, tenant RLS/FORCE RLS, PUBLIC revoke and `ob_ent_data` SELECT/INSERT grants mirroring 0070. Insert is conflict-safe and compares canonical stored bytes on conflict. There is no UPDATE/DELETE API. Use verified data capability only. Create additive migration and metadata without connecting to a database.
- [ ] **Verify:** Run focused test, scoped Biome, changed-path TypeScript, migration metadata/static checks and `git diff --check`. Record any unrelated whole-server typecheck diagnostic separately. Inspect 0071 against 0070 for tenant FK, RLS and grants. No database run.
- [ ] **Freeze:** Save owned before/after content/hashes, task-only patch including new files, protected-file equality and exact command outputs in a Task 1 report. Validator repeats DB-free checks; reviewer returns separate Spec/quality verdicts on exact hashes. Correct valid findings with a numbered SDD fix plan.

**Acceptance:** immutable tenant-bound Expert content identity and restart-readable repository interface exist; schema/migration are additive by static evidence. Live PostgreSQL durability/RLS/concurrent insert remains unverified.

## Task 2: Bind authorized selected Bot to Run version

**Depends on:** Task 1 reviewed checkpoint; Fix3 request-owned failure gate. **Owner:** backend_implementer. **Validator:** backend_validator. **Reviewer:** reviewer. **Owned files:** `server/src/agents/runtime-agents.ts` for a narrow provenance projection, `server/src/agents/agent-resolver.ts`, narrow source descriptor in `server/src/copilot.ts` only if required, `server/src/enterprise/contracts.ts`, `server/src/enterprise/runs/service.ts`, new `server/tests/enterprise/expert-run-admission.test.ts`, focused runtime-loader/resolver/Run tests only where necessary, and Task 2 report/checkpoint files. Do not edit the version catalog or model route catalog after its reviewed checkpoint without a scoped fix plan.

**Consumes:** `ExpertVersionCatalog.putOrGet/resolve`, actor-authorized Bot resolver, `ModelRouteSnapshotCatalog`, `RunService.start`, exact Mastra intent validation and caller Run cap. **Produces:** an authorized selected Bot/Expert descriptor and a Run admission interface carrying independently issued `expertVersionRef` and `routeRef` with no mutable lookup fallback.

- [ ] **Preflight:** Read `reports/task-2-source-preflight.md` and recheck its source facts. The built-in prompt uses trimmed `configuration.systemPrompt`; name/title/role description are not independently included. The runtime loader currently drops provenance. Freeze exact `RunService` and resolver signatures, owned hashes, and trusted classification rule in the Brief before editing.
- [ ] **RED:** Add tests for off-roster/deleted/remote Bot denial, authorized built-in version creation, changed execution prompt causing a new ref, route change leaving Expert ref unchanged, unknown/cross-tenant Expert ref refusing Run, and a Run persisting distinct supplied Expert and route refs. Assert invalid/absent caller cap or missing/pending/mismatched finalized intent still creates no Run. Run focused tests and record intended failures before production edits.
- [ ] **GREEN authorization:** Add a narrow trusted loader projection of `agents.packageId`, `agentProfiles.ownerUserId`, and a real `team_bot_publications` existence fact alongside the currently selected built-in row. Classify package ID present as `tenant_package`, otherwise publication present as `team_bot`, otherwise non-null owner as `user_profile`; reject contradictory or unclassified facts instead of guessing from visibility/name/ID. Extend the existing actor resolver with a method returning the same authorized Agent plus this source descriptor. Reuse its roster check; do not construct a second authorization path. Normalize prompt once and pass the same bytes to runtime and catalog. Remote sources retain current fail-closed behavior.
- [ ] **GREEN admission:** Adjust the narrow trusted `RunService` dependency/input seam so Runner composition supplies the catalog-issued Expert ref and route-catalog-issued route ref for the selected authorized Bot. Keep `createRunInTransaction` finalized-intent validation, output-ceiling validation and budget reservation unchanged. Recheck the referenced Expert snapshot and tenant before Run insert. On restart resolve from the catalog by persisted ref; missing/corrupt snapshot fails closed rather than re-reading current Bot configuration. Do not mount SSE in this Task.
- [ ] **Verify/freeze:** Run focused admission/resolver/Run contract tests, Biome, changed-path TypeScript and diff check; freeze complete exact checkpoint, then backend validation and independent Spec/quality review. Database backed atomicity/RLS/restart is pending isolated DB.

**Acceptance:** a production Runner can consume a trusted, immutable selected-Bot version and independent route identity without inventing either; existing Run admission guards still apply. No claim of mounted SSE or full T2 completion.

## Continuation and failure handling

`Task 1 → Task 1 validation/review → Task 2 → Task 2 validation/review → existing T2 Runner/SSE admission plan → governed model execution/headless cutover → isolated DB gate → parent T3–T10`. Read-only planning can overlap either Task; source edits cannot overlap in this shared worktree. If Task 1 or 2 exposes an incompatible existing interface or an unproven executable field, stop that Task's production edits and record a scoped ruling/fix plan; never fill `expertVersionRef` with a timestamp, Bot ID or test value. The separate SkillSnapshot publication/pin remains under T5; record its Run persistence need there without concatenating it into Expert identity.
