# OCR Governed Model Key Redaction Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close B-R1's selected-secret metadata-name leak and LOW native API-key regression gap.

**Architecture:** Keep the governed model boundary and its existing selected-secret set. Redact both names and values while copying plain-object metadata and `Headers`, preserving a `Headers` result and non-plain objects.

**Tech Stack:** TypeScript, AI SDK v3 language model, Bun tests, Biome.

**Spec:** Approved Mastra migration plan §6; OCR governed-model repair review B-R1 at `.superpowers/sdd/2026-10-11-ocr-governed-model-repair-r1/reports/review.md`.

## Global Constraints

- Own only `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.
- Redact selected secrets from metadata string keys and values, including valid `Headers` names.
- Preserve `Headers` type, stream functionality, and binary bytes.
- Do not invent an output token default; every caller explicitly supplies a positive cap.
- Do not commit, stash, reset, call providers, or use a database.

## Review Focus

1. A selected token used as a `Headers` name is absent from returned metadata.
2. A selected token/API key used as a plain-object key or metadata value is absent.
3. Sanitizing a header name that collides with another sanitized name does not throw or expose either original name.
4. Native API key is included in the selected secret set for stream metadata.
5. Existing binary stream content and `Headers` runtime type remain unchanged.

---

## Task 1: Redact metadata keys and close native-key evidence gap

**Files:**
- Modify `server/src/mastra/model.ts`
- Test `server/tests/enterprise/mastra-model.test.ts`
- Reports/snapshots: `.superpowers/sdd/2026-10-11-ocr-governed-model-key-redaction-fix/`

**Interfaces:** Consumes the existing redaction helper and selected secret array used by `doStream`; produces the same metadata shape with string keys and values redacted.

- [ ] Add RED tests for selected Plan token in a legal header name and plain object property name; assert neither token occurs in returned metadata and response headers remain a `Headers` instance.
- [ ] Add a native `doStream` test placing resolved API key in a metadata key and value; assert neither occurs in result metadata.
- [ ] Run focused tests and record expected RED.
- [ ] Redact plain-object keys and header names while reconstructing metadata. Ensure header-name collisions are handled deterministically without throwing; retain all available sanitized entries.
- [ ] Run focused tests, Biome on the two owned files, `git diff --check`, and hash-check the exact increment.
- [ ] Save immutable before/after snapshots, package, and implementation report.

**Acceptance:** selected plan token, endpoint, and native key cannot be recovered from returned request/response metadata keys or values; preserved stream/binary tests pass.

## Global Constraints

- Dependencies: none.
- Verification must be bound to the frozen after-snapshot hashes.
- No unrelated M03/M02 files may change.
