# Governed Model Stream Boundary R16 Fix 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close R16-Fix3-Q01 by rejecting malformed runtime stream discriminators before dispatch, output, or usage confirmation.

**Architecture:** Treat provider stream parts as untrusted runtime data even when TypeScript declares `StreamPart`. Before any type dispatch, require a primitive string discriminator and reject it if it contains a selected provider credential. Reuse the existing generic failure path to clear buffered output, cancel the provider reader, mark usage unknown once, and never confirm. Keep all valid protocol tags unchanged.

**Tech Stack:** TypeScript, Bun, AI SDK v3, Web Streams.

**Spec:** Approved Mastra design §6; user-approved boundary ruling (2026-10-11): “按边界失败关闭”; reviewer finding `.superpowers/sdd/2026-10-11-ocr-governed-model-redaction-r16-fix3/reports/review-fix3.md`.

## Global Constraints

- Every untrusted provider stream part must have a primitive string `type`; reject non-strings before dispatch.
- Reject primitive string `type` values containing any selected credential; never rewrite protocol tags.
- A rejected stream emits no offending part, clears queued output, cancels provider reading best-effort, settles unknown exactly once, and never confirms usage.
- Expose only the existing generic `MODEL_INVOCATION_FAILED`; do not put provider values into logs or public errors.
- Preserve safe protocol parts, existing redaction behavior, and explicit positive caller-supplied `maxOutputTokens`; add no default.
- Modify only `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.
- No commit, stash, reset, provider, database, network, or other external side effect.

## Review Focus

- An object-valued `type` containing the selected Plan token must not escape or be dispatched; assert generic error, cancellation, one unknown settlement, and no confirmation.
- Representative malformed runtime parts (`type: null`, missing `type`, or object-valued `type`) must fail with the same safe behavior before type-specific handling.
- A primitive discriminator containing a selected credential must fail before output and usage settlement, while ordinary valid tags remain byte-for-byte unchanged.
- If a text part was queued before a later malformed discriminator, the queued part must not leak after the stream is known invalid.
- Provider cancellation rejection must not replace the generic error or prevent unknown settlement.

---

### Task 1: Fail closed on malformed or credential-bearing stream discriminators

**Depends on:** R16-Fix3-CP1 and its independent validator/review evidence; user ruling above resolves the architecture choice. **Roles:** backend_implementer → backend_validator → reviewer.

**Files / ownership:** Modify only `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.

**Consumes:** Existing `containsCredential`, `publicFailure`, provider-reader cancellation, buffered output queue, and unknown/confirm settlement closures.

**Produces:** A runtime guard immediately after each provider reader read and before accessing/dispatching the part discriminator. If `type` is not a primitive string, or contains a selected API key / Plan token, route through the existing fail-closed path. Keep all well-formed non-secret tags unchanged.

- [ ] **Step 1 — RED:** Add focused cases for `type: {label: selectedPlanToken}`, `type: null`, missing `type`, and a secret-bearing primitive tag. Assert the first downstream read rejects generically; no malformed part or queued text is returned; provider cancel is invoked; `unknown` occurs exactly once; `confirm` never occurs. Include a cancel-rejection case to prove cleanup cannot replace settlement.
- [ ] **Step 2 — Confirm RED:** Run only the focused new tests against the frozen Fix3 source; capture expected assertion failures and verify they demonstrate leaked/bypassed discriminator behavior, not fixture/type errors.
- [ ] **Step 3 — GREEN:** Add the guard before any discriminator reads, buffering, enqueue, or finish settlement. Ensure the existing catch clears output, initiates reader cancellation without awaiting untrusted cleanup, marks unknown once, and exposes the generic failure.
- [ ] **Step 4 — Verify:** Run `bun test server/tests/enterprise/mastra-model.test.ts server/tests/enterprise/mastra-model.integration.test.ts server/tests/enterprise/model-gateway.test.ts server/tests/computer-gateway.test.ts`, owned-file Biome, and `git diff --check`. Record exact test/assertion counts and command outputs.
- [ ] **Step 5 — Checkpoint:** Freeze exact before/after hashes for both owned files and a task-only patch; write the implementation report. Do not commit.
- [ ] **Step 6 — Independent gates:** A backend validator verifies the exact frozen hashes and targeted evidence; a separate reviewer returns Spec-compliance and code-quality verdicts. R0 is verified only after both pass.

**Acceptance / failure handling:** A malformed/non-string or credential-bearing tag cannot escape, cannot trigger usage confirmation, and yields one conservative unknown settlement with best-effort cancellation. If review finds another untrusted-data bypass, do not broaden this fix speculatively: trace the exact boundary and create a narrowly scoped repair round with hash-bound evidence.
