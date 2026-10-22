# PKG03 Slice C (#462 frontend) — Implementation Report

Status: DONE (app-only; no server file touched; nothing committed).

## Files changed

- `app/src/lib/plugin-packages/queries.ts` — stale :17 comment corrected (installs/plans live in mutations.ts since PKG02); new `pluginPackageKeys.installDetail(scope, installId)` = `[...scopeKey(scope), "install", installId]` (scope triple = tenantId/workspaceId/principalId, already the existing mechanism — verified, then followed); new `pluginPackageInstallDetailQueryOptions` (GET, scope headers only).
- `app/src/lib/plugin-packages/mutations.ts` — `usePackageGrant(queryClient)` (PUT) and `usePackageGrantRevoke(queryClient)` (DELETE); scope captured per call as headers; one `Idempotency-Key` per attempt; body exactly per `PackageGrantInputSchema` / `PackageGrantRevokeBodySchema`; success invalidates exactly `installDetail(scope, installId)`.
- `app/src/components/market/package-grants.tsx` (new) — grants section: per-Bot rows (bot, resources, revision), grant form (Bot ID input + current-revision skill-resource checkboxes + submit), revoke per row; serverMessage pattern (server sentence wins; 403/409 localized); submit disabled while pending or with zero resources/no Bot.
- `app/src/components/market/package-detail.tsx` — section rendered for `canInstall && install && install.status !== "uninstalled"`.
- `app/src/locales/{en,zh-CN}/market.json` — new `packages.grants.*` keys, same languages as `packages.install.grantNotice`. Copy states installing alone grants nothing; a grant authorizes pinned skill use in runs.
- `app/tests/plugin-package-grants.test.tsx` (new) — native tier.

## Endpoints exercised (client-side only)

GET/PUT/DELETE `/api/enterprise/plugin-packages/installs/:installId[/bots/:botId/grants]` — contract mirrored from `server/tests/package-grants-routes.test.ts`; PUT body carries `expectedGrantRevision: null` (first grant) or the revision read from the detail DTO (CAS); DELETE sends `{expectedGrantRevision}`.

## Ruling applied (deviation flagged)

Server `allowedActions` is always `[]` (`install-service.ts:163`), and the routes test's fixture proves no grant action value — so the ruling's fallback applies. Readiness never carries `"uninstalled"` (that is a status value), so the gate is `install.status !== "uninstalled"`; flagged as the brief's deviation.

## Tests & evidence

- New: 6/6 pass (PUT scope headers + exact body; notice clears via invalidated refetch; DELETE with CAS revision; scope-key value assertions + mid-flight scope-switch pollution check; disabled-submit pending/zero-selection; member sees nothing).
- Combined package suites: **42/42** (grants 6 + packages-page 4 + install 17 + catalogue 15). Evidence: `E2E_UNIT_OUTPUT=.e2e/pkg03c/final bunx e2e run --config e2e.unit.config.ts <4 files>` — report.json `status: passed, exitCode: 0`.

## Verification tails

- `cd app && bun run typecheck` → `tsc --noEmit`, exit 0.
- `bunx biome check <7 touched files>` → "Checked 7 files … No fixes applied."

## Notes for review

1. Server `readinessOf` never leaves `needs_grant` (ignores grants), so in production the list-level "Needs Bot grant" tag persists after granting; the slice's clearing notice is the section's grants-derived empty notice (server-owned gap, not worked around).
2. Parked slice-A low manifests here: a fully-revoked Bot's row disappears (detail drops it) and the empty notice returns — the UI cannot show that a grant ever existed; audit lives only in `enterprise_package_changes`.
3. Grant form pre-selects a named Bot's active grant resources (PUT supersedes the whole set) to prevent revocation-by-omission; Bot is a free-text ID (no bot-roster read on this surface; identical 404 for unknown/cross-team bots is proven server-side).
4. Grant writes do not refetch the shelf list (brief: invalidate exactly the install-detail key).
5. Browser acceptance of the page remains a controller step per plan.
