# T03-R3 Independent Validation

**Status:** `DONE_WITH_CONCERNS` — the requested unit behavior and scoped formatting checks pass. Browser rendering and real user input dispatch remain unverified by this HappyDOM test.

## Revision and scope

- Worktree: `/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`
- HEAD: `203d0f0244b2f898218fa12027089c631e8448d9` (checkpoint PRE and POST HEADs match).
- Scope: `docs/plans/task-briefs/T03-R3-validation.md` and checkpoint `t03-r3`.
- No source or test files were modified. Only this validation report was written.
- The worktree contains many unrelated staged, unstaged, and untracked changes; the evidence below is tied to the named checkpoint and three-file scope.

## Checkpoint integrity

Commands:

```sh
sha256sum docs/verification/workspace-redesign/execution/checkpoints/t03-r3/delta.patch
sha256sum app/src/routes/_authed/_app/craft/tasks.tsx app/src/components/craft/scheduled-task-editor.tsx app/tests/detail-panel.test.tsx
```

Results: exit 0. The delta hash is `2fa11e9486f630e2f36760cca66a2fa47c8424692ab047e4f0dda2b266e1cb2e`, matching the brief and `delta.sha256`. The three live file hashes match the POST manifest:

- `tasks.tsx`: `a8546e8520c1d6f7deb26a0f240cc3b7951afc18e59e1bb0de1ee356dcefc845`
- `scheduled-task-editor.tsx`: `f2650f8a7b3ce0689712bf8cd99260311eff2aa1d277a1179b22fb6acd4e4815`
- `detail-panel.test.tsx`: `1f0b70388eeecc16777f1a034338ce2d1a322550602f9fe081ebf87e129b66ad`

## Verification

| Command | Exit | Result |
| --- | ---: | --- |
| `bunx e2e run --config e2e.unit.config.ts app/tests/detail-panel.test.tsx` | 0 | 1 file, 7 tests passed, including `production task presenter retains dirty A across resize and isolates B`. Non-fatal HeroUI `PressResponder` warnings and example `KEY_ENCRYPTION_KEY` warnings appeared. |
| `bunx biome check app/src/routes/_authed/_app/craft/tasks.tsx app/src/components/craft/scheduled-task-editor.tsx app/tests/detail-panel.test.tsx` | 0 | 3 files checked; no fixes applied. |

## Acceptance evidence and limitations

- **Shared production seam:** the production route renders `CraftTaskEditorPresenter` from `scheduled-task-editor.tsx`; the test imports and renders that same presenter.
- **Key ownership:** the test supplies `taskId` but no React `key`. The presenter derives `editorKey` from create/task identity and applies it to `ScheduledTaskEditor`, so editor remount identity is owned by production code.
- **Dirty A survives resize remount:** the test drives its `ResizeObserver` stub through widths 880→879→880, verifies Details changes between inline and dialog presentations, and then verifies the edited name and `data-dirty="true"` remain. This is an actual component transition using the app's resize observer path, but it is a synthetic observer callback in HappyDOM rather than browser geometry.
- **B isolation and save payload:** rerendering with task ID B loads `Task B` and `Prompt B`, discards A's dirty value, and saving records a PUT path containing `/B` with B's name and prompt.
- **Input dispatch limitation:** HappyDOM/React `fireEvent.change` did not reliably trigger the controlled editor's React change handler in this setup. To establish the dirty-A state, the test calls the input's internal `__reactProps$...onChange` handler directly. Consequently the assertions cover presenter state retention and B's save payload, but do not prove that a real browser-generated input event enters that state correctly. Browser tests were explicitly deferred in the brief.
- **Browser/accessibility/responsive behavior:** no browser or assistive-technology run was requested or performed. The test asserts roles and the resize-driven dialog transition, but does not establish rendered geometry, keyboard interaction, or screen-reader behavior.

No acceptance failure was observed in the scoped suite. The limitations above mean this report does not establish browser-level resize geometry or real input dispatch.
