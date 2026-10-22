# T03 Review Repair 02 — Exact Radius, Real Breakpoint Tests, Task Identity

> **Execution:** `superpowers:subagent-driven-development`, one `frontend_implementer`, no commits. Scoped only to findings from `docs/plans/reports/T03-R1-review.md`.

**Parent:** B1 T03 and T03 Review Repair 01 (`docs/plans/2026-10-20-workspace-redesign-b1-t03-repair-01.md`). **Input delta:** `checkpoints/t03-r1/delta.patch`, SHA-256 `96ae5928a597c79821f6e9addc0ce9097625a2fbbfbd86c718263ac9af68725d`.

## Findings in scope

1. **T03-R1-S3 (medium):** `rounded-xl` resolves to 11.2px with the active 8px radius token; PageRows requires exactly 12px.
2. **T03-R1-Q2 (medium):** pending Craft query test toggles a child label but never resizes DetailPanel, so it does not exercise a remount.
3. **T03-R1-Q2b (medium):** SidebarShell test covers only the missing preference, doesn't assert effective state/precedence, and directly calls `setOpen(false)` instead of a public toggle.
4. **T03-R1-Q3 (high):** switching edit identity from task A to B reuses editor local state and can publish/save A's values under B.

## Task R2

- **Role:** `frontend_implementer`; validator `frontend_validator`; reviewer `reviewer`.
- **Files:** `app/src/components/layout/page-shell.tsx`, `app/src/components/craft/scheduled-task-editor.tsx`, `app/src/routes/_authed/_app/craft/tasks.tsx`, and `app/tests/detail-panel.test.tsx`. Touch other T03 R1 test files only if the actual test ownership requires it, and list them explicitly before editing. No route, server, persistence, or business-protocol changes.
- **PRE/POST:** capture all changed source/test files before/after plus HEAD/status/staged/unstaged and full contents/hashes; create an exact reversible delta under `checkpoints/t03-r2/`.
- **Steps:**
  1. Set PageRows radius to explicit 12px, not a radius-scale alias, and add a source-contract assertion if the component test seam allows it.
  2. Change the Craft pending-query test to drive the existing `ResizeObserver` helper at 880→879→880 (or the actual equivalent threshold), assert inline→Sheet→inline, then resolve the query and verify loaded server fields and clean dirty state. Keep query resolution asynchronous.
  3. Exercise SidebarShell from each `missing`, `expanded`, `collapsed` stored state. Assert initial state, responsive compact state and zero storage writes, restore state without writes, and click the public desktop SidebarTrigger/shortcut once to assert the resulting persisted value and exactly one write. Keep the mobile no-write test separate.
  4. Bind the editor instance to its edit identity at the route boundary or reset all edit form/seed state on `taskId` changes before publishing or saving. Add a task A→B test proving B loads B values and only submits B payload. Preserve a dirty draft for the same identity across breakpoint remounts; don't leak draft A to B.
- **Verification:** targeted native tests under ADR0008 and scoped Biome; app typecheck outcome. No browser checks; rendered tests deferred to user. Bind evidence to POST delta hash.
- **Acceptance:** exact 12px, truthful breakpoint transition and preference tests, no stale cross-task state or payload, preserve existing async query seeding and draft/dirty behavior, no storage or API additions. Findings stay open if tests do not execute the stated transition.

## Review focus

Exact radius resolution; true measured width transition; three persisted startup values and public user toggle; query pending → remount → response; task identity changes and mutation payload targeting; same-task value/dirty retention; scope and baseline preservation.
