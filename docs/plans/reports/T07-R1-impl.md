# T07-R1 Implementation Report

- **Task:** T07-R1 — align the P01 Home composer to a 720px maximum.
- **Owned source:** `app/src/routes/_authed/_app/index.tsx` only.
- **Checkpoint:** PRE captured at `docs/verification/workspace-redesign/execution/checkpoints/t07-r1/PRE/`; POST and exact route delta are in the matching `POST/` directory.
- **Delta hash:** see `POST/hashes.txt` (SHA-256 of the post-edit route source).

## Change

Changed the Composer max-width from `max-w-2xl` (672px) to `max-w-[720px]`. Preserved the existing outer `p-4`, full-width behavior, hint/error rows, conditional states, and event/state logic. No API or route changes.

## Verification

- `bunx e2e run --config e2e.unit.config.ts app/tests/home-fallback-routing.test.tsx` — **not collected** (`NO_TESTS`): config explicitly excludes this Bun-runtime suite from native Node collection.
- `E2E_BUN_ONLY=app/tests/home-fallback-routing.test.tsx bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` — **skipped**: selector matches no driven group name.
- `E2E_BUN_ONLY='app/tests part 3' bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` — **passed**, 1 driven group, including `app/tests/home-fallback-routing.test.tsx`.
- `bunx biome check app/src/routes/_authed/_app/index.tsx` — **passed**, one file checked after final edit.
- `git diff --check` — **passed** after final edit.

## Evidence and limits

The POST source and exact route delta hashes are recorded in the POST checkpoint; PRE hashes remain unchanged. The final route diff contains only the Composer width utility edit. No viewport/browser sizing test was run; browser sizing, zoom, viewport, and keyboard acceptance remains pending user testing per the brief. The first native test command and first driven selector did not execute the target suite; the correctly selected driven group passed.
