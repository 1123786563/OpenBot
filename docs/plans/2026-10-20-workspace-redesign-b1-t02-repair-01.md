# T02 Review Repair 01 — Control and Popup Geometry

- **Source:** independent task review `docs/plans/reports/T02-review.md`.
- **Parent plan:** `docs/plans/2026-10-20-workspace-redesign-b1.md`, Task 2.
- **Authority:** refinement `implementation-spec.md` §3 and `theme-contract.json`; the explicit user instruction defers rendered browser acceptance until the user tests later.
- **Execution:** one SDD repair round, same `frontend_implementer`, same worktree, no commit. Scope is only the four medium findings listed below; no new design or broad formatting cleanup.
- **PRE:** `docs/verification/workspace-redesign/execution/checkpoints/t02/PRE-R1/`.
- **POST and review package:** `docs/verification/workspace-redesign/execution/checkpoints/t02/POST-R1/`.
- **Report:** append to `docs/plans/reports/T02-impl.md`; independent re-review at `docs/plans/reports/T02-re-review-01.md`.

## Findings in Scope

1. **T02-R1 coarse input hit area:** ensure Input, InputGroup, and QuestionnaireInput remain at least 44×44px on coarse pointers at all responsive widths, including ≥640px. Preserve 36px fine-pointer Input geometry and native props/events.
2. **T02-R2 Sheet surface geometry:** ensure 16px corner radius is not defeated by side placement classes; left/right Sheet is full width below 768px, with desktop width capped by the existing detail-width contract and viewport margin. Preserve ESC stack, focus return, scroll lock, Drawer behavior, and caller overrides.
3. **T02-R3 Dialog bounds:** default dialog surface width is `min(512px, 100vw - 32px)` and max height is `calc(100dvh - 32px)`, with internal scrolling. Preserve intentional full/cover/public size semantics, popup nesting, ESC/focus behavior, and caller overrides.
4. **T02-R4 Combobox popup:** cap total popup height by the available viewport and 320px; keep filters/chips visible and make the result list the shrinking scroll region, not a clipped fixed-height parent. Preserve selection identity, null/textValue, keyboard and portal behavior.

## Owned Files

- `app/src/components/ui/input.tsx`
- `app/src/components/ui/input-group.tsx`
- `app/src/components/ui/questionnaire.tsx`
- `app/src/components/ui/sheet.tsx`
- `app/src/components/ui/dialog.tsx`
- `app/src/components/ui/combobox.tsx`
- T02 behavior tests only if needed to prove these contracts, restricted to `app/tests/button-native.test.tsx` and `app/tests/heroui-spike.test.tsx`.

## Verification and Acceptance

- Add/adjust behavioral assertions before fixes when the existing test seams can represent the contract; never weaken tests.
- Run the affected native tests with ADR0008 and exact `bunx biome check` on files touched. Existing PRE lint diagnostics must be compared and recorded; do not bulk-format unrelated migration code.
- Capture PRE-R1/POST-R1 status, HEAD, staged/unstaged patches, all owned file contents and hashes, and a real PRE-R1→POST-R1 patch. Bind test output and independent re-review to the POST-R1 delta SHA.
- Reviewer must confirm all four findings are addressed and no regression. Browser geometry/computed-style remains pending for the user's later pass; no T02 task is marked verified until its required verification/review is otherwise complete, and no browser pass is claimed.
