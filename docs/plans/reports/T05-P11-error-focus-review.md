# T05 P11 Rejected-Save Focus — Independent Review

- **Scope:** Task 3 of `docs/plans/2026-10-21-workspace-redesign-p11-error-focus.md`; read-only review of the P11 increment against the approved HeroUI migration spec, relevant ADR, `CONTEXT.md`, and `docs/plans/task-briefs/T05-P11-error-focus.md`.
- **Reviewed snapshot:** `app/src/components/approvals/rules.tsx` SHA-256 `96a5b50a645b886bddd8bf16be8252ff62caa960b4929503911115c0b8b6b200`; `app/tests/approvals-rules.test.tsx` SHA-256 `f748d1fb8cc98fe426838f82ab8734e97020179c73e499b078f4d87ec686f64f`. These match `docs/verification/workspace-redesign/b1-approval-rule-focus/VALIDATION.md`. Compared with the byte copies under `checkpoints/PRE/`; no unrelated work was changed by this review.
- **Sources:** `docs/specs/2026-10-19-heroui-ui-migration-design.md` §§5, 7 (Dialog Escape/focus return, A04/A05); `docs/adr/0008-test-runner-tester-army-e2e.md` (native/driven test evidence); `CONTEXT.md`; P11 plan and Task Brief. No additional domain constraint in `CONTEXT.md` applies to this local focus repair.

## Spec compliance verdict: Pass for the bounded P11 behavior

`RuleForm` now retains its draft and error path and schedules focus on the Tool/app input when the rejected mutation invokes `onError` (`rules.tsx:230,244-245,282-290`). The independent browser record reports the exact POST intercepted with a synthetic 400, one request and zero writes per theme, focus in the input, Escape dismissal, trigger focus restoration, and no horizontal overflow at 390×844 in light and dark (`docs/verification/workspace-redesign/b1-approval-rule-focus/browser-validation.json`). This directly covers the observed failure and the P11 acceptance. The callback leaves the mutation payload and `onSuccess: close` path intact. The focused test now checks one rejected request followed by a successful retry that closes the dialog after a second request (`approvals-rules.test.tsx:253-261`). The browser record does not exercise that retry.

## Code quality verdict: Q1 resolved; scoped quality gate pass

### Q1 — Resolved — Retry-success coverage restored

- **Evidence and location:** Current `app/tests/approvals-rules.test.tsx:253-261` asserts one POST immediately after rejection, then retries, waits for dialog dismissal, and asserts two total POSTs. This restores the removed behavior assertion.
- **Impact:** The focused suite again guards dismissal after a rejected request. The synthetic refusal is one-shot; the test does not edit the field before retry, so its comment's word “corrected” is inaccurate but does not weaken the retry/close assertion.
- **Correction:** No further change required for Q1.

### Gate concern — Closed

The validator and coordinator reran scoped Biome and app typecheck on the same reviewed hashes; both pass.

## Evidence limits

I inspected the exact hashed source/test snapshot and the validator's recorded results; I did not rerun tests, browser validation, Biome, or OCR. The latest validator report records focused Bun tests 12/12 with 32 assertions and `git diff --check` passing, and scoped Biome and app typecheck passing. The implementation report documents why the happy-dom test does not assert focus/Escape and delegates those behaviors to the independent browser check, as permitted by the P11 plan. This review does not assess the broader dirty workspace or the complete HeroUI migration.

### Browser artifact follow-up

The earlier error screenshots were replaced after review showed they were captured after Escape at a different pixel size. The coordinator reran the controlled 400 interaction with explicit 390×844 / DPR 1, captured the error state before Escape and the closed state afterward in both themes, and updated the structured evidence. The behavior checks remain unchanged and the screenshots now match their recorded state and dimensions.
