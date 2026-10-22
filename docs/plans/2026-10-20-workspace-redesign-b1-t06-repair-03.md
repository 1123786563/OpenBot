# T06 Review Repair 03 — Preserve Projected Empty Payloads

- **Source:** `docs/plans/reports/T06-R2-review.md` findings R2-S1 (medium) and R2-Q2 (low).
- **Parent:** `docs/plans/2026-10-20-workspace-redesign-b1.md` Task 6 and T06-R2 repair plan.
- **Scope:** only P17 projected-empty payload disclosure semantics and P19 entry-action assertions. No API, permission, visual scope or product dependency changes.
- **Owner/sequence:** one serial `frontend_implementer`, then independent frontend validation and reviewer. No commits.
- **PRE:** HEAD/status/staged+unstaged patches and source copies with hashes in `docs/verification/workspace-redesign/execution/checkpoints/t06-r3/PRE/`.

## Paths and ownership

| Path | Owner | Allowed change |
|---|---|---|
| `app/src/components/ai-observability/run-steps.tsx` | T06-R3 | Track SafeValue presence from `state`, preserving a valid projected empty string as present; give it an explicit localized empty-value marker. Null/missing/omitted remain absent. |
| `app/tests/ai-observability-run-steps.test.tsx` | T06-R3 | Assert projected empty payload has an expandable disclosure and empty marker, while null, missing and omitted payloads do not. |
| `app/tests/ai-observability-experiments.test.tsx` | T06-R3 | Assert dataset failure hides the actual “Run an experiment” entry button; empty list preserves empty-state copy and the entry button if current UI exposes it. |
| `app/src/locales/en/ai-observability-runs.json` | T06-R3 | Localized explicit empty-projection marker. |
| `app/src/locales/zh-CN/ai-observability-runs.json` | T06-R3 | Localized explicit empty-projection marker. |

## Verification

1. Run the three changed test files natively with `cd app && bun test ./tests/ai-observability-run-steps.test.tsx ./tests/ai-observability-experiments.test.tsx` (plus any affected helper suite, if applicable).
2. Run the matching ADR0008 driven group through `bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` with `E2E_BUN_ONLY=app/tests/ai-observability` and a unique `E2E_UNIT_OUTPUT`; report collection and child suite results.
3. Run `bunx biome check` on only the three changed paths and `git diff --check`.
4. Capture POST and real PRE→POST delta hashes. Validator and independent reviewer verify the same package. Browser focus/keyboard remains deferred to user testing.

## Acceptance and failure handling

Projected empty, omitted and null/missing are distinct observable cases. The empty projected case is disclosed with explicit empty-value text, not silently conflated with absence. P19 tests name the actual visible entry action and preserve the empty state. Any test/runtime coverage gap remains explicit; no zero collection or skipped evidence is a pass. T07 stays gated until this bounded repair is independently verified and reviewed.
