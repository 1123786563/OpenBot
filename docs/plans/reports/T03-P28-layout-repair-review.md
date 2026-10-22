# T03 P28 layout repair — independent review

## Scope and checkpoint

- Reviewed the P28 repair delta against `docs/verification/workspace-redesign/p28-layout-repair/checkpoints/PRE/`, `docs/plans/2026-10-21-workspace-redesign-p28-detailpanel-fill.md`, its Task 1 brief, the parent B1 plan, `CONTEXT.md`, and the DetailPanel contract in the workspace redesign refinement documents. This is a source review, not a browser validation or full P28 acceptance.
- `app/src/components/craft/scheduled-task-editor.tsx` SHA-256: `63f99bf6aedfe1886bb663074c7d2ca0c956b44edd90287f5d493a1a5cf43514`.
- `app/tests/detail-panel.test.tsx` SHA-256: `cc5ea9d8f45b6406d8f83a941434d1c54853d1b1c8316f3f1408d6db52b31f9a`.

## Findings

No actionable finding in the reviewed delta.

## Spec compliance verdict: pass for the bounded repair

The presenter root at `app/src/components/craft/scheduled-task-editor.tsx:747` now participates in the route's flex row as `flex-1 min-w-0`. With the fixed session roster before it (`app/src/routes/_authed/_app/craft/tasks.tsx:60-62`), this gives the DetailPanel the remaining row width and permits shrinking without an intrinsic minimum width. The existing DetailPanel still observes its own container and applies the strict `width < detailWidth + 480` rule (`app/src/components/layout/detail-panel.tsx:54-65`), yielding the specified 879/880 boundary for its 400px panel. The repair leaves its open state, editor draft props, task API, and panel branches intact (`scheduled-task-editor.tsx:748-766`). No other production file changed in this P28 checkpoint.

The browser validator must still confirm actual 879/880 and 1440px geometry, URL and dirty draft retention, and absence of document overflow on these exact hashes. The new native test cannot establish computed flex widths in happy-dom.

## Code quality verdict: pass

The change is localized to the layout owner and does not alter shared DetailPanel behavior. The regression at `app/tests/detail-panel.test.tsx:609-632` puts the presenter after a fixed 256px roster and asserts both required flex classes. The resize helper at `detail-panel.test.tsx:74-82` now finds the observed panel within the new wrapper, so existing branch and draft tests continue to target the DetailPanel. The implementation report records a focused RED/GREEN run (10 passing plus the new failing assertion, then 11 passing), scoped Biome success, and a clean diff check on the reviewed hashes. I did not rerun tests or OCR for this independent source review.
