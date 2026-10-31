# T06 Computer Persistence and Separate Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Repository authorization and review rules govern execution.

**Goal:** OpenShell computer stop keeps browser disk state, a later action wakes the same execution scope, status stays read-only, and computer reset clears only computer data.

**Architecture:** Keep `ComputerProvider` as the lifecycle boundary. T02's OpenShell provider implements scoped stop, locate, status and reset; T05's intent/outcome operation guards reset. Confirm storage behavior against the selected OpenShell version in a real cluster before claiming persistence.

**Tech Stack:** TypeScript, Bun, Hono, OpenShell Kubernetes integration, tester-army `e2e`.

**Spec:** `docs/specs/2026-10-30-openshell-sandbox.md` A03, D7–D8; ADR 0013; `ticket-breakdown.md` T06.

**Issue:** published as [#740](https://github.com/1123786563/OpenBot/issues/740) (parent Spec [#734](https://github.com/1123786563/OpenBot/issues/734), label `ready-for-agent`, Blocked by [#736](https://github.com/1123786563/OpenBot/issues/736) and [#739](https://github.com/1123786563/OpenBot/issues/739)). Its three acceptance items map to Task 1 (profile survives stop/start and status does not wake), Task 2 (computer reset does not clear coding files) and Task 3 (Pod and control-service restart guarantees measured separately). `ready-for-agent` is not implementation authorization; re-ingest #740 and the approved fact sources first.

## Global Constraints

- Parent #734 and T06 are not implementation authorization. Re-ingest published Issue and approved facts before execution. Draft ticket IDs are not GitHub Issue numbers.
- Blocked by verified T02 and T05. Reuse their actual provider, scope and audit interfaces; reconcile names in this plan with those implementations before editing.
- Stop retains computer disk; reset affects only computer. No RAM restore or promise that an external site never expires a login.
- All lifecycle operations use full execution scope, not bare global Bot ID (ADR 0006). Do not change old substrate behavior.
- T05 records durable intent before ordinary reset, refuses on audit failure, and records/recovers outcome. Do not bypass it with a provider call.
- Tests use the ADR 0008 e2e runner and isolated output; live cluster evidence must bind selected versions and source tree.

## Review Focus

- A status poll on stopped computer must not call `locate` or start a pod (Task 1 test).
- Concurrent action and reset on the same scope must not revive the pre-reset profile (Task 2 test).
- Same logical Bot ID in another team/workspace must not see the profile (Task 1 test).
- Reset failure after accepted intent must remain reconcilable and not report success (Task 2 test).
- Controller restart must not be misreported as proven persistence from a unit mock (Task 3 live test).

## File map and dependency contract

Modify T02's OpenShell computer provider file (expected `server/src/computer/openshell-provider.ts`; confirm actual path), `server/src/computer/provider.ts` only if its existing `ComputerProvider` method contract cannot express the result, and `server/src/computer/routes.ts`/gateway wiring only if T05 has not already connected reset. Add tests beside `server/tests/computer-provider.test.ts` and `server/tests/computer-routes.test.ts`. T02 owns sandbox identity and storage binding; T05 owns audit operation. T06 owns stop/resume/reset semantics. `server/src/computer/sandbox.ts` is a reference for current `status`, `stop` and `reset`, not the OpenShell implementation.

### Task 1: Scoped stop and wake

**Files:** Modify T02 OpenShell provider; test `server/tests/openshell-computer-lifecycle.test.ts` (create if absent).

**Interfaces:** Consume `ComputerProvider.locate(botId): Promise<string>`, `status(botId): Promise<ComputerStatus>`, `stop(botId): Promise<{wasRunning:boolean}>` from `server/src/computer/provider.ts`, plus T02's full execution-scope resolver and sandbox identity. Produce the same interface with stop retaining the selected sandbox's disk identity.

- [ ] Write failing tests: save a profile marker in scope A, stop, assert status reports stopped without a start call, then locate and assert the marker remains; scope B with same Bot ID cannot read it. Assert two simultaneous locates issue at most one resume for a generation.
- [ ] Run `E2E_UNIT_OUTPUT=.e2e/t06/task1-red e2e run --config e2e.unit.config.ts server/tests/openshell-computer-lifecycle.test.ts`; expect the new cases to fail for missing lifecycle behavior.
- [ ] Implement scoped `locate/status/stop` in T02's provider. Await suspension confirmation, preserve persistent volume identity, and use generation-aware readiness so stale Ready does not count as wake. `status` reads only control state.
- [ ] Rerun the same command with output `.e2e/t06/task1-green`; expect all new cases collected and passed. Typecheck with `bun run --cwd server typecheck`.
- [ ] At implementation time commit only T06-owned files after the repository's review gate; do not commit this planning task.

### Task 2: Computer-only audited reset

**Files:** Modify T02 provider and T05 reset orchestration; test `server/tests/openshell-computer-lifecycle.test.ts`, `server/tests/computer-routes.test.ts`.

**Interfaces:** Consume T05's durable operation API and `ComputerProvider.reset(botId): Promise<{cleared:boolean}>`. Preserve `createComputerRoutes(...)` authorization. Produce a reset outcome only after the computer storage generation is gone or an explicit uncertain result that T05 can reconcile.

- [ ] Write failing tests for computer reset clearing its profile while the coding workspace marker remains; repeated request IDs use one intent/result; audit failure makes no reset call; provider timeout leaves an unknown outcome; a stale wake cannot restore the old generation.
- [ ] Run `E2E_UNIT_OUTPUT=.e2e/t06/task2-red e2e run --config e2e.unit.config.ts server/tests/openshell-computer-lifecycle.test.ts server/tests/computer-routes.test.ts`; expect the new cases to fail.
- [ ] Implement reset as an operation serialized against wake/stop for the same full scope, through T05's intent and outcome contract. Reconcile uncertain deletion before reporting `cleared`; never delete coding identity or shared workspace resources.
- [ ] Rerun with `.e2e/t06/task2-green`; expect the new cases to pass. Run `bun run --cwd server typecheck`.
- [ ] At implementation time commit the reviewed T06 increment.

### Task 3: Selected-version persistence acceptance

**Files:** Add the selected OpenShell deployment harness case under the T02 integration suite (actual path fixed at execution); retain results in `.archive/runs/<run-key>/verification/`, not in this plan.

**Interfaces:** Use the authorized OpenBot computer route and selected OpenShell provider, not direct public service access.

- [ ] Add a live test that writes a nonsecret login/profile fixture, stops and wakes, checks marker; polls status repeatedly without wake; resets computer and proves marker gone while a coding file remains. Repeat across pod recreation and controller restart as separate assertions, with honest pass/blocked results.
- [ ] Run the harness's T06 selector against an isolated Kubernetes namespace and chosen OpenShell/controller/CNI/storage versions; record commands, versions, source checkpoint, observed generations, collected case counts and teardown. A mock-only pass is insufficient.
- [ ] Run the repository's applicable typecheck, relevant e2e suites, independent behavior/Spec/quality review and OCR for the final authorized code increment; retain actual receipts per `.agents/rules/testing.md` and `review.md`.

**Independent acceptance:** T02 and T05 verified in the same tested tree; profile survives ordinary stop/start, status does not wake, reset clears only computer, cross-scope reads fail, and each restart guarantee is separately measured. Missing OpenShell disk persistence, generation receipt, or isolated live cluster is a blocked capability gate, not a reason to weaken A03.
