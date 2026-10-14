# B04 — Remove copied client after all mapped adaptations land: Evidence

- **Date (UTC):** 2026-10-13T02:52:18Z
- **Worktree:** `/Users/wuyongjun/trea/OpenBot/.worktrees/v4-base` @ branch `v4/openbot-exec`, HEAD `748f91ad`
- **Spec:** contracts §1 + ticket catalog B04; Issue #93; S41 is the live card
- **NO commit, NO staging** — the filesystem removal + unstaged `git status` deletions are the checkpoint (uncommitted protocol)

## 1. Resolved manifest (Task 1)

`docs/openmuse-v4/b01-build-inventory.py` extended (annotate table + B04 resolution layer:
`SUPERSEDED` citations, `CANONICAL_ADDITIONS` ticket map, `RESOLVE` strings) and the manifest
regenerated, then `--verify` run — 4 OK:

```
$ python3 docs/openmuse-v4/b01-build-inventory.py
rows: identical=24 diverged=43 copied_only=4 canonical_only=46 total=117

$ python3 docs/openmuse-v4/b01-build-inventory.py --verify
OK (a) union coverage of both trees
OK (b) every row has difference_hash
OK (c) every non-identical row annotated + resolved
OK (d) counts match: copied=71 canonical=108 identical=24 diverged=43 copied_only=4 canonical_only=46
```

Row-resolution summary (117 rows, 93 non-identical — every one resolved; identical 24 trivial):

| resolution | rows | notes |
| --- | --- | --- |
| trivial (identical) | 24 | incl. `package.json` — canonical adopted the copy's file byte-for-byte |
| canonical-parity 46792335 | 25 | zh-CN content parity via `src/strings.ts` catalog + localized fixtures (19 catalog rows, DateFields native/web, PdfReader.web, app.json, relative-date test, jev-actions test combined string) |
| superseded-by <ticket> — file:line | 9 | App.tsx:139, api.ts:37, auth.ts:28, client.ts:119, config.ts:13, email-signin.tsx:55, errors.ts:25, gate.tsx:93, types.ts:21 — in the canonical v4-base worktree (uncommitted checkpoint on 46792335) |
| landed-in-canonical <ticket> | 46 | canonical-only additions: 44 session-layer files + tests (A03, C01–C06, F04/F07/F08/F10, G06, I01/I03–I08, K02/K04, T03) + strings.ts/strings.test.ts |
| resolved-by B02/B03 | 5 | metro.config.js, tsconfig.json, path-rewrite rows (date-time, jev-tool-card, workspace) — canonical builds unmodified under the submodule |
| resolved-by B04 (dies with copy) | 8 | README.md, .gitignore, .npmrc, MIGRATION.md, bun.lock (bookkeeping) + 3 localization-gap rows (gap recorded in the manifest) |

Key fact behind the resolution: the canonical v4-base worktree adopted the copy's session layer
(`apps/mobile/src/openbot/*`, `App.tsx`, `package.json`) as an uncommitted checkpoint on 46792335
and extended it via the v4 client tickets (ledger 2026-10-12-openbot-v4-execution) — canonical
count 56 → 108. Script changes: `dist/` added to EXCLUDE_DIRS (build output), expected canonical
count updated, verify check (c) now also asserts every non-identical row carries a resolution.

## 2. Removal + git status (Task 2)

```
$ rm -rf apps/openmuse-mobile
$ ls apps/
openmuse

$ git status --porcelain | grep openmuse-mobile | head
 D apps/openmuse-mobile/.gitignore
 D apps/openmuse-mobile/.npmrc
 D apps/openmuse-mobile/App.tsx
 D apps/openmuse-mobile/MIGRATION.md
 D apps/openmuse-mobile/README.md
 D apps/openmuse-mobile/app.json
 D apps/openmuse-mobile/assets/README.md
 D apps/openmuse-mobile/assets/capybara.png
 D apps/openmuse-mobile/bun.lock
 D apps/openmuse-mobile/index.js
$ git status --porcelain | grep -c openmuse-mobile
71
```

71 deletions, all ` D` (unstaged — leading space) — matches the tracked file count; nothing staged.

## 3. Reference scan classification (Task 2)

`rg -l "openmuse-mobile"` outside the copy (whole worktree). **Live references found: 3 — all
fixed** (comment-only edits, no behavior change):

| file:line | fix |
| --- | --- |
| `server/src/mobile-bff/routes.ts:17` | doc comment now names the client as the `apps/openmuse` submodule, `apps/mobile` |
| `server/src/auth/index.ts:378` | EXPO_APP_SCHEME comment: `apps/openmuse-mobile` → `apps/openmuse` submodule, `apps/mobile` |
| `.env.example:701` | EXPO_APP_SCHEME comment: same rewrite |

