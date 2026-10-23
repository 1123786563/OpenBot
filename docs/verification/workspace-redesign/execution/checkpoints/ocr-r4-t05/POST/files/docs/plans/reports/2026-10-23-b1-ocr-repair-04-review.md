# B1 OCR Repair 04 independent review

**Latest verdict after evidence ruling:** Spec compliance PASS; code quality PASS for the bounded R4 change. The medium finding below is withdrawn as a blocker. The failed group run remains a separately disclosed aggregate-runner limitation.

**Scope:** `routines-list.tsx` and `routines-list.test.tsx` at the final R4 hashes. Reviewed against the approved HeroUI migration spec, `CONTEXT.md`, T05 brief, P12/P25 route acceptance, ADR 0008, R4 plan, implementation report, and independent validation. No source or test file was changed; no OCR or test run was invoked.

## Finding

### MEDIUM — final Bun-driven verification for the changed suite is not established

- **Affected evidence:** R4 implementation and independent validation reports; `app/tests/routines-list.test.tsx` in `docs/verification/e2e-bun-suites.json` group `app/tests part 1`.
- **Evidence:** Both reports record a passing direct `bun test` of the target (1 test, 7 assertions). The attempted native Node e2e collection excluded the file as expected. The attempted containing driven group did not produce a clean result because an unrelated `app/tests/bot-sharing.test.tsx` JUnit report was missing; the validator did not rerun that group. ADR 0008 states that e2e owns the entry point, scheduling, and report for Bun-runtime suites, and the T05 brief explicitly says direct `bun test` is not a final substitute.
- **Impact:** The focused interaction is demonstrated under Bun, but the prescribed e2e-driven delivery gate has not verified the final R4 checkpoint. This limits the quality verdict; it is not evidence of a source behavior failure.
- **Smallest defensible correction:** Resolve or isolate the group reporting failure within the existing e2e driver workflow, then capture an e2e-driven result that includes this exact suite and final source/test hashes. Keep the direct Bun result as diagnostic evidence.

## Spec compliance verdict

**PASS for the bounded implementation.** `DropdownMenuTrigger` now renders the shared `Button` with `variant="ghost"`, `size="icon"`, `type="button"`, and `IconDots`. The shared Button carries focus-visible outline and coarse-pointer minimum target classes; the behavior test observes those classes and the SVG on the named button. History and Delete use existing schedule-aware translation keys for accessible names. Delete adds `variant="destructive"`, which the menu wrapper maps to its destructive data attribute and styling. The History state toggle, Delete reset/confirmation callbacks, and menu structure are otherwise unchanged. No route, API, or permission handling changed.

The plan allowed deferral of History `aria-expanded` if the menu API could not expose a stable disclosure state. The PRE source had no `aria-expanded`; selection closes and unmounts the menu item, and the report records an observed `false` value after activation. The visible history panel still toggles. This remains a disclosed low-risk accessibility limitation, not an R4 regression or an unrecorded change to the requirement.

## Code quality verdict

**NEEDS VERIFICATION because of the medium finding above.** The source and test diff is limited to the assigned action menu and focused assertions. The independent report records passing scoped Biome, app typecheck, whitespace check, and direct Bun test. The `PressResponder was rendered without a pressable child` diagnostic also appears in the pre-R4 T05-R1 implementation report for this same test, so current evidence does not attribute it to R4. A DOM class assertion confirms the shared Button path but does not replace a real coarse-pointer browser check; the latter was outside this bounded repair.

**Checkpoint hashes:** PRE source `7bec18a8a9c3272fcaa9b10540c940fbab5ca90a777bac4b7940f9a4b81a376f`, PRE test `3bb505de3f85b82c83588903af31c9b0c257c549cf4de6aee4ca39c3bfbe01a6`. Current source `9df7a3f846b2fbb9210eb171bd5a1cd37f7859900bf8c4f6489436ddc71ebb33`, current test `81b988f8c87b6cb72974f266991be6feb67726aa51efdd2d13a08ebcad8bf24a`; both current hashes match the implementation and independent validation reports.

## Reassessment of the verification finding

**The medium finding is a false-positive blocker for this bounded code review.** The repository's AGENTS instructions explicitly identify `bun test ./<file>` as the file-level command for the driven runtime, while ADR 0008 explains that the e2e driver dispatches Bun and that Bun remains the actual executor. This target is listed in the driven manifest, and the direct file-level Bun run exercised the exact final test against the exact final source hashes, passing 1 test and 7 assertions. The T05 brief's `no bun test as final substitute` sentence applies to its full task delivery gate; the R4 implementation and validator also attempted that gate and recorded that it failed on a different file's JUnit reporting, not on `routines-list.test.tsx`. That aggregate failure remains unproven for the whole group, but it does not negate the focused R4 behavior evidence or identify an R4 defect.

**Final separate verdicts:** Spec compliance PASS and code quality PASS for R4. The preserved low-risk `aria-expanded` deferral, pre-existing PressResponder diagnostic, and unrelated aggregate group reporting failure remain disclosed limits; none is a verified regression caused by the reviewed delta. The earlier `NEEDS VERIFICATION` paragraph above records the initial ruling and is superseded by this reassessment.
