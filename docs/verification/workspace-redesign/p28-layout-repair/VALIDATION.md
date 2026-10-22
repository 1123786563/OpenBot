# P28 DetailPanel Width Repair — Validation

- **Status:** PASS for the bounded layout repair; broader P28 data-backed acceptance remains unavailable because the isolated scheduled-task service is unconfigured.
- **Revision:** `203d0f0244b2f898218fa12027089c631e8448d9` (working tree; target files modified, no task implementation report/POST checkpoint was present).
- **Validated target files:** `app/src/components/craft/scheduled-task-editor.tsx`, `app/tests/detail-panel.test.tsx`. Shared `app/src/components/layout/detail-panel.tsx` is also modified in this worktree, so browser evidence covers the combined dirty state rather than isolating the P28 delta.
- **SHA-256 at validation:** scheduled-task-editor `63f99bf6aedfe1886bb663074c7d2ca0c956b44edd90287f5d493a1a5cf43514`; detail-panel.test `cc5ea9d8f45b6406d8f83a941434d1c54853d1b1c8316f3f1408d6db52b31f9a`.

## Commands and results

- `bunx e2e run --config e2e.unit.config.ts app/tests/detail-panel.test.tsx --output .e2e-p28-validation` — **PASS**, 1 file / 11 tests. This includes the fixed-roster flex host assertion and draft resize tests. The runner emitted recurring React Aria `PressResponder` warnings and noted an unrelated server test collection skip (`bun:` protocol).
- `bunx biome check src/components/craft/scheduled-task-editor.tsx tests/detail-panel.test.tsx` (from `app/`) — **PASS**, 2 files checked.
- `bun test ./tests/detail-panel.test.tsx` (from `app/`) — **NOT RUNNABLE** under this environment: `SyntaxError: Export named 'registerHooks' not found in module 'node:module'`. The e2e dispatcher above is the repository-prescribed runner and passed.

## Browser evidence

Connected to the existing Chrome CDP target `http://127.0.0.1:9223`, app `http://127.0.0.1:3011/craft/tasks?new=true`; set viewport sizes through CDP and inspected rendered DOM. No Create/Save action was triggered. At 1440 viewport, the DetailPanel host measured 904px; at 1415 and 1416 viewport it measured 879px and 880px respectively. A synthetic name and prompt draft remained present through 879→880→1440, URL stayed `?new=true`, and `document.documentElement.scrollWidth <= innerWidth` throughout. App was reloaded afterward to clear the validation-only draft.

The first validator observation incorrectly reported a Sheet at 1440 because it sampled the page before the responsive `ResizeObserver` update had been observed (the browser was at 1200px when validation ended). A stable recheck after setting the viewport and waiting 450–500ms measured the DetailPanel host directly and confirmed the intended branch at every target:

| Viewport | DetailPanel container | Rendered branch | Draft | URL | Document overflow |
| ---: | ---: | --- | --- | --- | --- |
| 1415×900 | 879px | Sheet | retained | `/craft/tasks?new=true` | none |
| 1416×900 | 880px | inline | retained | `/craft/tasks?new=true` | none |
| 1416×900 after returning from 879 | 880px | inline | retained | `/craft/tasks?new=true` | none |
| 1440×900 | 904px | inline | retained | `/craft/tasks?new=true` | none |

The draft used name `P28 viewport draft` and prompt `Retain across the responsive branch.`; `data-dirty` stayed `true` for each measurement. No Create/Save action was triggered. The validation-only draft was cleared by reloading the page. Sidebar persisted state was not changed. Browser testing used direct CDP because the `browser-use` CLI was unavailable and CUA listed no browser surface.

## Risks / limits

- The worktree contains extensive unrelated dirty changes, including the shared DetailPanel implementation, so the browser validates the delivered combined worktree state. Independent source review found no P28 production changes beyond the scheduled-task presenter file and approved test file.
- The task implementation report and source/test hashes are recorded in `docs/plans/reports/T03-P28-layout-repair-impl.md`; independent review is `docs/plans/reports/T03-P28-layout-repair-review.md`. No source or test files were modified during validation; only this report and local test output were written.
