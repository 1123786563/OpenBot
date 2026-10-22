# T05 P15 Error-State Focus — Independent Review

## Scope and evidence

- Reviewed the PRE checkpoint against the current `app/src/components/bot-profile/setup.tsx` and `app/tests/bot-setup.test.tsx` only. PRE SHA-256: `setup.tsx` `9ebfec43eba5b2eef0c39667674109238ab522032a8c65762487cd10ad5f1c49`; test `ffd8ff923883c499d1e918d43167f08458318ccad6b391ec4d10e26b5ee01aab`. Reviewed POST SHA-256: source `52319fee3fda9c9e916e3e0bf93b3d38947b549569d01d2a66a7a77d9b979b86`; test `46667d593fd4c5cb9a31c66b9634c0b6e9085f63c8abf183988c412f88239dd4`.
- Fact sources: approved HeroUI migration spec (`docs/specs/2026-10-19-heroui-ui-migration-design.md`, especially §§2, 5, 7), `CONTEXT.md`, ADR 0008, P15 route acceptance and B1-E/B1-I verification mapping, the P15 repair plan, assigned brief, and implementation report.
- The implementation report records a passing focused Bun test, scoped Biome and TypeScript checks after the typed-ref correction. This review inspected code and recorded evidence; it did not rerun tests, invoke OCR, or perform the separate browser validation.

## Spec compliance verdict: Pass for the assigned repair

The PRE-to-POST source delta adds refs to both editor variants and refocuses the mounted field on the next animation frame after `onSave` rejects (`setup.tsx:253-274, 283-305`). The catch retains the existing draft and renders the error in the dialog (`setup.tsx:250-252, 265-311`). The success path still closes after a successful mutation, and the validation branch still returns before a request. The new Title regression checks a synthetic 503, retained value, input focus, Escape dismissal, trigger focus, and no store update (`bot-setup.test.tsx:215-232`). No API, validation limit, or shared Dialog change appears in this task delta. This meets the focused repair plan and preserves the approved spec's existing form and error behavior.

The plan assigns real-browser 390px light/dark focus and Escape verification to the independent frontend validator. That result is not present in this review package, so this verdict does not sign off the browser acceptance or the broader P15 route matrix.

## Code quality verdict: Pass with one low-priority test gap

The refocus is local to the failed-save boundary, uses DOM refs passed through the existing Input and Textarea wrappers, and checks the ref at callback time, so an unmounted dialog is not focused. There is no new data write or concurrency path. The typed-ref correction is included in the reviewed POST hash and the implementation report records a passing TypeScript check against that correction. No critical, high, or medium defect was found in the assigned delta.

### Finding L1 — Rejected-save test covers only the input branch

- **Severity:** Low (behavioral coverage).
- **Evidence / affected symbols:** `EditTextDialog` conditionally renders `Textarea` for Role description (`setup.tsx:283-291`) and `Input` for Name/Title (`setup.tsx:292-305`), and the new test opens only Title and asserts an `HTMLInputElement` (`bot-setup.test.tsx:219-228`). P15 acceptance explicitly calls for long textarea input to survive a save failure.
- **Impact:** A future regression in textarea ref forwarding or failed-save focus could pass this test, leaving Role description users on `BODY` after a rejected save. The implementation itself wires the textarea ref correctly; this is a coverage gap, not evidence of a current runtime failure.
- **Smallest defensible correction:** Add one rejected-save Role description test using the existing 503 fixture, asserting retained textarea value, focus after the error, Escape dismissal, and return focus to the Role row. The validator's real-browser Title check remains necessary for the original failure.

## Review conclusion

The reviewed code satisfies the narrow P15 focus repair with no blocking code finding. The low-priority textarea regression coverage gap remains, and browser acceptance awaits the assigned validator's evidence. This report is bound to the POST hashes above; later changes require a new review or a hash-matched addendum.
