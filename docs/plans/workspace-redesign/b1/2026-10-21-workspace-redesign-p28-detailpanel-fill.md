# P28 DetailPanel Width Repair

- **Parent plan:** `docs/plans/2026-10-20-workspace-redesign-b1.md` (T03 shared detail-panel compatibility; T08 rendered regression acceptance).
- **Evidence:** authenticated browser capture of `/craft/tasks?new=true` at 1440×900 showed the Craft session roster at 256px and the editor's `DetailPanel` root at only 408px inside the 920px app content area. The new-task Sheet therefore remains modal at desktop width, leaving the expected inline breakpoint unreachable. The parent route is a flex row; `CraftTaskEditorPresenter` currently contributes a non-growing flex item.
- **Goal:** make the P28 task editor's shared DetailPanel consume the remaining width after the Craft session roster. Preserve the existing 879/880px 400px-panel threshold, query-owned open state, draft lifetime, task API behavior, and all other layouts.
- **Out of scope:** changing panel breakpoints, changing task editing/product behavior, redesigning P28, touching the general DetailPanel unless the bounded implementation proves that necessary, or changing persistent data.
- **Owner and order:** Task 1 `frontend_implementer`; Task 2 `frontend_validator`; Task 3 `reviewer`. Serial, no commits. Main agent owns evidence/ledger updates and final integration review.
- **Owned implementation files:** `app/src/components/craft/scheduled-task-editor.tsx`, `app/tests/detail-panel.test.tsx`.
- **Consumes:** T03's route-owned scheduled-task draft in `CraftTaskEditorPresenter`; `DetailPanel`'s existing `< detailWidth + MIN_MAIN_WIDTH` overlay rule; B1 C=879/880 boundary requirement.
- **Produces:** a growing, min-width-safe P28 DetailPanel host; a regression assertion that catches the flex-row shrink-to-content layout; browser evidence that actual container widths 879/880 select Sheet/inline and preserve the `?new=true` draft across the transition.

## Global Constraints

- Preserve every pre-existing uncommitted file and hunk. Use only this linked worktree; no stash, reset, clean, commit, push, merge, publication, deployment, or product dependency installation.
- Do not run OCR, per the user's explicit instruction.
- Keep the fix limited to P28's layout host. Do not alter the 400px panel, `DetailPanel` threshold, session roster, or scheduled-task data/API behavior.
- The browser must remain on the user's isolated tmpfs test database and synthetic authenticated identity. Do not save the form or create a scheduled task.
- Verification evidence must bind to the exact post-edit file hashes. Do not call this full P28 acceptance: the isolated task service is unconfigured and populated task/edit/error variants remain unavailable.

## Task 1 — Grow the P28 DetailPanel Host

- **Role:** `frontend_implementer`
- **Depends on:** none
- **Files:** only the two owned implementation files above.
- **Steps:**
  1. Add a focused failing regression in `detail-panel.test.tsx` that renders `CraftTaskEditorPresenter` as the second child of a flex row after a 256px roster and proves its layout host is configured to take remaining width without shrinking below zero.
  2. Run that focused test and record RED.
  3. Give the presenter root the minimal `flex-1 min-w-0` participation required by its parent row. Keep the shared DetailPanel branches, thresholds, routing, and draft ownership intact.
  4. Re-run the regression and relevant existing Craft/DetailPanel draft tests; run scoped Biome and check whitespace.
  5. Report exact edits, commands/results, file hashes, and any limitation. Do not self-approve.
- **Failure handling:** if the test indicates a shared DetailPanel API change is required, stop before expanding file ownership and report the smallest evidence-backed seam; no unrelated layout change.
- **Acceptance:** the presenter fills available row width and avoids intrinsic-width shrink; existing task draft and A→B isolation tests still pass; no application behavior or URL change.

## Task 2 — Independent Browser/Behavior Validation

- **Role:** `frontend_validator`
- **Depends on:** Task 1 post-edit checkpoint reviewed for hash stability
- **Files:** report under `.archive/runs/2026-10-20-workspace-redesign-b1/verification/p28-layout-repair/`; no source/test edits.
- **Verification:** run the focused native suite and scoped Biome against the exact post-edit hash. In the isolated authenticated browser, measure the actual `DetailPanel` container at 879 and 880px, verify Sheet then inline structure, retain name/prompt/dirty state and `?new=true` through 880→879→880, and confirm document overflow stays absent. Also verify 1440px provides the expected inline panel. Never submit.
- **Acceptance:** all targeted checks pass on unchanged hashes; any failure or inability is recorded precisely.

## Task 3 — Independent Spec and Quality Review

- **Role:** `reviewer`
- **Depends on:** Tasks 1 and 2
- **Files:** read-only report under `.archive/runs/2026-10-20-workspace-redesign-b1/reports/`.
- **Review focus:** P28 shared-panel contract, layout ownership, flex shrink/overflow, responsive boundary behavior, URL and scheduled-task draft preservation, regression test quality, and change scope. Return separate Spec compliance and code-quality conclusions.
- **Acceptance:** both conclusions pass with no actionable finding, or a bounded follow-up plan is required.

## Review Focus

- The final rendered P28 editor must use the available content width in the flex row; the repair must not simply broaden the panel's breakpoint.
- At C=879 the Sheet remains modal; at C=880 the inline 400px panel is present.
- Existing route search and caller-owned task draft remain unchanged across the branch switch.
- The change must not cause horizontal document overflow or introduce global DetailPanel behavior changes.
