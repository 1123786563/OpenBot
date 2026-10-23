# Mastra Immutable Model Route Snapshot Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist an immutable, tenant-scoped, secret-free effective model-route snapshot so a Run’s opaque `model_route_ref` resolves to the same admitted provider/model and selected Bot identity after restart or deployment changes.

**Architecture:** Add a tenant-keyed route catalog with canonical versioned snapshots and content-derived refs. Derive effective model fields only from the actor-authorized selected built-in Bot's approved `tenantPackage.model` plus existing `runtimeModelForEnvironment` semantics; store the reauthorized Bot ID as plan invocation identity, not authorization proof. A pure domain module validates/canonicalizes snapshots and uses keyed fingerprints for provider destinations; a DataDatabase store inserts atomically and verifies exact equality on conflict or read. This slice does not wire Run admission or ModelGateway.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, Vitest, existing enterprise DataDatabase/RLS patterns.

**Spec:** Approved Mastra Intelligence-only design `docs/specs/superpowers/2026-10-11-mastra-intelligence-only-design.md`; parent DAG `docs/plans/2026-10-11-mastra-intelligence-only-dag.md`; Task 2 Brief `.superpowers/sdd/2026-10-11-mastra-intelligence-only-dag/briefs/task-2.md`; current T2 Runner/SSE plan `docs/plans/2026-10-12-mastra-t2-runner-sse-admission.md`; route evidence `.superpowers/sdd/2026-10-12-mastra-t2-active-run-lookup/reports/route-registry-architecture.md`, `route-source-research.md`, `route-registry-addendum.md`, and `route-contract-gate-reassessment.md`.

## Global Constraints

- Mastra is limited to Intelligence persistence, memory, and learning; existing OpenBot mechanisms retain Agent execution, tools, approvals, pause, and resume.
- Route refs must be durable and immutable; never re-derive an existing Run’s route from current deployment overrides.
- Persist only an explicit allowlist of non-secret model identity/configuration; never store credentials, auth headers, plan tokens, raw Bot config, or arbitrary JSON.
- Catalog access is tenant scoped; runtime data role receives only `SELECT, INSERT`; there is no runtime update/delete path.
- Do not add a foreign key from existing Runs in this slice: historical refs have no proven snapshots and cannot be fabricated/backfilled.
- Do not start, probe, reset, modify, or access any database. Do not run migrations or DB-backed suites; static/schema generation checks are permitted only if they do not connect to a DB.
- Preserve all existing dirty user files, especially migrations 0065–0069 and current journal/snapshots. Add the next migration as 0070 without editing existing migrations.
- No commit, staging, stash, reset, rebase, merge, push, release, PR, or worktree deletion.

## Review Focus

- Canonical snapshot ordering produces the same reference for semantically identical input; unsupported schema versions fail closed.
- Secret-like keys, credentials, arbitrary Bot fields, malformed model identifiers, and invalid transport identity never enter persisted snapshot bytes.
- Same tenant/ref insert conflict is accepted only for byte-for-byte equal canonical content; any mismatch is a corruption error, never overwrite.
- Tenant A cannot read/reuse Tenant B’s route even when snapshot contents are otherwise identical.
- Unknown, corrupt, or digest-mismatched refs fail closed without affecting Run history or stop/cancel paths.
- Plan `planBotId` equals the reauthorized selected Bot ID for both Gateway and Mastra execution; missing identity fails closed rather than falling back to Run ID.

## Contract Rulings

Read-only reassessment `.superpowers/sdd/2026-10-12-mastra-t2-active-run-lookup/reports/route-contract-gate-reassessment.md` (SHA256 `3b57b866f701922ccea613c9d3ea18f0efcc091607c91c9f22b28c6460dcad34`) reconciles this plan with the approved T2 rule: use the actor-authorized selected Bot, `tenantPackage.model`, and existing `BOT_MODEL`/`BOT_PROVIDER` override semantics; do not add parallel route config. `expertVersionRef` is a separate Run-level contract and must not be fabricated by the model catalog. Store the reauthorized selected `agentId` as the plan invocation identity and require both model consumers to use that identity consistently. Represent plan/native provider destinations only by domain-separated HMAC fingerprints; bind current live configuration and credentials at invocation and fail closed on identity drift or key rotation. No raw URL, token, Bot configuration, or other secret enters the catalog.

---

### Task 1: Add immutable tenant route catalog contract and persistence

**Role:** backend_implementer. **Validator:** backend_validator. **Reviewer:** reviewer. **Dependencies:** Existing approved T2 route ruling, active Run lookup review, and route contract reassessment. **Commit strategy:** uncommitted checkpoint; do not commit.

**Files:**
- Create: `server/src/db/schema/enterprise-model-routes.ts`
- Modify: `server/src/db/schema/index.ts`
- Modify: `server/drizzle.config.ts`
- Create: `server/drizzle/0070_enterprise_model_route_catalog.sql`
- Create: `server/drizzle/meta/0070_snapshot.json` using the repository’s DB-free Drizzle schema-generation workflow; do not run migration or connect to a database.
- Modify: `server/drizzle/meta/_journal.json` by appending idx 70 / tag `0070_enterprise_model_route_catalog`; preserve existing entries byte-for-byte.
- Create: `server/src/enterprise/runs/model-route-catalog.ts`
- Create: `server/tests/enterprise/model-route-catalog.test.ts`
- Create: `.superpowers/sdd/2026-10-13-mastra-route-snapshot-catalog/reports/task-1-implementer-report.md` and before/after manifests plus increment patch.

