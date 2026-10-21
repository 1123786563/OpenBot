# Governed Model Malformed Usage R9 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent malformed runtime usage values such as `null` from escaping settlement handling.

**Architecture:** Treat provider usage as untrusted runtime data. Normalize `unknown` values; only a present object with nonnegative safe integer totals yields confirmed usage. Every other shape returns `undefined` and follows mark-unknown.

**Tech Stack:** TypeScript, AI SDK LanguageModelV3, Bun.

**Spec:** Approved Mastra design §6; R8 review `.superpowers/sdd/2026-10-11-ocr-governed-model-key-redaction-r8/reports/review-r8.md`.

## Global Constraints

- Own only `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.
- Malformed/missing usage never confirms or throws a raw TypeError; settle unknown exactly once.
- Preserve valid usage confirmation and stream finish delivery.
- No commit/stash/reset, DB/provider/network, or unrelated edits.

## Review Focus

1. `usage: null` generates generic successful response with unknown once (for generated content) and no confirm.
2. `usage: null` on stream finish delivers finish after unknown once.
3. Primitive/array/malformed totals remain unknown; valid totals still confirm.

---

## Task 1: Normalize usage from unknown

**Files:** `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts`.

- [ ] RED: add generate/stream cases with `usage: null`, asserting no TypeError, one unknown, no confirm, and safe finish delivery.
- [ ] Run targeted RED cases.
- [ ] Change internal total-usage function to accept `unknown`, guard null/non-object/arrays and malformed token structures, then return undefined; retain safe integer/nonnegative checks.
- [ ] Run model, integration, gateway suites, Biome and scoped diff check; freeze exact snapshots/packages/report.

**Acceptance:** only structurally valid numeric usage confirms; all other runtime shapes use unknown safely.
