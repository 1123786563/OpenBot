# T05 Review Repair 01 — Retained Data, Bot-Scoped SMS, Routine Actions

- **Source:** `docs/plans/reports/T05-review.md` findings T05-S1/S2/S3 (all medium).
- **Parent:** `docs/plans/2026-10-20-workspace-redesign-b1.md`, Task 5; source authority P08–P15 and implementation-detail §§5–6.
- **Scope:** Keep loaded Bot content during background profile query errors; bind persisted SMS verification challenge to its Bot and avoid cross-Bot exposure; move routine secondary actions into an accessible menu while preserving existing handlers/confirmation.
- **Constraints:** no API/model authorization change, no new product dependency, no browser acceptance claims, no commits/push/merge/publish. Preserve the existing dirty baseline.
- **Owner:** one serial `frontend_implementer`; then independent `frontend_validator` and `reviewer`.
- **Files:** `app/src/components/bot-profile/bot-subpage.tsx`, `app/src/components/delivery/reaching-you.tsx`, `app/src/components/routines/routines-list.tsx`, `app/src/locales/en/routines.json`, `app/src/locales/zh-CN/routines.json`, `app/tests/bot-reaching-you.test.tsx`, new `app/tests/routines-list.test.tsx`, and new `app/tests/bot-subpage.test.tsx`. Locale paths were added by parent authorization to provide a translated accessible menu trigger; PRE snapshots/hashes were captured before editing. Both new test files are recorded absent in PRE.
- **PRE:** capture complete snapshots and hashes for these paths plus HEAD/status/full tracked patches before editing, under `docs/verification/workspace-redesign/execution/checkpoints/t05-r1/PRE/`.

## Steps and acceptance

1. TDD T05-S1: render prior Bot data while a refetch error is present and surface the refresh error without unmounting route children; only render unreachable state when there is no usable data. Add regression coverage for successful profile load followed by failed refetch and retained child state. Existing guard and initial error behavior remain intact.
2. TDD T05-S2: persist SMS challenge as a versioned, Bot-scoped session value. On a different Bot, do not display or submit the challenge; preserve the original Bot's ability to resume. Clear malformed/legacy unscoped entries safely. Add an A→B→A test proving isolation and same-Bot confirmation.
3. TDD T05-S3: use the existing DropdownMenu wrapper for non-primary routine actions (History/Delete; keep real Run now as the direct primary action if brief/spec supports this hierarchy). Preserve labels, accessible names, delete confirmation and run/history behavior. Add a public DOM interaction assertion.
4. Run relevant native behavior tests through ADR0008 filters and relevant Bun-driven group(s), scoped Biome on changed files, and app typecheck if feasible; record collection/pass/fail/skip and unrelated baseline failures. Do not use browser testing or real data.
5. Capture POST and reversible delta; validate exact hashes. Independent reviewer returns separate Spec/quality verdicts; validator confirms test and checkpoint evidence. Any finding gets a bounded subsequent repair round, not expansion beyond these three findings.

## Failure handling

If source ownership conflicts with later tasks, record a serial transfer and stop other writers. If requirements cannot be met without changing API/security/resource ownership, report the exact conflict and continue independent work; do not guess. All responsive, focus, real permission and rendered acceptance remains pending for the user's later browser test.
