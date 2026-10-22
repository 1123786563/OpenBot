# T03-R1 independent Spec and quality review

Scope: the R1 PRE→POST delta only, assessed against the T03 repair plan, prior T03 findings, the authorized T03 task, workspace implementation spec/detail, CONTEXT.md, and ADR 0008. No tests, browser checks, OCR, source edits, commits, or remote issue actions were performed.

## Checkpoint integrity

- Recomputed `delta.patch` SHA-256: `96ae5928a597c79821f6e9addc0ce9097625a2fbbfbd86c718263ac9af68725d`, matching the brief.
- Recomputed PRE and POST manifest SHA-256: `8dde8dc428eb4f297f196488de666fa3f0ba808988b084fbf483d761a7bae904` and `374a2d3b2239fa87f556f0d150f2e1e97e86474065a9608c11c7fa74cdb9dd60`, matching the implementation report. All 14 files in each snapshot match their manifest hash and byte count; all 14 POST files match the live worktree. Eight files differ PRE→POST.

## Spec findings

### R1-S3 — Medium — PageRows still does not have the required 12px radius

**Evidence / affected symbol:** `PageRows` now uses `rounded-xl` at `app/src/components/layout/page-shell.tsx:204`. This class resolves through `--radius-xl: calc(var(--radius) * 1.4)` at `app/src/styles.css:162`; both themes set `--ob-radius: 8px` at `app/src/styles/tokens.css:55,130`, and the theme maps `--radius` to `--ob-radius`. Thus the source contract is 11.2px, while `implementation-spec.md` §4 and T03 step 1 require 12px. The repair's class-name change alone does not establish the specified geometry.

**Impact:** Shared settings/admin row groups remain below the specified corner radius. **Smallest correction:** give PageRows an explicit 12px radius or a token whose computed value is exactly 12px, then include this value in geometry verification.

### R1-Q2 — Medium — The breakpoint regression test never crosses a breakpoint

**Evidence / affected test:** The new Craft test at `app/tests/detail-panel.test.tsx:340-367` only rerenders `Harness` with `compact` true/false. That prop changes an `<output>` string at line 357. `DetailPanel` chooses Sheet versus inline solely from its measured container width and `ResizeObserver` at `app/src/components/layout/detail-panel.tsx:54-70`. This test never calls the existing `resize(...)` helper or asserts a dialog/inline transition. The editor therefore remains on one branch, so the test cannot prove pending query → breakpoint remount → loaded seed, the required R1-Q2 regression.

**Impact:** A future regression that publishes an unseeded draft only on remount could pass this test. **Smallest correction:** drive the `Observer` at 880→879→880 (or equivalent widths), assert the branch transition, then resolve the delayed query and inspect the loaded editor state.

### R1-Q2b — Medium — Preference transition coverage omits required stored states

**Evidence / affected test:** The SidebarShell test clears storage and only checks the missing-key initial state at `app/tests/detail-panel.test.tsx:180-266`; it does not mount with stored `expanded` or `collapsed`, does not assert effective open state after `responsiveCompact`, and calls `setOpen(false)` directly instead of exercising a toggle at lines 212-258. `implementation-detail.md` §3 explicitly requires missing/expanded/collapsed initial conditions and zero writes on responsive changes, one write on explicit desktop toggle.

**Impact:** The test can pass even if restored preferences or the user toggle precedence are wrong. **Smallest correction:** parameterize the three stored conditions, assert rendered/effective state before and after compact changes, and click the public SidebarTrigger or shortcut once to verify the stored value and write count.

## Code-quality findings

### R1-Q3 — High — Switching directly between edit IDs reuses the previous task draft

**Evidence / affected symbols:** `CraftTasksPage` keys its route-owned draft by `editorKey` (`app/src/routes/_authed/_app/craft/tasks.tsx:60-74`) but renders each edit as the same unkeyed `ScheduledTaskEditor` at lines 93-100. React therefore retains that component when search changes from `edit=A` to `edit=B`. `ScheduledTaskEditor` initializes `form` and `seeded` only once (`app/src/components/craft/scheduled-task-editor.tsx:227-233`), and its server seeding runs only when `!seeded` (lines 244-249). The R1 effect guard also checks only whether *some* edit is seeded (lines 237-242). The new test fixes `taskId="task-1"` throughout and cannot catch this transition.

**Impact:** Directly selecting task B while task A is open can display A's values and publish them under B's route key. Saving can then send A's name/prompt/schedule to B's update mutation, a data consistency defect. **Smallest correction:** key the editor instance by create/edit identity at the route boundary, or reset editor state when `taskId` changes before publishing or saving; add an A→B behavioral test that confirms B's loaded values and B-only save payload.

## Evidence for repaired items and limits

- T03-S1 is corrected in source: app `280px`, admin/settings `256px` at `app/src/routes/_authed/_app.tsx:18`, `admin/route.tsx:24`, and `settings/route.tsx:15`.
- T03-S2 is corrected at the source variable/class level: `SIDEBAR_WIDTH_ICON="64px"` feeds both normal collapsed spacer and container (`app/src/components/ui/sidebar.tsx:30,328-339`); `SidebarShell` supplies `--sidebar-width-mobile: min(280px, calc(100vw - 32px))` and the mobile Sheet's `--sidebar-width` refers to that variable with the same fallback (`sidebar-shell.tsx:54-59`, `ui/sidebar.tsx:28-29,292-297`). Rendered widths and portal cascade were not observed here.
- T03-Q1's specific pending-empty-draft publication is blocked by the new `taskId && !seeded` guard (`scheduled-task-editor.tsx:237-242`); the query remains pending until data arrives and the editor can seed at lines 244-249. The new loading branch provides a pending status. The test gap above limits behavioral confidence in the breakpoint case.
- The implementation report records 13 targeted native tests passed and Biome passed. Those results were not rerun. Its app typecheck remains red on the pre-existing `button-native.test.tsx:54` error. Browser geometry, actual portal styles, scroll/URL behavior, and rendered acceptance are pending.

## Verdicts

**Spec compliance: fail for R1.** S1/S2 and the narrow Q1 guard are supported by source evidence. S3 remains numerically wrong, and required breakpoint and preference behavior are still not exercised by the added tests. Rendered acceptance is unjudged.

**Code quality: fail for R1.** The editor's local state is not tied to its task identity, allowing a wrong-task edit/save path. The new tests miss that path and the claimed breakpoint remount. No new security data path or cross-process concurrency mechanism appears in this eight-file delta.
