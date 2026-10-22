# T02 Implementation Report

Status: DONE_WITH_CONCERNS. Scope implemented from `docs/plans/task-briefs/T02.md`; no commit was created. Dispatch used `frontend_implementer`; the tool role descriptor specifies gpt-6-luna / low. The worker's initial guess of medium was inaccurate and is superseded by the controller-verified dispatch configuration.

## Changes

Updated HeroUI UI wrappers for shared button variants/sizes, readable disabled states, focus and invalid field treatment, control borders/field fill, coarse pointer targets, popup surfaces/backdrops, menu item targets, and field/group styling. Existing value identity, refs/events, form behavior, keyboard handling, portal behavior, Dialog/Sheet ESC and nesting logic, and six variants/eight sizes were retained. Added public Button/field contract coverage and native ref/prop assertions in `app/tests/button-native.test.tsx`; the existing ButtonLink class assertion now expects the shared control-border token. No route/business code changed.

PRE-to-POST changed files (19): `bubble.tsx`, `button.tsx`, `checkbox.tsx`, `combobox.tsx`, `context-menu.tsx`, `dialog.tsx`, `dropdown-menu.tsx`, `field.tsx`, `input-group.tsx`, `input.tsx`, `item.tsx`, `label.tsx`, `questionnaire.tsx`, `select.tsx`, `sheet.tsx`, `switch.tsx`, `textarea.tsx`, `tooltip.tsx`, and `app/tests/button-native.test.tsx` under `app/src/components/ui` except the test. POST checkpoint and full targeted diff are under `docs/verification/workspace-redesign/execution/checkpoints/t02/POST/`; PRE was preserved.

## Verification

RED→GREEN: newly added native Button/field contract assertions failed before wrapper class changes and passed after implementation. Test assertions were strengthened/updated to the token contract, not removed.

Native command:

`E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.e2e/t02-native-final bunx e2e run --config e2e.unit.config.ts app/tests/button-native.test.tsx app/tests/heroui-spike.test.tsx`

Result: 22 passed, 2 failed, 0 skipped. `button-native.test.tsx` passed 9/9. Both failures are raw HeroUI Modal tests:

- `H01 Modal contract > is controlled by isOpen and emits onOpenChange on ESC`: after Escape, dialog `<section>` remains mounted; expected no dialog role.
- `H01 Modal contract > nests a second dialog and closes only the top layer on ESC`: expected accessible “Outer” was not found while nested; DOM dump retained both layers, hidden to accessibility in happy-dom.

The test source is byte-identical to T02 PRE (SHA256 `fdf5c423b336aec9b467eb98bec79cb119b1c3b0988fcc1f7e390ed44bb80986`). T02 only changed styling classes on the app Dialog/Sheet wrappers; it did not alter the raw `@heroui/react` Modal primitive or these tests. Prior same-repo evidence is `docs/verification/heroui-migration/h14/REPORT.md` and `docs/verification/heroui-migration/h14/spike-isolated/report.json` (SHA256 `185701a32b635411e24ee2b942f0092bf3ba4dfdc2f8e02b476cac56c9c04ef6`); `docs/verification/heroui-migration/reviews/REVIEW-W7-2026-10-20.md` §(d) records independent reproduction of these exact failures and full app native 995/995 pass. Thus this delta did not introduce or worsen them.

Driven ADR0008 command:

`E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=.e2e/t02-driven-final bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts --grep 'bun runtime suite app/tests part [23]'`

Result: passed, exit 0 (report `.e2e/t02-driven-final/report.json`); selected two driven group tests, 2/2 pass, 0 fail. The driver asserts internal Bun collection is non-empty for each selected group, avoiding a zero-collection pass.

Scoped Biome command checked the 18 changed production files plus `app/tests/button-native.test.tsx`. Result: exit 1, 19 checked, 15 errors and 1 warning, no fixes applied. Path-level diagnostics: `button.tsx` import ordering and existing `mergeRefs` formatting; `combobox.tsx` import ordering/format; `context-menu.tsx` import ordering, static-element interaction, exhaustive-dependency, format; `dialog.tsx` import ordering, exhaustive-dependency, format; `field.tsx`, `item.tsx`, `select.tsx` formatting (select also exhaustive-dependency); `tooltip.tsx` unused import warning. Each maps to existing PRE code outside the T02 styling/target-size hunks; no diagnostic is in the changed test. Formatter was not run in write mode, preserving migration content and unrelated baseline code.

## Pending acceptance / risk

Rendered browser/page acceptance remains explicitly pending for the user's later review; no browser claim is made. The two raw Modal spike failures above and existing Biome baseline diagnostics remain reported concerns. No dependency installation or commit was performed.

