# T03-R2 independent Spec and quality review

Scope: the R2 PRE→POST delta against the assigned R2 plan and brief, R1 findings, the workspace implementation spec/detail, CONTEXT.md, and ADR 0008. The workspace implementation spec still labels itself pending user review; the authorized R2 plan and brief provide the concrete criteria for this repair. This was a read-only review of source and recorded verification. I did not run tests, browser checks, or OCR.

## Checkpoint integrity

- Recomputed `delta.patch` SHA-256: `07112110f7c895f1df16dd05188c82d9efe9d5b74a7ef2477aaac96500dbe687`, matching the brief and implementation report. `git apply --check --reverse` succeeds against the live worktree.
- Recomputed PRE and POST manifest SHA-256: `b3247d909ad5413e7e18ac388d8d2c0f18b4f130b0d9c265a93541fd6b78383c` and `7b82c6ffc529624499699bcdf18446636b81e427b2ba4136e70638bae408b986`, matching the implementation report. All four files in each snapshot match their recorded byte count and SHA-256; all four POST files match the live worktree. Three files changed. `scheduled-task-editor.tsx` is byte identical PRE→POST.

## Finding

### R2-Q1 — Medium — Identity and dirty-draft regression tests bypass the route owner

**Evidence / affected test:** The new A→B test constructs its own `DetailPanel` and `ScheduledTaskEditor` in `app/tests/detail-panel.test.tsx:436-454`, including a hand-written `key={\`edit:${taskId}\`}` at line 445. It never renders `CraftTasksPage`, whose key and route-owned draft are the actual fix at `app/src/routes/_authed/_app/craft/tasks.tsx:60-74,84-103`. Removing the production key or misrouting `currentDraft` would leave this test green. The test also switches from an untouched loaded A to B (`detail-panel.test.tsx:456-472`), so it never checks that a dirty A draft stays out of B. The only dirty-state breakpoint test uses a synthetic `DraftOwner` (`detail-panel.test.tsx:125-177`), and the real editor's pending-query test resolves immediately after the remount without editing a same-task draft (`detail-panel.test.tsx:307-399`).

**Impact:** The route-level wrong-task save regression and the same-task dirty draft handoff can recur without failing the targeted tests. The source fix looks correct by inspection, but its behavioral guard is weaker than the R2 acceptance and review focus require.

**Smallest correction:** Exercise the route-owned editor path, or a shared route-owned presenter used by both production and test, through A dirty → B load/save and a same-task 880→879→880 dirty draft round trip. Assert B-only payload and retained value plus `data-dirty` for the unchanged identity.

## Repaired findings and limits

- **R1-S3:** `PageRows` now uses literal `rounded-[12px]` at `app/src/components/layout/page-shell.tsx:204`; this meets the source contract independently of the 8px radius token. Its surrounding comment still says 16px at lines 197-199; that stale comment is low impact.
- **R1-Q2:** The pending-query test now drives the observed container width 880→879→880 and asserts inline→dialog→inline before resolving the response (`detail-panel.test.tsx:359-395`). `DetailPanel` uses the strict `< detailWidth + 480` predicate at `app/src/components/layout/detail-panel.tsx:57-61`, so the test traverses the intended branch boundary. Loaded name and clean dirty state are asserted.
- **R1-Q2b:** The SidebarShell test covers missing, `expanded`, and `collapsed` storage states, effective state during and after responsive compact, zero writes for those transitions, then one public `SidebarTrigger` click and one expected persisted write (`detail-panel.test.tsx:179-260`). The separate mobile toggle test still asserts no desktop preference write.
- **R1-Q3:** The route now keys both create/edit editor elements by `editorKey` (`craft/tasks.tsx:60,87-100`). React remounts when the edit ID changes; `currentDraft` is selected only for the matching key at lines 61-67. The editor's pending seed guard remains in place at `scheduled-task-editor.tsx:227-249`. This removes the identified A-state-under-B path by source inspection, subject to the test gap above.
- The implementation report records 7 native tests and scoped Biome passing; I did not rerun them. Its app typecheck remains red on the previously recorded, unrelated `app/tests/button-native.test.tsx:54` callback-ref error. Rendered geometry and browser acceptance remain deferred.

## Verdicts

**Spec compliance: pass for the R2 source changes, with behavioral acceptance incomplete.** The four R1 corrections are supported by the inspected source and targeted test assertions. The route-owned dirty-draft scenario is not proven by the added tests; browser geometry is unjudged. No storage key, server API, or business protocol change appears in this delta.

**Code quality: fail for the R2 regression gate.** R2-Q1 is a medium missing behavioral test at the state-ownership seam that caused the high-severity R1 defect. I found no new security or cross-process concurrency issue in the three-file delta. The reported typecheck is not clean, and this review makes no claim about browser behavior.
