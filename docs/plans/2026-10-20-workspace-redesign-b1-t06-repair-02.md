# T06 Review Repair 02 — Null Payloads and Acceptance Assertions

- **Source:** `docs/plans/reports/T06-R1-review.md`: high P17 null-payload crash, low P19 submit-action assertion, low exports direct-route and disclosure keyboard coverage.
- **Parent:** B1 Task 6 and T06-R1 plan. No scope expansion beyond these findings.
- **Owner:** one serial `frontend_implementer`, then independent frontend validator and reviewer. No commits.
- **PRE:** snapshot all five listed paths in `checkpoints/t06-r2/PRE/` before editing; include HEAD/status/full tracked patches and byte hashes.
- **Paths:** `app/src/components/ai-observability/run-steps.tsx`; `app/tests/ai-observability-run-steps.test.tsx`; `app/tests/ai-observability-experiments.test.tsx`; `app/tests/ai-observability-exports.test.tsx`; `app/tests/observability-route-guards.test.tsx`.

## Steps

1. Treat null, undefined and `SafeValue.state === "omitted"` step payloads as absent before formatting. Do not render an empty disclosure. Preserve projected/truncated text and keep the existing horizontal scroll region. Add cases for null input/output and omitted projection; P17 must render without throwing.
2. In P19 tests, directly assert failed dataset reads show unavailable status and the submit action/row is absent; keep a separate empty-list test proving empty state and its intended action behavior.
3. In the actual route harness, exercise direct `/bots/:agentId/exports` navigation for denied and allowed identities, confirming the route's beforeLoad guard executes. Do not rely only on a direct call to the helper.
4. Add keyboard activation coverage for step, sample and export `<summary>` disclosures using the supported test harness. If Happy DOM does not model native keyboard disclosure semantics, report exact limitation and retain source semantics; do not fake browser proof.
5. Run focused ADR0008 suites for all changed test files, changed-path Biome and same-hash verification. Reviewer and validator must confirm the high defect and low evidence gaps are closed before T07.

## Constraints

Preserve SafeValue redaction and null/missing/omitted distinctions; no API, permission, identity, test-fixture or dependency expansion. Browser geometry, theme, real permission and real-browser focus remain deferred by user request.
