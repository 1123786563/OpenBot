# B1 OCR Repair 03 independent review

**Latest verdict after R3B:** Spec compliance PASS; code quality PASS for the bounded R3/R3A/R3B package. The medium test-coverage finding below was valid at the R3A snapshot and is resolved by R3B. Its original evidence remains as review history.

**Scope:** R3 four wrapper source files and R3A final `ui-wrapper-merge.test.tsx`, reviewed read-only against the approved HeroUI migration spec, `CONTEXT.md`, ADR 0008, R3/R3A plans, implementation reports, and independent validation. No OCR or test run was invoked.

## Finding

### MEDIUM — Item class precedence regression is not covered by the new behavior test

- **Affected symbol:** `app/tests/ui-wrapper-merge.test.tsx`, Item test at lines 39–64.
- **Evidence:** The test passes `wrapper-class` and `element-class` and asserts only that `element-class` remains in the rendered `className`. Both unrelated classes survive `cn()`/`tailwind-merge` in either argument order. The pre-R3 implementation used `cn(theirs, ours)` and would satisfy that assertion, even though a conflicting wrapper utility would override the element utility. The style collision (`red` versus `blue`) and handler order assertions do distinguish old from new behavior, but the class assertion does not.
- **Impact:** The explicit element-wins class contract in `item.tsx:64–67` lacks a regression test, despite R3 acceptance requiring a behavioral check for class precedence. A future order reversal could pass the focused suite.
- **Smallest defensible correction:** Make the test pass conflicting utility classes on Item and its `render` element, such as `px-2` and `px-4`, and assert the rendered class retains the element utility while removing the wrapper utility. Keep the current style and handler assertions.

## Spec compliance verdict

**Implementation: PASS.** `Field` removes the caller's `data-invalid` before spreading remaining props, then writes normalized state last. `isInvalid` accepts only boolean `true` or string `"true"`; the R3A test checks that `"false"` becomes an absent DOM attribute and still checks true-state `aria-describedby` linkage. `Item` now passes wrapper classes to `cn()` before element classes and spreads wrapper styles before element styles, so conflicting element values win. Its merge still calls the element event handler before Item's handler and forwards other element props after resolved props. Input and QuestionnaireInput use Tailwind v4 `pointer-coarse:h-11!` and `pointer-coarse:min-h-11!`; the production build emitted both escaped selectors. These changes preserve the spec's shared-wrapper behavior and touch sizing scope.

**Acceptance evidence: PARTIAL.** The R3A false-state Field assertion, Item style conflict, and dual-handler order assertions are behavior-sensitive. The Item class assertion is not, as described in the finding. No live coarse-pointer computed-style check was performed; build output confirms emitted selectors, which is the planned fallback when live inspection is unavailable.

## Code quality verdict

**NEEDS FIX for one medium test-coverage finding before R3 acceptance is closed.** The four source deltas are limited to normalized state order, documented element precedence, and Tailwind syntax. Independent validation reports focused e2e passes (R3A final test: 1 file / 2 tests; existing Item disabled test: 1 file / 1 test), scoped Biome and app typecheck/build passes, and a clean diff check. The focused e2e runner reported an unrelated billing integration collection skip; it does not affect these selected tests. I inspected source, tests, reports, generated CSS selectors, and hashes; I did not rerun the suites.

## Checkpoint binding

- Final source SHA-256: `field.tsx` `89e0fb6b8f22cb239a64cc5e112a4a0c366b3c3f53fe539886b52ccf906eec73`; `item.tsx` `0bbd4287436c5ebb2595e7d6358b96a39b0b6396a7a2588b1fdd28e46a1f7b71`; `input.tsx` `95829e4c97a39c267d062cb6a2295c435f9d6e41ae256cbf2ed5d04c632a70ae`; `questionnaire.tsx` `e9dd7622e4f300efbcc1859e2e3746e4376b013f8e6f20aded74e5849f43aab5`. All match R3 `POST-independent.sha256` and current files.
- Final test SHA-256: `7889d781c02396f2720a8ae29b1cf0b9c44d89daccea09e86bad32de6978fe1e`, matching the R3A implementation and independent validation. R3's older test hash `4bfafa765bab895160e7190533974dc7621932d8ae28c7ee044b6c25df155b6f` is superseded by R3A; a whole-file `sha256sum -c` on the historical R3 list accordingly reports that one obsolete test entry as failed. The R3A PRE list likewise records the pre-R3A test hash rather than the final file. These are checkpoint chronology, not source drift.

## R3B re-review — current disposition

**Finding resolved.** The exact R3B PRE→current test delta changes only the Item test: wrapper `className` now includes `px-2`, rendered button `className` includes `px-4`, and assertions require `px-4` present and `px-2` absent. Those are conflicting padding-x utilities under the shared `cn()`/`tailwind-merge` function. The previous reversed `cn(theirs, ours)` would retain `px-2`, so this assertion now rejects the original defect. Custom-class retention, style collision, and element-before-Item click order assertions remain.

**Final Spec verdict: PASS.** Field false-state normalization and description linkage, Item class/style precedence and event order, and the two Tailwind v4 important touch rules match the R3/R3A/R3B acceptance. **Final quality verdict: PASS for this bounded package.** R3B's independent report and e2e artifact record 1 selected file / 2 selected tests passed, scoped Biome pass, and a no-index whitespace check on the untracked test file. The known unselected billing suite's Node collection skip remains outside this focused result. I inspected the R3B delta and validation report; I did not rerun e2e or OCR.

**Final checkpoint hashes:** The four source hashes remain `89e0fb6b8f22cb239a64cc5e112a4a0c366b3c3f53fe539886b52ccf906eec73` (Field), `0bbd4287436c5ebb2595e7d6358b96a39b0b6396a7a2588b1fdd28e46a1f7b71` (Item), `95829e4c97a39c267d062cb6a2295c435f9d6e41ae256cbf2ed5d04c632a70ae` (Input), and `e9dd7622e4f300efbcc1859e2e3746e4376b013f8e6f20aded74e5849f43aab5` (QuestionnaireInput). The final test hash is `ec77d996ec27256543ba3a631b6df4835ad384c7c5ca66c416f044650581c9dd`, matching the R3B implementation and validator reports. The R3A test hash above is superseded by this R3B checkpoint.
