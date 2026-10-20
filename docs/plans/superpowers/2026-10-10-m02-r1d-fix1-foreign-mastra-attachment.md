# M02 R1D Fix 1 — Foreign Mastra Attachment Denial Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Close review finding M02-R1D-01 by proving a foreign actor cannot attach another actor's file to a Mastra conversation they own, with no storage write, finalized intent, or attachment stamp.

**Architecture:** Keep the service implementation unchanged. Extend the existing conversations integration test with a distinct private conversation for the authenticated foreign principal and attempt to attach the owner's channel file while that channel is active. Assert the authorization rejection and all no-side-effect conditions independently of the existing revoked-member and deleted-channel cases.

**Tech Stack:** Bun, TypeScript, Drizzle, isolated PostgreSQL integration fixtures.

**Spec:** Approved migration spec §§4–5 and 10; R1D plan Task R1D Step 5; finding M02-R1D-01 in `.superpowers/sdd/2026-10-10-m02-r1d-r8-evidence-repair/reports/m02-r1d-review.md`.

## Global Constraints

- Use only the approved synthetic loopback PostgreSQL URLs in `.superpowers/sdd/2026-10-10-mastra-intelligence-migration/m02-r1a-brief.md`; never fall back to `DATABASE_URL` or persist URL/password values.
- Keep database tests serial. Use existing random fixture identities and assert exact cleanup for both private conversation rows and their intents.
- Change only `server/tests/enterprise/conversations.integration.test.ts`; no production source, schema, migration, or unrelated fixture edits.
- No source commits, stash, reset, or history rewrite. The workspace already contains owner-created commit `e15cef8`; preserve it and the verified R1D checkpoint unchanged.
- Do not claim this test covers Task 12 production cutover CAS or in-flight cutover races.

## Review Focus

1. An authenticated foreign principal owns a newly created private Mastra conversation but cannot use an attachment uploaded by the original actor; this is distinct from being denied access to the original actor's conversation.
2. The denied request must leave Mastra storage untouched, create no intent/finalization, and preserve the file's pre-test `attachedAt` value.
3. Cleanup must remove only this test's two generated conversation rows and intent references while restoring shared channel fixtures.

---

### Task M02-R1D-FIX1: Foreign actor attachment authorization evidence

**Depends on:** M02-R1D implementation checkpoint, independent validator PASS, finding M02-R1D-01. **Roles:** `backend_implementer` → `backend_validator` → `reviewer`.

**Files:** Modify only `server/tests/enterprise/conversations.integration.test.ts` in the existing Mastra attachment denial test. Do not edit `server/src/enterprise/conversations/service.ts` or any other file.

**Interfaces:**

- Consumes existing `foreignScope`, the Mastra-enabled `createConversationService` fixture, and an attachment fixture uploaded by `actorId`.
- Produces direct evidence that `service.getOrCreate(foreignScope, {})` creates a foreign-owned Mastra thread and `service.append(foreignScope, { threadId, clientMessageKey, content, attachments: [attachmentId] })` rejects with `ATTACHMENT_FORBIDDEN` before storage/intent/stamp side effects.

- [ ] **Step 1 — RED:** Add the foreign-owned thread case to `Mastra attachment denial writes no message, intent, or attachment stamp`. Keep the channel active and original actor membership intact. Temporarily write the append assertion as an expected resolution, then run the named test and capture its expected RED: the service rejects with `ATTACHMENT_FORBIDDEN`. This proves the test reaches the foreign actor's attachment authorization path rather than being rejected because the foreign actor does not own the thread.
- [ ] **Step 2 — GREEN:** Change the assertion to `rejects.toThrow("ATTACHMENT_FORBIDDEN")`; assert zero `getStore`/lock/save calls, no intent for the foreign thread, and unchanged pre-test `attachedAt`. Run the named test and require PASS. Do not add a production change because this review finding requests missing evidence and the existing service currently denies the operation.
- [ ] **Step 3 — Cleanup:** Ensure `finally` removes intent-attachment references, intents, and `enterpriseConversations` rows for both the existing owner thread and new foreign thread, and restores the channel/membership baseline.
- [ ] **Step 4 — Verification:** With the approved four synthetic database URLs set inline, run `bun test --timeout 60000 --max-concurrency 1 tests/enterprise/conversations.integration.test.ts`; run targeted Biome for that test file and `git diff --check`. Expected: entire conversations suite passes, including foreign, revoked-member, and deleted-channel attachment denials.
- [ ] **Step 5 — Checkpoint:** Capture the test file's exact before/after bytes, hashes, HEAD and report/package under `.superpowers/sdd/2026-10-10-m02-r1d-fix1-foreign-mastra-attachment/`. Stop for controller hash verification and independent validator/reviewer gates.

**Acceptance:** M02-R1D-01 is addressed by a separate foreign-actor-on-foreign-owned-Mastra-thread case with explicit authorization and no-side-effect assertions; the pre-existing revoked/deleted cases remain intact. R1D/R1C may pass only after independent validation and review confirm this same frozen increment.

## Pre-dispatch consistency

| Node | Owned boundary | Consumes / produces | Dependency | Verification |
|---|---|---|---|---|
| M02-R1D-FIX1 | One existing PostgreSQL integration test only | Consumes frozen R1D test/service fixtures; produces foreign-owner attachment denial and no-side-effect evidence | R1D validator PASS; R1D reviewer finding M02-R1D-01 | TDD RED; serial named suite; targeted Biome; diff-check; exact one-file checkpoint; independent validation and review |

DAG: one node, unique ID, no internal dependencies or cycles. This plan addresses only valid finding M02-R1D-01; no original R1D task is re-dispatched.
