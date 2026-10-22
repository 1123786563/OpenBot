# P11 Approval Rule Save-Error Focus Repair

- **Parent:** `docs/plans/2026-10-20-workspace-redesign-b1.md` T05/P11; route acceptance P11; B1-E/B1-I verification cases.
- **Finding:** In the isolated authenticated browser, a controlled 400 from `POST /api/approvals/rules` retains the typed rule and alert, but `document.activeElement` becomes `BODY`; Escape leaves the controlled Add a rule dialog open. Cancel closes it and restores focus. No rule write was accepted.
- **Goal:** Keep keyboard focus on the rule editor after save rejection so the draft can be corrected and Escape can dismiss the dialog.
- **Scope:** `app/src/components/approvals/rules.tsx`, its existing focused behavior test `app/tests/approvals-rules.test.tsx`, and evidence/report files listed in the Task Brief.
- **Out of scope:** API behavior, rule validation, shared Dialog implementation, successful save semantics, existing unrelated dirty hunks.
- **Execution:** Task 1 `frontend_implementer`; Task 2 `frontend_validator`; Task 3 `reviewer`. Serial, no commits. HEAD base `203d0f0244b2f898218fa12027089c631e8448d9`; PRE byte copies and hashes at `docs/verification/workspace-redesign/b1-approval-rule-focus/checkpoints/PRE/`.
- **Consumes:** existing controlled RuleForm and `save` mutation lifecycle; authenticated disposable tmpfs browser fixture and synthetic API response only.
- **Produces:** focus restoration to Tool or app field on rejected save; regression coverage for retained draft/error, focus, Escape, and trigger return.

## Global Constraints

- Preserve all existing dirty work. No reset, clean, stash, commit, push, merge, release, publication, deployment, or product dependency installation.
- Do not run OCR, per explicit user instruction.
- Browser request interception must return synthetic 400 for the exact rule POST; do not create/update a rule.
- Bind validation and reviews to POST hashes. Validators/reviewers are read-only apart from their reports.

## Task 1 — Recover Rule Editor Focus After Rejection

- **Role:** `frontend_implementer`.
- **Files:** `app/src/components/approvals/rules.tsx`, `app/tests/approvals-rules.test.tsx`, `docs/plans/reports/T05-P11-error-focus-impl.md` only.
- **Steps:** First extend the current rejected-save test to assert active focus is in the editor after alert appears, Escape closes the dialog, focus returns to Add a rule, and there is no retry/write. Run once to record RED. Implement the smallest RuleForm-local focus recovery, preserving current save/reset semantics. Re-run focused native test, scoped Biome, and `git diff --check`; report exact hashes.
- **Acceptance:** failed save retains `mcp/nowhere/*` and alert; focus is inside the Tool or app field; Escape closes dialog and returns focus; exactly one failed POST; success behavior unchanged.
- **Failure handling:** if the test environment cannot represent browser focus, keep a supported focused DOM assertion and defer real Escape contract to the independent browser validator; do not broaden Dialog ownership without evidence.

## Task 2 — Independent Validation

- **Role:** `frontend_validator`.
- **Files:** `docs/verification/workspace-redesign/b1-approval-rule-focus/VALIDATION.md` only.
- **Checks:** verify hashes; run the focused test and scoped Biome; browser check at 390×844 in light and dark using an intercepted synthetic 400 for the exact POST. Assert one POST, retained draft and alert, focus within dialog, Escape close, trigger focus restoration, no overflow. No POST reaches API.

## Task 3 — Independent Spec and Quality Review

- **Role:** `reviewer`.
- **Files:** `docs/plans/reports/T05-P11-error-focus-review.md` only.
- **Checks:** separately conclude Spec and code quality; inspect focus lifecycle, mutation timing, close/reset semantics, test fidelity, exact hashes. No production edits; no OCR.

## Review Focus

Does a rejected asynchronous rule save retain keyboard focus in the controlled modal, preserve draft and error, allow Escape dismissal with focus restoration, and leave successful save/API behavior unchanged?
