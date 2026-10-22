# P15 Setup Save-Error Focus Repair

- **Parent:** `docs/plans/2026-10-20-workspace-redesign-b1.md` T05/P15; refinement `route-acceptance.json` P15 exception and `verification-plan.md` B1-E/B1-I.
- **Finding:** In the isolated browser, a controlled 503 from the P15 title PATCH preserves the 120-character valid draft and shows an alert, but leaves `document.activeElement` on `BODY`. Escape then fails to close the controlled modal; focusing the input restores Escape behavior. Reproduced at 390×844.
- **Goal:** Keep keyboard focus inside the P15 edit dialog after save failure so the user can continue editing, read the error and dismiss the dialog with Escape.
- **Scope:** `SetupSections` / `EditTextDialog` in `app/src/components/bot-profile/setup.tsx` and focused behavior coverage in `app/tests/bot-setup.test.tsx` only. No server/API changes, no broad dialog refactor.
- **Out of scope:** changing field limits (Name 80, Title 120, Role description 1000), changing validation or save behavior, altering user data, or changing the shared Dialog component unless the focused evidence demonstrates its contract is responsible and a separate ownership plan is approved.
- **Execution:** Task 1 `frontend_implementer`; Task 2 `frontend_validator` (read-only); Task 3 `reviewer` (read-only). Serial; no commits. Original HEAD `203d0f0244b2f898218fa12027089c631e8448d9` remains the task base.
- **Consumes:** current inline `EditTextDialog` mutation lifecycle; `Dialog` controlled-focus restoration; the isolated authenticated P15 Bot only for browser regression.
- **Produces:** focus retention/restoration on failed update; a regression that fails if the error removes focus from the editor and confirms Escape dismissal after a controlled failure.

## Global Constraints

- Preserve all existing dirty worktree changes and unrelated hunks. No reset, clean, stash, commit, push, merge, release, publication, deploy, or product dependency installation.
- Do not run OCR, per the explicit user instruction.
- The browser fixture is the dedicated isolated tmpfs database. Intercept the exact Bot PATCH with a synthetic 503; never persist a profile update. Preserve the Bot name/title after browser checks.
- Bind verification and review to the task POST hashes. No source/test mutation by validators or reviewers.

## Task 1 — Retain Editor Focus on Save Error

- **Role:** `frontend_implementer`.
- **Files:** `app/src/components/bot-profile/setup.tsx`, `app/tests/bot-setup.test.tsx` only.
- **Steps:** Add a failing focused test using a rejected agent update; assert error visibility, retained draft, focus remains on the editor field, Escape closes, and focus returns to the invoking Name/Title row. Implement the smallest focus restoration at the dialog's error boundary; keep request and validation semantics unchanged. Run the focused E2E file, scoped Biome and diff check. Record RED/GREEN and POST hashes.
- **Acceptance:** rejected update keeps form value and error; active focus remains within the dialog on the editor field; Escape closes the modal and returns focus to the initiating row; no successful update is recorded.
- **Failure handling:** if happy-dom cannot model the focus transition, keep the behavioral test at the closest supported controlled seam and rely on the real-browser validator for the body-focus/Escape scenario; do not expand into shared Dialog ownership without evidence.

## Task 2 — Independent Validation

- **Role:** `frontend_validator`.
- **Files:** `docs/verification/workspace-redesign/p15-error-focus/VALIDATION.md` only.
- **Checks:** focused prescribed E2E file, scoped Biome, hash stability, isolated browser 390px light/dark. Intercept only `PATCH /api/agents/<fixture-id>` with 503; assert alert, 120-character Title retained, focus within dialog, Escape closes and trigger receives focus, no horizontal overflow. No API writes.

## Task 3 — Independent Spec and Quality Review

- **Role:** `reviewer`.
- **Files:** `docs/plans/reports/T05-P15-error-focus-review.md` only.
- **Checks:** separate Spec compliance and code quality verdicts; report exact files and hashes; inspect focus lifecycle, async state, validation behavior and test coverage. Do not run OCR.

## Review Focus

Does an asynchronous rejected save leave keyboard users inside the controlled modal with the value intact, does Escape still close it, and does focus return to the initiating row without altering success behavior or the Bot profile?
