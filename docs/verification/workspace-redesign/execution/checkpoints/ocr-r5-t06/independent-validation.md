# R5 / T06 Independent Validation

- **Result:** PASS for the assigned R5 brief.
- **Revision:** `f55d12f899883fc4a5d7bf0e8067bb500b86ee38` (no new commit).
- **Brief/report:** `docs/plans/2026-10-23-b1-ocr-repair-05.md`; `docs/plans/reports/2026-10-23-b1-ocr-repair-05-impl.md`.
- **Scope:** R5-owned component and designated test only. The worktree contains unrelated changes from other tasks; they were not validated as part of this report.

## Evidence

The component retains the `PageSection` frame and localized submission heading on the shared dataset fault path, while omitting the duplicate `StateNotice`. The dataset section remains the owner of the shared read notice (the experiment component does not render a notice in this branch). P19 renders the composed evaluations page and asserts exactly one `Upstream unavailable`, the `Run an experiment` heading, and absence of both dialog and submit button. Pending remains `return null`; success and empty-list branches remain unchanged in the scoped diff. This test uses DOM assertions; no standalone browser or responsive-layout run was relevant to this narrow fault-state change.

The PRE manifest hashes differ from the current final hashes, as expected for the two files changed by R5. Current hashes match the implementation report exactly. The scoped diff contains only these two paths. Other existing worktree changes are outside R5 ownership.

## Commands and results

| Command | Result |
|---|---|
| `git rev-parse HEAD` | `f55d12f899883fc4a5d7bf0e8067bb500b86ee38` |
| `bun test ./app/tests/ai-observability-experiments.test.tsx` | PASS: 45 tests, 0 failures, 124 expectations |
| `bunx biome check app/src/components/ai-observability/experiments-section.tsx app/tests/ai-observability-experiments.test.tsx` | PASS: 2 files checked, no fixes |
| `bun run --cwd app typecheck` | PASS: `tsc --noEmit`, exit 0 |
| `git diff --check` | PASS, exit 0 |
| `git diff --name-only` | Shows other concurrent workspace edits; scoped R5 diff is the component and designated test only |

The focused test emitted recurring React Native `PressResponder was rendered without a pressable child` warnings, plus React `act(...)` warnings on `ForwardRef(Button)` in the keyboard route test and `SubmitExperimentRow` in the late submission test. These did not fail assertions. They are outside the R5 fault-state assertions and should be tracked separately if warning-free test output is required.

## SHA-256 manifest

| File | PRE checkpoint SHA-256 | Current SHA-256 |
|---|---|---|
| `app/src/components/ai-observability/experiments-section.tsx` | `5f84e55296aa4081c702ae4029ae491c7cf1540ecc0ccf2932b381f68159ea0a` | `98945396b9e091e1d64ca44eab2705b6685c8dd0cc02cf8c5702e47e6ef72b26` |
| `app/tests/ai-observability-experiments.test.tsx` | `99ad0d667d001073fb911f8b7d2ecbc091dca076ce188978ffb29e8ed1abed1e` | `54fbfd05be61f4d8ac5b37d46c86eea46e79cfb1ce924cd7f01195b2d35ed697` |

## Acceptance gaps / risks

No R5 acceptance gap found. Validation covers the requested failure state and scoped static/type checks. It does not independently assess responsive layout or the full evaluations flow in a browser; those are not changed by this two-file, shared-fault presentation adjustment. Existing React test warnings remain as noted.
