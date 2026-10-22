# P15 Setup Error-Focus Finding

Date: 2026-10-21. Browser: isolated authenticated admin; temporary tmpfs database; viewport 390×844; Bot `agent_023d30c3-2e68-4bd4-a4ab-e2bba67c9fcc`.

## Reproduction

Opened P15 Title editor, entered a valid title, and intercepted only `PATCH /api/agents/<fixture-id>` with a synthetic 503 JSON error. The server did not receive the profile update.

- The inline alert appeared and the title draft remained in the input.
- After the rejected mutation settled, `document.activeElement.tagName` was `BODY`, and the active element was outside `[role=dialog]`.
- Pressing Escape while focus remained on BODY left the dialog open.
- Focusing the title textbox and pressing Escape closed the dialog and restored focus to the invoking Title row.
- Document horizontal overflow remained absent.

Structured evidence: `../t08/browser-smoke-2026-10-21/authenticated/P15-error-focus.json`; screenshot with the open error dialog: `../t08/browser-smoke-2026-10-21/authenticated/P15-error-focus-body.png`.

This reproduced a keyboard-recovery defect, so plan `docs/plans/2026-10-21-workspace-redesign-p15-error-focus.md` records a bounded source/test repair. The separate save-retention matrix used the allowed 120-character **Title** limit and returned the form to the original Bot profile.

During an earlier exploratory diagnostic, one PATCH was accidentally allowed through to this disposable tmpfs database and temporarily changed the Bot Name to `A legal title`. The current Bot Name was verified and restored through the P15 UI to its original `Workspace Browser Fixture` value before continuing. No live or persistent database was used; the correction is explicitly recorded here for provenance.