Historical/record references (10, left as-is — they document the migration, the manifest, or live
inside the untouchable submodule pin):

- `docs/superpowers/specs/2026-10-12-openmuse-frontend-openbot-backend-design.md` (approved design; defines the removal)
- `docs/superpowers/specs/OpenMuse-Mobile-OpenBot-Backend-Architecture.md` (pre-subtree architecture record)
- `docs/superpowers/specs/OpenMuse-Mobile-OpenBot-Backend-GoLive.md` (pre-subtree go-live plan)
- `deliverables/openmuse-web-qa/WEB-E2E-TEST-REPORT.md` (QA report of a past run against the copy)
- `docs/openmuse-v4/b01-copied-client-inventory.md` + `.1ac68f3.md` (the manifest + archive — the record itself)
- `docs/openmuse-v4/b01-build-inventory.py` (the archived generator; requires both trees, see its docstring)
- `apps/openmuse/docs/adr/0010-openmuse-repository-as-openbot-submodule.md` (submodule ADR, inside the pin — untouchable)
- `apps/openmuse/docs/superpowers/plans/2026-10-12-openmuse-openbot-contracts-v4.md` (contracts, inside the pin — untouchable)
- `apps/openmuse/docs/superpowers/plans/2026-10-12-openmuse-openbot-ticket-catalog-v4.md` (catalog, inside the pin — untouchable)

**Zero live references remain.**

## 4. Four clean builds from the removal state (Task 3)

**Method (recorded per plan):** NOT a git clone — a clone of HEAD would restore the copy (it is
tracked at `748f91ad`). Instead the scratch reproduces the worktree's CURRENT state with the
removal applied: `rsync -a` of the worktree excluding `apps/openmuse-mobile` (already absent —
the removal is what gets tested), `node_modules`, `dist`, `/.git` (worktree gitdir pointer),
`apps/openmuse` (re-materialized at the pin; the worktree's submodule is clean at the same SHA,
so content is identical), and scratch state dirs. Then the B02-recipe index reproduction
(`git init` + `git add .gitmodules` + `git update-index --add --cacheinfo 160000,46792335…,apps/openmuse`):

```
$ git submodule update --init --recursive
Submodule 'apps/openmuse' (https://github.com/1123786563/openmuse) registered for path 'apps/openmuse'
Submodule path 'apps/openmuse': checked out '46792335dfc260efa05f2185aa353093b12d9937'

$ cd apps/openmuse && pnpm install --frozen-lockfile
Done in 6.4s using pnpm v11.19.0
```

### (1) Web export

```
$ pnpm build:web
› web bundles (2):
_expo/static/js/web/browser-a16dc6a975c4405df5be736d4a266e08.js (349 B)
_expo/static/js/web/index-c9e2fe803a32494132849f829b9c99a9.js (5.18 MB)
› Files (2):
index.html (1.21 kB)
metadata.json (49 B)
Exported: dist/web
```

### (2) iOS export

```
$ pnpm build:ios
› ios bundles (1):
_expo/static/js/ios/index-f9fa22c53b1e999cdd4118ca88c437a9.hbc (8.67 MB)
› Files (1):
metadata.json (204 B)
Exported: dist/ios
```

### (3) Android export

```
$ pnpm build:android
› android bundles (1):
_expo/static/js/android/index-f6fa7902a39b3a9379192e28bd0d7039.hbc (8.62 MB)
› Files (1):
metadata.json (212 B)
Exported: dist/android
```

### (4) OpenBot build (`bun install && bun run build` at scratch root)

```
$ bun install
1343 packages installed [3.60s]

$ bun run build
app prebuild: Exited with code 0
worker build: Exited with code 0
server build: Exited with code 0
app build: ✓ built in 8.64s
app build: Exited with code 0
```

Zero mentions of `openmuse-mobile` in the build log (`grep -ci` → 0).

### Determinism vs B02/B03

Exported artifact digests are byte-identical to the B02/B03 evidence (same pin, same toolchain):
web `index.html` `0e1ae0c1…b0f4f`, web `metadata.json` `aa5f19cc…56991`, ios `metadata.json`
`a5d34ddc…99a514`, android `metadata.json` `2ac44bae…a6bc58`; bundle content-hash filenames
identical (`index-c9e2fe80…` web, `index-f9fa22c5…` ios, `index-f6fa7902…` android). Submodule
SHA re-checked after all exports: `46792335dfc260efa05f2185aa353093b12d9937` (unchanged).

## 5. Blockers

None. No live reference required touching an untouchable module (the three submodule-internal
mentions are historical records inside the pin).

`shasum -a 256 docs/openmuse-v4/b04-removal-evidence.md` — recorded in the completion report.
