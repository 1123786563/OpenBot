# T02 Review Repair 02 — Dialog Utility Syntax and InputGroup Height

- **Source:** scoped re-review `docs/plans/reports/T02-re-review-01.md` of Repair 01.
- **Parent:** B1 Task 2 and `docs/plans/2026-10-20-workspace-redesign-b1-t02-repair-01.md`.
- **Round:** SDD repair round 2; same `frontend_implementer`; no commit.
- **PRE:** `docs/verification/workspace-redesign/execution/checkpoints/t02/PRE-R2/`.
- **POST/package:** `docs/verification/workspace-redesign/execution/checkpoints/t02/POST-R2/`.
- **Report:** append to `docs/plans/reports/T02-impl.md`; independent scoped review at `docs/plans/reports/T02-re-review-02.md`.

## Findings in Scope

1. **T02-R3 residual:** Dialog default geometry utilities use invalid combined prefix+suffix important syntax and produce no CSS under installed Tailwind 4.3.3. Replace with supported syntax; use the existing focused compiler probe to confirm generated rules, and preserve custom size semantics.
2. **T02-R5 (new):** InputGroup's coarse-pointer fixed `!h-11` collapses textarea and stacked-addon groups. Make the minimum 44px while allowing height to grow for multiline/stacked content; preserve ordinary fine-pointer height.

No other sources or unrelated diagnostics are in scope.

## Verification

- Run a focused Tailwind compiler probe proving the corrected Dialog width/max-width/max-height rules are emitted.
- Run the applicable native T02 tests and scoped Biome on actual changed files; report baseline diagnostics without writes.
- Save PRE/POST source snapshots and hashes, complete status/tracked patches, and the actual PRE-R2→POST-R2 delta. Re-review only the new repair delta against T02-R3 and T02-R5.
- Browser geometry remains pending user testing; do not claim computed-layout acceptance.
