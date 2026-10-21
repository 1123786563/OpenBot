# T02 Final Review Fixes: Stable Suspension Receipts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make repeated `suspendMembership` calls with the same operation ID return exactly the receipt produced by the original call.

**Architecture:** Persist both `changed` and `epoch` in the membership-suspension security event alongside its payload digest. A matching replay validates and returns that stored receipt without changing membership or incrementing epoch again. Add a real restricted-operator PostgreSQL retry assertion.

**Tech Stack:** TypeScript, Bun test, Drizzle ORM, PostgreSQL JSONB audit events.

**Spec:** `docs/plans/superpowers/2026-10-09-enterprise-ai-02-tenancy.md` T1-C, especially its complete-payload idempotency rule and “重复直接返回旧结果”; Task 2 final independent review `reports/task-2-final-review.md` finding T02-FR01.

## Global Constraints

- Keep the change in the managed isolated worktree and preserve other uncommitted Task 1/2 changes.
- No commit or stash. Database verification may use only a fresh reserved database in `openbot-enterprise-test-pg`, random temporary logins, and synthetic fixtures; never use the existing `openbot_enterprise_test` or application DB.
- Store the original receipt atomically in the same transaction as the membership mutation and audit event.
- Replays must not mutate membership, increment epoch, or infer the old result from current membership state.
- A matching prior event with a malformed/missing stored receipt fails closed with a stable internal error; do not invent an answer.

## Review Focus

- First suspension of an active member stores and returns `{ changed: true, epoch: previousEpoch + 1 }`; immediate replay returns the exact same object.
- Replaying a suspension that initially made no state change retains `{ changed: false, epoch: previousEpoch }`.
- A replay does not perform a second membership update or create a second event; the database uniqueness on operation ID and stable epoch should hold.
- A prior event with the same operation ID but different payload/type remains an idempotency conflict.
- Receipt fields are validated as boolean and positive safe integer before being returned.

---

### Task 1: Persist and replay the original membership-suspension result

**Files:**
- Modify: `server/src/enterprise/tenancy/provision.ts`
- Modify: `server/tests/enterprise/tenancy.integration.test.ts`

**Interfaces:**
- Consumes: `suspendMembership(database: OperatorDatabase, input: SuspendMembershipInput): Promise<{ readonly changed: boolean; readonly epoch: number }>`.
- Produces: Security-event details storing the exact `changed` and `epoch` receipt; verified replay of the same operation ID returns it without a second state change.
- Owner role: `backend_implementer`
- Validator role: `backend_validator`
- Verification: test-first restricted PostgreSQL assertion, focused real PostgreSQL integration tests on a fresh guarded DB, scoped strict TypeScript, Biome, `git diff --check`.

- [ ] **Step 1: Add the failing integration assertion first.** In the existing membership-revocation case, call `suspendMembership` again with the exact same input/operation ID and assert its result equals the first receipt; ensure the member epoch remains the first receipt's epoch.
- [ ] **Step 2: Controller runs RED** on a newly created, reserved, empty database inside `openbot-enterprise-test-pg`, after applying migrations and creating three temporary restricted logins. Expected baseline: the new equality assertion fails because replay returns `changed: false` instead of the first `changed: true` result. Teardown synthetic data, temporary logins and DB after evidence.
- [ ] **Step 3: Implement receipt persistence** by storing `changed` with the existing operation `epoch` in the same audit event. On matching prior event, validate stored `changed` is boolean and `epoch` is a positive safe integer, then return those original values. Keep payload digest/type conflict checks and all locking/mutation behavior unchanged. Missing/invalid result must fail closed.
- [ ] **Step 4: Controller runs GREEN** on a new fresh reserved DB with full migrations and the same restricted test roles. The focused suite must prove identical first/replay receipts, no second epoch increment, and continued scope revocation; confirm all synthetic rows are removed before dropping test DB/logins.
- [ ] **Step 5: Run** scoped strict TSC, Biome, `git diff --check`, and related offline tests; capture complete before/after manifests and full-content package. Independent backend validator and reviewer assess exact same checkpoint.

**Failure handling:** If the current schema or event JSON typing prevents safe result validation, stop and document evidence before changing migrations. Do not recover a missing original `changed` value from current membership state; that would recreate the non-idempotent behavior. If the fresh isolated DB guard fails, do not substitute another database.
