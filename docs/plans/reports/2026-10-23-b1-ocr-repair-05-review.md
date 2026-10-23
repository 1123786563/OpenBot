# B1 OCR Repair 05 independent review

**Scope:** R5 component and P19 test at final hashes. Reviewed read-only against the approved HeroUI migration spec, `CONTEXT.md`, P19 route acceptance, T06 brief, R5 plan, implementation report, and independent validation. No OCR or test run was invoked.

## Finding

### LOW — fault-state section description still invites submission

- **Affected symbol:** `ObservationExperimentsSection` fault branch, `app/src/components/ai-observability/experiments-section.tsx:107–116`.
- **Evidence:** The branch keeps `description={t("submit.rowDescription")}`. The English copy says, “Freeze a Bot configuration against a frozen dataset version and submit it for evaluation.” This branch covers disabled, forbidden, and unavailable dataset reads; it does not render `SubmitExperimentRow`. The sibling dataset section renders the authoritative fault notice, and the P19 test confirms no submit button or dialog.
- **Impact:** The remaining instructional sentence suggests a next step that the page correctly withholds. The neighboring fault notice and missing action make this a copy clarity issue, with no permission or submission path exposed.
- **Smallest defensible correction:** Keep the required `PageSection` frame and localized title on fault, but omit this action-oriented description there, or use neutral fault-context copy without duplicating the dataset notice.

## Spec compliance verdict

**PASS.** `ObservationEvaluationsPage` renders `ObservationDatasetsBody` and `ObservationExperimentsSection` with the same `botId`; both observe `observationDatasetsQueryOptions(botId)` and use `observationScreenFault`. On a shared fault, the dataset body retains the sole `StateNotice`. The R5 experiment branch retains its `PageSection` heading/frame while omitting the second notice and `SubmitExperimentRow`. The P19 composed-page test asserts exactly one “Upstream unavailable,” the “Run an experiment” heading, and no dialog or submit action. Pending, successful, and empty-list branches are unchanged in the scoped diff. The changed code does not alter query keys, fault derivation, route guards, permissions, mutations, or server calls.

## Code quality verdict

**PASS with the low copy concern above.** The change is confined to the experiment fault branch and its behavioral test; it keeps the notice owner unambiguous. The independent validator reports 45 focused Bun tests passed, 0 failed, 124 expectations; scoped Biome, app typecheck, and diff check passed. Recurring PressResponder and React `act(...)` warnings were reported outside the R5 fault-state assertions. I inspected the scoped diff, composed page, notice owner, test, validation report, and hashes; I did not rerun tests.

**Checkpoint hashes:** PRE component `5f84e55296aa4081c702ae4029ae491c7cf1540ecc0cc02cf8c5702e47e6ef72b26`, PRE test `99ad0d667d001073fb911f8b7d2ecbc091dca076ce188978ffb29e8ed1abed1e`; final component `98945396b9e091e1d64ca44eab2705b6685c8dd0cc02cf8c5702e47e6ef72b26`, final test `54fbfd05be61f4d8ac5b37d46c86eea46e79cfb1ce924cd7f01195b2d35ed697`. Current final hashes match implementation and independent validation reports.
