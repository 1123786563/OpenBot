# T06 Review Repair 04 — Type the Omitted SafeValue Fixture

- **Source:** T07 app typecheck surfaced two new errors in the T06-R3 omitted-payload fixture. This repair is limited to those errors.
- **Parent:** T06-R3 plan and `docs/plans/2026-10-20-workspace-redesign-b1-t07.md` verification report.
- **Goal:** supply the required `SafeValue.state === "omitted"` reason in both test fixtures; do not change production behavior.
- **Owner/sequence:** one serial `frontend_implementer`, then focused validator and reviewer; no commits.
- **PRE:** `docs/verification/workspace-redesign/execution/checkpoints/t06-r4/PRE/`.

## Owned path

| Path | Allowed change |
|---|---|
| `app/tests/ai-observability-run-steps.test.tsx` | Add a valid existing `OmitReason` to the two omitted-value test fixtures, preserving the assertions. No production or other test changes. |

## Checks

Run the run-steps native suite, matching ADR 0008 `app/tests/ai-observability` driven group, changed-path Biome, and the app typecheck. Record all residual errors exactly; expected remaining baseline errors are button-native callback ref and the pre-existing exports-route generated route typing. Capture POST hash and PRE→POST package, then independent validation and source/test review.
