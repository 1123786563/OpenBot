# Governed Model Usage Getter Safety R10 Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ensure exceptions while reading provider usage fields settle as unknown instead of escaping.

**Architecture:** Wrap all runtime shape/property access and arithmetic in `totalUsage` with a narrow try/catch. Any malformed value or getter failure returns `undefined`, which reuses established unknown settlement.

**Tech Stack:** TypeScript, Bun tests.

**Spec:** Approved Mastra design §6; review `.superpowers/sdd/2026-10-11-ocr-governed-model-key-redaction-r9/reports/review-r9.md`.

## Global Constraints

- Own only `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.
- Usage shape/property exceptions are unknown, never public raw exceptions or confirmed usage.
- Preserve valid totals and existing invalid-shape handling.
- No commit/stash/reset, provider, DB, network, or unrelated edits.

## Review Focus

1. Throwing `inputTokens` getter in generate resolves safely and marks unknown once.
2. Throwing usage getter on finish is sanitized, marks unknown once, and finish delivery follows existing policy.
3. Valid plain usage still confirms once.

---

## Task 1: Guard usage property access

**Files:** `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts`.

- [ ] RED: add generate/stream fixtures with class instances whose `inputTokens` getter throws; assert no raw error, unknown once, no confirmation, and stream finish delivered.
- [ ] Run targeted tests against current behavior and capture RED.
- [ ] Catch all shape/getter errors inside `totalUsage` and return undefined.
- [ ] Run model/integration/gateway tests, Biome and scoped diff-check; freeze snapshots/packages/report.

**Acceptance:** malformed getters follow unknown settlement without raw exceptions; valid usage still confirms.
