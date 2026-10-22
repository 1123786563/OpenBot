# T03 independent Spec and quality review

Scope: the T03 PRE→POST checkpoint only. I read the assigned brief, formal Task 3 and bounded compatibility transfer, `implementation-detail.md` §§3–6, `implementation-spec.md` §5, `CONTEXT.md`, relevant ADR 0008, and the T03 implementation report. The HeroUI migration design and workspace implementation spec files still label themselves drafts; the authorized T03 plan and brief supply the concrete review criteria used here. Browser behavior remains unjudged.

## Checkpoint integrity

- Independently recomputed `delta.patch` SHA-256: `4c22784ae453cc3a8015e063d1f3592f6e4b05d7565cfff7139ba8d0be4f5f7d`, matching the brief.
- PRE and POST manifest SHA-256: `0bd070acc38d03a125400bf53224c005f642244ee42a21d92ddac482c1efb605` and `f864e2e1526d121af0fb0b7d4fda8ce59626d2124a466830c6fb8518bf3204d6`, matching the implementation report. Recomputed all 31 PRE snapshot, POST snapshot, and live worktree file hashes: no mismatches. Nine files differ PRE→POST; the other 22 are unchanged baseline, including the three shell routes, `ui/sidebar.tsx`, and `page-shell.tsx`.
- HEAD remained `203d0f0244b2f898218fa12027089c631e8448d9`. No tests, browser run, OCR, source edit, or remote issue action was performed for this review.

## Findings

### T03-S1 — High — Required shell widths were not implemented

**Evidence / affected files:** Task 3 step 1 and `implementation-spec.md` §5 require app expanded 280px and settings/admin expanded 256px. The unchanged PRE and POST source still passes `width="340px"` in `app/src/routes/_authed/_app.tsx:18`, `width="300px"` in `app/src/routes/_authed/admin/route.tsx:24`, and `width="300px"` in `app/src/routes/_authed/settings/route.tsx:15`. These paths have identical PRE/POST hashes. The T03 implementation report says they are 280/256/256, which the checkpoint does not support.

**Impact:** All three desktop shells consume more width than specified, shifting responsive content thresholds and reducing the space available for the main pane.

**Smallest correction:** Set those three `SidebarShell` widths to 280px, 256px, and 256px, then verify their rendered geometry and affected detail thresholds.

### T03-S2 — Medium — Collapsed rail and mobile drawer dimensions remain at the old values

**Evidence / affected symbol:** Task 3 step 1 and `implementation-spec.md` §5 require a 64px total rail and mobile width `min(280px, 100vw - 32px)`. `app/src/components/ui/sidebar.tsx:32` still defines `SIDEBAR_WIDTH_ICON = "3.2rem"`; the active root font is 16px (`app/src/styles.css:193`), so the normal collapsed spacer at `sidebar.tsx:330` is 51.2px. `sidebar.tsx:297` assigns the mobile Sheet its own `--sidebar-width: SIDEBAR_WIDTH_MOBILE`, which is still `18rem` at line 31 (288px). This inner value overrides `SidebarShell`'s newly assigned `--sidebar-width-mobile` at `app/src/components/layout/sidebar-shell.tsx:62`; the Sheet at `sidebar.tsx:294` uses `w-(--sidebar-width)`. `ui/sidebar.tsx` is byte identical in PRE and POST.

**Impact:** The collapsed rail misses the specified footprint, and the mobile drawer can exceed the target and lose the required 32px viewport margin on narrow screens.

**Smallest correction:** Make the primitive's actual collapsed width 64px including border and its mobile Sheet consume `min(280px, calc(100vw - 32px))`; cover both dimensions at the rendered component boundary.

### T03-S3 — Medium — PageRows radius remains 16px

**Evidence / affected symbol:** Task 3 step 1 specifies 12px. `app/src/components/layout/page-shell.tsx:204` still uses `rounded-2xl`, which is 16px in this Tailwind setup. The file is byte identical in PRE and POST.

