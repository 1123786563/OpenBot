# Governed Model Stream Boundary R12 Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ensure no provider secret bypasses the governed stream through text part metadata or nested raw streams.

**Architecture:** Redact a complete text-delta part before preserving its safe delta/id/other fields. Permit the provider's top-level stream only as an internal input that is replaced by the governed wrapper; reject nested stream values as unsupported provider metadata.

**Tech Stack:** TypeScript, AI SDK LanguageModelV3 stream parts, Web Streams, Bun.

**Spec:** Approved Mastra design §6; R11 review `.superpowers/sdd/2026-10-11-ocr-governed-model-boundary-r11/reports/review-r11.md`.

## Global Constraints

- Own only `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.
- All text-delta fields, IDs, and nested metadata are sanitized.
- Raw nested provider streams never reach the caller; top-level provider stream is always replaced by governed stream.
- Preserve binary bytes, ordering, budgeting, settlement and generic errors.
- No commit/stash/reset, provider, DB, network or unrelated edits.

## Review Focus

1. Selected API key in text-delta `id` cannot be emitted, including while delta text is buffered.
2. Selected API key in extra text-delta metadata cannot be emitted.
3. Nested ReadableStream metadata fails closed, settles unknown and cancels the nested/source reader as applicable.
4. Top-level stream still works through governed wrapper.

---

## Task 1: Govern all stream part fields

**Files:** `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts`.

- [ ] RED: add stream test with selected token in text-delta id and extra provider metadata, including pending buffering; add nested stream metadata case asserting generic failure and unknown settlement.
- [ ] Run targeted RED tests.
- [ ] Redact complete text-delta part, then buffer only sanitized id and delta; preserve only sanitized fields.
- [ ] In top-level stream result sanitization, remove the provider stream field before generic redaction, then attach only the governed wrapper; make generic nested ReadableStream values fail closed.
- [ ] Run model/integration/gateway tests, Biome, scoped diff-check; freeze exact snapshots/package/report.

**Acceptance:** all returned part fields and result metadata are governed; nested raw streams cannot escape.
