# T2 R13 Review Fix2 — Atomic Run Budget Acceptance

> **For agentic workers:** follow this single-task plan RED → GREEN → REFACTOR. Do not commit, stage, stash, reset, rebase, start/probe/connect any DB service, or edit protected files outside the explicit ownership below.

**Goal:** Close independent-review finding F1 for R13 Fix1 by testing Run transaction rollback and persisted aggregate budget admission under the existing isolated-database gate.

**Source of truth:** Approved design `docs/specs/superpowers/2026-10-11-mastra-intelligence-only-design.md`; parent plan `docs/plans/2026-10-11-mastra-intelligence-only-dag.md`; user ruling and active progress Ledger `.superpowers/sdd/2026-10-11-mastra-intelligence-only-dag/progress.md`; Fix1 plan, Brief, implementer/validation/review reports in `.superpowers/sdd/2026-10-12-mastra-t2-r13-review-fix1/`.

**Global constraints:** The explicit caller `forwardedProps.maxOutputTokens` is the Run's persisted aggregate ceiling. Preserve existing user changes. Do not run an integration test unless its required disposable DB environment is already present; do not probe environment endpoints. No production database, service startup, migration, schema/journal edits, commits, or branch operations. DB assertions can be added and safely gated, with runtime result explicitly unverified when URLs are absent.

## Review Focus

- A failure after Run/attempt/outbox insertion but before the initial ceiling reservation completes rolls back every row in that transaction.
- Sequential and concurrent model-step reservations cannot exceed the persisted Run ceiling; settled usage consumes actual usage, reserved and unknown claims consume their maximum.
- Test-only fault injection does not permit production callers to weaken/skip budget enforcement.
- Correct the Fix1 checkpoint evidence gap: `server/src/enterprise/models/budget.ts` changed from predecessor hash `07e3569189b572b8bd9a021daec8dd3f0b8f02b0d3bada355e3e02e213f2591d` to current hash `4f709c83cb2ee17c71e3bc0cdd25e6822b4e9f8b64f24943102efe2ec7180735`; it was omitted from Fix1 before-manifest, despite report saying unchanged. Preserve Fix1 report and record this correction in the Fix2 report/Ledger.

## Task 1 — Add atomic persistence acceptance

**Role:** backend_implementer. **Validator:** backend_validator. **Reviewer:** reviewer. **Dependencies:** R13 Fix1 checkpoint; no DB-dependent prerequisite to author tests. **Owned files:** `server/src/enterprise/runs/service.ts` only if a narrow, safe test seam is required; `server/tests/enterprise/runner-events.integration.test.ts`; `server/tests/enterprise/run-output-ceiling.test.ts`; Fix2 task report and manifests. Do not change the protected dirty `server/tests/enterprise/runs.integration.test.ts`.

**Consumes:** persisted Run ceiling enforcement in `server/src/enterprise/models/budget.ts`; the existing database-gated runner event service fixture.

**Produces:** A gated integration test that deliberately fails ceiling reservation after the Run transaction has inserted its Run/attempt/outbox and verifies no Run, attempt, outbox, or ceiling reservation remains. A gated persisted claim sequence/concurrency test that demonstrates total reserved/settled/unknown allowance never exceeds the persisted Run ceiling. The injectable seam, if necessary, must be test-only in effect: default is the real reservation implementation, no public request controls it, and no production path can bypass the reservation.

1. **RED:** Record HEAD and full before hashes/manifests, including `budget.ts`; add the two gated assertions first and run the test only if the required disposable database URLs are already set. If unavailable, record safe skip and source-level RED evidence; never connect/probe.
2. **Implement:** Use existing store transaction behavior where possible. If a narrow fault-injection seam is needed, make it an internal dependency whose default always calls real ceiling reservation; reject designs exposing request-controlled bypass. For persisted claims, reserve a first claim, settle it with actual usage, attempt a second claim within and then beyond remaining aggregate balance; include unknown/reserved maximum behavior and race two claims whose combined maxima exceed ceiling, asserting no over-admission.
3. **GREEN:** Run non-DB focused suites, source/test typecheck, scoped Biome, and diff check. Run database suites only when their designated disposable URLs are already explicitly configured; otherwise record not run/skipped. No environment probing.
4. **Freeze:** Report HEAD, all before/after path hashes, diff hash, test commands/results and DB status. Correct the Fix1 manifest/report gap in this report without rewriting prior evidence. Save to `.superpowers/sdd/2026-10-12-mastra-t2-r13-review-fix2/reports/task-1-implementer-report.md`.

**Acceptance:** F1 is addressed by meaningful DB-gated assertions; only owned paths changed; no production bypass exists; non-DB checks pass; DB execution status is explicit. Independent validator and reviewer inspect identical hashes. If DB remains unavailable, do not claim persistence behavior verified and preserve it as a remaining T2 validation blocker.

**Failure handling:** If a meaningful rollback test needs an unsafe production seam or schema/service modification, stop and report evidence. Do not widen scope. No other T2 work starts until the F1 checkpoint is reviewed.
