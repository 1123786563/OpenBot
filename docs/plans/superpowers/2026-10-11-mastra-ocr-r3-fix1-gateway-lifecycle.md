# Mastra OCR R3 Fix 1 — Gateway Stream Lifecycle Repair Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Task3 review findings for PlanModel header deadlines, cancellation settlement, and timer cleanup while enforcing the approved stream discriminator rule for every provider SSE event.

**Architecture:** Keep the gateway boundary and its two-file ownership. Continue using the manual timer seam for deterministic header/body timing. Ensure the request/header timer stays active until PlanModel returns its stream handle; every request timer is cleared on all exit paths; abort after provider terminal data is still unknown settlement. Validate optional top-level `type` before branching into provider-specific normalization.

**Tech Stack:** TypeScript, Bun, Fetch API, ReadableStream, AI SDK PlanModel adapter.

**Spec:** `docs/superpowers/plans/2026-10-11-mastra-ocr-r3-run-governance.md` Task 3; independent review `.superpowers/sdd/2026-10-11-mastra-ocr-r3-governance/reports/task-3-review.md`; approved ruling R3-ARCH-04 in `.superpowers/sdd/2026-10-11-mastra-ocr-r3-governance/progress.md`.

## Global Constraints

- Preserve Task1/Task2 implementation, user-authored HEAD, and all unowned files. No commit, stash, reset, migration, real provider, push, or merge.
- Change only `server/src/enterprise/models/gateway.ts` and `server/tests/enterprise/model-gateway.test.ts`.
- After provider dispatch, abort/timeout/invalid stream is charged unknown exactly once; it must never confirm authoritative usage after cancellation.
- request deadline is 120,000 ms by default; total stream deadline is 300,000 ms by default and at most 900,000 ms. Caller abort applies through the complete stream.
- Preserve valid provider protocol events and generic public errors; do not leak credentials or settlement exceptions.

## Review Focus

- PlanModel stream creation taking longer than the request/header timeout is aborted at that deadline; after timely stream headers, a healthy body may outlive the header deadline until its total stream deadline.
- Abort or timeout after an authoritative terminal frame but before upstream EOF settles unknown and cancels rather than confirming usage.
- PlanModel success, error, and pre-dispatch exits clear request timers; every stream exit removes abort listeners and clears the total timer.
- Optional top-level SSE `type` values are validated for all providers; non-string or credential-bearing values fail closed before being forwarded or settled, while supported valid labels remain accepted.

---

### Task 1: Repair gateway lifecycle races and discriminator validation

**Depends on:** Frozen R3 Task3 patch and independent review. **Roles:** fresh backend_implementer → fresh backend_validator → independent reviewer. Serial; no commit.

**Files:** Modify only `server/src/enterprise/models/gateway.ts` and `server/tests/enterprise/model-gateway.test.ts`.

**Interfaces:** Consume existing `ModelGatewayDependencies.timer`, request/stream timeout configuration, `Request.signal`, provider fetch, PlanModel adapter signals, and settlement callbacks. Do not add a new public API except narrow test support if strictly needed. Produce deterministic bounded cancellation and cleanup behavior.

- [ ] **Step 1 — RED: PlanModel header bound.** Add a manual timer test where `doStream()` remains pending after dispatch and rejects on abort. Advance the request timer before the total stream timer. Assert `handle()` ends with a generic failure and unknown settlement once. Add/retain a timely-header test showing the stream body can remain healthy beyond the request deadline but within the stream deadline. Confirm the current frozen code fails because it cancels requestTimer before awaiting `doStream`.
- [ ] **Step 2 — RED: abort after terminal data.** Feed an OpenAI SSE source with finish and authoritative usage frames, then hold the next read open. Consume through the finish frame, abort the caller signal, and assert upstream cancel, zero confirmations, one unknown settlement, and a generic stream failure. Confirm current frozen code incorrectly confirms from the terminal state after cancellation.
- [ ] **Step 3 — RED: request timer cleanup.** Assert a PlanModel JSON success cancels its request timer. Assert a PlanModel early route failure after determining no bot ID either schedules no timer or cancels any timer it started. Verify current code leaves the timer active.
- [ ] **Step 4 — RED: discriminator across providers.** Add OpenAI and Anthropic SSE cases with non-string `type` and `type` containing the configured provider secret; assert generic failure, upstream cancellation, zero confirmation, one unknown settlement. Keep a valid supported Anthropic label test. Confirm current OpenAI branch ignores the malformed optional top-level `type`.
- [ ] **Step 5 — Implement minimal fixes.** Keep the request/header timer active through `adapter.doStream()` and clear only after it resolves to a stream handle. Ensure all post-timer returns/errors clear request timer; after headers only the total stream timer remains until settlement/cancel. Check `signal.aborted` after each upstream read and immediately before terminal settlement so abort always wins. Validate an optional top-level `type` before provider branching, requiring string and no configured credential material. Remove abort listeners on stream close/error/cancel. Preserve one settlement coordinator and generic errors.
- [ ] **Step 6 — GREEN and regression verification.** Run `bun test tests/enterprise/model-gateway.test.ts tests/enterprise/mastra-model.test.ts tests/enterprise/mastra-model.integration.test.ts` from `server/`; all tests must execute and pass. Run Biome on the two owned paths, scoped `git diff --check`, and `bun run --filter server typecheck`; report the known unowned `server/scripts/enterprise-runtime-probe.ts:63:26` TS2345 without editing it.
- [ ] **Step 7 — Freeze and independent gates.** Record the exact increment patch, source hashes, commands and results. Fresh backend validator reruns tests/typecheck; independent reviewer returns separate Spec compliance/Quality conclusions and closes the listed findings. Then rerun complete Task3 validation if any frozen source hashes changed after its prior validation.

**Failure handling:** If deterministic ordering cannot be observed through the current timer or stream fakes, refine only the test seam inside the two owned files. Do not weaken timeout or unknown-accounting behavior. If a test reveals a correctness path outside the two files, report its concrete dependency and pause rather than silently widening scope.
