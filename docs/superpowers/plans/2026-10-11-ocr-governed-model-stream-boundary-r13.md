# Governed Model Stream Boundary R13 Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Preserve stable stream part identifiers and cancel rejected nested stream producers.

**Architecture:** Maintain a per-invocation original-ID → sanitized-ID map shared across related start/delta/end events. Collect unsupported nested streams during redaction and best-effort cancel them along with the root provider reader on any failure.

**Tech Stack:** TypeScript, Web Streams, AI SDK LanguageModelV3, Bun.

**Spec:** Approved Mastra design §6; R12 review `.superpowers/sdd/2026-10-11-ocr-governed-model-stream-boundary-r12/reports/review-r12.md`.

## Global Constraints

- Own only `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.
- Identical raw stream IDs map to one sanitized ID for the entire invocation.
- Any rejected nested ReadableStream is canceled on failure, in addition to root reader cancellation.
- Preserve no-secret, generic-error, unknown-settlement, ordering, binary, and output-cap behavior.
- No commit/stash/reset, provider, DB, network or unrelated edits.

## Review Focus

1. Secret-bearing text ID is equal across text-start, all deltas, and text-end.
2. ID remains stable when text flushes around an interleaved part.
3. Rejected nested stream underlying cancel hook runs; root provider reader is canceled too.
4. Cancellation failures remain private and do not block unknown settlement.

---

## Task 1: Stable stream IDs and nested producer cleanup

**Files:** `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts`.

- [ ] RED: add full text-start/delta/text-end sequence with selected token as raw id; assert current safe IDs differ. Update nested stream case with nested and root cancel spies; assert neither called currently.
- [ ] Run targeted tests and record RED.
- [ ] Add per-doStream stable sanitized-ID map for all stream parts that expose string `id`; use mapped ID for pending and flushed parts.
- [ ] Pass a per-invocation rejected-stream collector through recursive redaction. On metadata/pull failure, cancel all collected unlocked/lockable nested streams and root reader, suppressing provider cancel errors.
- [ ] Run model/integration/gateway, Biome, diff-check; freeze hashes/package/report.

**Acceptance:** public IDs stay stable across lifecycle events; nested/root producers are canceled and unknown settlement remains exactly once.
