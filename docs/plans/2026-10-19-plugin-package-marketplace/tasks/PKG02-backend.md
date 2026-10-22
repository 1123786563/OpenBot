# Task Brief — PKG02 Backend (#461)

## Context

- Issue: `docs/tickets/plugin-package-marketplace/issues/PKG02.md`.
- Spec: §6 (tables/authority/RLS), §7 (HTTP/DTO), §7.1 (types), §8 (plan/apply transaction), §14 (A02/A03/A04/A12).
- PKG01 is verified in this worktree: immutable artifacts/catalogue, read routes, shared contracts.
- External #74 (MT031 enterprise connector install/decision) is CLOSED and implemented at `server/src/enterprise/tenancy/plugin-catalog.ts`; reuse it as the connector authority. Do not build a parallel connector install table.
- No commit/push. Worktree `/Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market`, branch `feat/plugin-package-market-v1`.

## Scope (PKG02 only)

Minimal tenant/workspace install storage, revisions, plans, resource links, change receipts; install preview/apply API; installed facts merged into list/detail. Do NOT implement Bot grants (PKG03), expert creation (PKG04), tool dispatch (PKG05), upgrade/rollback (PKG06), disable/uninstall (PKG07), release withdrawal (PKG08), or migration/gray switch (PKG11). Plan operations other than `install` may parse but must answer `PACKAGE_UNSUPPORTED` until their ticket.

## Phase A — storage + migration + real restricted-role tests

Create `server/src/db/schema/enterprise-plugin-packages.ts` (typed schema, query-visible; follow the MT031 out-of-band migration track — do NOT rely on `drizzle-kit generate` because snapshots are stale) and a new MT task `PKG02` in `server/scripts/multitenancy/migrate-test.ts`.

Tables (all tenant-scoped; add `workspace_id` where the spec says so):

1. `enterprise_package_installs`
   - PK `(tenant_id, id)`; unique `(tenant_id, workspace_id, package_key)`.
   - columns: `id`, `package_key`, `current_version`, `status` (`enabled|disabled|uninstalled`), `generation` int >0, `revision` int >0, `installed_by`, timestamps.
   - compound FKs to tenant, workspace, and membership `(tenant_id, installed_by)`.
2. `enterprise_package_revisions`
   - PK `(tenant_id, install_id, revision)`; FK to install cascade.
   - columns: `release_version`, `artifact_digest`, `config` jsonb (closed, non-secret), `created_by`, `created_at`.
3. `enterprise_package_plans`
   - PK `(tenant_id, id)`; columns: `workspace_id`, `actor_id`, `principal_id`, `operation`, `package_key`, `version`, `artifact_digest`, `expected_revision` (nullable), `canonical_input` jsonb, `input_digest`, `preview` jsonb, `expires_at`, `consumed_at`, `result` jsonb, `created_at`.
   - CHECK expected_revision is null or >0; actor/principal non-empty.
4. `enterprise_package_resource_links`
   - PK `(tenant_id, install_id, revision, resource_id)`; columns: `workspace_id`, `kind`, `existing_skill_id` (nullable), `connector_install_id` (nullable), `expert_template_ref` (nullable).
   - CHECK kind-specific mutual exclusivity: for PKG02 skill rows leave all three null; a connector row must have `connector_install_id`; expert row `expert_template_ref`; never two non-null.
   - `connector_install_id` compound FK `(tenant_id, workspace_id, connector_install_id)` -> `enterprise_plugin_installs(tenant_id, workspace_id, id)` (verify the exact unique key; add one if missing).
5. `enterprise_package_changes`
   - PK `(tenant_id, change_id)`; columns `workspace_id`, `install_id`, `revision`, `actor_id`, `action`, `diff` jsonb (redacted), `created_at`, `idempotency_key`, `request_digest`, `result_json`.
   - partial unique `(tenant_id, workspace_id, actor_id, idempotency_key) WHERE idempotency_key <> ''`.

