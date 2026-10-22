# Task Brief — PKG01 Backend (#460)

## Context

- Parent spec: `docs/specs/2026-10-19-plugin-package-marketplace-design.md` §5 (artifact format, limits, digest), §7 (HTTP/DTO), §14 A01/A12.
- Issue: `docs/tickets/plugin-package-marketplace/issues/PKG01.md`.
- Worktree: `/Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market` (branch `feat/plugin-package-market-v1`, BASE `9057aeeb`).
- No commit/push. Leave all work uncommitted.
- Read `AGENTS.md` and ADR 0008 before running tests.

## Owned files (create unless noted)

- `shared/enterprise/plugin-package-contracts.ts`
- `server/src/plugin-packages/manifest.ts`
- `server/src/plugin-packages/artifact.ts`
- `server/src/plugin-packages/catalogue.ts`
- `scripts/plugin-packages/build.ts`
- `plugins/marketplace.json`
- `plugins/packages/openbot/demo-skill/openbot.plugin.json`
- `plugins/packages/openbot/demo-skill/skills/summarize/SKILL.md`
- `plugins/packages/openbot/demo-skill/README.md`
- `server/tests/package-artifact.test.ts`
- `server/tests/package-catalogue.test.ts`
- `server/tests/package-read-routes.test.ts`
- Modify: `server/src/config.ts`, `server/src/index.ts`, `server/src/app.ts` (only the minimum assembly + mount points).

## Wire contract (shared file)

Define strict Zod schemas and types:

```ts
type PackageManifestV1 = {
  schemaVersion: 1; platformApi: 1;
  publisher: string; name: string; version: string;
  display: { name: string; summary: string; icon?: string };
  resources: Array<
    | { kind: "skill"; id: string; path: string }
    | { kind: "expertTemplate"; id: string; path: string; skills: string[] }
    | { kind: "managedConnector"; id: string; catalogKey: string; required: boolean;
        tools: Array<{ name: string; effect: "read" | "write" }> }
  >;
  dependencies: [];
};
type MarketplaceV1 = {
  schemaVersion: 1;
  packages: Array<{ packageKey: string; version: string; artifactDigest: string;
                    category: string; listed: boolean }>;
};
type PackageListQuery = { search?: string; category?: string; cursor?: string; limit?: number };
type PackageResourceSummary = { id: string; kind: "skill" | "expertTemplate" | "managedConnector"; available: boolean };
type PackageBlocker = { code: PackageBlockerCode; resourceId?: string };
type PackagePageItem = {
  packageKey: string; version: string; displayName: string; summary: string; category: string;
  install: null; installable: boolean; blockers: PackageBlocker[];
};
type PackagePage = { items: PackagePageItem[]; nextCursor: string | null };
type PackageCatalogueDetail = {
  packageKey: string; version: string; artifactDigest: string; displayName: string; summary: string;
  category: string; publisher: string; name: string; resources: PackageResourceSummary[];
  installable: boolean; blockers: PackageBlocker[];
};
```

Closed blocker codes (at least): `ARTIFACT_MISSING`, `ARTIFACT_INVALID`, `PACKAGE_UNLISTED`, `PACKAGE_UNSUPPORTED`, `RESOURCE_UNAVAILABLE`.

## Required behavior

### Manifest (`manifest.ts`)
- `parsePackageManifest(input: unknown): PackageManifestV1`, Zod `.strict()` at every object.
- Reject: unknown schemaVersion/platformApi; duplicate resource IDs; unknown fields; non-empty `dependencies`; bad IDs; bad version.
- IDs `publisher`, `name`, resource `id`: `^[a-z0-9]+(?:-[a-z0-9]+)*$`, max 64.
- Version: exactly three non-negative integers, no leading zeros (`0` allowed).
- `expertTemplate.skills` must reference existing `skill` resource IDs.
- `managedConnector` has no URL/endpoint/auth field (strict schema rejects them).
- `display.name` ≤120, `display.summary` ≤500.