**Impact:** Shared settings and admin row groups keep the prior corner geometry across every PageRows consumer.

**Smallest correction:** Apply a 12px radius to PageRows and check row clipping at group corners.

### T03-Q1 — High — Craft edit can permanently skip server seeding after a resize during fetch

**Evidence / affected symbols:** `ScheduledTaskEditor` starts an edit with `emptyForm()` while detail data is pending (`app/src/components/craft/scheduled-task-editor.tsx:218-232`), then unconditionally publishes that empty form through `onDraftChange` in an effect at lines 237-239. The route stores it as the keyed draft (`app/src/routes/_authed/_app/craft/tasks.tsx:60-74`). If the panel crosses the 879/880 threshold before the detail query resolves, `DetailPanel` switches branches (`app/src/components/layout/detail-panel.tsx:70-89`) and remounts the editor. The remount receives the empty draft and initializes `seeded=true` solely because `draft !== undefined` (`scheduled-task-editor.tsx:230-232`), so the `detail.data && !seeded` condition at lines 241-246 can never populate the saved task when the query completes.

**Impact:** An existing scheduled task can appear as a blank new form for the rest of that edit session after a resize. The save validation then rejects empty name/prompt, and the user cannot edit the loaded task without closing and reopening.

**Smallest correction:** Do not publish an edit draft before it is seeded from the task or actually changed by the user. Preserve a separate seeded identity alongside the draft so a remount cannot treat a pending empty form as loaded. Add a delayed-query breakpoint test against the real editor.

### T03-Q2 — Medium — Behavioral tests do not exercise the changed contracts

**Evidence / affected tests:** The added `app/tests/detail-panel.test.tsx:121-174` controls a synthetic textarea in its own parent; it never mounts `SkillFields` or `ScheduledTaskEditor`, so it cannot catch T03-Q1 or prove real Skill/Craft value and dirty retention. Existing `app/tests/sidebar-preference.test.ts` tests only the storage helper, while `app/tests/sidebar-shortcut-layouts.test.tsx` mounts `SidebarProvider` directly, not `SidebarShell`; neither checks zero writes on resize/mobile open or one write on explicit desktop toggle as `implementation-detail.md` §3 requests. The new detail test also omits the specified scroll, URL, close/reopen, and real 879/880 caller cases. The implementation report records the real browser matrix as pending.

**Impact:** The reported 20/20 native pass and driven group passes do not establish the required responsive preference and form lifecycle behavior. The concrete Craft failure above is untested.

**Smallest correction:** Add focused `SidebarShell` preference transition coverage and real Skills/Craft editor breakpoint tests, including pending detail load, value/dirty retention, close/reopen, and caller URL behavior. Keep height and scroll reachability in the browser acceptance matrix.

## Verdicts

**Spec compliance: fail.** The nine-file delta changes the detail threshold and introduces route-owned drafts, but T03-S1 through T03-S3 leave explicit shell geometry requirements unmet. The Craft edit race also violates the required draft retention contract. Source confirms no new storage key, protocol, or server API in the delta; six compatibility files are within the recorded transfer list. `responsiveCompact` follows the prescribed state equation when supplied, but no T03 caller supplies it; the multi-pane caller is scheduled for later work. Rendered geometry, preference write counts, URL/Back, control release, and height-limited scroll remain pending browser acceptance.

**Code quality: fail.** T03-Q1 is a deterministic asynchronous state-ownership defect introduced by the compatibility wiring. T03-Q2 leaves the key observable contracts without behavioral coverage. I found no evidence of an added security data path or new cross-process concurrency mechanism in this T03 delta. The implementation report's targeted native/driven/Biome results are reported evidence, not independently rerun here; its app typecheck is red on the recorded pre-existing `app/tests/button-native.test.tsx:54` error, so this review does not claim a clean typecheck.
