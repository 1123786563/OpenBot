# R2B Independent Validation

**Status:** DONE
**Revision:** `f55d12f899883fc4a5d7bf0e8067bb500b86ee38` (HEAD; working tree contains the R2B test-only change)
**Plan:** `docs/plans/2026-10-23-b1-ocr-repair-02b.md`

## Checkpoint integrity

- PRE and POST both record base HEAD `f55d12f899883fc4a5d7bf0e8067bb500b86ee38`.
- PRE test snapshot SHA-256 matches `PRE/file-hashes.txt`: `d0ef5c34e8fa150e1b571224dc21570b70e8c5ea99c6b3a13175d738348e3a72`.
- Current `app/tests/channel-new-recipients.test.tsx` matches POST manifest SHA-256: `eeab39b4e986b04b1c09401eecb43a97d0d60567fb1bb0cca4dd85697a820ac7`.
- `sha256sum -c docs/verification/workspace-redesign/execution/checkpoints/ocr-r2b/POST/manifest.txt`: passed for all four manifested files.
- Current route source and R2A report hashes also match the POST manifest. POST `checkpoint.sha256` matches the manifest hash.
- Diff from PRE test snapshot contains exactly the added hidden-option absence assertion.

## Acceptance check

In `adding a visible Bot preserves the fetched URL recipient, order, and URL`, the regression opens the recipient list and asserts `queryByRole("option", { name: /hidden bot/i })` is null before finding/selecting the visible Bot option. It retains the final URL assertion (`agent: "hidden-bot"`) and selected-button order assertion (`hidden bot, visible bot`). Acceptance criteria verified.

## Commands and results

- `E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/execution/checkpoints/ocr-r2b/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` — exit 0; 1 test file passed, 2 tests passed, including both app/tests partitions. Runner emitted its expected notices for unselected Bun-only files that the Node loader cannot collect; these were skipped, not failures.
- `bunx biome check app/tests/channel-new-recipients.test.tsx` — exit 0; checked 1 file, no fixes.
- `git diff --check` — exit 0.

No credential values were recorded. The test-only acceptance is satisfied; this bounded validation did not exercise browser UI, responsiveness, or other route states beyond the assigned regression and requested suite.
