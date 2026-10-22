# T05-R1 Independent Validation

- **Revision:** `203d0f0244b2f898218fa12027089c631e8448d9` (HEAD at validation)
- **Checkpoint:** `docs/verification/workspace-redesign/execution/checkpoints/t05-r1/POST/`
- **Result:** `DONE_WITH_CONCERNS`

## Evidence and commands

- Recomputed SHA-256 for all seven paths in the POST manifest with a Node script; every file matches its recorded byte-level digest. The POST manifest digest also matches `POST-hash.txt` (`e25aa849d35a2330b2981ceb793b039671835156cd5d511584866469f92ea112`). POST head equals current HEAD. This confirms the claimed checkpoint source files are the exact current worktree contents.
- `bun test ./app/tests/bot-reaching-you.test.tsx` — **passed**, 7 tests / 23 assertions. Includes pending SMS A→B→A isolation and return behavior. Existing HeroUI PressResponder/label warnings were emitted.
- `bun test ./app/tests/routines-list.test.tsx` — **passed**, 1 test / 3 assertions. Confirms the accessible secondary-actions trigger exposes History and Delete, and Delete opens confirmation. Existing HeroUI PressResponder warning was emitted.
- Inspected `bot-subpage.tsx`: when error and usable cached data coexist, it renders the error alert plus children; initial error with no data shows unreachable; pending with no data renders no content. However, the brief explicitly requires regression coverage for successful load followed by failed refetch while retaining child state, and the implementation report confirms no isolated S1 test exists. No existing matching test was found.

## Acceptance assessment

- **T05-S1 retained Bot data on refetch error:** implementation logic matches requested behavior by inspection, but dedicated regression coverage is absent. **Gap remains.**
- **T05-S2 Bot-scoped SMS challenge:** covered by passing A→B→A interaction test; checkpoint exact.
- **T05-S3 routine secondary actions:** covered by passing DOM interaction test for menu items and delete confirmation; checkpoint exact.
- **Browser, responsive geometry, and browser keyboard-focus behavior:** deferred as declared; Happy DOM tests do not establish those criteria.

## Risks / limits

This validates the exact T05-R1 checkpoint and the two relevant existing test files. It does not validate full-app browser behavior. The recurring HeroUI accessibility warnings indicate other rendered controls lack labels/pressable semantics; they appear in the test harness broadly and were not attributed specifically to the changed controls here. The missing S1 regression test is an acceptance coverage gap even though the inspected conditional handles the described state.
