# Mastra OCR R3 Fix 1b — Gateway Deadline and Cleanup Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining Fix1 review gaps for gateway-owned PlanModel header bounds, pre-dispatch timer cleanup, and deterministic SSE discriminator regression coverage.

**Architecture:** Preserve the two-file gateway seam and manual timer. Race PlanModel stream-handle creation against the gateway-owned abort signal so a non-cooperative adapter cannot hold `handle()` past its finite deadline, and cancel any stream handle that resolves late. Ensure every timer is created only when needed or cleared on every early return. Make discriminator tests fail immediately on malformed input without advancing timeout clocks.

**Tech Stack:** TypeScript, Bun, AbortSignal, ReadableStream.

**Spec:** R3 Task3 Fix1 plan and independent review `.superpowers/sdd/2026-10-11-mastra-ocr-r3-fix1-gateway-lifecycle/reports/re-review.md`, findings `R3-T3-FIX1-REV-01` to `03`; approved R3-ARCH-03/04.

## Global Constraints

- Only `server/src/enterprise/models/gateway.ts` and `server/tests/enterprise/model-gateway.test.ts` may change.
- Preserve Task1/Task2/Task3 fixes, HEAD `8d6b9bd71a810556ab46b5dffa9f72f0427f5289`, no commit/history changes, and all other work.
- A gateway-owned request deadline must end PlanModel header waiting even if `doStream()` ignores abort; dispatched uncertainty is settled unknown once.
- All request timers stop on every early return, success, and error. Stream timers and signal listeners stop on close/error/cancel.
- No real provider calls, no sleeps, no timing-only success path; use manual timers and synthetic adapters/streams.

## Review Focus

- Missing HTTP credentials and unsupported Anthropic body mapping return without live timers.
- A never-resolving PlanModel `doStream()` is bounded by request/header timeout, unknown-settled once, and does not leave timers/listeners active.
- OpenAI malformed/credential-bearing `type` cases reject before forwarding even if no timeout occurs; a timeout alone cannot satisfy the regression.
- Successful stream and cancellation cleanup remain idempotent.

---

### Task 1: Finish gateway deadline and cleanup fixes

**Depends on:** Frozen Task3 Fix1 patch and review. **Roles:** fresh backend_implementer → fresh backend_validator → independent reviewer. Serial; no commit.

**Files:** Modify only `server/src/enterprise/models/gateway.ts` and `server/tests/enterprise/model-gateway.test.ts`.

**Interfaces:** Consume `ModelGatewayDependencies.timer`, `requestTimeoutMs`, `streamTimeoutMs`, `createPlanModel`, `resolveApiKey`, and existing settlement callbacks. Keep production public behavior otherwise stable.

- [ ] **Step 1 — RED: early timer returns.** Add deterministic manual timer checks for missing HTTP key and Anthropic mapping failure after parse. Assert generic response status and zero active timers. Verify current Fix1 fails with an active request timer.
- [ ] **Step 2 — RED: non-cooperative PlanModel adapter.** `doStream()` returns a never-resolving promise and ignores abort. Advance request/header timer; assert gateway promise resolves with generic failure, unknown settlement occurs once, and active timers are zero. Current Fix1 must remain pending or fail this contract.
- [ ] **Step 3 — RED: discriminator test sensitivity.** For non-string and credential-bearing OpenAI SSE top-level `type`, use a source that emits the malformed frame then stays open. Read the response body and assert it errors before advancing either timeout; assert cancel, unknown once, confirm never. The test must fail if the discriminator guard is removed. Keep valid protocol positive cases.
- [ ] **Step 4 — Implement.** Use a gateway-owned abort race around `adapter.doStream`; remove its abort listener in `finally`, and cancel a generated stream handle if it resolves after timeout. Move HTTP request timer creation to after key and Anthropic input mapping succeed, or otherwise prove all early branches cancel it. Rewrite OpenAI discriminator tests to assert immediate malformed-event rejection independent of timeout. Preserve existing limits, one-time settlement and generic response behavior.
- [ ] **Step 5 — GREEN.** Run the full gateway + Mastra model suites, Biome, scoped diff check and server typecheck. Record the known unrelated probe-script TS2345 only if unchanged.
- [ ] **Step 6 — Freeze and gates.** Record exact increment patch against the verified Fix1 checkpoint, manifests and RED/GREEN evidence. Fresh backend validator repeats tests and checks hashes; scoped independent review returns Spec/Quality verdicts. If source changes after validation/review, rerun affected checks and review.

**Failure handling:** A timeout race must not drop a late-created PlanModel stream; cancel that handle. If the adapter has no cancellation path, report the remaining bounded-resource limitation rather than claiming cleanup. Do not relax the finite deadline or settlement requirement.
