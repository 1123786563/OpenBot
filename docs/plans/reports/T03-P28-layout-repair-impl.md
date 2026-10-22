# T03 P28 DetailPanel Width Repair — Implementation Report

**Status:** implemented, uncommitted. **Checkpoint:** post-edit source/test hashes below. No database/task writes, installs, commits, or OCR were performed.

## Changes

- `app/src/components/craft/scheduled-task-editor.tsx`: wrapped the presenter's shared `DetailPanel` in a `div.flex-1.min-w-0`, so it takes the flex row's remaining width while allowing intrinsic content to shrink safely.
- `app/tests/detail-panel.test.tsx`: added a regression rendering the presenter after a fixed 256px roster and asserting its host has both layout classes. Updated the resize helper to locate the observed DetailPanel inside wrappers; without this, the existing responsive draft regressions stopped targeting the panel after the presenter acquired its host.

The shared panel branches and thresholds, query state, draft ownership, and task API behavior were not changed.

## RED → GREEN

- RED command: `bunx e2e run --config e2e.unit.config.ts app/tests/detail-panel.test.tsx`
- RED result: exit 1; 10 passed, new host regression failed because the host did not declare `flex-1` (an initial selector mismatch was corrected before recording the meaningful RED result).
- GREEN command: `bunx e2e run --config e2e.unit.config.ts app/tests/detail-panel.test.tsx`
- GREEN result: exit 0; 11 passed, including task draft/loading/error and A→B isolation/breakpoint regressions.
- A separately named Craft scheduled-task draft suite was not present under `app/tests`; the existing relevant draft tests are in this focused DetailPanel suite.

## Scoped checks

- `bunx biome check app/src/components/craft/scheduled-task-editor.tsx app/tests/detail-panel.test.tsx` — exit 0; 2 files checked.
- `git diff --check -- app/src/components/craft/scheduled-task-editor.tsx app/tests/detail-panel.test.tsx` — exit 0.

The e2e runner printed its existing collection note for an unrelated Bun-only server integration suite (`billing-period-fulfillment.integration.test.ts`); it was skipped and did not affect the selected app test file.

## Post-edit SHA-256

- `app/src/components/craft/scheduled-task-editor.tsx`: `63f99bf6aedfe1886bb663074c7d2ca0c956b44edd90287f5d493a1a5cf43514`
- `app/tests/detail-panel.test.tsx`: `cc5ea9d8f45b6406d8f83a941434d1c54853d1b1c8316f3f1408d6db52b31f9a`

No browser measurement was performed in this implementation task; the independent browser validator owns that check.
