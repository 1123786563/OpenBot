# Task Brief — T05 P15 Error-State Focus

- **Task:** Repair focus loss in the P15 setup edit dialog after a rejected Bot profile PATCH.
- **Plan:** `docs/plans/2026-10-21-workspace-redesign-p15-error-focus.md`.
- **Owner:** `frontend_implementer` (only). No subagents.
- **Workspace:** `/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`.
- **BASE:** `203d0f0244b2f898218fa12027089c631e8448d9`; existing branch worktree remains dirty.
- **Commit policy:** no commits authorized; produce an uncommitted checkpoint.
- **Files you may edit:** `app/src/components/bot-profile/setup.tsx`, `app/tests/bot-setup.test.tsx`, and your implementation report `docs/plans/reports/T05-P15-error-focus-impl.md` only. Do not revert or reformat unrelated hunks.
- **Fact sources:** P15 in `docs/design/2026-10-20-workspace-redesign/handoff/refinement/route-acceptance.json`; B1-E/B1-I in `verification-plan.md`; PRE snapshot at `docs/verification/workspace-redesign/p15-error-focus/checkpoints/PRE/`.
- **Observed contract:** a browser PATCH rejected with a controlled 503 showed the title error and retained its 120-character input, but focus moved to BODY. Escape did not close until the field was manually focused. Cancel then closed and restored the invoking row. The P15 title limit is 120; Bot Name is limited to 80.
- **Acceptance:** add a RED test for rejected save preserving input/error, focus within the text field/dialog, Escape closes, and focus returns to trigger; implement minimal P15-local fix; focused prescribed e2e runner, Biome and `git diff --check` pass. No successful API mutation.
- **Required report:** exact changed files, RED/GREEN commands and outcomes, scoped lint outcome, final SHA-256, any warning/limitation.
- **Preserve:** all existing dirty state. No server changes, no `.env`/database changes, no dependency installation, no OCR, no user data writes, no Git state operation.
