# T02 independent task review

Reviewed 2026-10-20. Read-only source review; the only written artifact is this report. No tests were rerun, no source was edited, and no commit was created.

## Scope and identity

Reviewed the actual T02 PRE→POST incremental package, not HEAD alone: `docs/verification/workspace-redesign/execution/checkpoints/t02/POST/delta.patch`. Independently recomputed SHA-256: `b53c088ddcd3c15a87e1c4aead987b84b96381404900bc8c0ea078165b7e692e` (matches request and checkpoint). Requirements: T02 Brief, B1 plan Task 2, refinement `implementation-spec.md` §3 (including its shared state/target contract), `implementation-detail.md` §2, and `theme-contract.json`. Existing surrounding geometry was read only to assess whether these T02 requirements were implemented. RouterLink received the specifically requested bounded check.

## Spec compliance: FAIL — four medium findings

### T02-R1 — medium — ordinary input targets still fall below 44px on coarse pointers

Evidence: `app/src/components/ui/input.tsx:21`, `app/src/components/ui/input-group.tsx:14`, `app/src/components/ui/questionnaire.tsx:170`.

The new Input class still fixes height to `h-9` (36px) without a coarse-pointer minimum. InputGroup likewise retains `h-9`; QuestionnaireInput retains `h-8` and `sm:min-h-0`, so at widths ≥640px a touch input is only 32px. The change adds coarse minima to Button, Select, Combobox trigger and menu items, but not these changed interactive field classes. This misses the Brief/Task 2 coarse-pointer minimum and spec §3 interactive box requirement. Add coherent coarse-pointer minimum sizing to the field and containing group, including QuestionnaireInput at wider touch viewports. Preserve native props/events. Verify the computed interactive box, not merely presence of a class on a different wrapper.

### T02-R2 — medium — Sheet surface radius is discarded and required responsive width is absent

Evidence: `app/src/components/ui/sheet.tsx:120` (new `rounded-2xl`, immediately followed by `SIDE_CLASSES[side]`), `sheet.tsx:31`–`34` (all sides specify `rounded-none`; left/right retain `w-3/4` and `sm:max-w-sm`).

The new surface class is contradicted by the placement classes in the same cn call. The existing placement geometry also leaves default left/right sheets at 75% width on a 390px viewport instead of the spec §3 full-width sheet below 768px. Thus replacing scrim and adding an overridden radius does not fulfill the sheet geometry decision. Reconcile placement classes with the required 16px surface and responsive width while preserving Drawer behavior. This is an incomplete T02 acceptance item, not a claim that the old 75% geometry originated in this delta.

### T02-R3 — medium — Dialog keeps its old cap rather than the required viewport-margin geometry

Evidence: `app/src/components/ui/dialog.tsx:351`, `dialog.tsx:376`–`387`.

The modified Dialog surface still uses `max-h-[85svh]!`; it does not implement `max-height:calc(100dvh - 32px)` from spec §3. The container remains default `size="lg"` with no wrapper constraint establishing `min(512px,100vw - 32px)`. This review does not infer the installed library's precise lg pixel width; the explicit 85svh cap alone proves the required geometry was not implemented. Establish the specified default dialog bounds and internal scrolling, while preserving intentional public size overrides and the ESC/focus implementation. Record any interpretation needed for existing full/cover modes instead of silently replacing their public semantics.

### T02-R4 — medium — Combobox popup remains capped and clipped by the old outer layout

Evidence: `app/src/components/ui/combobox.tsx:139` (outer `max-h-64 overflow-hidden`), `combobox.tsx:201` (list `max-h-72 overflow-y-auto`); compare the new Select popup at `app/src/components/ui/select.tsx:629`.

Spec §3 gives Select/Combobox popovers the shared max-height=min(320px, available viewport) and scrollable-content contract. Only Select received that update. Combobox still caps the entire popup at 256px while the list alone can occupy 288px plus the chips/filter header, so the parent can clip the list beyond its independently sized scroll viewport. Extra coarse-pointer option height makes the missing constrained layout particularly relevant. Use a viewport-bounded popup and a shrinking scrollable list below the filter/chips rather than clipping their combined height. This is an unfulfilled required popup change, not an assertion that the pre-existing clipping structure is a newly introduced logic regression.

## Code quality: PASS with scope limitations

No separate newly introduced event/ref/value-registration/form/portal logic defect was found in this incremental package. The production delta is limited to styling classes and comments; HERO_VARIANT/HERO_SIZE, six variants/eight sizes, mergeRefs/adaptRender and native event handling are not rewritten. Added test assertions retain existing assertions, add native ref/prop checks, and update the outline token expectation consistently. Class-string assertions provide useful source-contract coverage but cannot establish computed style, target size, clipping or actual focus visibility; the four Spec findings remain release-blocking for T02 regardless of this quality verdict.

The existing Biome failures do not become proof of a new defect merely because their files changed. Imports and existing semantic hook/interaction code in the identified production files are unchanged by this delta. Formatting diagnostics can cover whole nodes and must not be blanket-described as wholly outside styling hunks without diagnostic ranges. The implementation report's exit 1 / 15 errors / 1 warning is not a clean lint pass. No raw scoped Biome diagnostic artifact was supplied in the review package, so this review does not independently certify every diagnostic's exact PRE attribution or count. Preserve the failure as disclosed baseline debt and attach exact diagnostics/PRE comparison if the gate requires attribution; avoid broad formatting churn to unrelated migration code.

## RouterLink bounded check: justified no-edit waiver

`app/src/components/ui/router-link.tsx:52` derives its entire shared visual class from exported `buttonVariants({ variant, size, className })`; lines 53–58 forward matching data attributes. Lines 60–79 render a real native anchor for href or TanStack Link for to and forward the remaining anchor props. Therefore Button's cva update already reaches both RouterLink branches, with the existing shared six-variant/eight-size vocabulary and anchor semantics. No separate router-link.tsx edit is necessary for plan Step 1; this waiver covers style alignment, not unrequested API redesign.

## Verification evidence and exceptions

Parsed `.e2e/t02-native-final/report.json`: selected tests are 22 passed / 2 failed, runner exit 1; failures are exactly raw HeroUI H01 Modal controlled ESC and nested ESC tests. Parsed `.e2e/t02-driven-final/report.json`: selected groups are 2 passed, runner exit 0. Filtered-out suite records are not counted as executed skips.

Independently compared PRE/POST `heroui-spike.test.tsx`: byte-identical, SHA-256 `fdf5c423b336aec9b467eb98bec79cb119b1c3b0988fcc1f7e390ed44bb80986`. `composing-enter.test.tsx` and `form-submit-controls.test.ts` are also byte-identical. Prior independent review `docs/verification/heroui-migration/reviews/REVIEW-W7-2026-10-20.md:39` records the same two isolated raw Modal failures and passing full-app context; H14 REPORT likewise documents their isolation dependence. This supports treating these two failures as known baseline behavior, not an attributable T02 regression. It does not make the current targeted command green and does not substitute for current-version wrapper nested-focus/ESC evidence: raw library Modal and the application's guarded Dialog/Sheet are distinct paths.

Rendered browser/page acceptance remains explicitly deferred to the user, per the current instruction. This report makes no browser, computed-style or full-app regression-pass claim. Repair R1–R4 through the coordinator's scoped T02 fix task and re-review the resulting incremental checkpoint before marking T02 Spec-verified.
