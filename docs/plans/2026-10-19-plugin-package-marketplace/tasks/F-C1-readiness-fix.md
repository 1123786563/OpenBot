# Task Brief — F-C1 fix: install readiness must reach `ready` when active grants exist

## Context

Worktree `/Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market`, uncommitted; latest checkpoint cp08 (`59bdcc7a…`). No commit/push. Follow-up from PKG03 slice C review (ledger "PKG03 slice C" section, finding F-C1 [medium·bug-server]): `readinessOf` in `server/src/enterprise/plugin-packages/install-service.ts:128-138` never returns `ready` and always pushes `NEEDS_GRANT`, so the tag persists after an admin grants Bots. Spec `docs/specs/2026-10-19-plugin-package-marketplace-design.md` §PackagePage: "readiness 按 unavailable → needs_connection → needs_grant → ready 优先取值……ready 表示当前请求人有至少一条明确可用的包资源".

## Controller ruling (bind this)

An install is `ready` iff: status `enabled` AND release verified AND zero connector blockers AND **`facts.grants.length > 0`** (facts carry ACTIVE — never-revoked — grant facts per the store contract; list and detail paths both load them: `store.ts:285` and `store.ts:315`). Revoking the last grant returns the install to `needs_grant`. The "请求人" in the spec sentence is the scoped request context, not a Bot identity.

## Deliverables

1. **`readinessOf`** (`install-service.ts:128-138`): final branch becomes `return facts.grants.length > 0 ? "ready" : "needs_grant";`. Update the stale doc comment above it (currently claims PKG03 adds grants later — they exist since slice A).
2. **Tests**:
   - Native: extend whichever existing native suite constructs `PackageInstallFacts` (grep `grants:` in `server/tests/package-*.test.ts`; `install.integration` / `read-routes` / `install-routes`) with: grants present → list+detail DTO readiness `ready` and no `NEEDS_GRANT` blocker; grants emptied → back to `needs_grant` with the blocker; disabled/needs_connection precedence unchanged.
   - Driven (real roles, `server/tests/multitenancy/package-grants.test.ts`, group `server/tests/multitenancy pkg03`): after the existing grant flow, assert scoped list and detail readiness `ready`; after revoking all grants of the install, `needs_grant` again. Reuse the file's fixtures/patterns; no new group.
3. **UI touch, only if needed**: `app` needs NO changes — the dialog notice derives from readiness and the grants section gate is status-based. Verify no app test asserts the old never-ready behavior (grep `needs_grant` in `app/tests/`); fix assertions only if they encoded the bug.

## Constraints

- Server-only except (3). No new deps; expand-only; typecheck: only the 3 pre-existing bootstrap errors; Biome clean on touched files.
- Official evidence: fresh dirs `.e2e/fc1-native/` (native suites you touched, via `bunx e2e run --config e2e.unit.config.ts <files>`) and `.e2e/fc1-driven/` via `E2E_BUN_ONLY="server/tests/multitenancy pkg03" E2E_UNIT_OUTPUT=.e2e/fc1-driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`. All existing package suites must stay green (pkg02/pkg03/pkg03b driven groups unchanged in behavior; re-run pkg03b only if you touch shared runtime code — you should not).
- Known env facts: enterprise test DB is docker `openbot-enterprise-test-pg` (:5435, should be running; `docker start` if exited); role URLs via `enterpriseRuntimeDatabaseUrlFrom`; journal persistent (migrate reruns are up-to-date).

## Report

Files, exact branch logic, test counts (old suites green + new assertions), evidence dirs, typecheck/biome, deviations. ≤350 words. No commit.
