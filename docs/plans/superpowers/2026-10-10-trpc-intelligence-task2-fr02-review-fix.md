# T02-FR02 ACL Revocation Replay Review Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make duplicate `revokeResourceRead` calls return the original persisted receipt even if the resource changes or is deleted later.

**Architecture:** Keep the existing advisory locks, conflict checks, mutation, and transactional audit event. For a matching prior event, validate the persisted `changed` and `acl_epoch` fields and return them directly without querying current resource state. Prove the behavior through the restricted PostgreSQL integration test.

**Tech Stack:** TypeScript, Bun, Drizzle ORM, PostgreSQL.

**Spec:** Parent review finding `.superpowers/sdd/2026-10-09-trpc-intelligence-migration/reports/task-2-fr01-final-review.md` (T02-FR02); approved idempotency contract `docs/plans/superpowers/2026-10-09-enterprise-ai-02-tenancy.md` §T1-C and duplicate operation contract; parent DAG `docs/plans/2026-10-09-trpc-intelligence-dag.json`.

## Global Constraints

- Keep all source work in the managed worktree `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`.
- Do not commit or stash; retain BASE `fbdecc29cd786952c4b496abc68384b31a320b17` and HEAD `dce86f89d6263b7c6630023ae90c1394cc71cb03`.
- Use only the dedicated `openbot-enterprise-test-pg` container and a fresh guarded reserved DB for PostgreSQL verification; use synthetic identities only and remove fixtures, temporary LOGINs, and DB afterward.
- Keep secrets out of files, reports, and command output.
- Preserve existing lock ordering, payload digest/type conflict checks, authorization, and atomic audit behavior.
- A matching replay must return the original receipt. Missing or malformed persisted result fields fail closed; never infer a prior result from current resource state.

## Review Focus

- Resource deletion after a successful revocation must not change the receipt returned by an identical retry; test by deleting the synthetic resource after the first operation and retrying the same input.
- Corrupt or incomplete stored receipts must not fall back to current resource state; test that removing `acl_epoch` produces `IDEMPOTENCY_RESULT_INVALID`.
- Different operation payloads must continue to fail with `IDEMPOTENCY_CONFLICT`; preserve the current digest/event-type guard before receipt validation.

---

### Task 1: Replay the persisted ACL-revocation receipt

**Files:**
- Modify: `server/src/enterprise/tenancy/provision.ts`
- Modify: `server/tests/enterprise/tenancy.integration.test.ts`

**Interfaces:**
- Consumes: `revokeResourceRead(database: OperatorDatabase, input: RevokeResourceReadInput): Promise<{ readonly changed: boolean; readonly aclEpoch: number }>`.
- Produces: a replay path that returns persisted `changed` and `acl_epoch`, validates them as boolean and positive safe integer, and throws `IDEMPOTENCY_RESULT_INVALID` for invalid stored results.
- Owner role: `backend_implementer`.
- Validator role: `backend_validator`.
- Verification: controller-observed real PostgreSQL RED then GREEN on separate fresh guarded DBs; related offline tests; strict scoped TypeScript; Biome; `git diff --check`.

- [ ] **Step 1: Add the failing restricted PostgreSQL regression first.** Bind the existing ACL revocation input once, assert the first receipt, delete the now-ungranted synthetic resource through the setup handle, replay the exact input, and assert exact receipt equality. Then remove `acl_epoch` from the matching synthetic audit event and assert replay rejects with `IDEMPOTENCY_RESULT_INVALID`.
- [ ] **Step 2: Controller runs RED.** On a fresh reserved database with the three restricted LOGIN roles, apply all migrations and run `tenancy.integration.test.ts`. Expected: failure at the replay after resource deletion because the current implementation throws `RESOURCE_NOT_FOUND`. Remove synthetic rows, drop temporary LOGINs and database, and verify the cleanup catalog state.
- [ ] **Step 3: Implement the minimal replay fix.** After matching event type and digest, validate `prior.details.changed` and `prior.details.acl_epoch`; return those values directly. Do not read the resource on replay. Keep lock order, conflict checks, and the first-execution event write unchanged.
- [ ] **Step 4: Controller runs GREEN on a second fresh guarded database.** Expect the same original receipt after resource deletion and `IDEMPOTENCY_RESULT_INVALID` after the audit receipt is made incomplete; the complete tenancy integration file passes. Verify zero fixture rows before DB teardown and no temporary LOGINs or reserved DB afterward.
- [ ] **Step 5: Run the related offline suite, strict scoped TypeScript, Biome, and `git diff --check`; capture before/after hashes and full-content package.** Independent backend validation and review assess the same checkpoint.

**Failure handling:** If deleting the synthetic resource is blocked by an unexpected FK, preserve the approved behavior test by transitioning the resource to a non-active/deleted state that still invalidates a current-state lookup; document the observed constraint and prove the stored receipt remains authoritative. Do not add a schema migration or weaken the first-call existence/status check.
