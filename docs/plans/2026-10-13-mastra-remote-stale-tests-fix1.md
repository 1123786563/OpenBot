# Remote Fail-Closed Regression Test Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement the assigned Task. Steps use checkbox (`- [ ]`) syntax for tracking. The coordinator owns independent validation and Review.

**Goal:** Restore meaningful DB-free regression coverage for the accepted remote AG-UI/Mastra fail-closed rule and resolve the 18 stale test failures without reopening remote execution.

**Architecture:** Keep the real roster loader, endpoint fixtures, credential reader spies, and agent-construction path. Assert managed/customer credential classification at the loader boundary, then assert that every built remote agent refuses before network, tool, or approval-context side effects. Keep the direct raw `HttpAgent` control and all currently passing cancellation tests.

**Tech Stack:** TypeScript, Bun test, CopilotKit/AG-UI test fixtures.

**Spec:** `docs/specs/superpowers/2026-10-11-mastra-intelligence-only-design.md`; accepted remote ruling and plan `docs/plans/2026-10-12-mastra-t2-production-cutover.md`; source mapping `.superpowers/sdd/2026-10-12-mastra-t2-production-cutover/reports/remote-stale-test-alignment-map.md`.

## Global Constraints

- The accepted `REMOTE_RUN_BUDGET_UNVERIFIED` behavior stays in force for `remote_ag_ui` and `remote_mastra`. A refused run must make zero remote requests and execute zero tools.
- This is one backend test-contract repair; own only `server/tests/picked-harness-auth.test.ts`, `server/tests/remote-approval-context.test.ts`, and `server/tests/run-built-agent-cancellation.test.ts`. No production source, other tests, fixtures outside these files, schema, migrations, or package changes.
- Preserve all 9 currently passing assertions across these three files. Keep endpoint fixtures as tripwires; do not bypass `buildAgents`, construct a production remote transport directly, or make a test pass by skipping it.
- Use the existing uncommitted-checkpoint strategy: capture HEAD, exact before/after content and SHA256, a task-only patch including any new/deleted file, the tracked/untracked workspace manifest, RED/GREEN command outputs, and a report. Do not stage, commit, stash, reset, rebase, merge, push, or touch unrelated user changes.
- Do not start, probe, reset, or access any database or local database service. The user is preparing an isolated test database; database acceptance remains unverified.

## Review Focus

- A managed endpoint with case or trailing-slash variants still gets the deployment token in the loaded roster while a lookalike customer endpoint does not; the picked-harness test matrix pins both.
- A customer endpoint retains its vault credential and never gets the deployment token; the BYO matrix checks `credentialReads` and `RegisteredAgent.headers`.
- A built remote agent always rejects with `REMOTE_RUN_BUDGET_UNVERIFIED` before the standing endpoint fixture records a request; all three suites assert this.
- A refused remote tool call leaves local tool count zero and approval context absent; both remote-approval tests assert these conditions.
- The raw `HttpAgent` cancellation control and the eight built-in cancellation tests retain their original assertions; the focused GREEN run checks the complete three-file suite.

---

### Task 1: Align the remote test contracts with fail-closed execution

**Dependency:** T2-SSE exact frozen checkpoint (`.superpowers/sdd/2026-10-12-mastra-t2-runner-sse-admission/checkpoints/task-1-continuation/checkpoint-manifest.json`) and its independent validator/reviewer reports, both PASS in DB-free scope. This task is independent of the read-only T2-GOV planning report. The three owned test files must match the map's SHA256 values before edits: `5db6a8293df7298e194670149a4db5ac4eb30b7a67b5928dc52706495f143b89`, `de62fa367d2a81c7e185d104f475b6a2df7d81ee82734fb03b6dcf56b61619a7`, `7a9a8a706dfaada3b41a3f805a51ac4b45c3feb0875bea69231cef51390311f9`.

**Owner role:** backend_implementer. **Validator role:** backend_validator. **Review role:** independent reviewer.

**Files:**

- Modify: `server/tests/picked-harness-auth.test.ts` — 15 stale wire-header expectations, real roster-loader matrix, standing endpoint fixture.
- Modify: `server/tests/remote-approval-context.test.ts` — 2 stale remote-provider approval expectations, refusal tripwires.
- Modify: `server/tests/run-built-agent-cancellation.test.ts` — only the production-wrapped remote subcase of the final failing test; retain the direct raw `HttpAgent` control and other tests.

**Interfaces:** Consumes `buildAgents`, `createRuntimeAgentLoader`, `RegisteredAgent.headers`, `UnavailableAgent.runAgent()`'s error code, `HttpAgent.prototype.run` spy and existing endpoint fixtures. Produces a DB-free regression suite that verifies loader classification and zero remote side effects. No production API or data-contract change.

