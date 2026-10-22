# Task Brief — T03 P28 DetailPanel Width Repair

- **Plan:** `docs/plans/2026-10-21-workspace-redesign-p28-detailpanel-fill.md`
- **Task:** 1 — Grow the P28 DetailPanel Host
- **Agent role:** `frontend_implementer`
- **Worktree:** `/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`
- **Commit policy:** no commit; deliver an uncommitted checkpoint and report.
- **PRE checkpoint:** `docs/verification/workspace-redesign/p28-layout-repair/checkpoints/PRE/`
- **Inputs:** `docs/design/2026-10-20-workspace-redesign/handoff/refinement/implementation-spec.md` (P28/shared DetailPanel contract); `docs/design/2026-10-20-workspace-redesign/handoff/refinement/implementation-detail.md` §4; `docs/design/2026-10-20-workspace-redesign/handoff/refinement/verification-plan.md` B1-C and shared regression smoke; parent T03 ledger entry in `docs/plans/2026-10-20-workspace-redesign-b1-ledger.md`.
- **Observed defect:** in the authenticated isolated browser at 1440×900, `/craft/tasks?new=true` renders a 408px `DetailPanel` container in a flex row with a 256px `SessionSidebar`; the 920px app content area leaves unused space and the editor remains a modal Sheet. The 400px-panel C=879/880 boundary is consequently not reachable in this route.
- **Acceptance:** make the DetailPanel host the remaining-width flex item using the minimal layout class change; add a focused regression assertion; preserve query, draft, submit contract and panel thresholds. Scope is limited to these files:

  - `app/src/components/craft/scheduled-task-editor.tsx`
  - `app/tests/detail-panel.test.tsx`

- **Required loop:** write/run the focused RED test, implement, then run the focused native test, relevant existing Craft draft test, scoped Biome and diff-check. Record commands, exit codes, and post-edit file hashes in `docs/plans/reports/T03-P28-layout-repair-impl.md`.
- **Constraints:** no other files; no database writes/task creation; no product dependency installation; no commit. Do not change `DetailPanel` thresholds or any generic shell. Do not dispatch agents.
- **Stop condition:** if the scope cannot be met with the two owned files, stop and report the evidence-backed seam without editing additional files.
