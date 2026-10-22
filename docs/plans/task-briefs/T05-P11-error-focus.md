# Task Brief — T05 P11 Save-Error Focus

- **Task:** Repair focus loss after rejected approval-rule save.
- **Plan:** `docs/plans/2026-10-21-workspace-redesign-p11-error-focus.md`.
- **Owner:** `frontend_implementer` only.
- **Workspace:** `/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`.
- **BASE:** `203d0f0244b2f898218fa12027089c631e8448d9`; preserve dirty workspace.
- **Commit policy:** no commit; uncommitted checkpoint.
- **Files:** `app/src/components/approvals/rules.tsx`, `app/tests/approvals-rules.test.tsx`, `docs/plans/reports/T05-P11-error-focus-impl.md` only. Existing unrelated dirty hunks in both source/test files are pre-existing and must remain unchanged.
- **PRE:** `docs/verification/workspace-redesign/b1-approval-rule-focus/checkpoints/PRE/` with SHA256SUMS.
- **Finding:** synthetic POST 400 retained draft/error but focus went to BODY; Escape did not close; Cancel restored trigger. The initial isolated run made one intercepted POST and no rule mutation.
- **Acceptance:** add RED coverage, then minimal local focus repair; rejected save retains exact rule and error; editor focus restored; Escape closes and trigger receives focus; one rejected POST only. Run focused native test, scoped Biome, diff check. Report RED/GREEN and file hashes.
- **Constraints:** no API/shared Dialog changes, no database write, no OCR, no dependencies, preserve all existing changes.