## T02 review repair round 1

Repaired findings T02-R1–R4 in the six owned production files only. Input, InputGroup, and QuestionnaireInput now retain their fine-pointer heights while coarse pointers receive 44px minimums; removed the responsive `sm:min-h-0` override. Sheet side geometry now preserves 16px panel corners, uses full width below the desktop breakpoint, and caps desktop side panels at 24rem with a 16px viewport margin. Default `lg` Dialog surfaces now receive the specified 512px/viewport width bound and 16px margins; capped dialogs use `100dvh - 32px` maximum height and internal scrolling, while full/cover bypass these bounds. Combobox popup is a flex column capped at `min(320px,100dvh - 32px)` and its list is the shrinking scroll region beneath chips/filter.

Native check command: `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.e2e/t02-r1-native bunx e2e run --config e2e.unit.config.ts app/tests/button-native.test.tsx app/tests/heroui-spike.test.tsx`. Result 22 passed / 2 failed; Button native 9/9 passed. The same raw Modal ESC and nested ESC failures reproduced unchanged, matching the byte-identical spike PRE and prior H14/W7 evidence noted above. No test was weakened. Browser/computed layout acceptance remains pending user testing.

Biome check command: `bunx biome check app/src/components/ui/input.tsx app/src/components/ui/input-group.tsx app/src/components/ui/questionnaire.tsx app/src/components/ui/sheet.tsx app/src/components/ui/dialog.tsx app/src/components/ui/combobox.tsx`. Exit 1, 6 files checked, 6 errors, no fixes. Diagnostics were existing style/import/hook diagnostics in modified paths; no broad formatter write was applied. The T02-R1 additions are utility classes only. PRE-R1/POST-R1 full owned-file copy, status, HEAD, patch, and hash are recorded in `docs/verification/workspace-redesign/execution/checkpoints/t02/POST-R1/`; delta SHA256 is bound in its checkpoint. Self-review: all four requested geometry contracts are represented in source classes; rendered/computed geometry and interaction behavior remain unverified until the user's browser pass.

Checkpoint correction by the coordinator: PRE-R1 contains all eight file-content snapshots under `PRE-R1/files/` and corresponding SHA values in `PRE-R1/manifest.json`; the worker's earlier “no file-content directory” statement was incorrect because the source snapshots are nested below `files/app/src/components/ui/`. A verified PRE-R1→POST-R1 unified delta was reconstructed from those snapshots, hash-checked against both manifests, and saved at `POST-R1/delta.patch` (SHA-256 `8745eb9c29ec3f7d5296f560071de2a893ecd23b822401edae4f2af6be37af75`). All eight POST files match their checkpoint hashes.

## T02 review repair round 2

Dialog bounds now use supported Tailwind v4 leading important syntax (single `!` prefix) and the stale 85svh comment was updated. InputGroup coarse sizing now uses `pointer-coarse:min-h-11` without a fixed coarse height, preserving `h-auto` textarea and stacked-addon variants.

Focused Tailwind compile probe (from `app/`): `node --input-type=module` importing `compile` from `tailwindcss`, compiling `@tailwind utilities;`, then building candidates `!max-h-[calc(100dvh-32px)]`, `!max-w-[calc(100vw-32px)]`, `!w-[min(512px,calc(100vw-32px))]`. Exit 0; emitted CSS contains max-height `calc(100dvh - 32px) !important`, max-width `calc(100vw - 32px) !important`, and width `min(512px, calc(100vw - 32px)) !important`.

Native command: `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.e2e/t02-r2-native bunx e2e run --config e2e.unit.config.ts app/tests/button-native.test.tsx app/tests/heroui-spike.test.tsx`. Result 22 passed / 2 failed; Button native 9/9 passed; the two raw HeroUI Modal ESC failures remain unchanged and attributed above. Biome command: `bunx biome check app/src/components/ui/dialog.tsx app/src/components/ui/input-group.tsx`. Exit 1, 2 files checked, 3 diagnostics, no fixes applied; diagnostics are import ordering/format and existing hook dependency in dialog plus formatting around the touched class expression; no write-mode formatting performed.

POST-R2 copies/hashes/status/HEAD and tracked staged/unstaged patches are recorded under `docs/verification/workspace-redesign/execution/checkpoints/t02/POST-R2/`. PRE-R2 contains manifest and Git patches but no source file snapshots; therefore a direct content-derived PRE-R2→POST-R2 patch cannot be generated from the checkpoint as captured. The PRE evidence remains preserved. Browser computed geometry remains pending user testing.
