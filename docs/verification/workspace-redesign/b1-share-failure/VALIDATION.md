# P14 Publish Save-Error Focus Validation

## Result

**PASS** for the bounded P14 save-error interaction. Scoped commands pass; the coordinator replayed the browser scenario after the validator pass, and the PRE manifest was corrected and verified. One low automated test-coverage gap remains documented by the reviewer.

## Revision and hashes

- Git HEAD: `203d0f0244b2f898218fa12027089c631e8448d9` (working tree contains many unrelated pending changes).
- `app/src/components/bot-profile/sharing.tsx`: `389f96db1fe063c2e9ad2c9bc5de7e78d8f56731d1ab67e1c7b24ebb5feee6d5`.
- `app/tests/bot-sharing.test.tsx`: `88c1779886fdfaf9397c1ce67a583f72b4a7c35c76045dff10afaee302a309fd`.
- Both hashes match the final hashes recorded in `browser-validation.json`'s accompanying validation evidence.

## Checks run

All commands were run against the above working-tree content:

- `cd app && bun test ./tests/bot-sharing.test.tsx` — PASS, 8 tests / 26 assertions. Output includes repeated existing React Aria warnings about `PressResponder` children and missing accessible labels.
- `cd app && bunx biome check src/components/bot-profile/sharing.tsx tests/bot-sharing.test.tsx` — PASS, 2 files checked.
- `cd app && bun run tsc --noEmit` — PASS.
- `git diff --check` — PASS.
- `shasum -a 256 app/src/components/bot-profile/sharing.tsx app/tests/bot-sharing.test.tsx` — PASS; hashes listed above.
- `file docs/verification/workspace-redesign/b1-share-failure/artifacts/*.png` — PASS; all five artifacts are valid PNGs at 390×844.
- `shasum -a 256 docs/verification/workspace-redesign/b1-share-failure/artifacts/*.png` — PASS; all artifacts are readable and hashed (hashes are available in the command output for this validation run).

## Browser evidence reviewed

`browser-validation.json` records exact intercepted `PUT /api/team-bots/agent_efd707f9-b827-42a5-9296-e6f3e45c6a05/publication` responses of synthetic 503, not forwarded to the API. At 390×844 / DPR 1 in both light and dark themes it records the dialog and error retained, focus on the Audience Select trigger, no horizontal overflow, Escape closure with trigger focus restoration, one intercepted request, and zero publication writes. The related error and closed-state screenshots exist and are valid PNGs. These browser observations were not independently replayed in this validator turn.

## Acceptance scope and caveats

The P14 rejected-publication save-error focus case is supported by the existing browser evidence and current regression test. The regression test also checks retained people/group draft values. The report does not establish other sharing permissions or states; those remain outside this brief / partial per existing evidence.

The PRE checkpoint manifest lists `app/src/components/bot-profile/sharing.tsx`, but the copy available in the checkpoint directory is named `sharing.tsx`; running `shasum -a 256 -c SHA256SUMS` from `checkpoints/PRE` therefore fails because the manifest path is not present there. This does not affect the independently computed final source/test hashes above, but the PRE checkpoint hash could not be verified using its manifest as written.

No source or test files were modified by validation. No OCR was run.

## Follow-up to initial independent validation

The initial validator recorded `DONE_WITH_CONCERNS` for two evidence limitations: it did not replay the browser and could not verify the PRE manifest path. The coordinator has since replayed the exact interaction in both themes and recaptured 390×844/DPR 1 error/closed screenshots; see the JSON and artifacts. The PRE manifest path was corrected to `sharing.tsx`, and `shasum -a 256 -c SHA256SUMS` from the PRE directory now reports `sharing.tsx: OK`. The low-severity automated keyboard-recovery coverage limitation is recorded in the independent Review; live browser behavior is covered.
