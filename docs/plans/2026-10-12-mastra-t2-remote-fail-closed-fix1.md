# T2 Remote Fail-Closed — Review Fix 1

> **For agentic workers:** follow this plan with RED → GREEN → REFACTOR. Do not commit, stage, stash, reset, rebase, access/start/probe any database service, or expand beyond the reviewed findings.

**Goal:** Close production-cutover review findings PC-1/PC-2 for remote fail-closed behavior and restore truthful Copilot regression coverage.

**Source of truth:** Approved Mastra design and confirmed route/budget ruling; parent T2 plan/brief and Ledger; continuation plan and reports at `.superpowers/sdd/2026-10-12-mastra-t2-production-cutover/`.

## Global Constraints

- Remote AG-UI/Mastra executions have no verified upstream per-Run ceiling enforcement or authoritative usage; refuse them before any Bot-specific memory/storage/provider/tool side effect.
- Do not remove the fail-closed policy, introduce a default, claim callback/terminal events as proof, or add a second route.
- Preserve all existing user changes and unrelated tests. Do not touch protected `runs.integration.test.ts`, DB/schema/migrations, or frontend files.
- Keep independent built-in-model mismatch investigation separate from product behavior: tests with no compatible deployment override must assert the checked-in tenant package's actual default, not hardcode a stale model; do not change runtime selection unless an independent source defect is proven.

## Review Focus

- `runAgent` refusal occurs before `PersonalMemoryMiddleware` can read or mutate data; remote-only rosters still do not read personal standing instructions.
- Remote tests assert safe refusal and zero remote endpoint/tool/memory activity. Generic feature tests continue testing their intended behavior on built-in agents, not by invoking now-unsupported remote execution.
- No test continues to require active remote transport under this unverified governance policy.
- Copilot suite passes; deployment model selection tests prove selected overrides and package-derived defaults without relying on a stale literal.

## Task 1 — Repair remote refusal boundary and tests

**Role:** backend_implementer. **Validator:** backend_validator. **Reviewer:** reviewer.
**Dependencies:** frozen partial fail-closed increment; continuation review PC-1/PC-2. **Owned files:** `server/src/copilot.ts`, `server/tests/copilot.test.ts` only; report/manifests in this plan's SDD directory.

1. **RED:** Add a remote-only roster test with `loadPersonalMemory` spy and invoke the real `runAgent` entry; demonstrate the middleware is reached before refusal on current code. Capture and classify all current full-suite failures.
2. **Fix PC-1:** Do not attach personal-memory middleware to `UnavailableAgent` or otherwise refuse before all middleware. Test remote AG-UI and Mastra variants through `runAgent` with memory loader, tool resolver and fetch spies, all zero. Preserve the safe public refusal reason.
3. **Fix PC-2:** Update obsolete remote-run tests to assert fail-closed behavior. Where a test is about a generic built-in feature (standing role, vendor, attachments, instruction handling), use a built-in fixture so the intended behavior remains covered. Remove/retarget only tests whose old expectation was remote execution. Fix default-model tests to compare against the loaded package model unless a compatible explicit deployment override is selected. Do not alter production model selection merely to satisfy an outdated expectation.
4. **GREEN:** Run full `bun test tests/copilot.test.ts`, targeted TypeScript for changed paths, scoped Biome and `git diff --check`. Explain every prior failing case; do not swallow errors or weaken unrelated built-in assertions.
5. **Freeze:** Capture exact before/after manifest and diff increment for two owned files. Save report to `.superpowers/sdd/2026-10-12-mastra-t2-remote-fail-closed-fix1/reports/task-1-implementer-report.md`.

**Acceptance:** PC-1 and PC-2 resolved; full Copilot suite passes; no non-owned path changed; no remote side effects before refusal. Independent validator/reviewer gate the same hashes. This remains a partial Task 2 slice and does not implement Runner/SSE composition or finish T2.

**Failure handling:** If model selection mismatches reflect actual runtime source behavior rather than stale fixtures, record minimal reproduction and stop before changing selection policy. Do not mask or attribute them to remote refusal without evidence.
