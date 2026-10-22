# T07-R2 Implementation Report

- **Task:** Align Home hint and error rows to the 720px input column.
- **Owned source:** `app/src/routes/_authed/_app/index.tsx` only.
- **Checkpoint:** PRE is at `docs/verification/workspace-redesign/execution/checkpoints/t07-r2/PRE/`; POST source and exact route delta are in `POST/`.
- **Source SHA-256:** recorded in `POST/hashes.txt`.

## Change

Changed only the fallback hint, submit error, and initial-load error max-width classes from `max-w-2xl` to `max-w-[720px]`. The Composer's existing 720px width, all `w-full` classes, conditions, content, padding, and behavior remain unchanged.

## Verification

- `E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/execution/t07-r2-e2e E2E_BUN_ONLY='app/tests part 3' bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` — **passed**, driven group includes `app/tests/home-fallback-routing.test.tsx`.
- `bunx biome check app/src/routes/_authed/_app/index.tsx` — **passed**, one file checked.
- `git diff --check` — **passed**.

## Evidence and limits

POST includes the route snapshot, the route's current Git delta, and source hash. Browser sizing/viewport acceptance remains pending user testing. App typecheck was not rerun in this task; plan says it follows T06-R5.

The final combined T07 PRE→POST package has been regenerated from the original T07 PRE through R2: `checkpoints/t07/POST/`. It remains exactly four changed paths and binds the Home alignment fix to the same full manifest.
