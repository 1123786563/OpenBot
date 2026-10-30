# T07 Coding Persistence and Separate Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Repository authorization and review rules govern execution.

**Goal:** Idle coding compute stops while OpenCode files and recoverable session disk data survive, and coding reset clears only coding state.

**Architecture:** T03's per-scope coding sandbox is the lifecycle owner; server `CodeSandboxClient` and gateway remain the OpenBot boundary. Stop and resume use the same persistent sandbox identity with fresh process generation. T05 provides intent-first reset orchestration.

**Tech Stack:** TypeScript, Bun, OpenCode, OpenShell Kubernetes integration, tester-army `e2e`.

**Spec:** `docs/specs/2026-10-30-openshell-sandbox.md` A03, D7–D8; ADR 0013; `ticket-breakdown.md` T07.

**Issue:** published as [#741](https://github.com/1123786563/OpenBot/issues/741) (parent Spec [#734](https://github.com/1123786563/OpenBot/issues/734), label `ready-for-agent`, Blocked by [#737](https://github.com/1123786563/OpenBot/issues/737) and [#739](https://github.com/1123786563/OpenBot/issues/739)). Its three acceptance items map to Task 1 (real file and session survive stop/start, status does not wake), Task 2 (coding reset does not clear browser data) and Task 3 (crash and Pod-recreation scope recorded honestly). `ready-for-agent` is not implementation authorization; re-ingest #741 and the approved fact sources first.

## Global Constraints

- T03 and T05 must be verified before implementation. Re-ingest any published T07 Issue and approved facts; this draft is not execution authorization.
- Full execution scope is required (ADR 0006). Coding and computer are separate persistent identities and storage.
- `status` does not wake. In-flight work is not idle; stop never promises RAM or unsaved edit recovery.
- Ordinary reset needs T05 durable intent and outcome; audit failure refuses it. Existing shared-container mode remains compatible.
- External OpenShell persistence and OpenCode session behavior are live validation gates, not assumed features.

## Review Focus

- Status polling must not create or resume coding compute (Task 1).
- Active SSE turn or task must prevent idle stop (Task 1).
- Same Bot ID under another scope must not see coding files (Task 1).
- Reset during resume must not restore deleted coding state (Task 2).
- Pod recreation and OpenCode restart may differ; evidence must name which retained session data (Task 3).

## File map and dependency contract

Modify T03's coding OpenShell lifecycle adapter (expected `server/src/codesandbox/openshell-provider.ts`; confirm actual path). `server/src/codesandbox/client.ts` exposes `SandboxClient` with `createSession`, `readFile`, `resetWorkspace` and stream operations. `server/src/codesandbox/gateway.ts` owns run and reset governance; `server/src/codesandbox/routes.ts` owns user/Bot admission. Existing `agent-sandbox/src/bot-runtimes.ts` and `devserver.ts` are shared-mode references, not the OpenShell lifecycle owner. Tests live near `server/tests/codesandbox-client.test.ts`, `codesandbox-gateway.test.ts`, and T03 integration suite.

### Task 1: Idle coding stop and scoped resume

**Files:** Modify T03 lifecycle adapter and idle coordinator; test `server/tests/openshell-coding-lifecycle.test.ts` (create if absent).

**Interfaces:** Consume T03's full-scope sandbox key, service URL resolver and active-turn signal. Produce `status(scope): Promise<"running"|"stopped"|"starting"|"unreachable">`, `ensureRunning(scope): Promise<{url:string; generation:string}>`, and `stop(scope): Promise<{wasRunning:boolean}>` in the T03 adapter; if T03 uses equivalent names, keep its API and map these semantics.

- [ ] Write failing tests: create a file and OpenCode session record, mark idle, stop, poll status without resume, then request an active session and find both disk objects; concurrent request resumes once; active turn/SSE prevents stop; cross-scope key cannot read the file.
- [ ] Run `E2E_UNIT_OUTPUT=.e2e/t07/task1-red e2e run --config e2e.unit.config.ts server/tests/openshell-coding-lifecycle.test.ts`; expect new tests to fail.
- [ ] Implement idle stop only after task and stream activity are absent, and resume against the same persisted storage identity. Wait for new generation readiness; preserve existing `SandboxClientOptions.executionScope` and OpenBot proxy authorization.
- [ ] Rerun with `.e2e/t07/task1-green`; expect new cases to pass. Run `bun run --cwd server typecheck`.
- [ ] At implementation time commit only the reviewed T07 increment.

### Task 2: Coding-only audited reset

**Files:** Modify T03 lifecycle adapter and `server/src/codesandbox/gateway.ts`/`routes.ts` as required; test `server/tests/openshell-coding-lifecycle.test.ts`, `server/tests/codesandbox-gateway.test.ts`, `server/tests/codesandbox-routes.test.ts`.

**Interfaces:** Existing `CodeRunGateway.resetWorkspace(): Promise<{ok:true}|{ok:false;reason:string}>` and `SandboxClient.resetWorkspace(): Promise<void>` are the current API; T05's operation API must be the audit-first path. Produce reset behavior for coding state only, with uncertainty represented before a success response.

- [ ] Write failing tests: coding reset deletes file/session disk state but leaves computer profile; audit unavailable causes no reset; repeated request ID does not double-delete; concurrent resume cannot revive old storage generation; cross-Bot request is 403.
- [ ] Run `E2E_UNIT_OUTPUT=.e2e/t07/task2-red e2e run --config e2e.unit.config.ts server/tests/openshell-coding-lifecycle.test.ts server/tests/codesandbox-gateway.test.ts server/tests/codesandbox-routes.test.ts`; expect the new assertions to fail.
- [ ] Route OpenShell reset through T05's durable intent/result contract and T03's scope-aware lifecycle lock. Keep `CodeRunGateway` outcome shape unless T05 requires an explicit unknown result; never map uncertainty to `ok:true`.
- [ ] Rerun with `.e2e/t07/task2-green`; expect all new tests collected and passed; run server typecheck.
- [ ] At implementation time commit the reviewed T07 increment.

### Task 3: Live recovery boundary

**Files:** Extend T03's integration harness case; archive results in `.archive/runs/<run-key>/verification/`.

**Interfaces:** Exercise authorized server coding route and event stream through OpenBot.

- [ ] Add live fixtures for a real file and recoverable OpenCode session disk state; stop/start and test both. Separately inject process crash, Pod recreation and controller restart; assert what survives and record session protocol behavior, SSE reconnection and generation.
- [ ] Run the selected-version harness in isolated resources; preserve source/version/storage identities and individual case outcomes. Any unsupported session persistence is blocked for the relevant A03 assertion, not silently replaced by file-only acceptance.
- [ ] Perform applicable e2e/typecheck, independent behavior/Spec/quality review and OCR against the final authorized increment.

**Independent acceptance:** Coding file and recoverable disk session survive ordinary stop/start, reset clears coding only, status does not wake, active work is not culled, and abnormal recovery claims match live evidence. T08 consumes the proven activity and resume interfaces.
