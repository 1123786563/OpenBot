# T02-R6 independent validation

Status: **DONE_WITH_CONCERNS**

## Scope and revision

Validated only the assigned T02-R6 brief at `.superpowers/sdd/2026-10-22-workspace-redesign-b1-t02-repair-06/task-1-brief.md` against `docs/plans/reports/T02-R6-impl.md` and its PRE→POST evidence. Current HEAD is `d00e0ee144340350e676b0c759abfe1df8fc435f`; PRE records `203d0f0244b2f898218fa12027089c631e8448d9`. POST manifest identifies the current HEAD and notes that the full dirty worktree was committed despite the brief's no-commit rule. I left HEAD, index, sources, and tests unchanged.

## Integrity and static check

All four live owned source files match their POST manifest SHA-256 values and POST snapshots:

- `button.tsx`: `bade903e2b4c74456205ed35ec13c5db645a1b600115cdfbbac99d1e222eda55`
- `sheet.tsx`: `e7ddf257463c48386b388dfc47576fdb7378e5cef278a850fa92ed9a48fa08b1`
- `context-menu.tsx`: `337b759407d8d2643aa044225d3b42eedb069b73f5de5d6b6248df3263eb66e8`
- `dialog.tsx`: `758809a85ff02ad024ac7447907c14747dfb9309b2fcd6ad783a280dac62a5de`

PRE snapshot hashes also recompute correctly. `review-package.patch` SHA-256 is `f4ddb50d5762a1eab7c7b63293e8dd93f2ad20255a0b9712056b24a2bdaa882e`, equal to the POST manifest value. Inspection confirms the patch contains the four-file PRE→POST delta.

Command: `bunx biome check app/src/components/ui/button.tsx app/src/components/ui/sheet.tsx app/src/components/ui/context-menu.tsx app/src/components/ui/dialog.tsx` — **exit 0**, “Checked 4 files … No fixes applied.” This independently confirms the recorded `biome-final.txt`/`.exit` evidence.

## Behavior evidence and acceptance gap

The recorded focused command was `bunx e2e run --config e2e.unit.config.ts app/tests/zz-probe-context-menu.test.tsx app/tests/button-native.test.tsx app/tests/heroui-spike.test.tsx app/tests/bot-setup.test.tsx` — **exit 1**, 32 executed, 30 passed, 2 failed, 0 skipped/interrupted/flaky. ContextMenu probe and button-native passed (9 tests); `bot-setup` was not selected by the runner. The two failures are:

1. `app/tests/heroui-spike.test.tsx` › `H01 Modal contract` › `is controlled by isOpen and emits onOpenChange on ESC` — modal remains in the DOM after ESC; trace at `.e2e/unit/results/heroui-spike-test-h01-modal-contract-is-controlled-a9f09b2d3a57fbd8/trace.md`.
2. `app/tests/heroui-spike.test.tsx` › `H01 Modal contract` › `nests a second dialog and closes only the top layer on ESC` — top-layer/ESC visibility assertion fails; trace at `.e2e/unit/results/heroui-spike-test-h01-modal-contract-nests-a-b5d154f605d8060f/trace.md`.

Evidence these failures predate T02-R6: W7's independent review, `docs/verification/heroui-migration/reviews/REVIEW-W7-2026-10-20.md` (section (d)), records the identical two Modal-ESC failures on an isolated `heroui-spike` run (13 pass/2 fail), while full app-scope native passed 995/995; it attributes these reds to isolation conditions. The current `.e2e/unit/report.json` failure test IDs and traces match those names. This supports “pre-existing isolation-sensitive failures,” not “all behavior passes”; the focused acceptance criterion of zero failures is unmet in this run. The implementation report also says the runner emitted an unrelated collection skip for `server/tests/billing-period-fulfillment.integration.test.ts` due to `bun:` protocol.

## Result and risks

Static-check criterion verified. Hash/package integrity verified. The required focused behavior suite is **not fully green**, with both failures matching the documented H14/W7 baseline. This is a disclosed acceptance gap, not evidence that T02-R6 introduced a regression. The unapproved whole-worktree commit recorded by POST is a process/integrity risk; validation preserved it unchanged. No loading, browser, or responsive checks were applicable to this static wrapper repair.

## R6 reviewer repair validation (2026-10-22)

**Status for repair: DONE_WITH_CONCERNS.** This addendum validates the appended “Review repair note” in `docs/plans/reports/T02-R6-impl.md`.

- Current HEAD remains `d00e0ee144340350e676b0c759abfe1df8fc435f`. The repaired `app/src/components/ui/context-menu.tsx` SHA-256 is `4b04a2801604d011a66298c54ba41d382d423fb46be24fa649dc1813b14df317`, matching the repair note. Source now destructures caller `role` and applies `role={role ?? "presentation"}` after `{...props}`, so an explicit caller role is retained and the spread cannot override the default. The targeted Biome suppression is directly on the event wrapper and documents that interaction is delegated to its child.
- Command: `bunx biome check app/src/components/ui/button.tsx app/src/components/ui/sheet.tsx app/src/components/ui/context-menu.tsx app/src/components/ui/dialog.tsx` — **exit 0**, 4 files checked, no fixes applied.
- Command: `bunx e2e run --config e2e.unit.config.ts app/tests/zz-probe-context-menu.test.tsx` — **exit 0**, run `01a163f0-49ed-78c1-8cd0-494c09055c0c`, 1 file and 8 tests passed; 0 failed/skipped/interrupted/flaky. The probe covers pointer context-menu positioning, Shift+F10, item activation/close, disabled items, checkbox/radio behavior, Escape, and touch long-press/drag cancellation.
- The test output emitted repeated React Aria warnings that an accessible name (`aria-label` or `aria-labelledby`) is required for menus. They did not fail the probe; the current assigned check is a focused interaction test. This remains an accessibility evidence concern if menu naming is within a separate acceptance requirement.

The earlier four-file focused batch still had two `heroui-spike` Modal ESC failures, documented above and matching the H14/W7 isolation-sensitive baseline. They are outside this repair's focused ContextMenu probe and do not recur in its 8-test run. Git status and HEAD were inspected after validation; I made no Git mutations and modified no production or test files.