### Artifact (`artifact.ts`)
- `buildArtifact(root: string): Promise<VerifiedArtifact>`:
  - `manifest` must be at `openbot.plugin.json`, parse via manifest parser.
  - limits: manifest ≤64 KiB; ≤256 resources; total files ≤512; total bytes ≤16 MiB; every text file ≤1 MiB; each resource path must exist and be a regular file.
  - path rules: POSIX relative, no absolute path, no empty segment, no `.`/`..`, no `\`, no control chars; reject symlinks (lstat), devices/fifos; reject case-folding path collisions.
  - assets (`display.icon` and any `.png`/`.webp` outside text resources) must be PNG/WebP by magic bytes.
  - read each file once into a bounded Buffer via `lstat` + `open`/`readFile`, verify the path stays under root via `realpath`, then compute hashes from that same buffer. Never re-read after verification.
  - digest: for every regular file in the package (including manifest, README, assets), compute SHA-256; sort by UTF-8 bytes of canonical relative POSIX path; `entries = [[path, bytes, sha256hex], ...]`; `digest = sha256("openbot:plugin-package:v1\0" + JSON.stringify(entries))` (compact JSON).
  - return `{ manifest, files: [{path, bytes, sha256}], digest, root }`.
- `loadArtifact(root: string, digest: string): Promise<VerifiedArtifact>`:
  - read from `<root>/sha256/<digest>/`, verify computed digest equals requested; throw on mismatch.
- Atomic write: `storeArtifact(artifact, destRoot)` writes to a temp dir then `rename` to `<destRoot>/sha256/<digest>/`; if target exists, verify and reuse; never partially expose.
- Same files in different traversal order must yield the same digest.
- Same publisher/name/version with a different digest must be rejected at registration/index validation.

### Catalogue (`catalogue.ts`)
- `loadPackageCatalogue({ index, artifactRoot }): Promise<PackageCatalogue>`.
- Validate index with strict Zod; reject duplicate `(packageKey, version)` with differing digest; reject duplicate exact entries.
- For each entry, attempt `loadArtifact`; if missing/invalid, include it in the catalogue as unavailable with the appropriate blocker (do not throw, do not claim installable).
- `listed:false` entries are not returned by the public list (or returned with `PACKAGE_UNLISTED` blocker if `includeUnlisted` is explicitly requested; default false).
- `list(scope, query)`:
  - limit default 20, max 100; non-integer/<1/`>100` → `INPUT_INVALID`.
  - search ≤200 chars, case-insensitive substring over packageKey/displayName/summary.
  - category exact match.
  - stable sort by packageKey ascending (UTF-8).
  - opaque, stable key cursor encoding last packageKey; invalid cursor → `INPUT_INVALID`.
  - `installable = artifact verified && listed`.
  - Never include filesystem paths, secrets, config, or other-team install facts.
- `get(scope, publisher, name)`: return exact current version detail; unknown → `RESOURCE_NOT_FOUND` (no existence leak across scopes; catalogue is deployment-wide but install facts are absent in PKG01).

### Build script (`scripts/plugin-packages/build.ts`)
- Usage: `bun scripts/plugin-packages/build.ts --catalog plugins/marketplace.json --out <artifactRoot>`.
- Loads strict `MarketplaceV1` from `--catalog`; package source dir is `plugins/packages/<packageKey>`.
- Builds each artifact, writes atomically to `<out>/sha256/<digest>/`.
- If the declared `artifactDigest` does not equal the computed digest, exit non-zero and name the package (same version/new content is rejected).
- `--print-digest <packageDir>` prints the computed digest for authoring.
- No network, no execution of package content.

### Fixture
- Create `plugins/marketplace.json` with one listed package `openbot/demo-skill@1.0.0`, category `productivity`, and the correct digest.
- Fixture package contains only one Skill resource (`skills/summarize/SKILL.md`) plus README and manifest. It must not contain secrets or endpoints.

### Read-only HTTP (`server/src/enterprise/plugin-packages/routes.ts`)
- `createPluginPackageRoutes(deps)` returning Hono.
- `GET /` → list; `GET /catalogue/:publisher/:name` → detail.
- Deps inject `resolveScope(request): Promise<PlatformScope>`; production uses the shared `createScopeResolver` with tenant/workspace headers, exactly like `entry-context.ts`.
- Require authentication and trusted scope; canonical errors: 401 `AUTH_REQUIRED`, 400 `INPUT_INVALID`/`SCOPE_REQUIRED`, 403 `TENANT_FORBIDDEN`, 404 `RESOURCE_NOT_FOUND`, 503 `PACKAGE_STORAGE_UNAVAILABLE`.
- If the catalogue failed to load at startup, return 503 `PACKAGE_STORAGE_UNAVAILABLE` — never an empty success page.
- Mount at `/api/enterprise/plugin-packages` in `app.ts`; assemble in `index.ts` from `OPENBOT_PLUGIN_ARTIFACT_ROOT` (default `plugins/.artifacts` at repo root) and the real scope resolver. If `enterpriseCapabilities` is absent, use an unavailable router returning 503.

## Tests (TDD, native)
Write RED tests first, run them, then implement.

- `server/tests/package-artifact.test.ts` (native, filesystem only):
  - digest stable across creation/traversal order; two builds identical.
  - same version different content → registration/build rejection (test at catalogue/index level if easier).
  - reject absolute path, `..`, symlink, case-fold collision, >64 KiB manifest, >256 resources, >512 files, >16 MiB total, >1 MiB text, unknown field, non-empty dependencies, duplicate IDs, bad version, unknown platformApi, invalid PNG/WebP.
  - exact limit boundaries accepted (e.g. 256 resources, 512 files, 64 KiB manifest).
  - file swapped during verification cannot change the verified buffer (best-effort: mutate after read is not possible; assert digest computed from buffer).
- `server/tests/package-catalogue.test.ts` (native): search/category/cursor/limit, unavailable artifact blocking, listed false hidden, duplicate version/digest rejection, no path leakage.
- `server/tests/package-read-routes.test.ts` (native): inject a fake scope resolver; 401/403/400/404/503 paths; list/detail happy path; assert no secrets/paths in JSON; pagination.
- Use `tests/support/e2e-compat` imports for native suites (follow existing `server/tests/*.test.ts` files; check one for the exact import path).

## Verification commands

```sh
cd /Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market
E2E_UNIT_OUTPUT=.e2e/pkg01-backend bunx e2e run --config e2e.unit.config.ts server/tests/package-artifact.test.ts server/tests/package-catalogue.test.ts server/tests/package-read-routes.test.ts
bun run --filter server typecheck
bunx biome check server/src/plugin-packages shared/enterprise/plugin-package-contracts.ts scripts/plugin-packages server/tests/package-artifact.test.ts server/tests/package-catalogue.test.ts server/tests/package-read-routes.test.ts
```

Every command must show >0 tests and exit 0, or report the exact failure. Do not mark success on skipped/zero tests or collection errors.

## Constraints

- No new npm dependency.
- No execution of package scripts/code; no network.
- Do not touch other issues' owned files beyond the listed app.ts/index.ts/config.ts seams.
- Do not modify the parent spec/plan/tickets.
- Do not commit.
- Keep comments minimal and only for non-obvious invariants.

## Report back

- Files changed (path + one line).
- Test commands and actual pass/fail counts, report directory.
- Any deviation from this brief and why.
- Any unverified/blocked item.
