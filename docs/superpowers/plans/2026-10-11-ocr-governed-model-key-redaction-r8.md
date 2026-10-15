# Governed Model Missing Usage R8 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Treat a missing provider usage object as unknown usage and settle the invocation safely.

**Architecture:** Make the internal usage estimator tolerate absent usage at runtime and return `undefined`, reusing the existing mark-unknown path for generate and stream.

**Tech Stack:** TypeScript, AI SDK LanguageModelV3, Bun.

**Spec:** Approved Mastra design §6; R7 review `.superpowers/sdd/2026-10-11-ocr-governed-model-key-redaction-r7/reports/review-r7.md`.

## Global Constraints

- Own only `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.
- Absent or invalid usage never confirms; it marks unknown once and remains generic.
- Preserve known usage confirm behavior and all existing redaction/stream guarantees.
- No commits/stash/reset, providers/DB/network or unrelated edits.

## Review Focus

1. Runtime-absent generate usage returns safely with unknown settlement once.
2. Runtime-absent stream finish usage delivers redacted finish after unknown settlement once.
3. Known usage continues to confirm; invalid numeric usage remains unknown.

---

## Task 1: Optional usage normalization

**Files:** `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts`.

- [ ] RED: add generate and stream cases where the runtime omits the complete usage property; assert no TypeError, unknown once, no confirm, and finish delivery for stream.
- [ ] Run targeted tests and capture current TypeError/missing unknown behavior.
- [ ] Make `totalUsage` accept `undefined` and return `undefined` before property access; keep runtime behavior for present objects.
- [ ] Run model, integration, gateway suites, Biome, scoped diff-check and freeze exact package/snapshots/report.

**Acceptance:** absent usage is accounted unknown through existing path, with no public TypeError or false confirmation.
