# Governed Model Provider Boundary R11 Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close remaining provider-object accessor and stream-reader acquisition paths that can bypass redaction or settlement.

**Architecture:** Guard outer usage reads and reader acquisition with public generic error/unknown settlement. Recursively sanitize supported enumerable provider metadata, while preserving explicit safe runtime types (Headers and binary views); reject unsupported opaque object types rather than returning them unchanged.

**Tech Stack:** TypeScript, AI SDK LanguageModelV3, Web Streams, Bun.

**Spec:** Approved Mastra design §6; R10 review `.superpowers/sdd/2026-10-11-ocr-governed-model-key-redaction-r10/reports/review-r10.md`.

## Global Constraints

- Own only `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.
- No provider object with selected secrets may bypass redaction.
- Any post-claim exception must be generic and settle unknown exactly once; stream acquisition failures must not leak raw errors.
- Preserve Headers and binary bytes, accounting rules, output caps, stream ordering.
- No commit/stash/reset, provider, DB, network, or unrelated edits.

## Review Focus

1. Root result `usage` getter failures cannot escape doGenerate settlement.
2. Class-instance metadata containing selected key cannot return/emit unsanitized; either sanitize enumerable own fields safely or fail closed.
3. Throwing stream/getReader accessor marks unknown once and returns generic failure.
4. Nested usage getters continue to resolve to unknown.
5. Known usage and prior redaction/stream tests remain valid.

---

## Task 1: Close provider object and acquisition boundaries

**Files:** `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts`.

- [ ] RED: add a root `usage` getter that throws; a class instance provider-metadata object with enumerable selected key; and a stream `getReader` throwing accessor. Assert unknown once, no confirm, generic boundary; preserve finish policy where appropriate.
- [ ] Run targeted RED tests.
- [ ] Make usage extraction access safe; make `redact` sanitize supported class own properties or fail closed for opaque non-plain values (except Headers and ArrayBuffer views); preserve binary bytes.
- [ ] Guard `getReader()` acquisition with markUnknown and generic error.
- [ ] Run model/integration/gateway suites, Biome, scoped diff check; freeze complete task increment and report.

**Acceptance:** no outer getter or opaque provider object leaks a raw exception/secret; failed stream acquisition settles unknown; known supported values retain contracts.
