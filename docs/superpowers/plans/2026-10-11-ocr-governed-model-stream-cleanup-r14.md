# Governed Model Nested Stream Cleanup R14 Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Cancel every rejected nested stream without letting provider-controlled cancellation promises block the root invocation's unknown settlement.

**Architecture:** Traverse complete metadata/object arrays and collect unsupported nested streams, then reject after traversal. On failure, mark the invocation unknown and initiate root/nested cancellation best-effort without awaiting provider-controlled cancellation promises.

**Tech Stack:** TypeScript, Web Streams, Bun.

**Spec:** Approved Mastra design §6; R13 review `.superpowers/sdd/2026-10-11-ocr-governed-model-stream-boundary-r13/reports/review-r13.md`.

## Global Constraints

- Own only `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.
- Every nested unsupported stream in a traversed metadata graph has cancellation initiated.
- Unknown settlement and root cancellation do not await nested provider cancel promises.
- Suppress provider cancellation errors; retain generic public failure.
- Preserve stable IDs, stream contract, redaction, binary and usage behavior.
- No commit/stash/reset, providers, DB, network, unrelated edits.

## Review Focus

1. Two sibling nested streams both have cancel hooks invoked before failure is surfaced.
2. A nested cancel promise that never resolves does not block root cancellation or unknown settlement.
3. Nested cancellation errors remain private and do not block later cleanup.

---

## Task 1: Full collection and detached best-effort cleanup

**Files:** `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts`.

- [ ] RED: nested metadata contains two stream values; assert both cancel hooks; make first cancel promise never resolve and assert root cancellation + unknown finish promptly.
- [ ] Run targeted tests to confirm one-only cancellation and blocked settlement.
- [ ] Make redaction collect all nested streams without immediate throw, finish traversing the object, then reject at call boundary.
- [ ] On failure, mark unknown and initiate root/nested cancel best-effort without awaiting provider-controlled promises. Always attempt every collected stream.
- [ ] Run model/integration/gateway, Biome, scoped diff check; freeze exact increment.

**Acceptance:** all nested producer cancellations are initiated, while public failure and unknown settlement complete independently of never-settling nested cancellation promises.
