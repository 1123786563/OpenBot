# T02 repair 01 independent re-review

Reviewed 2026-10-20. Scope is exclusively the PRE-R1→POST-R1 repair increment and the prior T02-R1–R4 findings. No source edits, tests, browser checks, commits, or subagents. This report is the sole written artifact.

## Package identity

Independently recomputed delta SHA-256: `8745eb9c29ec3f7d5296f560071de2a893ecd23b822401edae4f2af6be37af75`, matching POST-R1/checkpoint.json and the requested scope. All eight captured files (six production files and two unchanged test files) have matching live-file, snapshot-file, and checkpoint SHA-256 values. The incremental patch changes only the six permitted production files; the two test files are unchanged by this repair.

## Prior findings

- **T02-R1 — ADDRESSED at source-contract level.** `app/src/components/ui/input.tsx:21`, `input-group.tsx:14`, and `questionnaire.tsx:170` now apply unconditional coarse-pointer `!h-11` / `!min-h-11`, including above 640px. Questionnaire no longer resets its minimum at `sm`. Fine-pointer Input retains h-9. Native props and event/ref paths are unchanged. See the separate new InputGroup regression below; this status does not approve that regression or establish computed geometry.
- **T02-R2 — ADDRESSED at source-contract level.** `app/src/components/ui/sheet.tsx:31`–`34` replace blanket `rounded-none` with placement-edge rounding and replace w-3/4/sm:max-w-sm with w-full and a desktop `md:w-[min(24rem,calc(100vw-32px))]`. `sheet.tsx:120` explicitly supplies 16px exposed-edge corners. Existing caller class ordering and Drawer interaction paths remain intact. Rendered width/radius is deferred to user testing.
- **T02-R3 — NOT ADDRESSED (medium).** `app/src/components/ui/dialog.tsx:387`–`388` contain `!max-h-[calc(100dvh-32px)]!`, `!max-w-[calc(100vw-32px)]!`, and `!w-[min(512px,calc(100vw-32px))]!`. Each combines a leading and trailing important marker. The installed Tailwind 4.3.3 compiler emits **no rule** for these candidates. Therefore the old height cap was removed without successfully installing the requested replacement, and default width still lacks the intended explicit rule. `!m-4` and `overflow-y-auto` do not establish those missing bounds. Use one supported important marker per utility, then inspect generated CSS. The unchanged comment at `dialog.tsx:355` also still describes 85svh and should be updated with the repair. Full/cover exclusions remain intact.
- **T02-R4 — ADDRESSED at source-contract level.** `app/src/components/ui/combobox.tsx:139` replaces the 256px outer cap with a viewport-bounded 320px flex column; `combobox.tsx:200` removes the competing 288px list cap and gives the list `min-h-0 flex-1 overflow-y-auto`. This implements a shrinking list under the chips/filter instead of the previously mismatched parent/list caps. Selection, keyboard, identity, and portal code are unchanged. Actual popup placement/available-space and clipping geometry remain deferred to user testing.

## New issue introduced by this repair

### T02-R1-N1 — medium — coarse InputGroup now forcibly collapses multiline and stacked groups to 44px

At `app/src/components/ui/input-group.tsx:14`, the new `pointer-coarse:!h-11` has important priority over the same class string's existing `has-[>textarea]:h-auto` and `has-[>[data-align=block-start/end]]:h-auto` variants. InputGroup explicitly supports textarea and vertically stacked addons (`input-group.tsx:31`–`34`, `132`–`143`). On coarse pointers these supported layouts now have a fixed 44px outer height even when their content requires multiple rows; content can overflow or overlap neighboring controls. Previously those variants grew automatically. Preserve auto height and enforce the coarse minimum, or limit any fixed height rule to the single-line layout. `pointer-coarse:!min-h-11` alone can enforce the intended floor without defeating auto growth. This is a source-level cascade conflict, not a browser measurement claim.

## Focused discrepancy check

The invalid Dialog utilities warranted one focused, read-only compiler check, using the installed `tailwindcss` API from `app/`:

```js
import { compile } from 'tailwindcss';
const c = await compile('@theme { --spacing: 0.25rem; } @tailwind utilities;');
console.log(c.build([
  'max-h-[calc(100dvh-32px)]!',
  '!max-h-[calc(100dvh-32px)]!',
  'w-[min(512px,calc(100vw-32px))]!',
  '!w-[min(512px,calc(100vw-32px))]!',
  'pointer-coarse:!h-11', '!m-4'
]));
```

Exit 0. Output contains the suffix-only max-height/width rules and the coarse height and margin rules, but no rules for either double-marker Dialog candidate. The max-width candidate uses the identical unsupported marker construction. This check creates no files and does not claim a build/test or browser pass.

## Verdicts

**Spec compliance: FAIL.** R3 is still unresolved; R1, R2, and R4 have the requested source-level repairs, subject to the new InputGroup preservation defect and deferred rendered acceptance.

**Code quality: FAIL.** The scoped increment introduces unsupported Tailwind Dialog utilities and a fixed-height cascade regression in supported InputGroup compositions. No new event/state/ref/portal logic defect is evident in this style-only increment. Fix the two medium issues through the coordinator's scoped repair and re-review its actual checkpoint increment.

Browser computed geometry is deferred to the user's later testing. It is neither passed nor an execution blocker in this review. Existing broader lint/test baseline disclosures remain governed by the prior T02 report; this re-review does not recertify them.
