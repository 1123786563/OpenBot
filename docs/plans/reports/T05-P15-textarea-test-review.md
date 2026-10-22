# T05 P15 Role Textarea Test — Independent Review

## Scope and evidence

- Reviewed only the increment from `docs/verification/workspace-redesign/p15-error-focus/checkpoints/textarea/PRE/bot-setup.test.tsx` (SHA-256 `46667d593fd4c5cb9a31c66b9634c0b6e9085f63c8abf183988c412f88239dd4`) to `app/tests/bot-setup.test.tsx` (SHA-256 `c733dccc4b875e212e94b333e65aadf968a9fafc96d3307a1a0d38402bdc308b`). The diff is exactly one 22-line test at lines 235–255; no unrelated test hunk is mixed into this increment.
- The previously reviewed `app/src/components/bot-profile/setup.tsx` still has SHA-256 `52319fee3fda9c9e916e3e0bf93b3d38947b549569d01d2a66a7a77d9b979b86`. I used it only to check the test's exercised branch. Fact sources were the approved HeroUI spec, `CONTEXT.md`, ADR 0008, P15 route acceptance, the P15 repair plan and brief, the prior independent review, and `T05-P15-textarea-test-impl.md` (SHA-256 `b089f61709b28a0c9e39df9af4571ab89b358a8e6da90d81d2d274974dd3212d`).
- The implementation report records a focused Bun run of 5 passing tests and 20 assertions, scoped Biome pass, and diff check pass. This is a read-only review of code and recorded evidence; I did not rerun tests or OCR. The separate browser report records passing Title focus recovery in light and dark themes at 390×844; it does not exercise Role.

## Spec compliance verdict: Pass for the assigned textarea regression

The added test opens the Role editor, types a valid new draft, invokes Save against the fixture's synthetic 503, waits for an alert, and checks the draft and active field (`bot-setup.test.tsx:235–250`). It then presses Escape, waits for the dialog to close, checks focus on the invoking Role row, and verifies that the profile store recorded no update (`:251–254`). The source maps `roleDescription` to `multiline: true` and renders `Textarea` for that branch (`setup.tsx:59–64, 283–291`); the failed-save path schedules focus back to the mounted field (`:265–274`). This closes prior review finding L1 for the current source and covers the P15 error-focus repair's requested behavior without changing product code.

The P15 route acceptance also calls for long textarea input retention and 200% reachability. This short-value, test-only increment does not establish those broader route checks; this verdict is limited to the assigned rejected-save regression.

## Code quality verdict: Pass with one low-severity coverage weakness

The new test reuses the existing route-backed 503 fixture, observes the user-facing editor and focus transitions, and adds no production mutation or concurrency path. The increment is isolated and the recorded focused checks passed. No critical, high, or medium finding was found.

### L1 — The test does not assert that the edited control is a textarea

- **Severity:** Low, behavioral coverage.
- **Evidence / affected symbol:** `bot-setup.test.tsx:243–245` selects a textbox named `Role` and casts it with `as HTMLTextAreaElement`. The cast is erased at runtime; an `input` with the same accessible name would still satisfy the query, typing, value, and focus assertions. The prior review's gap was specifically coverage of the `Textarea` ref branch.
- **Impact:** A future change that accidentally renders Role as a single-line input could leave this regression green while the textarea focus path is no longer tested.
- **Smallest defensible correction:** Assert the queried element is a `TEXTAREA` (for example, `expect(field.tagName).toBe("TEXTAREA")`) before typing. Keep the existing focus, draft, Escape, and no-update assertions.

## Conclusion

The assigned low-priority regression is covered against the current reviewed source, and the task increment contains no unrelated diff. Quality passes for this bounded change with L1 recorded as a low-severity test-strengthening suggestion; no blocking finding remains in this increment.

## Follow-up on L1 (2026-10-21)

The subsequent bounded fix is reviewed separately in `T05-P15-textarea-review-fix-review.md`. It adds the requested runtime `TEXTAREA` assertion; the prior L1 finding is closed with Spec PASS and quality PASS for that one-line increment.
