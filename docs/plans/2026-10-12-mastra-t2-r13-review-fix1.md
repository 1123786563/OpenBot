# T2 R13 Review Fix 1 — Run Budget Source and Compatibility

> **For agentic workers:** REQUIRED: follow this plan task-by-task using RED → GREEN → REFACTOR, then freeze the task checkpoint for independent validation and review. Do not commit, stage, stash, reset, rebase, or touch a database service.

**Goal:** Close the valid R13 review findings without changing the confirmed policy: each Run's aggregate budget equals the caller's explicit `forwardedProps.maxOutputTokens`.

**Source of truth:** Approved design `docs/specs/superpowers/2026-10-11-mastra-intelligence-only-design.md`; T2 plan `docs/plans/2026-10-11-mastra-intelligence-only-dag.md`; user budget ruling recorded in `.superpowers/sdd/2026-10-11-mastra-intelligence-only-dag/progress.md`; R13 report/review/validation in the same Ledger reports directory.

**Global constraints:** Preserve every existing user edit. `server/tests/enterprise/runs.integration.test.ts` is dirty user work; this plan permits only additive `forwardedProps.maxOutputTokens` values in shared test input helpers and exact inline `RunService.start` input literals, preserving all existing assertions and unrelated hunks. `server/tests/enterprise/runner-events.integration.test.ts` is T2-owned and may receive the same focused fixture updates and DB-gated persistence assertions. No migration/schema widening. No DB startup, URL probing, migration, or live DB access; DB tests may be authored and safely gated but remain unverified until the user's disposable DB is explicitly ready.

## Review Focus

- Invalid/missing caps reject before writes; accepted value is persisted unchanged as route maximum and aggregate Run ceiling.
- No required global/configured token policy remains for per-Run admission or invocation reservation; persisted aggregate ceiling is the authoritative source.
- Existing test fixtures still represent prior behaviors after supplying explicit caps; no user-authored logic/assertions are overwritten.
- Persisted balance remains atomic across multiple invocation reservations and usage confirmation.

## Task 1 — Fix R13-1/2/3

**Role:** backend_implementer. **Validator:** backend_validator. **Reviewer:** reviewer. **Dependencies:** R13 checkpoint/review only. **Owned files:** `server/src/enterprise/contracts.ts`, `server/src/enterprise/runs/service.ts`, `server/src/enterprise/models/budget.ts`, `server/tests/enterprise/runs.integration.test.ts` (fixture-only edits described above), `server/tests/enterprise/runner-events.integration.test.ts`, `server/tests/enterprise/run-output-ceiling.test.ts`. Do not edit other paths.

**Consumes:** R13 adds required `StartRunInput.forwardedProps`; `RunService.start` persists its exact output cap. The current persisted Run budget reservation and model capability logic already enforce remaining balance.

**Produces:** Existing callers pass the new explicit cap; reservation service needs no independent required configured-budget source and enforces all invocation claims against the persisted Run ceiling; a DB-gated service test proves invalid input creates no Run/attempt/budget reservation and valid input persists the exact cap to both records; focused tests prove multiple model-step claims cannot exceed aggregate remaining budget.

1. **RED:** Add cap inputs to tests only after recording each pre-edit hash. Write the DB-gated service test and focused non-DB reservation-policy regression first. Run focused RED tests and targeted typecheck; capture the original missing-cap type errors and failing policy/assertions.
2. **Implement:** Remove the mandatory `configuredBudgetTokens` requirement from RunService production admission. Refactor budget reservation so the persisted Run ceiling is the sole aggregate source; invocation caps are explicit per call and are admitted only against ceiling minus confirmed/reserved/unknown usage. Keep an optional compatibility argument only if direct legacy helper callers demonstrably need it; it must not affect production Run budget calculation. Add only the fixture caps needed by existing tests, preserving all existing test logic and assertions.
3. **GREEN:** Run `bun test tests/enterprise/run-output-ceiling.test.ts tests/enterprise/mastra-model.test.ts`; run TypeScript checks for all changed test/source paths (keep unrelated existing diagnostics separate); run the DB-gated Run and runner-event integration suites and explicitly record skips without any DB access if their designated environment is absent. Run scoped Biome and `git diff --check`.
4. **Freeze:** Capture current HEAD, owned before/after manifests, protected user-path manifests, and an increment including any additions/deletions. Confirm no schema, journal, migration, or user logic changed beyond the explicitly permitted fixture cap properties. Save exact commands/results and hashes to the task report.
5. **Independent gates:** Validator and reviewer inspect the same frozen hashes. Reopen only findings with evidence; do not call this complete T2.

**Acceptance:** R13 findings R13-1, R13-2, and R13-3 are addressed in code and tests; no independent Critical/High/Medium finding remains for this slice. Database behavioral evidence is marked unverified if the disposable DB is not configured. T2 remains incomplete until its production Runner, route composition, SSE/headless cutover, remote fail-closed behavior, and full DB gates pass.

**Failure handling:** If a production-safe policy refactor requires changing an unowned data model or schema, stop and report exact evidence rather than widening scope or adding a default. If disposable DB URLs are absent, do not start/provision/probe a service; preserve gated tests and report the limitation.
