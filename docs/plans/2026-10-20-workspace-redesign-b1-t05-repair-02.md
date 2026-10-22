# T05 Verification Repair 02 — Synchronize the Driven Exclusion Index

- **Source:** T08 full app native e2e collection fails on `app/tests/bot-subpage.test.tsx` (`bun:` protocol). Those files are already in a driven group but missing from the root `files` exclusion index consumed by `e2e.unit.config.ts`.
- **Evidence:** `docs/verification/e2e-bun-suites.json` has 461 files across `groups` and only 459 in top-level `files`; set difference is exactly `app/tests/bot-subpage.test.tsx` and `app/tests/routines-list.test.tsx`. Both are selected by `app/tests part 1`; e2e config reads only top-level `files` to exclude them from Node native collection.
- **Parent:** T05 and T08 final app verification in the authorized B1 plan. No product behavior changes.
- **Goal:** make the driven groups and native exclusion list agree exactly so full app native collection doesn't attempt Bun-only files.
- **Owner/sequence:** one `mechanical_worker`, then independent validator/reviewer. No commit.
- **PRE:** `docs/verification/workspace-redesign/execution/checkpoints/t05-r2/PRE/`.

## Owned path

| Path | Allowed change |
|---|---|
| `docs/verification/e2e-bun-suites.json` | Add the two already-grouped app test paths to top-level `files`, preserving `groups` and all other entries. No regeneration from stale audit snapshots. |

## Verification

Assert `set(groups[].files) === set(files)`, no duplicates, and both target paths are present. Run `bun scripts/e2e-coverage-audit.mjs`, full app native collection, app/tests driven group, changed JSON Biome/JSON parse, `git diff --check`. Capture POST/delta hashes and independent review. This check only repairs test-runner classification; behavior tests still execute in the Bun-driven app/tests part 1 group.
