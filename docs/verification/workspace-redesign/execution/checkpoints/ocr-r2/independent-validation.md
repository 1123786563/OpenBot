# R2 / R2A independent validation

**Date:** 2026-10-23  
**Revision:** `f55d12f899883fc4a5d7bf0e8067bb500b86ee38`  
**Status:** `DONE_WITH_CONCERNS`

## Checkpoint integrity

- `cd docs/verification/workspace-redesign/execution/checkpoints/ocr-r2/POST && sha256sum -c checkpoint.sha256` — initial invocation reported all entries missing because the hash list stores repository-relative paths. Reran from the repository root:
  `sha256sum -c docs/verification/workspace-redesign/execution/checkpoints/ocr-r2/POST/checkpoint.sha256` — all 5 checkpoint files `OK`.
- `sha256sum -c docs/verification/workspace-redesign/execution/checkpoints/ocr-r2/POST/manifest.txt` — all 4 listed source/test/report files `OK`.
- R2A report's three recorded hashes match current files:
  - `archive/verification/e2e-file-audit.json`: `2a28a5f1c5f872663b282b5e6e1d4fadf005e19bc1d120bea447f642f2964821`
  - `docs/verification/e2e-bun-suites.json`: `f4536c30ee054d35235fa8950c8f8e6318c0b29730689ae4ca2f6e1ee5fced05`
  - prior `ocr-r2-runner/driven/report.json`: `74e9f605849f068525694069d06e68809d115fac80f642b2737cb05848ac5d66`

## Validation commands and results

- `bun scripts/e2e-coverage-audit.mjs` — exit 0; 1,079 suite files accounted for (833 native, 231 driven, 10 engine, 5 named exclusions), no coverage gaps.
- `bunx biome check app/src/routes/_authed/_app/channel/new.tsx app/tests/channel-new-recipients.test.tsx` — exit 0; 2 files clean, no fixes applied.
- `E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/execution/checkpoints/ocr-r2/validator-driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` — exit 0; Node/e2e report status `passed`, `tests/bun-suites.test.ts` 2/2, both `app/tests part 1` (15.63s) and `app/tests part 2` (37.48s) passed. Fresh report: `docs/verification/workspace-redesign/execution/checkpoints/ocr-r2/validator-driven/report.json`. This confirms the driven partition executed successfully. The runner report is an aggregate per Bun group, so it does not expose per-file child results; the target suite is included exactly once in the passing `app/tests part 1` group.
- Manifest exact-once check (`node` JSON inspection) — `app/tests/channel-new-recipients.test.tsx` appears once in `files` and once in group `app/tests part 1`.

## Acceptance inspection

- The regression initializes `/channel/new?agent=hidden-bot` with a fetched `hidden: true` profile absent from the visible roster, opens the recipient picker, selects `visible-bot`, then asserts selected button label order `Hidden Bot, Visible Bot` and search state `{ agent: "hidden-bot" }`.
- Source merges already-selected profiles with the roster for the chosen IDs, preserving selected order; the fetched detail remains sourced from the existing `agentQueryOptions` path. The change does not modify route/API permission checks or visibility filtering. Visible options still derive from `profiles`/the permission-filtered roster; this patch does not add hidden detail to that roster.
- Existing route logic retains `toFieldChange` for the selection cap and escape semantics. No new permission broadening is present in the changed selection callback.

## Acceptance gap / risk

The new interaction test verifies hidden-recipient preservation, order, and URL, but does not explicitly assert that the hidden Bot is absent from the picker options. Source inspection shows options are still fed the visible `roster`, and no roster or permission logic was broadened, so no observed behavior regression is indicated. Treat the missing direct negative assertion as a coverage limitation for the “do not expose hidden Bot in visible roster” criterion.

No browser, responsive, or assistive-technology interaction run was part of this scoped route regression validation. The test uses the existing DOM harness; accessibility-tree handling of the initially open picker is documented in the test helper comments.
