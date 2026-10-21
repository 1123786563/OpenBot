# Governed Model Secret Redaction R4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent redaction-boundary reconstruction of credentials and keep harmless metadata usable with bracket-containing credentials.

**Architecture:** Return untouched strings when no selected secret occurs. If a secret occurs, replace the entire string with a boundedly generated opaque candidate that is checked against every selected secret. Metadata key allocation detects secret-bearing names directly without routing through value-redaction.

**Tech Stack:** TypeScript, Node crypto UUID, Bun tests.

**Spec:** Approved Mastra design §6; R3 review `.superpowers/sdd/2026-10-11-ocr-governed-model-key-redaction-r3/reports/review-r3.md`.

## Global Constraints

- Own only `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.
- Returned strings, keys, and stream parts must not contain selected secrets.
- Unaffected strings and metadata entries pass through unchanged.
- Candidate generation must remain bounded and checked against full secret strings.
- Preserve collisions, Headers type, stream/binary behavior, unknown settlement cleanup, and explicit positive output cap.
- No commit/stash/reset, provider, DB, or network.

## Review Focus

1. `A${secret}B` cannot become a string that reconstructs `${secret}` across replacement boundaries.
2. Secret `[` or `]` does not make unrelated key/value metadata fail.
3. Secret-bearing keys use safe-name allocation without value-marker allocation.
4. Stream chunks and response metadata remain redacted and reader cleanup remains correct on true exhaustion.

---

## Task 1: Whole-value safe replacement

**Files:** `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts`.

**Interfaces:** No exported API changes.

- [ ] RED: add selected token `A[redacted]B` in a value `A${token}B` and assert returned string does not contain token; include metadata value, Header value, and stream delta. Add selected secret `[` with ordinary and secret-bearing metadata proving harmless values remain intact and secret values are redacted.
- [ ] Run focused tests to confirm RED.
- [ ] Implement direct selected-secret detection. Return unchanged string if no secret occurs; otherwise replace the whole string (not surrounding fragments) with a bounded random opaque candidate verified against selected secrets. In key allocation, directly detect selected substrings rather than invoking value redaction.
- [ ] Preserve R3 bounded key allocator and doStream cleanup.
- [ ] Run focused suite, Biome, scoped diff-check; save exact snapshots/package/report.

**Acceptance:** no selected secret is present in output after substitution, bracket secrets do not alter safe unrelated entries, failure on true finite-namespace exhaustion remains generic and cleans stream state.

## Global Constraints

- No budget, authorization, schema, or route changes.
- Validator and reviewer use frozen after hashes.
