# T09 Review Repair Plan — Gate Queued Writes After Readiness Changes

- **Source:** T09 independent Claude review report `docs/plans/evidence/2026-10-15-opik-issue4/T09/review-report.md`, F1 Low, SHA256 `ae5bd32e175def56946e8d4b60e263eb18d7b78fa397dc63bf1a883045b88ced`.
- **Facts:** approved Opik Spec, Issue #15 acceptance, T09 implementation and independent review reports, coordinator R-10/R-11 rulings.
- **Workspace:** fresh Orca Claude child worktree. Coordinator transfers exact reviewed T09 patch and prerequisites, hash-verifies before work.
- **Commit policy:** uncommitted patch/checkpoint only; no commit/stash/push/merge/publish.
- **Review focus:** once readiness flips not-ready, no already-queued but not-yet-started observation write should begin; in-flight write is not cancelled. Existing fail-closed behavior, queue order/capacity/counters, no Agent-result coupling remain intact.
- **Global constraints:** implement only in Orca Claude worker; fresh independent read-only Claude review; exact file ownership; no real Opik calls.

## Task 1 — Recheck readiness before each queued write starts
- **Depends on:** T09 implementation + independent review; reviewer F1.
- **Role:** Claude backend implementation worker. **Validator:** separate Claude reviewer.
- **Owned files:** `server/src/ai-observability/health.ts`, `server/tests/opik-health.test.ts`.
- **Consumes:** existing `OpikHealthService` state machine, queue pump, safe write outcomes, T08 `OpikPort` contract.
- **Produces:** after a readiness probe changes `lastProbed` to not-ready, writes still in the local queue are skipped/refused before `perform`; record them in an existing safe counter/outcome. In-flight operations are not cancelled. Later successful readiness can resume future submissions without changing existing semantics beyond the reviewed finding.
- **Steps:** hash verify candidate/prereqs; add failing test for first write in flight, queue a second, flip readiness to auth failure, resolve first and assert second never calls perform and is accounted; run true RED; minimal fix; run related suites/typecheck/Biome; produce repair package and report.
- **Failure handling:** if safely identifying queued vs in-flight work requires changing public interfaces, ask coordinator; do not edit other files; disclose any edge case not fixed. No self-review.
