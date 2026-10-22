# Task Brief — PKG01 Frontend (#460)

## Context

- Parent spec §11 (Web interaction), §7 (DTO), §14 A11.
- Issue `docs/tickets/plugin-package-marketplace/issues/PKG01.md`.
- Backend wire contract is already implemented in `shared/enterprise/plugin-package-contracts.ts` and exposed at:
  - `GET /api/enterprise/plugin-packages` (query: search, category, cursor, limit)
  - `GET /api/enterprise/plugin-packages/catalogue/:publisher/:name`
- Worktree `/Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market`, branch `feat/plugin-package-market-v1`. No commit/push.

## Goal

Add a read-only "插件包" (packages) view to the existing `/admin/market` page: list, search, category filter, pagination, package detail with resources and unavailable reasons. No install action in this ticket.

## Owned files

- `app/src/lib/plugin-packages/queries.ts` (new)
- `app/src/components/market/package-pane.tsx` (new)
- `app/src/components/market/package-detail.tsx` (new)
- `app/src/routes/_authed/admin/market.tsx` (modify: add tab only)
- `app/src/locales/zh-CN/market.json`, `app/src/locales/en/market.json` (add keys)
- `app/tests/plugin-package-catalogue.test.tsx` (new)

## Requirements

1. Read the existing scope selection source before coding: `app/src/lib/enterprise/tenant/selection.ts`, `app/src/lib/enterprise/tenant/queries.ts`, and how the market route currently gets current user. The package query MUST be scoped to the current `tenantId` + `workspaceId` + `principalId` (user id). When no team/workspace is selected, show a clear "select a team first" empty state and do not fetch.
2. Use the existing `client` wrapper (`app/src/lib/client.ts`) and pass `tenantId`, `workspaceId`, `signal`, `fallbackKey`. Never hand-roll scope headers.
3. Query key: `["plugin-packages", tenantId, workspaceId, principalId, "list", {search, category, cursor}]`; detail key includes publisher + name. A scope switch must produce a new key and must not reuse the previous team's data.
4. UI:
   - Add a fourth tab `packages` to `market.tsx` alongside experts/skills/connectors.
   - Package pane: local search input (debounced or submit), category chips, list of cards showing displayName, packageKey, version, summary, and unavailable blockers.
   - Pagination via `nextCursor` ("load more").
   - Detail dialog: publisher/name/version/digest, resource list with kind + available, blockers with human-readable localized reason.
   - Loading skeleton, error state with retry, empty state.
   - Follow existing market visual primitives (`components/market/wb.tsx`) and dialog patterns.
5. i18n: every new string in both `zh-CN` and `en` market namespaces. No hard-coded Chinese/English in components.
6. Tests (`app/tests/plugin-package-catalogue.test.tsx`, native via `tests/support/e2e-compat`, follow `app/tests/plugin-read-failure.test.tsx`):
   - list renders real package name/version and resources;
   - unavailable package shows a localized blocker reason;
   - scope switch issues a new request with the new tenant/workspace headers (fetch stub captures headers) and does not show old data;
   - empty/error states;
   - detail fetch happy path.
   At least 5 meaningful tests.
7. Accessibility: tab is keyboard reachable, dialog title/description present, search has an aria-label.

## Non-goals

- No install/preview/grant buttons or mutations.
- Do not modify backend files.

## Verification

```sh
cd /Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market
bunx e2e run --config e2e.unit.config.ts app/tests/plugin-package-catalogue.test.tsx
bun run --filter app typecheck
bunx biome check app/src/lib/plugin-packages app/src/components/market/package-pane.tsx app/src/components/market/package-detail.tsx app/src/routes/_authed/admin/market.tsx app/tests/plugin-package-catalogue.test.tsx
```

Report: files, test count, command output, deviations/blockers. Do not commit.