- [ ] **Step 1 — Capture before and RED.** Record HEAD, complete git-visible manifest, exact bytes and hashes of the three owned files, and protected hashes of `server/src/copilot.ts`, `server/src/agents/agent-resolver.ts`, `server/src/agents/runtime-agents.ts`, `server/tests/copilot.test.ts`, and `server/tests/approvals-native.test.ts`. From `server/`, run `bun test tests/picked-harness-auth.test.ts tests/remote-approval-context.test.ts tests/run-built-agent-cancellation.test.ts` before edits. Expected: the existing contract is RED with 8 pass / 18 fail; failures are the 15 missing remote HTTP requests, 2 `REMOTE_RUN_BUDGET_UNVERIFIED` approval refusals, and 1 production-wrapped remote request timeout. Save full output and exit code. Stop if the before hashes or failure taxonomy differ; report drift to the coordinator before editing.
- [ ] **Step 2 — Retarget picked-harness assertions.** In the existing `runPicked` helper, keep real config/package/loader, SQL and credential spies, `Bun.serve` fixture, and `buildAgents`. Replace the unconditional `requests.length === 1` expectation with `await expect(agent.runAgent(...)).rejects.toThrow("REMOTE_RUN_BUDGET_UNVERIFIED")` and `requests.length === 0`. Return the loaded roster. In each of the 15 failing matrix cases, move managed deployment-token, BYO `Authorization`, credential-read count, case/slash canonicalization, invalid companion-row filtering, and no-token near-miss assertions from `requests[0].headers` to the corresponding loaded agent's `headers`; preserve the unaffected `loadConfig` test byte-for-byte. Follow the per-case F1–F15 table in the source map.
- [ ] **Step 3 — Retarget remote approval tripwires.** Keep the mocked `HttpAgent.prototype.run`, approval tool, and both test cases. Replace the now-unreachable provider-event expectations with a rejected `runAgent()` result containing `REMOTE_RUN_BUDGET_UNVERIFIED`, zero mocked provider requests, zero local tool calls, and no captured approval context. Preserve the fixture setup that would detect a future transport reopen. Record the remote-only approval merge and backend-answer dedup assertions as parked coverage in the task report; they can be restored only if a separately reviewed remote governance contract exists.
- [ ] **Step 4 — Retarget the wrapped remote cancellation subcase.** In the final failing test, keep the direct raw `HttpAgent` cancellation half and its original abort evidence. For the production-wrapped `buildAgents` half, assert `runAgent()` rejects with `REMOTE_RUN_BUDGET_UNVERIFIED` and the live fixture receives zero requests; call `abortRun()` only if it is safe on a never-run `UnavailableAgent`, and record the observed behavior. Keep all eight other passing tests and their assertions intact. Park the now-unreachable wrapped-remote HTTP-abort/standing-role-on-wire coverage in the report.
- [ ] **Step 5 — GREEN and focused integration.** From `server/`, rerun the three owned test files. Expected: 26 pass / 0 fail; no skipped tests. Then run `bun test tests/copilot.test.ts tests/approvals-native.test.ts tests/enterprise/runner-production.test.ts` to guard accepted refusal, built-in approval, and mounted SSE behavior. Expected: all pass. Run `bunx biome check` only on the three owned files and `git diff --check` on the task patch; expected no new diagnostics or whitespace errors. Do not run DB-gated suites.
- [ ] **Step 6 — Freeze and self-review.** Save exact before/after owned-file contents, hashes, task patch, full RED/GREEN/static-check logs, complete non-owned hash comparison, and independent-test handoff in `.superpowers/sdd/2026-10-13-mastra-remote-stale-tests-fix1/`. Report how all 18 failed assertions were replaced with still-meaningful invariants, explicitly list parked remote-only coverage, and state that no source file changed. The coordinator then sends the same-hash checkpoint to backend validation and independent Spec/quality Review.

**Acceptance:** The 18 stale expectations are replaced by loader-boundary classification and fail-closed side-effect assertions; the original 9 passing cases remain, the three-file suite has 26 pass / 0 fail, protected production hashes are unchanged, and independent validation/Review accept the exact uncommitted checkpoint. This does not reopen remote execution or complete T2, and the isolated database gates stay unverified.

## Shared-file and interface preflight

| Boundary | Owner | Consumer | Guard |
| --- | --- | --- | --- |
| `server/src/copilot.ts` accepted remote refusal | Previously reviewed Task A; no writer in this plan | All three test files | Before/after SHA256 equal `615ebdc2907988f1e5be752f33c198e85852f2ae6c9ffacb6f2da231646e3fc3` |
| `runtime-agents.ts` loader classification | Previously reviewed Task A; no writer in this plan | Picked-harness matrix | Exact before/after protected hash; classify headers on loaded agent |
| T2-GOV future production files | Separate later backend tasks | These tests | This plan writes only the three tests and does not introduce any production contract |

Self-review: The F1–F18 source-map rows each point to Steps 2–4; every Review Focus line has an assertion in those steps and a GREEN check in Step 5. The single task has its own RED/repair/GREEN cycle and independent gate. No DB or production behavior is claimed.
