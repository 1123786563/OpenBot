# T05 repair round 1 — implementation report

## Scope

Fixed T05-S1/S2/S3 from `T05-review.md`. Parent authorized the two locale paths for a translated menu label and the new `app/tests/routines-list.test.tsx` UI test. PRE includes locale source snapshots and an explicit absent-file tombstone for the new test. Existing unrelated workspace changes were preserved. No commits made.

## Changes

- `bot-subpage.tsx`: when cached Bot data exists, keep rendering route children during a background query error and show the refresh error; initial errors without data still show the unreachable state.
- `reaching-you.tsx`: pending SMS session data is versioned and contains challenge, Bot, and channel identity. It is surfaced only for the matching Bot. Invalid and legacy unscoped values are cleared.
- `routines-list.tsx`: Run now remains primary; History and Delete are under the existing dropdown menu. Existing history action and delete confirmation handlers remain wired.
- `en/routines.json`, `zh-CN/routines.json`: localized “More actions” label.
- Tests: SMS A→B→A persistence/isolation and a routine DOM menu interaction covering History and Delete confirmation.
- `docs/verification/e2e-bun-suites.json`: registered the new routine UI test in `app/tests part 1`; coverage audit passes with no gaps.

## Verification

- `bun test ./app/tests/bot-reaching-you.test.tsx` — 7 pass, 0 fail; 23 assertions. Existing HeroUI accessibility warnings were printed by the test harness.
- `bun test ./app/tests/routines-list.test.tsx` — 1 pass, 0 fail; 3 assertions. Existing HeroUI PressResponder warning printed.
- `E2E_BUN_ONLY='app/tests part 1' bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` — e2e driver passed the selected Bun-runtime group. Driver reported five process-sharing failures and individually reran those files successfully, including the SMS suite.
- `bun run scripts/e2e-coverage-audit.mjs` — 1076 suite files; 600 native, 461 driven, 10 engine, 5 named exclusions; no gaps.
- `bunx biome check` on all seven changed app source/locale/test files — passed, no fixes.
- `bunx tsc --noEmit --project app/tsconfig.json` — blocked by existing unrelated error `app/tests/button-native.test.tsx:54` (callback ref returns `HTMLButtonElement | null`); no errors in changed files.
- Attempted `bunx e2e run --config e2e.unit.config.ts app/tests/bot-reaching-you.test.tsx`; config correctly excluded this Bun-driven file (`NO_TESTS`). The ADR0008 driven group above is the applicable e2e entry point.

## Checkpoint evidence

- PRE: `docs/verification/workspace-redesign/execution/checkpoints/t05-r1/PRE/` (HEAD/status/full tracked patches, scoped path snapshots, manifest). Locale PRE SHA-256 values: en `ee1626cef461bc9e0cd21a7140cbdc9ca4dc1877a6e13c9d795fcc1729d50eb1`, zh-CN `ea4bbbea70d2f6697c8c31bce8210e8d02eff08581389d922550a7ed5667dafe`. New test PRE state: absent, empty sentinel SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- POST: `docs/verification/workspace-redesign/execution/checkpoints/t05-r1/POST/`; manifest SHA-256 `e25aa849d35a2330b2981ceb793b039671835156cd5d511584866469f92ea112` (recompute after final copy).
- Delta: `docs/verification/workspace-redesign/execution/checkpoints/t05-r1/delta.patch` (scoped PRE→POST source delta).

## Remaining evidence and risk

- BotSubpage S1 lacks an isolated component regression test in the authorized paths; source behavior was changed but needs a dedicated retained-content test.
- The new routines test exercises public DOM menu availability and actions in Happy DOM; rendered responsive geometry, keyboard focus in a browser, and all browser acceptance remain deferred. No browser acceptance is claimed.
- Independent validation and review are pending parent orchestration.
