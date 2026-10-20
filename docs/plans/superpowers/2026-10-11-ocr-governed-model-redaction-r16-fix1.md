# Governed Model Redaction R16 Fix 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. This is one serial backend repair task followed by independent validation and scoped review.

**Goal:** Ensure replacement selection can redact any supported credential value without losing safe context, and bound stream cross-boundary memory when no multi-character credential exists.

**Architecture:** Remove the fixed replacement namespace assumption by searching bounded, unpredictable candidate strings and verifying each complete assembled value. Keep the candidate generator independent from credential contents and fail closed only if the bounded safe candidate search is genuinely exhausted. Record no emitted tail when lookbehind is zero.

**Tech Stack:** TypeScript, Bun, Web Streams.

**Spec:** Approved Mastra design §6; R16 review `.superpowers/sdd/2026-10-11-ocr-governed-model-redaction-r16/reports/review-r16.md`.

## Global Constraints

- Only provider API keys and Plan tokens are selected credentials; no implicit output-token default.
- Preserve safe source context and keep every selected credential absent from returned text.
- Streaming remains bounded and fail closed on a detected leak.
- Preserve earlier R1–R16 behaviors and unrelated workspace edits.
- No commit/stash/reset, DB/provider/network calls, or edits outside `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.

## Review Focus

1. Credential equal to `ob-v-` is masked while surrounding safe content remains.
2. Empty selected credential list and all single-character credentials keep emitted-tail storage bounded at zero.
3. Candidate generation stays bounded and checks whole returned text for internal and boundary reconstruction.

---

### Task 1: Make replacement candidate independent from credential namespace

**Files / ownership:** Modify `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts` only.

**Interfaces:** Consumes existing credential list and interval masker; no exported API changes.

- [ ] **Step 1 — RED:** Add a generated and streamed regression using selected secret `ob-v-` embedded between ordinary prefix/suffix; assert the secret is absent and prefix/suffix are retained. Add/retain a zero-lookbehind long-stream assertion that emitted-tail length remains zero when secrets are empty or single-character only.
- [ ] **Step 2 — Confirm RED:** Run only these tests and record the expected failure (current fixed candidate namespace exhausts; zero lookbehind stores all text).
- [ ] **Step 3 — Implement:** Generate candidate marker strings without a mandatory `ob-v-` prefix; for each bounded candidate, reject if it contains any selected credential or joins with preceding/following known output to form one. Keep complete candidate-value scanning; never return a candidate after exhausting the bounded safe search. Set `emittedTail` to the last `lookbehind` chars only when `lookbehind > 0`, otherwise set it to `""`.
- [ ] **Step 4 — GREEN:** Run focused regressions, then the four scoped model/integration/gateway suites, Biome and scoped diff-check. Preserve tests added by R16-T1.
- [ ] **Step 5 — Checkpoint:** Freeze exact before/after hashes, patch, commands, and report in `.superpowers/sdd/2026-10-11-ocr-governed-model-redaction-r16-fix1/`; validator and reviewer bind the same checkpoint.

**Acceptance:** R16-Q01 Medium and R16-Q02 Low are addressed with no new credential leak or text loss.
