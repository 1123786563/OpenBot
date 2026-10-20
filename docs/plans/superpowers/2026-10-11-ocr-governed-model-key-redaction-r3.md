# Governed Model Metadata Redaction R3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent replacement values from recreating credentials and ensure collision-safe name generation always terminates or cleans up conservatively.

**Architecture:** Generate replacements through bounded candidate search that validates each whole candidate against all selected secrets and already-used names. When metadata redaction fails after stream acquisition, cancel the reader, settle the invocation unknown, and return a generic failure.

**Tech Stack:** TypeScript, Node crypto UUID, AI SDK v3, Fetch `Headers`, Bun tests.

**Spec:** Approved Mastra migration design §6; R2 review `.superpowers/sdd/2026-10-11-ocr-governed-model-key-redaction-r2/reports/review-r2.md`.

## Global Constraints

- Own only `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.
- No selected secret may occur in any returned metadata key/value or emitted stream part.
- Name/value candidate generation must have an explicit finite bound and never spin indefinitely.
- If redacting stream result metadata fails after upstream acquisition, cancel upstream reader and mark capability unknown before returning generic failure.
- Preserve collisions, valid Headers, explicit caller output cap, and binary stream bytes.
- No commit/stash/reset, DB, provider, or network access.

## Review Focus

1. Selected secret `redacted` cannot be recreated by the replacement value in object, header, or stream part.
2. Selected secret containing nearly all HTTP token characters cannot cause allocator spin.
3. Multiple secret-bearing keys remain unique when the usable candidate set is constrained.
4. Exhausted safe-name search has a bounded cleanup path: reader canceled and capability marked unknown.
5. Normal collision and binary stream behavior remains intact.

---

## Task 1: Bounded safe replacement and stream cleanup

**Files:** `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts`.

**Interfaces:** Keep exported GovernedModel APIs unchanged.

- [ ] RED: add value assertions for `redacted` in a metadata value and stream part; add near-exhaustive token-alphabet secret with two secret-bearing metadata keys and verify prompt termination or generic failure; add exhausted-alphabet stream case asserting reader cancel and `markModelInvocationUnknown` once.
- [ ] Run focused tests and record RED.
- [ ] Implement finite safe candidate search, checking complete candidates against the secret set and reserved/emitted names. Do not remove all characters appearing inside a secret before testing whole candidates. Replace fixed `[redacted]` marker with a candidate verified against selected secrets.
- [ ] On stream result metadata redaction failure, cancel the reader and mark unknown; preserve original generic error boundary.
- [ ] Run focused suite, Biome, and scoped diff-check; record exact snapshots/package/report.

**Acceptance:** adversarial cases terminate within the test timeout; no secret occurs in returned keys/values/parts; exhaustion does not leak a key, hang, leave an open reader, or leave invocation settlement implicit.

## Global Constraints

- No schema, auth, routing, or budget policy changes.
- Tests bind to frozen after-file hashes.