**Interfaces:**
- Consumes: existing `DataDatabase` transaction type from `server/src/enterprise/tenancy/connections.ts`, `PlatformScope`, and route evidence cited above.
- Produces: `ModelRouteSnapshotInput = { agentId: string; route: RuntimeModelRoute; nativeBaseUrl?: string }`, `SafeModelRouteSnapshot`, `CanonicalModelRouteSnapshot`, `canonicalizeModelRouteSnapshot(tenantId, input, modelCapabilitySecret)`, `ModelRouteCatalogStore.put(scope, input)`, and `ModelRouteCatalogStore.get(scope, routeRef)`. The safe snapshot is exactly `{ schemaVersion: 1, agentId, provider, defaultModel, credentialSecretRef, plan?: { provider, endpointFingerprint }, nativeBaseUrlFingerprint }`; absent plan/native override uses an explicit `null` identity. `put` returns immutable canonical snapshot/ref; `get` returns it only after tenant-scoped lookup, schema validation, canonical re-encoding, and digest verification.
- Exact snapshot allowlist: `schemaVersion: 1`; reauthorized `agentId`; effective model `provider` (`openai|anthropic`) and `defaultModel`; `credentialSecretRef` (reference ID only); optional plan provider and endpoint HMAC fingerprint; native provider base-URL HMAC fingerprint/default marker. `expertVersionRef` is not in the catalog and remains an independent Run-level field. `planBotId` equals the persisted reauthorized `agentId`. Runtime tokens, raw endpoints, auth-file paths, raw Bot configuration and other secrets are never persisted.

**Owned files:** only the files listed above. Do not modify `enterprise-runs.ts`, RunService, ModelGateway, `server/src/enterprise/models/gateway.ts`, existing 0065–0069 migrations/snapshots, or tests outside the new focused test.

- [ ] **Step 1: Freeze and inspect:** capture HEAD, exact owned/unowned source hashes, complete task-owned untracked-file manifest, and protected dirty-path manifest. Verify the approved route-source ruling in Task 2 Brief; inspect runtime route and provider destination normalization plus schema export and Drizzle generation scripts. Keep `expertVersionRef` separate from this catalog.
- [ ] **Step 2: RED tests:** add DB-free tests for canonical key ordering/digest stability, tenant domain separation, versioned ref format, secret/unknown-key rejection, malformed model identity rejection, transport HMAC domain separation/drift, and digest/corrupt-row rejection. Add a store test seam or injected minimal DB interface to prove insert-conflict exact comparison, tenant predicate, and fail-closed missing/corrupt reads without opening a database. Run focused tests and record expected failures.
- [ ] **Step 3: Schema/migration:** define `enterprise_model_routes` with exactly `tenant_id`, `route_ref`, `schema_version`, `agent_id`, `snapshot jsonb`, and `created_at`; primary key `(tenant_id, route_ref)`, FK only to tenant, tenant RLS, `FORCE ROW LEVEL SECURITY`, and `ob_ent_data` SELECT/INSERT-only grants. No separate duplicate fingerprint column, update/delete grant, or historical Run FK. Generate snapshot/journal via DB-free tooling; if the tooling tries to connect, stop.
- [ ] **Step 4: Pure contract:** implement strict schema-version-1 allowlist parsing, deterministic canonical serialization, tenant-separated SHA-256 route ref, and read-time digest/canonical consistency verification. Derive endpoint fingerprints with domain-separated HMAC from the existing model capability secret; never silently strip secret-like or unknown input keys.
- [ ] **Step 5: Persistence:** implement tenant-scoped `put/get` using DataDatabase transactions and `app.tenant_id`; on duplicate `(tenant_id,route_ref)`, fetch and compare every immutable field and canonical bytes, throwing stable `MODEL_ROUTE_CONFLICT` on any mismatch. Do not mutate existing rows.
- [ ] **Step 6: GREEN/static checks:** run focused DB-free tests, targeted TypeScript check for changed files, scoped Biome, schema consistency/generation check that is proven not to connect to a database, and `git diff --check`. Do not run migrations, integration suites, or database probes.
- [ ] **Step 7: Freeze/report:** save before/after manifests, task increment patch/hash, source/test hashes, exact commands/results, and explicit limitations. Independent validator/reviewer inspect this exact frozen increment; any edit invalidates affected evidence and requires rerun.

**Verification:** From repository root, run `bun test server/tests/enterprise/model-route-catalog.test.ts`; scoped `bunx biome check` on owned TypeScript; targeted `bun x tsc --noEmit` with project config if it avoids unrelated DB access; `git diff --check`; Drizzle schema generation only with a non-routable placeholder URL and after confirming it is DB-free. Expected: all focused tests pass, migration/schema/journal agree, no DB-backed check is reported as passed.

**Acceptance:** The catalog deterministically represents only the approved effective model route and reauthorized Bot identity, persists/recovers it under tenant scope, detects immutable conflicts/corruption, and preserves legacy Run history. `expertVersionRef` remains independent. T2 Run admission binding, consistent Gateway/Mastra binding, production composition, and DB runtime/RLS behavior remain incomplete and are not claimed by this task.

**Failure handling:** If route fields cannot be safely derived from existing model/runtime types, or if schema generation would connect to any DB, stop before unrelated edits, record concrete evidence, and leave the task pending rather than substituting a synthetic model route.
