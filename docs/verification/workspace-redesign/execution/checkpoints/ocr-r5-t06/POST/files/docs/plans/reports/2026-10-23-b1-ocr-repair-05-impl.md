# B1 OCR Repair 05 Implementation Report

## Task

R5 / T06: avoid repeating the shared dataset read fault in the experiment submission section while preserving its frame/title and suppressing submit when the shared read fails. Strengthen the P19 failure case to verify one unavailable notice on the composed evaluations page.

## Changes

- `app/src/components/ai-observability/experiments-section.tsx`: on a dataset query fault, keep the `PageSection` with its title and description, but omit the duplicate fault `StateNotice`. Pending and answered list behavior remain unchanged.
- `app/tests/ai-observability-experiments.test.tsx`: P19 now asserts exactly one “Upstream unavailable” title, the “Run an experiment” heading remains, and no dialog or submit action appears.

## Verification

- RED: `bun test ./app/tests/ai-observability-experiments.test.tsx` failed at P19 before the component edit because `findByText("Upstream unavailable")` found two elements.
- GREEN: `bun test ./app/tests/ai-observability-experiments.test.tsx` — passed; 45 tests, 0 failures, 124 expectations.
- `bunx biome check app/src/components/ai-observability/experiments-section.tsx app/tests/ai-observability-experiments.test.tsx` — passed; 2 files checked.
- `bun run --cwd app typecheck` — passed (`tsc --noEmit`, exit 0).
- `git diff --check` — passed.

## Final SHA-256

- `app/src/components/ai-observability/experiments-section.tsx`: `98945396b9e091e1d64ca44eab2705b6685c8dd0cc02cf8c5702e47e6ef72b26`
- `app/tests/ai-observability-experiments.test.tsx`: `54fbfd05be61f4d8ac5b37d46c86eea46e79cfb1ce924cd7f01195b2d35ed697`

## Notes

The focused test emits existing React Native press responder and `act(...)` warnings; assertions pass. No query key, permissions, translations, or dataset section behavior changed. No commit created.
