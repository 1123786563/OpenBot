# Governed Model Redaction R16 Fix 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. This is one serial backend repair task followed by independent validation and scoped review.

**Goal:** Close R16-Fix1 review findings with a deterministic replacement that cannot contain a selected credential, preserves safe finish metadata context, and avoids process-global test instrumentation.

**Architecture:** Select one printable BMP sentinel by bounded deterministic scan from visible block characters followed by BMP private-use characters, requiring that no selected credential contains it. Replace every merged source credential interval atomically with that sentinel. Do not use random replacement candidates. Keep raw-source stream lookbehind, source-coordinate cut adjustment, emitted-tail check, forced-flush boundary rejection, and the complete output / `leftContext + output` defensive scan. If no sentinel is available or a defensive check fails, take the existing public failure path and settle usage unknown.

**Tech Stack:** TypeScript, Bun, Web Streams.

**Spec:** Approved Mastra design §6; R16 review `.superpowers/sdd/2026-10-11-ocr-governed-model-redaction-r16/reports/review-r16.md`; Fix1 review `.superpowers/sdd/2026-10-11-ocr-governed-model-redaction-r16-fix1/reports/review-fix1.md`; read-only architecture adjudication in current task.

## Global Constraints

- Only provider API keys and Plan tokens are selected credentials; no implicit output-token default.
- Preserve safe source context and keep every selected credential absent from returned text.
- Streaming remains bounded and fails closed on a detected leak or exhausted bounded sentinel pool.
- Keep metadata-key policy separate from text value redaction.
- Preserve earlier R1–R16 behaviors and unrelated workspace edits.
- No commit/stash/reset, DB/provider/network calls, or edits outside `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.

## Review Focus

1. One-character credentials including `-` and `4`, `ob-v-`, adjacent intervals, generated text, split stream chunks, and finish metadata preserve safe prefix/suffix while excluding the credential.
2. A selected credential equal to a sentinel candidate advances selection; sentinel-pool exhaustion fails closed.
3. Raw-source stream boundary handling, forced flush rejection, and complete assembled-output defensive checks remain intact.
4. Long zero-lookbehind streaming test does not patch global built-ins and verifies complete output.

---

### Task 1: Use a deterministic credential-absent text sentinel

**Depends on:** R16-T1 and Fix1 checkpoint (both remain unverified until this repair passes independent gates).

**Files / ownership:** Modify `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts` only.

**Consumes:** R16 exact source intervals and streaming lookbehind implementation; Fix1 reviewer findings Q01-Q03; architect recommendation to use a single absent code point and retain source-coordinate stream safeguards.

**Produces:** A bounded `selectTextSentinel(secrets)` helper and exact, atomic interval replacements; regression coverage for generated, streamed, finish metadata, adjacency/split chunks, sentinel collision/exhaustion, and zero-lookbehind output.

- [ ] **Step 1 — RED:** Add tests showing generated and streamed `before - after` and `before 4 after` preserve context while removing one-character credentials; exercise split chunks and adjacent matches; update finish metadata test to use `before ob-v- after` and assert both surrounding values survive; add deterministic sentinel collision/exhaustion coverage where testable. Replace the global `String.prototype.slice` patch with long-stream output assertions.
- [ ] **Step 2 — Confirm RED:** Run targeted tests and capture expected failures against Fix1.
- [ ] **Step 3 — Implement:** Scan a bounded deterministic pool of printable single-code-unit BMP sentinels, first visible block characters then BMP private-use values; choose the first character absent from every selected credential. Replace merged intervals with that character. Remove UUID/random candidate retries from text replacement only. Keep metadata-key replacement independent. Preserve defensive full-value and left-context scans, raw-source lookbehind and existing flush-boundary rejection. Empty lookbehind must continue storing an empty emitted tail.
- [ ] **Step 4 — GREEN:** Run targeted tests, then model/integration/gateway suites, Biome and scoped diff check.
- [ ] **Step 5 — Checkpoint:** Freeze exact before/after hashes, full task-only patch, commands, output and report under `.superpowers/sdd/2026-10-11-ocr-governed-model-redaction-r16-fix2/`; validator and reviewer bind the same checkpoint.

**Acceptance:** R16-Fix1-Q01, Q02, Q03 and all original R16 exact-mask / streaming acceptance criteria pass without new leaks, context loss, unbounded buffering, or successful settlement after a detected failure.
