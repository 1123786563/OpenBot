# P11 Rule Save-Error Focus — Independent Validation

- **Status:** PASS for the bounded P11 rejected-save interaction and focused-test acceptance.
- **Revision:** `203d0f0244b2f898218fa12027089c631e8448d9` (uncommitted worktree).
- **Scope:** Task 2. No source or test files changed by the validator.
- **Reviewed hashes:** `rules.tsx` `96a5b50a645b886bddd8bf16be8252ff62caa960b4929503911115c0b8b6b200`; `approvals-rules.test.tsx` `f748d1fb8cc98fe426838f82ab8734e97020179c73e499b078f4d87ec686f64f`.

## Checks

| Check | Result |
| --- | --- |
| Focused native suite: `cd app && bun test ./tests/approvals-rules.test.tsx` | PASS, 12 tests / 32 assertions; includes rejected draft retention and successful retry/close. Existing React Aria/HeroUI warnings remain. |
| Scoped Biome: `bunx biome check app/src/components/approvals/rules.tsx app/tests/approvals-rules.test.tsx` | PASS, 2 files, no fixes. |
| App TypeScript: `bunx tsc --noEmit -p app/tsconfig.json` | PASS, no diagnostics. |
| `git diff --check` | PASS. |

## Browser validation

Using the isolated admin account and tmpfs database, the exact `POST /api/approvals/rules` was intercepted and answered with synthetic 400; no request was forwarded and no rule was written. At 390×844, DPR 1, in both themes, the draft and alert remained, focus returned to the Tool/app input, Escape closed the dialog, focus returned to Add a rule, and horizontal overflow was false. One intercepted request per theme.

Structured data: `browser-validation.json`. Error-state and closed-state screenshots are saved separately in `artifacts/`; all are 390×844 and reflect their named state. The coordinator repeated the live interaction and captured these artifacts after the first validator identified the earlier screenshot/state mismatch.

## Limits

This closes only P11 rejected-save focus behavior. Permission variants, other form states, and the wider P01–P23 acceptance matrix remain partial. No OCR was run per explicit user instruction.
