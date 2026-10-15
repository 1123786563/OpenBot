# Governed Model Stream Boundary R16 Fix 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Fix4-Q01 by preventing provider discriminator rereads and close Fix4-Q02 with a buffered-text rejection regression.

**Architecture:** Snapshot an own data-property `type` descriptor from each untrusted provider part and use only that captured primitive string for validation, dispatch, redaction, and output. Reject accessor/missing/inherited/non-object discriminators before invoking provider getters. Build a shallow stream-part snapshot that omits the original `type` property during field reads and inserts only the captured safe discriminator. Preserve current queued-output clearing/cancellation/unknown settlement. Add a short text delta followed by a malformed discriminator so the same pull buffers text, encounters invalidity, and exposes no text.

**Tech Stack:** TypeScript, Bun, AI SDK v3, Web Streams.

**Spec:** Approved Mastra design §6; user ruling “按边界失败关闭”; R16-Fix4 reviewer findings at `.superpowers/sdd/2026-10-11-ocr-governed-model-redaction-r16-fix4/reports/review.md`.

## Global Constraints

- Treat provider stream parts as untrusted runtime data, independent of TypeScript declarations.
- A usable discriminator must be an own data property whose captured value is a primitive string and contains no selected credential.
- Never invoke or reread the original `type` accessor; use one captured safe tag for validation, dispatch, redaction, and output.
- Accessor, missing, inherited, null, object, and credential-bearing tags fail before dispatch/output/finish settlement.
- On rejection, emit no offending part or still-buffered text, clear output and pending text, initiate best-effort reader cancellation, settle unknown exactly once, never confirm, and expose only generic `MODEL_INVOCATION_FAILED`.
- Preserve valid protocol tags, existing redaction/stream behavior, and explicit positive caller-supplied `maxOutputTokens`; do not add defaults.
- Modify only `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.
- No commit, stash, reset, provider, database, network, or external side effect.

## Review Focus

- A `type` getter that would return `finish` on first access and a selected token later must never run; the stream rejects before usage confirmation.
- Plain own data-property tags still preserve valid protocol behavior and reject secret-bearing strings.
- A short safe text delta buffered by lookbehind before a malformed tag must not be returned after rejection.
- Synchronous and rejected asynchronous cancellation cannot replace generic failure or prevent the one unknown settlement.

---

### Task 1: Snapshot and use the validated stream discriminator exactly once

**Depends on:** R16-Fix4-CP1; independent validation passed; Fix4-Q01/Q02 review findings. **Roles:** backend_implementer → backend_validator → reviewer.

**Files / ownership:** Modify only `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.

**Consumes:** Fix4-CP1 generic error, buffered-text lookbehind, queued-output cleanup, provider-reader cancellation, unknown/confirm settlement, and selected secret set.

**Produces:** A runtime snapshot helper or equivalent inline boundary that obtains `type` with `Object.getOwnPropertyDescriptor`, requires an own data descriptor, stores its value once, validates primitive string and credential absence, and constructs a plain safe snapshot excluding the original `type` read. All downstream branches and redaction receive the snapshot and captured tag.

- [ ] **Step 1 — RED:** Add an accessor regression whose getter would return a valid `finish` tag on first read and the selected Plan token on a later read; assert fail-closed generic error, getter invocation count zero, cancellation, unknown once, and no confirm. Add a buffered-text case: enqueue a short safe `text-delta` smaller than lookbehind, then an object-valued secret-bearing `type`; assert first downstream read errors with generic failure and returns no text, with cancellation/unknown/no-confirm.
- [ ] **Step 2 — Confirm RED:** Run the two focused tests against Fix4-CP1; record behavior failures, not fixture/type failures.
- [ ] **Step 3 — GREEN:** Capture the own `type` data descriptor without invoking accessors; validate it before processing; snapshot other enumerable fields while omitting raw `type`; insert/use the captured string for all discriminant comparisons and returned parts. Keep cleanup generic and conservative.
- [ ] **Step 4 — Verify:** Run `bun test server/tests/enterprise/mastra-model.test.ts -t 'malformed provider stream|buffered text before malformed'`, then the four scoped model/integration/gateway suites, owned-file Biome, and `git diff --check`. Record exact outputs and counts.
- [ ] **Step 5 — Checkpoint:** Freeze after snapshots, task-only patch and hash-bound report. No commit.
- [ ] **Step 6 — Independent gates:** Backend validator verifies exact hashes and test evidence; separate reviewer returns Spec and Quality verdicts. R16/R0 remains unverified until both pass.

**Acceptance / failure handling:** No accessor can change a discriminator between check and use; invalid runtime tags cannot emit or confirm; buffered text is discarded on the same failure. If the provider SDK uses accessor-backed stream parts in supported operation, stop and report that compatibility evidence rather than weakening the boundary.
