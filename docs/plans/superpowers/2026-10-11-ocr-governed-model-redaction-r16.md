# Governed Model Credential Redaction R16 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. The controller dispatches one backend implementation task, then independent backend validation and review.

**Goal:** Redact selected model credentials without destroying safe output or exposing credentials across streamed chunk boundaries.

**Architecture:** Keep credential masking at the governed model boundary, operating on original source text and exact match intervals. Use one invocation-scoped credential set containing only provider API keys and Plan tokens; preserve ordinary surrounding content and keep the stream's source-coordinate lookbehind separate from masked output. Keep collision-safe metadata-key and stable stream-ID policies intact.

**Tech Stack:** TypeScript, Bun, Web Streams.

**Spec:** [Approved Mastra migration design §6](../specs/2026-10-10-mastra-intelligence-migration-design.md); R15 full workspace OCR `.superpowers/sdd/2026-10-10-mastra-intelligence-migration/reports/ocr-r15-workspace.txt`; architecture adjudication in the R16 ledger.

## Global Constraints

- Every model invocation caller explicitly supplies a positive `maxOutputTokens`; no implicit default or invented budget.
- Provider API keys and Plan tokens remain private; ordinary model output and Plan endpoint text are not credentials.
- Per-Run cumulative usage remains governed by the issued capability; failures with ambiguous provider execution are settled unknown, never confirmed after a failure.
- Rejected provider stream shapes fail before output, best-effort cancel readers, and settle unknown exactly once.
- Preserve the existing ID mapping, part order, metadata-key collision safety, binary payload bytes, and output limits.
- No commit, stash, reset, database, external provider, network call, or edits outside the owned files.

## Review Focus

1. Secret inside ordinary prose: preserve every character outside exact credential matches while leaving no selected secret in the returned value.
2. Overlapping and adjacent matches: mask their union and preserve unrelated prefix/suffix text.
3. Chunk-split secret: hold raw source suffix across chunks, mask before emission, and preserve unrelated text on both sides.
4. Replacement boundaries: replacement text and neighboring output cannot recreate a selected secret, including when a credential contains bracket/marker text.
5. Plan route: token is masked but its endpoint remains intact in generated and streaming content.

---

### Task 1: Preserve safe text while masking credentials

**Depends on:** R15 Spec and Quality PASS. **Roles:** backend_implementer → backend_validator → reviewer. **Execution:** serial; do not dispatch dependent work before both gates pass.

**Files / ownership:** Modify `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts`. No other path is owned.

**Interfaces:** Consumes the existing `secrets` argument at the governed boundary and stream lifecycle. Produces no exported API changes. Redaction takes selected credential strings only (provider API key and selected Plan token); plan endpoint is excluded.

- [ ] **Step 1 — RED:** Add focused cases for ordinary generated text containing a credential, adjacent/overlapping repeated credential occurrences, a credential split across stream chunks with safe prefix/suffix, marker-collision input (including `A[redacted]B` and `redacted`), and Plan endpoint text alongside its token. Assert safe surrounding content is preserved and no full credential appears in output.
- [ ] **Step 2 — Confirm RED:** Run each new focused test against current production code. Expected failures must demonstrate whole-value replacement, over-wide stream deletion, endpoint removal, or cross-boundary masking failure—not fixture/import errors. Record exact outputs and source hashes.
- [ ] **Step 3 — Implement:** Replace whole-value masking with a bounded exact-match interval masker over the original string. Merge overlapping or adjacent credential intervals, replace only their union with a collision-safe marker, and verify the final candidate contains no selected credential before returning. Remove `planEndpoint` from the invocation's redaction credential list. In streaming, retain up to the longest credential length minus one characters from the **raw source**, choose emission boundaries in source coordinates (backing a boundary up when an interval crosses it), and never slice masked output by a raw-source length. Keep replacements atomic at emitted boundaries and retain the existing emitted-tail fail-closed check.
- [ ] **Step 4 — GREEN/refactor:** Run focused new cases; then run `bun test server/tests/enterprise/mastra-model.test.ts server/tests/enterprise/mastra-model.integration.test.ts server/tests/enterprise/model-gateway.test.ts server/tests/computer-gateway.test.ts`. Run Biome on both owned files and scoped `git diff --check`. Expected: all tests pass; no credential appears; ordinary surrounding text and endpoint survive.
- [ ] **Step 5 — Checkpoint:** Freeze before/after contents and hashes, HEAD, exact task increment and report under `.superpowers/sdd/2026-10-11-ocr-governed-model-redaction-r16/`. Independent validator and reviewer must bind the same after hashes. Any new issue starts a numbered repair task; do not amend the frozen checkpoint in place.

**Acceptance / failure handling:** Close R15 workspace OCR findings for whole-value loss, over-wide stream replacement, and endpoint misclassification; close the related low zero-lookbehind buffer issue. Preserve all prior R1–R15 regression behavior. On a failing security edge, keep output generic and credentials unexposed; never weaken the check to make tests pass.
