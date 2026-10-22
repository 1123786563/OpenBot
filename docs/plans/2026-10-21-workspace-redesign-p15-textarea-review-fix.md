# P15 Role Textarea Regression Review Fix

- **Parent:** `docs/plans/2026-10-21-workspace-redesign-p15-error-focus.md` Task 3 follow-up.
- **Finding:** `docs/plans/reports/T05-P15-textarea-test-review.md` low T05-P15-TEXTAREA-Q1: the `HTMLTextAreaElement` assertion is erased at runtime, so the regression does not prove the Role editor is actually rendered as a textarea.
- **Goal:** Make the rejected-save regression fail if the Role editor renders as an input.
- **Scope:** `app/tests/bot-setup.test.tsx` only, plus a task report and PRE/POST evidence.
- **Acceptance:** Assert `field.tagName === "TEXTAREA"` before entering the Role draft; focused suite and scoped Biome/diff check pass; test increment contains no unrelated edits.
- **Owner / review:** `frontend_implementer`, followed by a read-only `reviewer`.
- **Base:** current Role-textarea test SHA `c733dccc4b875e212e94b333e65aadf968a9fafc96d3307a1a0d38402bdc308b`; source remains `52319fee3fda9c9e916e3e0bf93b3d38947b549569d01d2a66a7a77d9b979b86`.
- **Constraints:** Preserve the full dirty worktree. No product source change, dependency install, Git state operation, user-data update, OCR, or commit.

## Task 1 — Assert the rendered control type

- **Role:** `frontend_implementer`.
- **Files:** `app/tests/bot-setup.test.tsx`; `docs/plans/reports/T05-P15-textarea-review-fix-impl.md`; PRE evidence under `docs/verification/workspace-redesign/p15-error-focus/checkpoints/textarea-review-fix/PRE/`.
- **Steps:** Snapshot current test bytes and SHA; add `expect(field.tagName).toBe("TEXTAREA")` before typing; run `cd app && bun test ./tests/bot-setup.test.tsx`, scoped Biome, and `git diff --check`; report exact increment and POST SHA.
- **Verification:** `5 pass / 0 fail`, Biome clean for the owned file, no diff whitespace errors.

## Task 2 — Independent review

- **Role:** `reviewer` (read-only).
- **Files:** `docs/plans/reports/T05-P15-textarea-review-fix-review.md` only.
- **Checks:** Confirm the test now proves `TEXTAREA` at runtime and retains its other rejected-save assertions; confirm exact task increment and source immutability; separate Spec and quality verdicts.

## Review Focus

Would this regression fail if the Role editor stopped rendering a textarea, while continuing to verify focus recovery after a rejected save?

## Completion record

- Task 1 implemented and verified: report `docs/plans/reports/T05-P15-textarea-review-fix-impl.md`; POST test SHA `d01e1d0caf26d905c342810c80757c155a2f56347a95bcd57017235eac9e7d9e`; product source SHA unchanged.
- Task 2 independently reviewed: `docs/plans/reports/T05-P15-textarea-review-fix-review.md`; Spec PASS, quality PASS. The runtime `TEXTAREA` assertion closes the earlier L1.
- Focused native test: 5/5 tests, 21 assertions; scoped Biome and `git diff --check` pass.
