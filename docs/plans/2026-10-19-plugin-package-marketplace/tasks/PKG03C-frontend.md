# Task Brief — PKG03 Slice C (#462): Bot grant management UI (Bot 授权页面)

## Context

Worktree `/Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market`, branch `feat/plugin-package-market-v1`, uncommitted; latest checkpoint cp07 (`56dde21a…`). No commit/push. Slices A (grants backend) and B (run pins) are reviewed PASS — read `docs/plans/2026-10-19-plugin-package-marketplace/ledger.md` entries "PKG03 slice A" and "slice B" first. This slice closes #462's remaining frontend deliverable: the **Bot authorization page** surface. Discovery: it does NOT exist yet — `app/src/components/market/skills-pane.tsx` grant counts are the LEGACY per-skill grants, and `app/src/lib/plugin-packages/queries.ts:17` still says installs/plans/grants are "other tickets" (stale for installs/plans since PKG02).

## Goal (slice C)

A deployment admin can, per installed package, see which Bots hold which skill-resource grants, GRANT skill resources to a Bot, and REVOKE them — with scope-safe caching (no cross-scope pollution).

## Interfaces you consume (read these; they are the contract)

- API contract source of truth: `server/tests/package-grants-routes.test.ts` (19 tests) — PUT and DELETE on `/api/enterprise/plugin-packages/installs/:installId/bots/:botId/grants`; admin-only; skill resources only.
- Wire schemas: `shared/enterprise/plugin-package-contracts.ts` — `PackageGrantInputSchema` (:439, `resources` array min 1 max 256), `PackageGrantRevokeBodySchema` (:452), `PackageGrantDTO` (:470), install detail DTO carries `grants: PackageGrantDTO[]` and `allowedActions` (:493-513). Scope and actor never travel on the wire (server derives from trusted headers via `use-package-scope.ts` → client header normalization in `app/src/lib/client.ts`).
- Existing patterns to mirror: `app/src/lib/plugin-packages/mutations.ts` (mutation + invalidation shape), `app/src/components/market/package-detail.tsx` (detail rendering, `needs_grant` notice :166-204), `app/tests/packages-page.test.tsx` (harness test pattern incl. `/api/me` stub `{user:{...,onboarding:null}}`, workspace-scope `memberEpoch`+`teams`).

## Deliverables (priority order; keep the tree compiling and existing tests green at each completed step)

1. **Queries**: correct the stale comment at `queries.ts:17`; ensure the install-detail query key carries tenant/workspace/principal (follow the existing scope-key mechanism in `app/src/lib/plugin-packages/use-package-scope.ts` — if it already does, verify and note it).
2. **Mutations**: `usePackageGrant` (PUT body `{resources:[{kind:"skill",id}...]}` per `PackageGrantInputSchema`) and `usePackageGrantRevoke` (DELETE, optional body per `PackageGrantRevokeBodySchema`); on success invalidate exactly the affected install-detail key; surface server errors via the established `serverMessage` pattern (PKG01 fix).
3. **UI**: a grants section in the admin package detail (`package-detail.tsx`) rendered only when `allowedActions` includes the grant action: per-Bot rows from `install.grants` (Bot, resources, grantRevision), a grant flow (pick Bot + one or more skill resources of the CURRENT revision), and revoke. Copy must not imply install grants execution by itself: installing alone grants nothing; a grant authorizes pinned skill use in runs. New copy goes through the existing i18n mechanism (`packages.*` keys).
4. **Tests** (extend `app/tests/packages-page.test.tsx` or a sibling file, native tier): grant PUT called with scope headers and correct body; revoke called; after grant success the needs_grant notice clears (readiness transition via invalidated refetch); a scope switch mid-flight does not write a stale response into the new scope's cache (query-key assertion).

## Constraints

- No new npm deps. Admin-only surface (the market route already gates role — do not add a second gate).
- Never send tenant/workspace/principal in a body — headers only. Client input never picks scope.
- App typecheck exit 0; Biome clean on touched files; official evidence: `bunx e2e run --config e2e.unit.config.ts <test files>` fresh report dir under `.e2e/pkg03c/`.
- Do not touch server code except nothing — this slice is app-only. If you find a server contract gap, STOP and report it instead of working around it.

## Report

Files, endpoints exercised, test counts (pass/fail), typecheck/biome output tails, deviations, remaining state if capped. ≤450 words. No commit.
