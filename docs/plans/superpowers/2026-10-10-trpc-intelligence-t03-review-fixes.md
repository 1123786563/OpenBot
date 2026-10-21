# T03 Review Findings Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close T03 reviewer findings R01–R04 without weakening least-privilege authorization or changing the approved T17 history-wiring boundary.

**Architecture:** Keep the current conversation schema and same-transaction storage model. Supplied thread IDs become lookup-only; legacy access checks active enterprise channel resource grants; T03 readers and legacy revocation writers share transaction-scoped advisory locks; empty text-only messages are rejected before storage.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, PostgreSQL, existing enterprise test database guard.

**Spec:** Approved migration design §5–§6 and §10; parent plan Task 3; T03 brief/Rulings; independent review `reports/task-3-review.md`; architecture ruling in the repair ledger.

## Global Constraints

- Preserve the original BASE `fbdecc29cd786952c4b496abc68384b31a320b17`, the user-authored HEAD commit `508800cf2c54f6eba2f3cf52ff897b198a92c714`, and all unrelated worktree content; do not commit or stash.
- Use only the dedicated guarded PostgreSQL test container, fresh reserved database, synthetic fixtures, transient least-privilege roles, and prove cleanup; never fall back to `DATABASE_URL`.
- Keep the online `ob_ent_data` database role without channel or membership UPDATE privilege; PostgreSQL row locking is therefore not an acceptable repair.
- Lock order is enterprise tenant/principal/membership shared keys, enterprise resource shared key, then sorted legacy-channel shared advisory keys. Writers take the matching exclusive channel key inside their mutation transaction.
- Unknown supplied thread IDs never create platform conversations. Only omitted IDs mint a server-owned platform conversation.
- Legacy channels without an active enterprise resource and current principal read grant fail closed in enterprise APIs; the legacy channel route remains the compatibility path until T17 provisions resource/grant state.
- T17 still owns trusted production route wiring and authorized legacy history reads. Do not mount the T03 factory or route legacy history to an unowned backend.
- No credentials in logs or artifacts. Do not delete unrelated `.DS_Store` files.

## Review Focus

1. A caller who left a group cannot recreate its deleted Intelligence mapping as a second platform transcript; test real removal semantics and no platform row/message.
2. Enterprise resource/grant revocation denies legacy conversation discovery and operations while membership remains; list filters inaccessible items.
3. Concurrent membership removal/channel soft-delete and conversation reads have a serial authorization outcome under shared/exclusive advisory locking, including attachment sends.
4. Normalized empty text with no attachments returns `INVALID_MESSAGE`; attachment-only messages remain valid.
5. All locking remains compatible with the online role's SELECT-only access to legacy authorization tables.

---

## Worktree and checkpoint

Worktree: `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`; current implementation source is the exact T03 package in `packages/task-3-final-review-package.json` (SHA-256 `fec4ef1dbeec1d81c428208a8c6bc41c096b93eb0d86dadaa54845d3318edc61`), prior snapshot `snapshots/task-3-after.json` (SHA-256 `6174c0583ef8efca64ea5d34526b5c7b604903aaf22b0a83a12d71194de3a5b3`). Parent Task 3 remains running; T04 remains pending. This repair is a fresh numbered outer review-fix plan and owns only findings T03-R01..R04.

Execution record: `.superpowers/sdd/2026-10-10-trpc-intelligence-t03-review-fixes/`. No commits. Capture exact before/after snapshots, tracked patches, full content and hashes for new/ignored files, validation evidence, and scoped review package. Only this serial worktree may consume the checkpoint.

### Task R3-1: Close T03-R01..R04

**Depends on:** T03 implementation checkpoint and findings above. **Roles:** `backend_implementer` → `backend_validator` → `reviewer`.

**Files / ownership:**
- Modify `server/src/enterprise/conversations/service.ts`, `server/src/enterprise/conversations/store.ts`, `server/tests/enterprise/conversations.integration.test.ts`.
- Modify `server/src/channels/group.ts` only to take the exclusive legacy-channel advisory lock before removing membership/mapping in its existing transaction.
- Modify `server/src/channels/routes.ts` only to take the same exclusive lock before soft-deleting a channel in its existing transaction.
- Modify `server/src/channels/attachments.ts` only if required to acquire shared locks for referenced channel IDs, in sorted order, before eligibility reads/stamps; preserve the public wrapper and transaction ownership.
- No schema/migration changes expected. Any need for more files requires a written ruling before editing.

**Consumes:** `createConversationService({data: DataDatabase})`; T02 `assertTrustedScope`; T02 resource key `JSON.stringify(["enterprise","resource",tenantId,channelId])`; existing T03 `ConversationService`; existing guarded PG harness.

**Produces:** lookup-only behavior for supplied `threadId`; active channel resource/read-grant checks in the same conversation transaction; transaction-level shared advisory channel lock protocol observed by readers and legacy revoke/delete writers; validated message-empty boundary.

- [ ] **Step 1 — RED:** Add guarded PostgreSQL tests for supplied unknown IDs, actual group leave mapping deletion, missing/revoked resource grant with membership retained, empty content/no attachments, attachment-only content, and lock serializability for both reader-first and writer-first outcomes. The group removal test must execute the actual store removal path or the exact production deletion transaction and assert no conversation/message row can be created afterward. Concurrency tests use independently held real transactions and bounded timeouts; no mock locks.
- [ ] **Step 2 — Confirm RED:** Run the new focused integration cases against a fresh guarded database before implementation; preserve test output, fixture row counts and cleanup proof. Expected failures must identify the missing behaviors, not setup/import errors.
- [ ] **Step 3 — Implement:** Reject an unknown supplied ID with `CONVERSATION_NOT_FOUND`; mint only when `threadId` is omitted. For a mapped legacy channel, under the T02 resource shared advisory lock require same tenant/workspace resource ID equal to `channelId`, kind `channel`, status `active`, and current principal `read` grant. Fail closed when resource/grant is absent; list filters denied legacy candidates. Acquire shared legacy-channel locks and then reread mapping/channel/membership; append locks referenced channel IDs in sorted order before attachment authorization/stamp. Add matching exclusive lock before group removal and channel soft-delete mutations. Reject normalized empty content with no attachment before entering a transaction.
- [ ] **Step 4 — Green and regressions:** Run the focused integration suite and relevant channel/thread route suites. Preserve the same lock order for every multi-channel operation and confirm no table UPDATE privilege was added.
- [ ] **Step 5 — Static/schema checks:** Run scoped strict TypeScript, Biome on every changed TypeScript file, drizzle journal/schema consistency check, and `git diff --check`. No migration is expected; if drizzle output changes, stop and document why before proceeding.
- [ ] **Step 6 — Checkpoint:** Record full source hashes and a full-content repair Review Package. Backend validator and independent reviewer inspect the exact same package/snapshot. Reviewer reports separate Spec compliance and code quality conclusions. Any C/H/M finding starts a new numbered SDD repair plan; do not mark T03 verified meanwhile.

**Acceptance / failure handling:** T03-R01, R02, R03, and R04 are each covered by real PostgreSQL behavior evidence; resource absence/revocation denies enterprise legacy access; leave/revoke/delete races serialize; minimum grants unchanged; focused and scoped checks pass; independent validator and reviewer pass exact hashes. If PostgreSQL contention test cannot be made deterministic with bounded barriers, retain the test and fix its synchronization; do not replace it with timing-only sleeps. T17 history/route integration remains a documented downstream gate.
