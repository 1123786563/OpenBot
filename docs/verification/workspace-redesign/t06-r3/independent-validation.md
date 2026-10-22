# T06-R3 independent validation

**Status: DONE_WITH_CONCERNS.** Source-level acceptance and requested checks passed on the reviewed revision. Browser keyboard/focus is still pending as explicitly deferred in the brief.

## Scope and integrity

- Reviewed plan `docs/plans/2026-10-20-workspace-redesign-b1-t06-repair-03.md`, implementation report `docs/plans/reports/T06-R3-impl.md`, and the T06-R3 PRE/POST checkpoint package. No source or test files were modified; this report and the validator's isolated e2e output are the only new artifacts.
- Revision: `203d0f0244b2f898218fa12027089c631e8448d9`; PRE and POST checkpoint HEADs agree with each other and the workspace HEAD.
- The current hashes of all five scoped implementation paths match the POST manifest: `run-steps.tsx` `de3cdd4a…22df19`; run-steps test `12f77c5f…63abd4`; experiments test `99ad0d66…abed1e`; English locale `4b5c3520…6413e4`; Chinese locale `5c284649…953ac0`.
- PRE hashes match the three source/test snapshots captured for the repair. Regenerated PRE→POST diffs for those three paths match the saved `delta-run-steps.patch`, `delta-run-steps-test.patch`, and `delta-experiments-test.patch`; `delta-tracked.patch` names only the five scoped paths. The locale PRE snapshots were copied from the exact T06-R1 POST locale files (R2 did not modify locales): `PRE/files/app/src/locales/en/ai-observability-runs.json` SHA-256 `7d6ddabd3201b24a0d7414e0b71d97ae3406d0bbb3c0d84b41e23ab4455bc390`, and `PRE/files/app/src/locales/zh-CN/ai-observability-runs.json` SHA-256 `09c7f387ec8f12aab349a04e6e98e3f71bacd843ad082dcacc64ace9d1b65dd8`. The recorded PRE→POST locale patches (`delta-en-locale.patch`, `delta-zh-locale.patch`) add only the localized empty-value key; their SHA-256 values are `d6138b22d2b109073c7ca173db15ec6a76f4a74f6fbc5da0be12d2f1749b335e` and `3b642e9e98b609800fc01c91cf29d83ab90f8110490010fad463e6fea4e7b60e`. These hashes are captured in `locale-integrity.txt`.
- Scoped package diff path set: exactly the three source/test paths plus the two locale paths. No full-workspace diff was used to assess package scope.

## Evidence

Commands run from workspace root unless noted:

| Command | Result |
|---|---|
| `cd app && bun test ./tests/ai-observability-run-steps.test.tsx ./tests/ai-observability-experiments.test.tsx` | Exit 0; 72 passed, 0 failed, 309 assertions. Includes projected empty vs null/missing/omitted payloads, and P19 dataset failure vs empty list entry-button assertions. |
| `E2E_BUN_ONLY=app/tests/ai-observability E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/execution/e2e-t06-r3-validator-20261021 bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` | Exit 0; 1 selected ADR0008 driver passed, which reports the Bun runtime `app/tests/ai-observability` group passed. Report: `docs/verification/workspace-redesign/execution/e2e-t06-r3-validator-20261021/report.json`. Collection also logged three unrelated unselected `bun:`-loader files (`bot-subpage`, `routines-list`, server billing-period integration) as skipped; no selected group file was skipped. |
| `bunx biome check app/src/components/ai-observability/run-steps.tsx app/tests/ai-observability-run-steps.test.tsx app/tests/ai-observability-experiments.test.tsx app/src/locales/en/ai-observability-runs.json app/src/locales/zh-CN/ai-observability-runs.json` | Exit 0; 5 files checked. |
| `git diff --check -- app/src/components/ai-observability/run-steps.tsx app/tests/ai-observability-run-steps.test.tsx app/tests/ai-observability-experiments.test.tsx app/src/locales/en/ai-observability-runs.json app/src/locales/zh-CN/ai-observability-runs.json` | Exit 0. |

## Acceptance and limits

- P17 implementation treats non-null projected text as payload presence, so an empty projected value remains expandable and displays a localized empty-value marker; null, missing and omitted values remain without a disclosure. The targeted tests distinguish all four cases.
- P19 tests query the visible `Run an experiment` entry button: absent on dataset read failure, present alongside the empty-list copy for a successful empty list.
- No acceptance gap found in the assigned source-level brief. Browser behavior, keyboard navigation and focus appearance remain deferred, not failed. Native tests emitted React `PressResponder` warnings during empty-list/modal tests despite passing; these are non-failing test-environment warnings, with no failed assertion or selected driven-suite error, and are disclosed as informational.
