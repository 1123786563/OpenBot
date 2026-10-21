# R4-2 Proxy Verification Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure binding verification validates and returns only the exact primitive fields captured from untrusted property descriptors.

**Architecture:** Treat the input to `verify(..., value: unknown)` as hostile. Capture the exact own data-property values once, validate that immutable local snapshot against the active scope and expected conversation, then use that same snapshot for canonical HMAC comparison and the newly branded return value. Never read candidate properties again after descriptor capture.

**Tech Stack:** TypeScript, Node.js crypto, Bun test.

**Spec:** `docs/specs/superpowers/2026-10-11-mastra-intelligence-only-design.md` §§3–4; original repair context `docs/plans/superpowers/2026-10-11-mastra-ocr-r4-binding-migration-fix.md` Task R4-2; finding `.../reports/task-r4-2-review.md` R4-2-REV-1.

## Global Constraints

- OpenBot remains authoritative for identity, conversation authorization, and the expected conversation.
- The candidate binding is untrusted input; do not trust getters, proxies, caller-provided brands, or serialized fields until validated.
- Never expose signing keys, canonical payloads, or raw signatures in errors or diagnostics.
- Preserve the module-private brand, HMAC-SHA256 canonical representation, and JSON round-trip support.
- Do not commit or touch unrelated worktree changes.

## Review Focus

1. Proxy `get` traps that disagree with own data descriptors cannot alter verified values.
2. Accessor properties, throwing descriptor traps, arrays, unexpected symbols/keys, and exotic prototypes fail closed without leaking exceptions.
3. The single captured payload is used for scope/conversation checks, HMAC input, and returned binding construction.
4. Existing valid mint/verify and JSON round-trip behavior remains unchanged.

## Task DAG and Acceptance Mapping

| ID | Source | Acceptance | Depends on | Owner | Validator | Owned files | Interfaces | Verification | Status |
|---|---|---|---|---|---|---|---|---|---|
| R4-2-F1 | Reviewer finding R4-2-REV-1 (Medium) | Descriptor values are captured once, validated once, and are the only values used for scope checks, signature comparison, and returned branded value; malicious Proxy/accessor cases fail closed | R4-2 implementation checkpoint | backend_implementer | backend_validator | `server/src/mastra/intelligence-contracts.ts`, `server/tests/enterprise/intelligence-contracts.test.ts` | Existing authority and serialized binding contract unchanged | Focused contract and compatibility tests, strict targeted TypeScript, Biome, scoped diff check | pending |

### Task 1: Snapshot untrusted binding descriptors exactly once (R4-2-F1)

**Depends on:** verified implementation checkpoint R4-2; this is its scoped repair. **Roles:** backend_implementer → backend_validator → reviewer.

**Files / ownership:** Only `server/src/mastra/intelligence-contracts.ts` and `server/tests/enterprise/intelligence-contracts.test.ts`.

**Interfaces:** Keep `verify(scope, conversationId, value: unknown): AuthorizedConversationBinding | undefined`. In `readSerializedBinding`, after `Object.getOwnPropertyDescriptors`, collect each required data descriptor's `.value` into one local payload. Validate the values in that payload and return it. Later checks and construction must not read properties from the original input.

- [ ] **Step 1 — RED:** Add a Proxy test whose `getOwnPropertyDescriptor` reports the signed plain data values while its `get` trap returns a different tenant/workspace string; expect `verify` to return `undefined` (or, if getters are never invoked and descriptor snapshot is valid, return a binding whose fields exactly match those descriptor values). Add an accessor-property test and a throwing descriptor-trap test; all unsafe cases must fail closed.
- [ ] **Step 2 — RED verification:** Run `bun test tests/enterprise/intelligence-contracts.test.ts`; confirm the Proxy disagreement test exposes repeated property reads before the fix.
- [ ] **Step 3 — GREEN:** Refactor parsing to use descriptor `.value` data exclusively. Validate local primitive values; use that one payload for expected scope/conversation comparison, canonical HMAC, and result construction. Preserve fail-closed exception handling.
- [ ] **Step 4 — GREEN verification:** Run focused contract tests and `bun test tests/enterprise/mastra-compatibility.test.ts`; expect all existing tests plus new hostile-object cases to pass.
- [ ] **Step 5 — Static checks:** Run strict targeted TypeScript, Biome on the two files, and scoped `git diff --check`.
- [ ] **Step 6 — Self-review:** Search the parser/verify path for candidate-object property reads after descriptor capture; record exact hashes and report.

**Failure handling:** If proxy descriptor invariants prevent constructing a meaningful hostile fixture, test the feasible Proxy behavior without weakening validation. Do not accept a result containing values other than the captured own data descriptors.

### Shared-file/interface preflight

- One serial task owns both implementation and behavior tests. No other pending task may edit these two files until its after-checkpoint passes independent validation and review.
- Baseline is the verified R4-2 after-checkpoint; task increment must be computed against that snapshot, not HEAD.
- Commit strategy remains uncommitted snapshots; no Git history operation is authorized.
