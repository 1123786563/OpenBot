# T03-R3 independent Spec and quality review

Scope: the R3 PRE→POST increment, R2-Q1, the R3 plan and brief, the workspace implementation spec/detail, CONTEXT.md, and ADR 0008. The design documents still label themselves pending user review; the authorized R3 plan and brief provide this repair's concrete acceptance criteria. This was a read-only source and checkpoint review. I did not run tests, browser checks, or OCR.

## Checkpoint integrity

- Recomputed `delta.patch` SHA-256: `2fa11e9486f630e2f36760cca66a2fa47c8424692ab047e4f0dda2b266e1cb2e`, matching the brief and implementation report. `git apply --check --reverse` succeeds against the live worktree. PRE and POST record the same HEAD, `203d0f0244b2f898218fa12027089c631e8448d9`.
- Recomputed PRE and POST manifest SHA-256: `a4f8b6a484843738b42387171712d255bdda34791bc9b5273f15bd5e0c5a2397` and `b686d62703ad13bed9e3aae1be29e9fcd6df5aea8fe7d8b7c7c162c252bd8d97`, matching the implementation report. All three PRE and POST snapshots match their recorded byte counts and SHA-256 values. All three POST files match the live worktree.

## R2-Q1 disposition

**Resolved.** `CraftTasksPage` renders `CraftTaskEditorPresenter` at `app/src/routes/_authed/_app/craft/tasks.tsx:62-67`. The presenter itself owns the draft, derives `editorKey`, selects only its matching draft, keys the real `ScheduledTaskEditor`, and places it inside the real `DetailPanel` at `app/src/components/craft/scheduled-task-editor.tsx:724-759`. The test imports that presenter at `app/tests/detail-panel.test.tsx:12` and supplies only `taskId` at lines 422-436; it contains no independently authored key expression.

The behavior test loads A, invokes the mounted name input's change handler, and confirms both the entered value and `data-dirty="true"` at lines 438-465. Its ResizeObserver helper supplies the actual panel root width, and the test asserts inline→Sheet→inline at 880→879→880, then confirms the dirty A value remains at lines 466-477. It changes the same mounted presenter's props to B and asserts B's loaded name/prompt, absence of A's dirty name, and one save targeting `/B` with B's name and prompt at lines 479-493. The pending-query case also uses the production presenter and checks the same branch round trip before resolving, then verifies the loaded name and clean state at lines 307-385. These assertions would fail if the presenter's keyed editor identity or draft selection were removed in the A→B path.

The test calls the mounted input's private React `onChange` prop at lines 441-455 because the recorded HappyDOM setup does not dispatch a usable controlled change event through HeroUI/React Aria. This is brittle if React's internal prop storage changes, but it reaches the real editor callback at `scheduled-task-editor.tsx:365-372`; the rendered value and dirty state assertions prevent an absent handler from producing a false pass. It is meaningful evidence for the production state seam, while native user event behavior remains outside this test's proof.

The presenter clears its draft when `active` becomes false (`scheduled-task-editor.tsx:737-739`), and the route's close callback clears the search state (`craft/tasks.tsx:57,63-66`). The close/reopen reset is not newly asserted in R3, but these paths preserve the pre-R3 contract by source inspection. The pending edit form still avoids publishing an empty draft before query seeding (`scheduled-task-editor.tsx:238-249`).

## Findings

No new critical, high, or medium finding in the R3 increment. The private React-prop handler is a **low-severity test maintenance risk**, affecting `app/tests/detail-panel.test.tsx:441-455`: a future React/HeroUI change could require adapting the harness. Its impact is test fragility, not a presently false-green state assertion. The smallest correction, if the harness later supports it, is to dispatch a supported user input event through the public input seam while retaining the rendered value/dirty assertions. It does not block this scoped review.

## Verdicts

**Spec compliance: pass for R3's scoped repair.** R2-Q1 is addressed through the production presenter, dirty same-identity resize, B identity loading and B-only save, and pending-query seeding. No API, storage, or business protocol change appears in this increment. Rendered browser acceptance remains deferred as directed.

**Code quality: pass with the low-severity harness limitation above.** The state owner remains outside the responsive branch, identity isolation is centralized, and the close reset path remains intact. The implementation report records 7/7 targeted native tests and scoped Biome passing; I did not rerun them. App typecheck remains red on the previously recorded unrelated `app/tests/button-native.test.tsx:54` callback-ref error, so this review does not claim a clean app typecheck.
