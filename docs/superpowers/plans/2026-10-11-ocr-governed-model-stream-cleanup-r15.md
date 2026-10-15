# Governed Model Stream Part Cleanup R15 Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Reject nested streams in text-delta fields before they can be emitted or usage confirmed.

**Architecture:** After redacting all non-delta text-part fields, check the shared rejected-stream collector before buffering the delta; throw into the existing cleanup path if unsupported streams were found.

**Tech Stack:** TypeScript, Web Streams, Bun.

**Spec:** Approved Mastra design §6; R14 review `.superpowers/sdd/2026-10-11-ocr-governed-model-stream-cleanup-r14/reports/review-r14.md`.

## Global Constraints

- Own only `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.
- Nested streams anywhere in any provider part fail closed before enqueue.
- Rejected nested/root streams are canceled best-effort and unknown is marked once, without confirming usage.
- Preserve all stable ID, ordering, collision, binary and output cap behavior.
- No commit/stash/reset/provider/DB/network or unrelated edits.

## Review Focus

1. Text-delta extra field with nested stream is not emitted.
2. Nested source and root source cancel hooks run even if cancellation hangs/errors.
3. Invocation marks unknown exactly once and never confirms after part rejection.

---

## Task 1: Enforce collected-stream rejection on text deltas

**Files:** `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts`.

- [ ] RED: provider emits text-delta with nested ReadableStream in provider metadata, followed by finish; assert generic failure, no text delta, both cancel hooks, unknown once/no confirm.
- [ ] Run targeted RED.
- [ ] Check collector immediately after redacting text-delta source fields and before buffering/emission; use existing cleanup path.
- [ ] Run model/integration/gateway suites, Biome, diff-check and freeze exact snapshots/package/report.

**Acceptance:** nested stream in any text part is rejected before output/usage confirmation and cleaned up.
