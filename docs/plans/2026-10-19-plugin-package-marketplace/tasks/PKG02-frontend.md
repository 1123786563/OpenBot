# Task Brief — PKG02 Frontend (#461)

## Context

- Backend wire contract is implemented:
  - `GET /api/enterprise/plugin-packages` items now include `install: PackageInstallDTO | null`.
  - `GET /api/enterprise/plugin-packages/installs/:id` → install detail with resources.
  - `POST /api/enterprise/plugin-packages/plans` (company admin) → `PackagePlanDTO`.
  - `POST /api/enterprise/plugin-packages/plans/:id/apply` header `Idempotency-Key` → 201 first / 200 replay, body `PackageInstallDTO`.
- Types: `shared/enterprise/plugin-package-contracts.ts` (read the exact fields; `.strict()` everywhere).
- Worktree `/Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market`. No commit/push.

## Goal

Company administrators can preview an install (exact version/digest/team/resources/connection and permission needs) and confirm it; members see the real install state (`needs_grant`), and the UI never implies installation grants Bot execution rights.

## Owned files

- `app/src/lib/plugin-packages/mutations.ts` (new)
- `app/src/components/market/package-install-dialog.tsx` (new)
- `app/src/components/market/package-pane.tsx`, `package-detail.tsx` (modify: install state/action)
- `app/src/lib/plugin-packages/queries.ts` (types for install)
- `app/src/routes/_authed/admin/market.tsx` (only if a prop wiring change is needed)
- `app/src/locales/{zh-CN,en}/market.json`
- `app/tests/plugin-package-install.test.tsx` (new)

## Requirements

1. **Admin-only affordance, server-authoritative**: show the install/preview action only when `allowedActions`/role says so; even when hidden, the server rejects. Non-admin package detail shows install state read-only.
2. **Preview dialog**:
   - Shows exact packageKey, version, artifact digest, current team, resource list, added tools with read/write effect, blockers (needs connection), 10-minute expiry.
   - Config fields: only flat non-secret strings/numbers/booleans; never a token/password field.
   - Preview failure keeps non-secret input and allows retrying the plan.
   - Closing/switching scope discards the pending plan (clear planId + input; no confirmation of a stale plan).
3. **Confirm**:
   - Generates one `Idempotency-Key` per confirm attempt; repeated clicks while pending are disabled and must not send a second apply.
   - First success (201) or replay (200) updates caches and shows the installed `needs_grant` state.
   - 409 revision/idempotency conflict, 410 expired plan, 403 refusal: show a localized actionable message; an expired plan returns the user to preview without losing non-secret config.
   - After success, invalidate the package list/detail keys for the same scope.
4. **Installed state**: cards/detail show version, revision, status, readiness (`ready|needs_connection|needs_grant|unavailable`) and blockers. `needs_grant` must say that installation does not grant Bot execution.
5. **Scope isolation**: a scope switch remounts/clears pending plan and caches; a late apply response from team A must not write into team B's cache (use the captured scope key/plan).
6. **i18n**: all new strings zh-CN + en; keyboard accessible dialog; buttons disabled while pending.
7. Tests (native, `tests/support/e2e-compat`, fetch stub):
   - admin preview renders exact version/digest/team/resources and sends POST /plans;
   - non-admin has no install action;
   - confirm sends exactly one apply with an `Idempotency-Key` and shows `needs_grant` on 201;
   - double click while pending sends one request;
   - 410 expired plan returns to preview with config preserved;
   - scope switch clears a pending plan and a late response does not pollute the new scope;
   - list shows installed state.
   At least 7 meaningful tests.

## Verification

```sh
bunx e2e run --config e2e.unit.config.ts app/tests/plugin-package-install.test.tsx
bunx e2e run --config e2e.unit.config.ts app/tests/plugin-package-catalogue.test.tsx
bun run --filter app typecheck
bunx biome check <changed files>
```

Report: files, test counts, commands, deviations/blockers. Under 350 words.