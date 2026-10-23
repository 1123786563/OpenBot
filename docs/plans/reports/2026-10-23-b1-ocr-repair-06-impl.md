# R6 implementation report: T07 demonstration schedule Select semantics

**Plan:** `docs/plans/2026-10-23-b1-ocr-repair-06.md`  
**Scope:** `app/src/components/computer/demonstration-recorder.tsx`, `app/tests/computer-driving-local-fields.test.tsx`  
**No commit created.** Unrelated worktree changes were preserved.

## Changes

- Added closed-trigger `items` labels for each translated cron preset and the custom cron choice.
- Replaced the empty conversation-only selection with `__only_conversation__`, initialized it as the selected value, and removed the placeholder prop. Schedule payload construction omits `channelId` for that sentinel.
- Added behavioral coverage for all cron display labels and absence of the channel trigger's `data-placeholder`; retained and exercised channel selection, toggle-back, and payload omission coverage.

## Verification

- `bun test ./app/tests/computer-driving-local-fields.test.tsx` — could not collect under installed Bun 1.4.2: `SyntaxError: Export named 'registerHooks' not found in module 'node:module'`. The prescribed driven path below was used per ADR 0008.
- `bunx e2e run --config e2e.unit.config.ts app/tests/computer-driving-local-fields.test.tsx` — PASS, 1 file / 6 tests.
- `bunx biome check app/src/components/computer/demonstration-recorder.tsx app/tests/computer-driving-local-fields.test.tsx` — PASS, 2 files, no fixes.
- `bun run --cwd app typecheck` — PASS (`tsc --noEmit`; config generation also completed).
- `git diff --check -- app/src/components/computer/demonstration-recorder.tsx app/tests/computer-driving-local-fields.test.tsx` — PASS.

## Final content hashes

- `app/src/components/computer/demonstration-recorder.tsx`: `9eddb918799037e5b5e1be59bcbd5643f56aad1fd3291c4331e1c1ec32ba44ad`
- `app/tests/computer-driving-local-fields.test.tsx`: `d915dd0a511fd66c041f74524c7e31624aa8d3e476bfb6a4853045277b7ed63f`
