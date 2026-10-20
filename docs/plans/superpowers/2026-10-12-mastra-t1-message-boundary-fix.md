# Mastra T1 Message Boundary Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two valid Medium T1 review findings by preventing mutation of validated message content and rejecting malformed Mastra V2 parts.

**Architecture:** Keep the existing `parseMessageInput` boundary and message representation. Validate V2 parts against the pinned Mastra V2 part contract before branding, and recursively freeze only the detached JSON persistence graph returned from parsing. Preserve valid binary and URL inputs by canonicalizing them before freezing.

**Tech Stack:** TypeScript, Bun, `@mastra/core` 1.64.0, Biome.

**Spec:** `docs/specs/superpowers/2026-10-11-mastra-intelligence-only-design.md` §§3–5; parent plan `docs/plans/2026-10-11-mastra-intelligence-only-dag.md` Task 1; findings in `.superpowers/sdd/2026-10-11-mastra-intelligence-only-dag/reports/t1-recovery-review.md`.

## Global Constraints

- Mastra owns durable message history and memory; existing OpenBot execution, tool, approval, pause/resume, and recovery mechanisms retain ownership.
- Messages preserve complete parts, tool calls/results, attachment references, and stable identity.
- Repeated message IDs require identical payload; conflicting bodies are rejected and never silently overwritten.
- No product Agent execution, database changes, credentials, or external service calls are introduced in this repair.
- No commit, stash, reset, rebase, database service operation, merge, push, PR, or publish.

## Review Focus

- Callers attempt to mutate nested V2 content after validation; frozen detached values must retain the validated serialized payload.
- Callers attempt to mutate V1 tool helper arrays/objects after validation; the returned V1 graph must remain stable.
- V2 `parts` contains null, primitives, missing/unknown discriminator, or malformed required fields; reject before branding. Accept the pinned `MastraSourceUrlPart` as `type: "source"` and reject the unsupported `type: "source-url"` spelling.
- Valid V2 text, tool call/result, activity, image/file URL/binary parts remain accepted and lossless.
- Hostile getters/proxies and cyclic/sparse structures remain safely rejected without escaping errors or hanging.

---

### Task 1: Harden the T1 message parser output boundary

**Depends on:** T1 recovery checkpoint finding T1-RECOVERY-1 and T1-RECOVERY-2; frozen checkpoint below.

**Roles:** backend_implementer → backend_validator → reviewer.

**Files:** Modify `server/src/mastra/intelligence-contracts.ts`; modify `server/tests/enterprise/intelligence-contracts.test.ts` only.

**Interfaces:** Consumes `parseMessageInput(value: unknown): IntelligenceResult<MessageInput>`. Produces the same API with recursively immutable detached returned content and validates each Mastra V2 part against the pinned part discriminants/required fields before returning `MessageInput`.

**Checkpoint baseline:** HEAD `b1532dbe4ec4d2e64b58fd31c57a7c1863ffd155`; parent increment `reports/t1-recovery-increment.patch` SHA256 `5e33b182e49d4a61dda158108ac7651dd384cd5012a4a639b31cb2f6248deae0`; current T1 file hashes `reports/t1-recovery-after.sha256` SHA256 `efc329910870c602b4c1f8d62e21556c1c7b7d51d7b740a3d0e0ec13cd6b91cf`.

- [x] **Step 1 — RED:** Add a V2 nested mutation test and a V1 helper-array/object mutation test. Assert the return graph is frozen and attempted mutation cannot change serialized parsed content. Add malformed V2 cases for null part, primitive part, missing/unknown `type`, and invalid required fields; assert fixed `invalid-input` failure. Preserve passing valid text/tool/activity/image/file URL/binary parts.
- [x] **Step 2 — Verify RED:** From `server/`, run `bun test tests/enterprise/intelligence-contracts.test.ts -t 'parsed message content is immutable|malformed Mastra V2 parts are rejected'`. Confirm failures are specifically nested output mutation changing payload and malformed V2 inputs being accepted.
- [x] **Step 3 — Implement:** Validate only the pinned Mastra V2 part discriminants and required fields while preserving legal extension fields; recursively `Object.freeze` the already detached persistence graph, not caller-owned input or native binary/URL objects. Keep all parse failures normalized to `intelligenceFailure("invalid-input")`.
- [x] **Step 4 — Verify GREEN:** Run the focused two tests, then `bun test tests/enterprise/intelligence-contracts.test.ts tests/enterprise/mastra-compatibility.test.ts tests/mastra-roster.test.ts tests/learning-mastra.test.ts` from `server/`; expected all pass, including attachment conversion and hostile-input cases.
- [x] **Step 5 — Static checks:** Run targeted strict TypeScript for the contract test, Biome on the two owned files, and `git diff --check` on the exact increment. Record exact output/status.
- [ ] **Step 6 — Repair R2 RED/GREEN:** Add a test rejecting `type: "source-url"` while retaining a valid Mastra source part (`type: "source"`, `source.sourceType: "url"`, string `id`/`url`). Run only the focused regression first and prove RED, then remove the unsupported discriminator, rerun focused and full Task 1 checks.
- [ ] **Step 7 — Freeze and gates:** Save the cumulative after manifest and R2-only increment, TDD repair report, fresh independent backend validation and separate Spec/code quality re-review bound to identical hashes. No downstream DAG task starts until both gates pass.

**Failure handling:** If the pinned Mastra part union cannot be represented without losing legal fields, inspect only the installed 1.64.0 declarations and add a lossless validator for the actual accepted union; do not weaken tests to match implementation. Database is not used. Stop before expanding file ownership.

## Self-review and dependency scan

This repair has one task with two files and one interface; there are no cross-task file overlaps or dependency cycles. It covers only the two review findings and retains the existing T1 compatibility assertions. Plan acceptance is specifically T1 contract behavior; downstream persistence idempotence and production storage remain in their original parent tasks.
