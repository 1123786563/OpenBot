# Governed Model Generate Settlement R7 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure generate metadata-redaction failures settle the invocation unknown instead of confirming usage for a failed public result.

**Architecture:** Prepare the fully redacted generate response before usage settlement. On redaction failure, settle unknown exactly once and return the generic public error. Only after successful preparation may usage be confirmed or marked unknown based on provider usage.

**Tech Stack:** TypeScript, AI SDK LanguageModelV3, Bun tests.

**Spec:** Approved Mastra design §6; R6 re-review `.superpowers/sdd/2026-10-11-ocr-governed-model-key-redaction-r6/reports/review-recheck.md`.

## Global Constraints

- Own only `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.
- Redaction failure must never confirm usage; unknown settlement is idempotent and generic.
- Preserve existing output-cap, model invocation, stream, binary, and reader-cleanup behavior.
- No commit/stash/reset, DB/provider/network, or unrelated file edits.

## Review Focus

1. A generated result containing a selected secret that exhausts safe replacement candidates rejects generically.
2. The same failure marks unknown exactly once and never calls confirm usage.
3. Normal generated result redaction still confirms usage once before returning.

---

## Task 1: Redact before generate settlement

**Files:** `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts`.

- [ ] RED: add generate result with token `ob-v-` in text content (forcing marker candidate exhaustion); assert generic failure, unknown once, no confirm.
- [ ] Run targeted test to prove current confirmation occurs before the thrown redaction failure.
- [ ] Move response redaction before usage settlement; on redaction throw, await idempotent markUnknown (swallow internal settlement details) and throw generic failure.
- [ ] Keep normal confirmation and unknown-usage tests passing.
- [ ] Run model/integration/gateway suites, Biome, scoped diff check; freeze snapshots/package/report.

**Acceptance:** no redaction-failed public generation is usage-confirmed; unknown settlement occurs once, normal successful generation behavior unchanged.
