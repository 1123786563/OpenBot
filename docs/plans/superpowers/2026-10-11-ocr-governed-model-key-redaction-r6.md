# Governed Model Stream Redaction R6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve AI SDK stream part order and keep all joined output safe when multiple replacements or finish metadata are involved.

**Architecture:** Flush pending text before its source-order boundary events (`text-end`, non-text parts, finish); retain emitted suffix context to reject any later text that would complete a credential. Validate the complete result of multi-match replacement, falling back to a whole-window safe replacement. Redact finish data before usage settlement.

**Tech Stack:** TypeScript, AI SDK LanguageModelV3, Fetch streams, Bun.

**Spec:** Approved Mastra design §6; R5 review `.superpowers/sdd/2026-10-11-ocr-governed-model-key-redaction-r5/reports/review-r5.md`.

## Global Constraints

- Own only `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.
- Preserve source order: text delta must precede text-end and any later source part.
- Concatenated emitted deltas and all part values must not expose selected secrets, including replacement-to-replacement or across flushed part boundaries.
- Prepare/redact finish part and pending text before confirming usage; on redaction failure cancel source and mark unknown once.
- Keep bounded searches, reader cleanup, Headers/object collision behavior, binary bytes, and explicit positive output cap.
- No commit/stash/reset, provider, DB, or network calls.

## Review Focus

1. `text-start → text-delta → text-end → finish` retains canonical order with long selected token.
2. Two sanitized replacements cannot form a selected secret at their join.
3. Forced flush before another part cannot permit later text to complete a secret already partly emitted; reject safely before emitting completion.
4. Finish-field redaction failure occurs before usage confirmation and settles unknown once.
5. Source reader cancellation remains exact on pull failure.

---

## Task 1: Ordered, boundary-safe streaming settlement

**Files:** `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts`.

- [ ] RED: test text-start/delta/text-end/finish order; two secret occurrences that cause adjacent candidate replacement and assert joined deltas safe; a later delta completing a secret across forced flush is rejected before completion; finish raw metadata exhaustion causes cancel, generic error, and one unknown (no confirm).
- [ ] Run targeted cases to record RED.
- [ ] Validate final `redactStreamText` output against all selected secrets after all replacements; if reconstructed, use a whole-window safe candidate.
- [ ] Maintain emitted text suffix of max-secret-length minus one. Before enqueueing a new text delta, ensure joining it to prior emitted suffix cannot expose a secret; fail closed and cancel if it does.
- [ ] Flush pending text in source order before `text-end`, non-text parts, and finish. Redact/prepare finish and pending text before usage settlement; confirm/unknown exactly once before exposing finish.
- [ ] Run model/gateway tests, Biome, scoped diff check; freeze exact package/snapshots/report.

**Acceptance:** source protocol order remains valid; no selected secret can appear in joined output text; finish redaction errors cancel and mark unknown before usage confirmation.

## Global Constraints

- No public interface/schema/budget change.
- Evidence is tied to frozen R6 after hashes.
