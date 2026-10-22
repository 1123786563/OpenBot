# T03 Review Repair 01 — Shell Geometry, Craft Seeding, and Behavioral Coverage

> **Execution:** `superpowers:subagent-driven-development`, one `frontend_implementer`, no commits. This is a scoped repair of findings from `docs/plans/reports/T03-review.md`; no original T03 task is being restarted.

**Source / parent:** T03 in `docs/plans/2026-10-20-workspace-redesign-b1.md`; review of `checkpoints/t03/delta.patch` (`4c22784ae453cc3a8015e063d1f3592f6e4b05d7565cfff7139ba8d0be4f5f7d`).

## Findings in scope

- **T03-S1 (high):** shell expanded widths were not changed; app/admin/settings remain 340/300/300 instead of 280/256/256.
- **T03-S2 (medium):** collapsed rail remains 3.2rem (51.2px at 16px root) and mobile Sheet remains hardcoded at 18rem, overriding the intended width.
- **T03-S3 (medium):** PageRows remains `rounded-2xl` (16px) instead of 12px.
- **T03-Q1 (high):** a pre-seed empty Craft edit draft can be persisted to the route; if resize remounts the editor while data is pending, the empty draft is then mistaken for seeded state and server data is never loaded.
- **T03-Q2 (medium):** available native tests do not exercise SidebarShell persistence transitions or actual transferred Skills/Craft editor state across remounts; improve the closest behavior seams and add a pending-query seed regression.

## Constraints

Preserve the original T03 implementation and all user baseline edits. Do not commit, push, merge, publish, install dependencies, change APIs/data protocols, add storage for drafts, or redesign Skills/Craft pages. Continue to defer rendered/browser acceptance for the user. Preserve DetailPanel's controlled URL/open contract, explicit close/unmount behavior, 400px default detail width, and 480px main minimum.

## Task R1

- **Owner / validator / reviewer:** `frontend_implementer` / `frontend_validator` / `reviewer`.
- **Files owned for this repair:** `app/src/routes/_authed/_app.tsx`, `app/src/routes/_authed/admin/route.tsx`, `app/src/routes/_authed/settings/route.tsx`, `app/src/components/ui/sidebar.tsx`, `app/src/components/layout/page-shell.tsx`, `app/src/components/craft/scheduled-task-editor.tsx`, `app/src/routes/_authed/_app/craft/tasks.tsx`, and behavior test files `app/tests/detail-panel.test.tsx`, `app/tests/sidebar-preference.test.ts`, `app/tests/sidebar-shortcut-layouts.test.tsx`, plus one new focused test file only if needed. Existing T03 transferred Skills owner files may be touched only to complete a failing real-form test discovered in this repair; such changes must remain draft-state-only and named in the repair report.
- **PRE/POST:** capture all owned source/test files, their SHA/bytes, HEAD, status, staged/unstaged patches before and after; store beneath `checkpoints/t03-r1/`. Create a real PRE→POST package that reverses and hash-validates.
- **Consumes:** T03 POST checkpoint and findings above. No new API beyond T03's current `responsiveCompact` and draft callback props.
- **Steps:**
  1. Change shell expanded widths to app 280px and admin/settings 256px.
  2. Correct the actual Sidebar primitive values used by spacer and mobile Sheet: total collapsed footprint 64px including border; mobile drawer `min(280px, calc(100vw - 32px))`. Ensure SidebarShell's supplied variable is the variable the Sheet consumes.
  3. Set PageRows radius to 12px.
  4. Keep a pending Craft edit query distinct from an actual route-owned draft. Do not publish an empty unseeded edit form as a saved draft; after remount, seed from loaded server data unless a user-edited draft for the same task exists. Preserve create/edit identity, dirty state and existing save/run/delete behavior.
  5. Add deterministic native behavior coverage for width constants/classes, SidebarShell missing/expanded/collapsed preference transitions (resize/mobile do not write; explicit desktop toggle writes once), DetailPanel value/dirty retention, and Craft pending-query → breakpoint remount → loaded task seed. Add/adjust a Skills draft remount seam if the current native coverage cannot prove its prop handoff. Tests must assert observable value/state, not stable DOM identity.
- **Verification:** run only applicable tests via ADR0008's native/driven commands, plus `bunx biome check` on the exact changed files. Run app typecheck and report unrelated errors without modifying files outside ownership. No browser checks. Bind every result to the POST delta hash.
- **Produces:** corrected source contracts and behavior tests. **Acceptance:** every finding is fixed at source/test level; native tests collect and pass; no new persistence key or business protocol; no false claim of rendered geometry. **Failure handling:** if the test runner cannot model an existing component seam, record concrete evidence and use the narrowest testable public contract; do not weaken the requirement or silently park the finding.

## Interfaces and consistency precheck

- Shell widths flow through existing `SidebarShell.width`.
- Sidebar uses the actual existing `--sidebar-width-mobile` / collapsed width inputs; no duplicate sizing source.
- PageRows stays the existing shared component.
- Craft route remains the owner of `ScheduledTaskDraft`; editor reports only a loaded or edited draft of the current task.
- `DetailPanel` open/close/navigation props remain unchanged.
- The findings and acceptance are all mapped to R1; no dependency edges or source scope beyond the listed files are introduced.

## Review focus

All five findings above, async query seeding across remount, preference write counts/event paths, exact 64px and 280/256 widths in source utility contract, dirty-state preservation, and no unrelated baseline changes.
