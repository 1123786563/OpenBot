# Task Brief — PKG03 Slice A (#462): enterprise package Bot grants

## Context

Worktree `/Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market`, branch `feat/plugin-package-market-v1`, uncommitted on cp05 (source SHA `d9c7df29…0605`). No commit/push. PKG01/PKG02 are acceptance-complete (ledger `docs/plans/2026-10-19-plugin-package-marketplace/ledger.md` — read it first). Spec §6 (grants table + branded errors), §8 (skill resources read from immutable artifact, never the global slug table), §9 (grant is scope-scoped; "安装≠授权"), §14 A02/A04.

## Goal (slice A only — no Run pins, no runtime read path, no dialog flow)

A company `tenant_admin` can grant an installed package's **skill resources** (not connector tools) to a specific Bot of the same tenant/workspace. Grant state is visible on install detail; revocation bumps grant revision; install uninstall/disable revokes grants (hook the lifecycle hook point if it already exists, else leave a clearly-marked seam function).

## Deliverables

1. **Table** `enterprise_package_grants` (per spec §6): PK `(tenant_id, install_id, generation, bot_id, resource_id)`; columns `tool_ref text NOT NULL DEFAULT ''` (empty for skill rows — DB CHECK `tool_ref = ''` for kind skill rows; connector tool rows must have non-empty `tool_ref`), `granted_by`, `granted_at`, `revoked_at`; compound FK `(tenant_id, workspace_id, install_id)` → installs; FK `(tenant_id, bot_id)` → the Bot ownership table used by `enterprise/tenancy` bots-ownership (verify exact table/columns in `server/src/db/schema/enterprise-bot-ownership.ts`; Bot must belong to the same tenant AND be registered to the same workspace — read that module first and mirror its constraints); RLS identical shape to installs (data read tenant+workspace arm, operator full, FORCE, app-tenant scoped); add to the **PKG03 MT task** in `server/scripts/multitenancy/migrate-test.ts` (new task id `PKG03`, expand-only, after PKG02) — same DDL style, no production migration.
2. **Grants module** `server/src/enterprise/plugin-packages/grants.ts` (mirror `install-service.ts` patterns): `setBotGrant(scope, admin, input)` and `revokeBotGrant(scope, admin, input)` using `createPackageMutationStore` transactions + branded `packageError`; inputs validated with strict shared Zod (`shared/enterprise/plugin-package-contracts.ts` — add `PackageGrantInput`/`PackageGrantDTO` per spec §7.1: installId, botId, expectedGrantRevision nullable, resources[] with resourceId + kind=='skill'); validates: install exists in scope and status enabled; resource ids exist in the install's current revision **skill** resources only; Bot ownership via the tenancy bots-ownership authority (same tenant/workspace); grant revision = count of distinct generations for (install,bot) after write; write `enterprise_package_changes` row (`action: 'grant'|'revoke'`, redacted diff, idempotency key from header semantics identical to apply).
3. **Routes** on the existing package router: `PUT /installs/:id/bots/:botId/grants` (admin authorizer + `assertClassifiedCompanyEntrance`, register in admin-separation like the plans routes) and `DELETE` same path; mount + `index.ts` wiring identical to PKG02.
4. **Install detail/list** surface grants: extend install read (`store.ts` read side) with `grants: PackageGrantDTO[]` (active only, i.e. `revoked_at IS NULL`); DTO updated in shared contracts.
5. **Tests** (all must run, none skipped):
   - Native: extend `server/tests/package-install-routes.test.ts` style file `server/tests/package-grants-routes.test.ts` — 400/401/403/404 mapping, admin-only, skill-only enforcement (connector resource → 422 `PACKAGE_UNSUPPORTED`… use a new code `RESOURCE_KIND_UNSUPPORTED` if clearer — declare it in shared enum), unknown/cross-scope bot → 404 same-shape.
   - Driven (real roles, `server/tests/multitenancy/package-grants.test.ts`, register in the `server/tests/multitenancy pkg02`-style explicit group `server/tests/multitenancy pkg03` + EXPLICIT_GROUPS in `scripts/lib/e2e-manifest.mjs`): cross-tenant bot refused; bot in different workspace refused; unknown resource refused; grant→detail shows grant; revoke→detail hides; grant revision monotonic; uninstalled install refuses new grants; forged PackageWriteTx refused; grant rows invisible to data role of another tenant.
   - Run MT031→PKG02→PKG03 sequence via the same dry-run→manifest→apply recipe as PKG02 tests.

## Constraints

- No new npm deps; no production migration; `enterprise_package_changes` gets `tool_ref`-safe redacted diff (no secrets by construction).
- Legacy `plugin_grants` stays untouched and is never consulted (spec: no OR-fallback).
- `bun run --filter server typecheck` must stay at the 3 pre-existing bootstrap errors only; Biome clean on touched files; server tests run with `bun test ./server/tests/...` for targeted RED/GREEN, official evidence via `E2E_BUN_ONLY="server/tests/multitenancy pkg03" E2E_UNIT_OUTPUT=.e2e/pkg03a-driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`.
- Docker container `openbot-enterprise-test-pg` must be Up (it is); MT apply through `resolveTestDatabaseTarget` recipe.

## Report

Files, DDL/task id, test counts per suite (exact), typecheck/biome status, deviations, blockers. ≤400 words. No commit.