RLS:
- `enable row level security` + `force row level security` in the MT DDL; `REVOKE ALL` from PUBLIC; grant only the needed verbs.
- Data role (`ob_ent_data`): SELECT only, tenant arm using `app.tenant_id` and (where applicable) `app.workspace_id`.
- Operator role (`ob_ent_operator`): INSERT/UPDATE/DELETE on installs/revisions/plans/links/changes, plus SELECT.
- No data-role writes. No operator delete of revisions/links/changes (append-only), except none needed.
- Add indexes for `(tenant_id, workspace_id, package_key)`, `(tenant_id, install_id, revision)`, `(tenant_id, expires_at)`, and change idempotency lookup.

Write `server/tests/multitenancy/package-storage.test.ts` (Bun-driven; follow `server/tests/multitenancy/plugin-install.test.ts`):
- Apply the `PKG02` MT task via dry-run → manifest → apply (accept `applied`/`up-to-date`).
- Use the real restricted roles from `ENTERPRISE_TEST_*`.
- Prove: cross-tenant/workspace FK rejection; data role cannot INSERT/UPDATE/DELETE; operator can; RLS hides other tenant/workspace rows; transaction-local `app.*` settings are cleared after commit/rollback; a member revoked after open cannot continue writing through the mutation transaction.
- If any required env var is missing, the suite must be explicitly `blocked` (skip with a named reason), never a pass.

## Phase B — mutation service, plan/apply, read facts, HTTP

Create:
- `server/src/enterprise/plugin-packages/{contracts,store,mutation-context,plans,install-service}.ts`.
- Extend `shared/enterprise/plugin-package-contracts.ts` with `PackagePlanInput`, `PackagePlanDTO`, `PackageInstallDTO`, `PackageInstallDetailDTO`, `PackageStatusInput` placeholder only if genuinely needed (PKG07 owns status), and closed error codes.
- Extend `server/src/enterprise/plugin-packages/routes.ts` (or add `install-routes.ts`) and mount at the same base.

Interfaces:
```ts
createPackageReadStore(data: DataDatabase): PackageReadStore
createPackageMutationStore(operator: OperatorDatabase): PackageMutationStore
// mutation.transaction(scope, admin, fn) revalidates admin + company/team membership
// inside one operator transaction; PackageWriteTx is only issued here.
createPackageService({ catalogue, readStore, mutation, now? }): PackageService
```

