# Governed Model Metadata Redaction R2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure metadata-name redaction cannot recreate a selected secret and never drops entries when sanitized names collide.

**Architecture:** Generate opaque replacement names only when a key contains a selected secret; reject candidates containing any selected secret and resolve collisions against already emitted names. Preserve all values while maintaining `Headers` and plain-object shapes.

**Tech Stack:** TypeScript, Node crypto UUID, Fetch `Headers`, Bun tests.

**Spec:** Approved Mastra migration design §6; review `.superpowers/sdd/2026-10-11-ocr-governed-model-key-redaction-fix/reports/review.md`.

## Global Constraints

- Own only `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.
- No secret may appear in a returned metadata key or value.
- Preserve all colliding metadata values deterministically; preserve `Headers` type.
- Keep callers' explicit positive `maxOutputTokens` contract, with no fallback.
- No commit/stash/reset, provider calls, or DB.

## Review Focus

1. Secret exactly `redacted` or `x-redacted` cannot reappear in a sanitized header name.
2. Sanitized header/property-key collisions preserve every original value.
3. Native selected API key is tested on the `doStream` path.
4. `Headers` names remain valid HTTP tokens; response remains a `Headers` instance.
5. Existing stream and binary tests remain byte-exact.

---

## Task 1: Unique safe metadata keys and native stream evidence

**Files:** `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts`.

**Interfaces:** Reuse existing secret list; no public API change.

- [ ] RED: add Plan token `redacted` and `x-redacted` header-name cases; add header and plain-object collision cases; change/add native selected-key case to call `doStream` and place key in metadata name/value.
- [ ] Run focused test; confirm failures show leak/collision/native-stream gap.
- [ ] Implement a candidate-name allocator that retries until candidate is valid for header grammar where needed, contains no selected secret, and is unique among emitted names. Preserve all colliding values and sanitized plain-object entries.
- [ ] Run focused model test, Biome, and scoped diff check; record outputs and hash-bound snapshots/package.

**Acceptance:** every original metadata entry/value survives exactly once under sanitized keys, no selected secret is visible in any key/value, and native streaming metadata is directly covered.

## Global Constraints

- No new dependency; no schema or route changes.
- Bind validation/review to the exact after hashes.
