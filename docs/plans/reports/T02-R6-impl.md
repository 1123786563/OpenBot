# T02-R6 implementation report

## Scope and changes

Implemented only the four owned wrappers: `button.tsx`, `sheet.tsx`, `context-menu.tsx`, and `dialog.tsx`.

- `button.tsx`: sorted React imports and applied the formatter's single-line `mergeRefs` layout.
- `sheet.tsx`: formatter-only wrapping of long values/ternary.
- `context-menu.tsx`: added the missing `cancelLongPress` hook dependency using a stable `useCallback`; after independent review, the event-handling wrapper defaults to `role="presentation"` and preserves a caller-supplied role; added a narrow Biome suppression documenting its delegated interaction; removed the temporary unused import.
- `dialog.tsx`: included `props.onOpenChange` in the Escape listener effect dependencies.

The presentational role keeps the event surface out of the accessibility tree while preserving caller overrides and pointer, keyboard, and touch handling. No public wrapper props or exports changed.

## Diagnostics before edits

Command: `bunx biome check app/src/components/ui/button.tsx app/src/components/ui/sheet.tsx app/src/components/ui/context-menu.tsx app/src/components/ui/dialog.tsx`

Exit: 1. Output: 4 files checked; 6 errors. Findings: `button.tsx` import ordering + formatting; `sheet.tsx` formatting; `context-menu.tsx` static element interactions + missing `cancelLongPress` dependency; `dialog.tsx` missing `props.onOpenChange` dependency.

## Validation

- `bunx biome check --write app/src/components/ui/button.tsx app/src/components/ui/sheet.tsx app/src/components/ui/context-menu.tsx app/src/components/ui/dialog.tsx` — exit 0; checked 4 files, no fixes applied after corrections.
- `bunx biome check app/src/components/ui/button.tsx app/src/components/ui/sheet.tsx app/src/components/ui/context-menu.tsx app/src/components/ui/dialog.tsx` — exit 0; checked 4 files, no fixes applied. Captured in `docs/verification/workspace-redesign/t02-r6/biome-final.txt` and `.exit` (exit value 0).
- `bunx e2e run --config e2e.unit.config.ts app/tests/zz-probe-context-menu.test.tsx app/tests/button-native.test.tsx app/tests/heroui-spike.test.tsx app/tests/bot-setup.test.tsx` — exit 1. E2E report `.e2e/unit/report.json`, run `01a163c0-5a21-71f6-80e4-f4d37d9f1ed7`, status failed; discovered 7981, selected/executed 32, passed 30, failed 2, interrupted/flaky/skipped 0. `button-native` passed (9 tests); ContextMenu probe passed; `heroui-spike` had two failures, including nested modal accessibility visibility assertion (`app/tests/heroui-spike.test.tsx:303`), and emitted a PressResponder warning. The report output also records an unrelated collection skip for `server/tests/billing-period-fulfillment.integration.test.ts` due to `bun:` URL protocol. No result line was emitted for `bot-setup` as selected; the runner selected 32 tests from 3 files. Full command output was not retained, but structured summary is preserved in `.e2e/unit/report.json`.

## Final hashes

- `button.tsx`: `bade903e2b4c74456205ed35ec13c5db645a1b600115cdfbbac99d1e222eda55`
- `sheet.tsx`: `e7ddf257463c48386b388dfc47576fdb7378e5cef278a850fa92ed9a48fa08b1`
- `context-menu.tsx`: `337b759407d8d2643aa044225d3b42eedb069b73f5de5d6b6248df3263eb66e8`
- `dialog.tsx`: `758809a85ff02ad024ac7447907c14747dfb9309b2fcd6ad783a280dac62a5de`

## Self-review

Reviewed the four-file diff. Changes are confined to import/format compliance and effect/interaction semantics flagged by Biome. The callback dependency is stable via `useCallback`; the dialog listener correctly rebinds when the close callback changes. The trigger defaults to a presentational role and honors caller overrides. No tests or unrelated source files were edited. No commit was made by the implementer. The original combined focused command had two `heroui-spike` failures; both match the documented isolation-sensitive Modal baseline. After the reviewer-requested role repair, the targeted ContextMenu probe passed 8/8. The independent controller verification summary records the remaining full-suite variance and final authorization boundary.

## Review repair note

Applied the reviewer-requested accessibility correction in `context-menu.tsx`: the wrapper now uses `role={role ?? "presentation"}` after destructuring `role` from caller props, so caller-provided roles are retained and cannot be overwritten by the props spread. Biome still flags a presentational event wrapper under `noStaticElementInteractions`, so a targeted suppression documents that this wrapper delegates interaction to its child and is intentionally presentational.

- `bunx biome check app/src/components/ui/context-menu.tsx` — exit 0, one file checked, no fixes applied. Output: `docs/verification/workspace-redesign/t02-r6/repair-biome.txt`.
- `bunx e2e run --config e2e.unit.config.ts app/tests/zz-probe-context-menu.test.tsx` — exit 0; one file, 8 passed, 0 failed, skipped, interrupted, or flaky. Output: `docs/verification/workspace-redesign/t02-r6/repair-context-menu-e2e.txt`; structured report `.e2e/unit/report.json`.
- Final `context-menu.tsx` SHA-256: `4b04a2801604d011a66298c54ba41d382d423fb46be24fa649dc1813b14df317`.