Plan (`POST /api/enterprise/plugin-packages/plans`):
- Auth: signed-in + selected scope; admin authorizer (PKG02 requires `tenant_admin` to create/apply install plans? Acceptance only says only tenant_admin can apply; preview may be admin-only too per spec §7 "tenant_admin 可安装/升级"; treat plan as company management write and require `CompanyAdminContext` for both plan and apply).
- Input: `operation:"install"`, `packageKey`, exact `version`, `expectedRevision:null` (non-null → `REVISION_CONFLICT` until PKG06), `config` (≤32 flat non-secret fields), `connectorInstalls` (resourceId→installId; validate each referenced connector install exists in the same tenant/workspace via the #74 table; do not resolve connections).
- Strict Zod; reject scope/actor/principal/secret/version-range fields.
- No vendor call (add a spy/probe assertion in tests).
- Resolve the exact catalogue entry + artifact digest; reject unknown/unlisted/unavailable artifact (`PACKAGE_UNSUPPORTED`/`RESOURCE_NOT_FOUND`).
- Preview: resources, addedTools from connector tool declarations, removedTools `[]`, blockers (`NEEDS_CONNECTION` if a required connector has no mapping; `NEEDS_GRANT` informational is not a plan blocker), `expiresAt = now + 10 min`.
- Persist plan with canonical input JSON + SHA-256 digest. Return `PackagePlanDTO`.

Apply (`POST /api/enterprise/plugin-packages/plans/:id/apply`, header `Idempotency-Key` 1–128 ASCII):
- Verify the immutable artifact OUTSIDE the transaction first; then open the mutation transaction.
- Lock order: tenant → principal → membership → workspace-membership → package release/key → install → plan. Use `pg_advisory_xact_lock(hashtextextended(key,0))`, same style as the repo; no network waits while locked.
- Revalidate admin/epoch/membership, plan belongs to the same tenant/workspace/actor, not expired (unless replay), artifact digest still matches, package still listed/available, `expectedRevision` still matches.
- Idempotency: same key + same request digest → return the stored result (even after expiry, 200); same key + different digest → 409 `IDEMPOTENCY_CONFLICT`; a consumed plan replayed with a different key returns the original result and records the new key.
- Unique `(tenant, workspace, package_key)` guarantees one install under concurrent different plans; if an existing install conflicts with the requested config/digest, return 409 `REVISION_CONFLICT` rather than overwriting.
- Write install (revision 1, generation 1, status enabled), revision, resource links, change event, then mark the plan consumed — one transaction.
- Result: `PackageInstallDTO` with `readiness:"needs_grant"`, blockers, `allowedActions: []` (later tickets add actions).
- First apply → 201; replay → 200.

Reads:
- `GET /api/enterprise/plugin-packages` now merges the current scope's install into each catalogue item (`install: PackageInstallDTO | null`), using the trusted scope. No install facts from other teams.
- `GET /api/enterprise/plugin-packages/installs/:id` → `PackageInstallDetailDTO` with resources linked to that install revision; cross-scope/unknown → 404 same shape.
- Read routes use the verified `DataDatabase`; RLS + scope settings; never operator fallback.

HTTP errors: 401 `AUTH_REQUIRED`; 400 `INPUT_INVALID`/`SCOPE_REQUIRED`; 403 `TENANT_FORBIDDEN`/`TENANT_ADMIN_REQUIRED`; 404 `RESOURCE_NOT_FOUND` for unknown AND cross-scope; 409 `REVISION_CONFLICT`/`IDEMPOTENCY_CONFLICT`; 410 `PLAN_EXPIRED`; 422 `PACKAGE_UNSUPPORTED`; 503 `ADMIN_CHANNEL_UNAVAILABLE`/`PACKAGE_STORAGE_UNAVAILABLE`. Unknown IDs must not leak existence.

Assembly:
- In `server/src/index.ts`, obtain the operator channel with `verifyOperatorDatabase`; if absent, admin routes answer 503 while browse still works.
- Construct the admin authorizer with `createCompanyAdminAuthorizer` (same pattern as workspace-scope routes).
- Pass the package admin routes through the same `coworker` seam; mount under the existing base.
- Register the new write paths in `admin-separation.ts` company management plane rules (exact method+path). Platform admin must not gain company authority.

## Tests

1. `server/tests/multitenancy/package-storage.test.ts` (real DB, Bun-driven).
2. `server/tests/package-install.integration.test.ts` (real DB, Bun-driven):
   - two teams and two companies install the same package independently; config/grants/links do not cross;
   - concurrent same plan apply → one install; replay returns the same result;
   - different plans same package → one install or 409, never two rows;
   - same idempotency key different body → 409; expired plan with the same key → original result; expired plan with a new key → 410;
   - expectedRevision null on first, mismatch → 409;
   - withdrawn/unlisted/digest-mismatch plan/apply → refused;
   - cross-scope install/plan ID → 404;
   - install alone creates no Bot grant/connector access (query counts), `needs_grant` visible;
   - membership revoked between plan and apply → refused;
   - no vendor/transport call (spy count 0).
3. `server/tests/package-install-routes.test.ts` (native, injected deps):
   - 401/403/400/404/409/410/422/503; admin-only; platform admin without company context refused; idempotency header validation; forged scope ignored/rejected; secret-looking config rejected with no echo.
4. Register both Bun-driven files in `docs/verification/e2e-bun-suites.json` under the existing `server/tests` group (or the correct group) so `E2E_BUN_ONLY=server/tests` executes them. Do not hand-edit a false group name; read `tests/bun-suites.test.ts` semantics.

## Verification commands

```sh
cd /Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market
E2E_UNIT_OUTPUT=.e2e/pkg02-native bunx e2e run --config e2e.unit.config.ts server/tests/package-install-routes.test.ts
E2E_BUN_ONLY=server/tests E2E_UNIT_OUTPUT=.e2e/pkg02-driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
bun run --filter server typecheck   # prove remaining errors are pre-existing
bunx biome check <changed files>
```

Rules: >0 tests; no skipped DB suite counted as pass; real restricted roles required for the DB suites. If roles are missing, report `blocked` with the exact env evidence.

Report: tables/DDL, migration task id, routes, tests counts, reports, deviations/blockers. Under 600 words.