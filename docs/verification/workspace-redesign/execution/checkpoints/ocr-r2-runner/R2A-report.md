# R2A driven partition report

**Date:** 2026-10-23  
**BASE:** `f55d12f899883fc4a5d7bf0e8067bb500b86ee38`

## Change

Recorded the exact native collection failure for `app/tests/channel-new-recipients.test.tsx` in `archive/verification/e2e-file-audit.json` with status `collection_error`, then regenerated `docs/verification/e2e-bun-suites.json` using `bun scripts/e2e-bun-manifest.mjs`. The suite appears exactly once in `files` and once in `app/tests part 1`.

Exact error: `COLLECTION_ERROR: failed to collect app/tests/channel-new-recipients.test.tsx: Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. Received protocol 'bun:'`

## Validation

- `bun scripts/e2e-coverage-audit.mjs` — exit 0; 1079 suite files, 833 native, 231 driven, 10 engine, 5 named exclusions; no coverage gaps.
- `E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/execution/checkpoints/ocr-r2-runner/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` — exit 0; `tests/bun-suites.test.ts` passed 2/2 groups. `app/tests part 1` passed (16.71s), `app/tests part 2` passed (39.68s). No group failures occurred, so ADR 0008's failure-triggered shared-process per-file rerun was not triggered. The new suite ran within `app/tests part 1`.
- The runner report is `driven/report.json` and records an overall `passed` status.

## SHA-256

- `archive/verification/e2e-file-audit.json`: `2a28a5f1c5f872663b282b5e6e1d4fadf005e19bc1d120bea447f642f2964821`
- `docs/verification/e2e-bun-suites.json`: `f4536c30ee054d35235fa8950c8f8e6318c0b29730689ae4ca2f6e1ee5fced05`
- `docs/verification/workspace-redesign/execution/checkpoints/ocr-r2-runner/driven/report.json`: `74e9f605849f068525694069d06e68809d115fac80f642b2737cb05848ac5d66`
