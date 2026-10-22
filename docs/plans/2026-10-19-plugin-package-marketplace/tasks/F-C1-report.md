# F-C1 Report — install readiness reaches `ready` when active grants exist

## Files

- `server/src/enterprise/plugin-packages/install-service.ts` — `readinessOf` final branch + doc comment (only production change).
- `server/tests/package-install-routes.test.ts` — new native describe "package install service readiness: grants decide the final hop" (3 tests) driving the real `createPackageService` over `PackageInstallFacts` doubles + a verified release double.
- `server/tests/multitenancy/package-grants.test.ts` — 2 new driven tests in the existing group, reusing its fixtures: ready-assertion after the existing grant flow, needs_grant-assertion after the lifecycle seam revoked all grants. Probe catalogue double resolves the seeded `openbot/pkg03-package` to a verified connector-free skill release; grants come from real rows via the real restricted read channel.
- App: untouched (deliverable 3 verified — `app/tests/plugin-package-grants.test.tsx` already models `granted ? "ready" : "needs_grant"`; no test encodes never-ready).

## Branch logic (exact)

```ts
return facts.grants.length > 0 ? "ready" : "needs_grant";
```

Precedence unchanged: `status !== "enabled"` → unavailable; `!release?.verified` → unavailable; unlinked required connector → needs_connection. `installDTO` already keys the `NEEDS_GRANT` blocker off readiness, so ready ⇒ no blocker, grants emptied ⇒ blocker returns. Controller ruling satisfied: facts carry ACTIVE grants (store loads them on list `store.ts:285` and detail `store.ts:315` — verified by reading the code).

## Tests

- Native `server/tests/package-install-routes.test.ts`: 24/24 (21 pre-existing + 3 new: grants-present ready without NEEDS_GRANT on list+detail; grants emptied → needs_grant with blocker; disabled/unverified/needs_connection precedence). Evidence `.e2e/fc1-native/`.
- Driven pkg03 group (`E2E_BUN_ONLY="server/tests/multitenancy pkg03"` via `tests/bun-suites.test.ts`): e2e harness 2/2 pass (pkg03 + pkg03b rows — the filter prefix-matched both; pkg03b green unchanged). Direct `bun test` per-test: 15 pass / 0 fail / 0 skipped (13 existing + 2 new). Evidence `.e2e/fc1-driven/`.
- Regression pkg02 group: harness pass (`.e2e/fc1-driven-pkg02/`); direct run 19/19 incl. fresh-install stays `needs_grant` and connectorless stays `needs_connection`.

## Typecheck / Biome

- `bun run typecheck` (server): only the 3 pre-existing `scripts/bootstrap-local-gateway.ts` errors; nothing new.
- `bunx biome check` on the 3 touched files: clean.

## Deviations

The brief expected an existing native suite constructing `PackageInstallFacts`; none existed (grep found only DTO stubs), so the service-level describe was added to `package-install-routes.test.ts`. No commit; everything uncommitted in the worktree.
