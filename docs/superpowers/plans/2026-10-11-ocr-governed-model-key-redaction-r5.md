# Governed Model Stream Redaction R5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent credentials reconstructed across adjacent stream text deltas and cancel upstream reads when part redaction fails.

**Architecture:** Add bounded-lookbehind buffering for text deltas, sanitizing combined pending text before releasing all but the longest-secret overlap. Flush pending safe text before finish; discard it on cancellation/error. In any pull failure, mark unknown and cancel the source reader.

**Tech Stack:** TypeScript, AI SDK LanguageModelV3 stream parts, Bun Web Streams.

**Spec:** Approved Mastra design §6; R4 review `.superpowers/sdd/2026-10-11-ocr-governed-model-key-redaction-r4/reports/review-r4.md`.

## Global Constraints

- Own only `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.
- The concatenation of emitted text deltas must not contain any selected secret, including secrets split across source deltas or replacement boundaries.
- Pending text is never exposed until at least `maxSecretLength - 1` lookbehind makes it safe.
- On part redaction failure, cancel acquired source reader and mark unknown exactly once.
- Preserve binary chunks, metadata names/collision behavior, stream ordering, and positive explicit output cap.
- No commit/stash/reset, providers, database, or network calls.

## Review Focus

1. Adjacent source deltas whose combined content contains a secret emit no such substring after concatenation.
2. Sanitized replacement plus future text cannot reconstruct a selected token across output parts.
3. Finish flushes pending redacted text before the finish part; incomplete/error/cancel does not leak pending text.
4. Part-redaction candidate exhaustion calls upstream cancel and marks unknown once.
5. Binary bytes are emitted unchanged.

---

## Task 1: Stateful stream text sanitizer and source cleanup

**Files:** `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts`.

**Interfaces:** No exported API changes.

- [ ] RED: add two source text-delta parts with token `Xob-v-` that currently assemble to the token after marker substitution; assert joined public deltas do not contain token. Add split-source-secret case, finish ordering, and exhausted part-redaction case with cancel spy and one unknown settlement.
- [ ] Run tests and record the failing assertions before implementation.
- [ ] Implement pending text buffer. Combine pending plus each raw delta, redact, retain trailing overlap of `maxSecretLength - 1`, and emit safe prefix only. Flush pending through redactor immediately before finish; drop on error/cancel. Ensure the pull algorithm reads ahead when a chunk emits no prefix without blocking indefinitely past finish.
- [ ] Cancel the provider reader in pull failure before surfacing generic error; retain idempotent unknown settlement.
- [ ] Run focused model/gateway tests, Biome, scoped diff check; save exact snapshots/package/report.

**Acceptance:** no selected secret appears in joined text output under adjacent-delta boundary cases, stream ordering stays valid, and source cancellation/unknown settlement is evidenced.

## Global Constraints

- No schema, route, or budget changes.
- Verification uses frozen R5 after hashes.
