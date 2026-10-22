# Fix Brief — PKG01 Review Round 1

Binding review report: independent reviewer, 2026-10-19. Fix all blocking findings in the same worktree. No commit.

## Blocking fixes

1. **HIGH — multi-version selection** (`server/src/plugin-packages/catalogue.ts` ~238-253, 281).
   - Keep every version per package key.
   - Public reads must choose among **listed** records only.
   - Prefer the newest **listed + verified** record; a newer unlisted or broken record must never hide a listed verified release.
   - If no listed verified record exists, return the newest listed record with its blockers (so unavailable is explained).
   - Direct detail lookup of an unlisted-only package returns `RESOURCE_NOT_FOUND` (public detail is listed-only).
   - Add tests: listed 1.0.0 + unlisted 2.0.0 → list/get return 1.0.0; listed 1.0.0 verified + listed 2.0.0 missing artifact → 1.0.0 served; only unlisted → list empty + detail 404.

2. **MEDIUM — walked path validation** (`server/src/plugin-packages/artifact.ts` ~161-179).
   - Apply the same POSIX path predicate (no absolute, no `.`/`..`, no backslash, no control chars, no empty segment) to **every** path returned by the directory walk, not just manifest-declared paths.
   - Add a test with a control-character filename (create it via `Buffer`/`open` if needed) and a backslash filename; both must be rejected.

3. **MEDIUM — strict query parsing** (`server/src/enterprise/plugin-packages/routes.ts` ~102-125).
   - Reject unknown query keys.
   - Validate `category` against the package-id pattern (or the shared schema's constraints).
   - Actually use `PackageListQuerySchema` after coercing `limit`; do not keep a parallel hand parser with different rules.
   - Add tests: `?foo=bar` → 400; invalid category → 400; valid query still works.

## Cheap low fixes (do them)

4. `server/src/index.ts` package-route assembly: reuse `enterpriseCapabilities.scopes` if it exists instead of constructing a third resolver; if a separate resolver is genuinely required, document why in one line. Keep the 503 fallback, but log one structured error code using the same logger style as the neighboring enterprise assembly (no bare `catch {}`).
5. Remove the unreachable `MAX_RESOURCES` guard and the always-false `existing.digest` check in `artifact.ts` (or keep only if you can point to a reachable case in a comment).
6. Version comparison (`catalogue.ts` ~73-95): compare numeric parts with `BigInt` or length+lexicographic to avoid `Number` precision loss; add a test with a >2^53 component.
7. `resources[].available`: a `managedConnector` resource cannot be resolved in PKG01. Mark it `available:false`; if `required:true`, add `RESOURCE_UNAVAILABLE` and make the package not installable. Expert template/skill resources remain `available:true` after artifact verification. Fixture (skill-only) stays installable.
8. Validate outgoing page/detail DTOs with `PackagePageSchema` / `PackageCatalogueDetailSchema` before returning (catches drift).

## Verification (fresh report dirs)

```sh
cd /Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market
E2E_UNIT_OUTPUT=.e2e/pkg01-fix bunx e2e run --config e2e.unit.config.ts server/tests/package-artifact.test.ts server/tests/package-catalogue.test.ts server/tests/package-read-routes.test.ts
bun run --filter server typecheck   # prove any remaining error is pre-existing
bunx biome check <changed files>
```

Report: findings fixed (by number), tests added, exact counts, remaining deviations. Do not commit.