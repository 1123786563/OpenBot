# Governed Model Redaction R16 Fix 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. This is one serial backend repair task followed by independent validation and scoped review.

**Goal:** Close the two remaining Fix2 review findings: prevent selected credentials from escaping through fixed stream protocol discriminators, and redact Headers values without creating new credential collisions.

**Architecture:** A stream discriminator is protocol structure and cannot be rewritten without invalidating the consumer contract. Before any stream part is processed or emitted, scan its `type` value against selected credentials. If it collides, fail closed before returning that part; clear buffered output, cancel the provider reader, mark usage unknown exactly once, and surface only the existing generic public failure. Web `Headers` values are ByteString-limited, so use a separate bounded printable ASCII / non-control Latin-1 sentinel pool absent from selected credentials, directly replacing only matched source intervals. Do not encode a BMP sentinel as a literal escape, since that escape can itself contain a credential.

**Tech Stack:** TypeScript, Bun, Web Streams.

**Spec:** Approved Mastra design §6; validator finding in `.superpowers/sdd/2026-10-11-ocr-governed-model-redaction-r16-fix2/reports/validation-fix2.md`; independent Fix2 review `.superpowers/sdd/2026-10-11-ocr-governed-model-redaction-r16-fix2/reports/review-fix2.md`.

## Global Constraints

- Never return a selected credential through text, metadata, stream fields, or protocol discriminators.
- Preserve valid `StreamPart` type discriminators; do not rewrite protocol structure.
- Headers values must remain valid Web `Headers` ByteStrings and preserve non-secret source text.
- On discriminator collision, fail before emitting the offending part and do not confirm usage; mark outcome unknown exactly once.
- Preserve deterministic text sentinel, raw-source stream safeguards, all prior governed model behavior, and unrelated workspace edits.
- Modify only `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.
- No commit/stash/reset, DB/provider/network calls, or delegation by the implementation agent.

## Review Focus

1. A selected credential `-` colliding with `text-delta` causes a generic failure before any stream part is returned; provider is canceled, usage is unknown once, usage is never confirmed.
2. A credential equal to an actual discriminator such as `finish` is likewise blocked before return/confirmation.
3. A selected credential `u` in Headers value `before u after` is replaced with a ByteString-safe sentinel absent from the credentials; both safe substrings survive, secret is absent, and constructing/reading the Headers succeeds.
4. Exhausted Header-safe sentinel pool fails closed without returning a secret-bearing value.
5. Non-colliding streams remain valid, ordinary text values remain BMP-sentinel-redacted, and existing generated/streaming tests pass.
6. Discriminator checks happen before buffering, output enqueue, or finish usage confirmation.

---

### Task 1: Fail closed on credential-bearing protocol tags

**Depends on:** R16-Fix2-CP1 (implementation frozen; independent review pending) and its validator finding.

**Files / ownership:** Modify `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts` only.

**Consumes:** Existing `containsCredential`, generic `publicFailure`, stream cancellation and unknown-settlement path; Fix2 checkpoint.

**Produces:** A guard that rejects any provider stream part whose fixed `type` discriminator contains a selected credential before that part can escape, plus a bounded Header-compatible sentinel path for Header value text; regression tests cover punctuation/full-tag collisions and ByteString replacement.

- [ ] **Step 1 — RED:** Add a stream test using selected Plan token `-` and provider `text-delta`; assert first read rejects with generic `MODEL_INVOCATION_FAILED`, no part was returned, cancellation occurs, `unknown:` is recorded once, and no `confirm:` occurs. Add a finish-tag collision case if it can be covered without duplicating the first behavior. Add a Header value test using selected token `u`, with retained prefix/suffix and no token in the resulting Header; assert the Headers object remains readable.
- [ ] **Step 2 — Confirm RED:** Run the focused regressions and record the current leak/successful usage confirmation.
- [ ] **Step 3 — Implement:** Check every read provider part's discriminator against selected credentials immediately after read and before dispatching by type, buffering, enqueue, or finish settlement. Reuse existing failure/cancel/unknown path; do not rewrite tags or alter safe parts. Add bounded ByteString-safe sentinel selection for Headers value redaction and route only matched Header source intervals through it; remove escaped BMP sentinel conversion.
- [ ] **Step 4 — GREEN:** Run targeted tests, all four scoped model/integration/gateway suites, Biome, and scoped diff-check.
- [ ] **Step 5 — Checkpoint:** Freeze exact hashes, task-only patch, snapshots, commands and report under `.superpowers/sdd/2026-10-11-ocr-governed-model-redaction-r16-fix3/`.

**Acceptance:** No successful stream can return a fixed discriminator containing a selected credential; conflicting streams fail closed before the offending part and never confirm usage. Header replacement preserves safe text, is accepted by Web `Headers`, and cannot contain a selected credential.
