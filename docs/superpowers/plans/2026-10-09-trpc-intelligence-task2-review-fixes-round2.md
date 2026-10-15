# Task 2 Review Fixes — Round 2: Underlying LOGIN Privileges and Visibility Evidence

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Fix only the findings listed below. Preserve the serial SDD checkpoint/review process.

**Goal:** Close R2-1 review findings R2-1-R01 (High) and R2-1-R02 (Medium). The previous R2-1 review failed; do not mark R2-1 verified until these findings are fixed and a new independent review passes.

**Facts:** Prior repair plan `2026-10-09-trpc-intelligence-task2-review-fixes.md`; failed review `../.superpowers/sdd/2026-10-09-trpc-intelligence-migration/reports/task-2-r1-review.md`; successful real PostgreSQL evidence `../.superpowers/sdd/2026-10-09-trpc-intelligence-migration/reports/task-2-r1-postgres-evidence.md`; exact previous source checkpoint `../.superpowers/sdd/2026-10-09-trpc-intelligence-migration/snapshots/task-2-r1-after.json` SHA-256 `b74433f847866204508935412afdd602220fde67842dc03ed2e731515598e91e`.

**Commit policy:** No commits. Capture complete before/after uncommitted content and hashes; reviewer and validator bind to one checkpoint.

## Global Constraints

- Use only `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`. Do not inspect, copy from, or modify another checkout.
- Do not change PostgreSQL migrations or capability grants except if a review-proven contract requires it; this round is about verifying LOGIN separation and exercising existing self-row policies.
- Never print, persist, or log database credentials. R2-1’s dedicated database and temporary LOGIN roles were removed after the prior evidence run; create a fresh empty uniquely named database for the next DB acceptance and drop it and all temporary LOGIN roles afterward.
- Only the setup URL may seed/alter ACLs/owners in the integration test database. The directory/data/operator connections remain distinct restricted LOGINs. Use synthetic identifiers only.
- Preserve the T1-B matrix: a runtime LOGIN has exactly one expected NOLOGIN capability, no enterprise table ownership, no enterprise schema/table/column privilege grants directly to itself, and no owner/operator/identity role membership.
- Test and cleanup any intentional privilege mutation with `finally`/`afterAll`; do not make a passing result depend on stale grants or ownership.

## Task R2-1B — Reject elevated underlying LOGINs and assert self-visible RLS rows

**Depends on:** R2-1 previous implementation checkpoint; R2-1 remains unverified. **Role:** backend_implementer → backend_validator → reviewer.

**Owned files:**

- Modify `server/src/enterprise/tenancy/connections.ts` to query direct ACL entries and ownership for `session_user`, separately from `current_user`. Reject an underlying LOGIN that directly owns any protected `enterprise_%` table/partition/view/sequence/foreign table, owns the public schema or target database, can become such an owner through another membership, or has direct grants on protected enterprise relations/columns/schema. Retain the expected one capability membership and exact role attribute checks. Do not treat the LOGIN's membership in itself as an escalation.
- Modify `server/tests/enterprise/tenancy-rls.integration.test.ts` to use the setup-only connection to temporarily grant a direct table privilege to the existing test data LOGIN, assert `verifyDataDatabase` rejects it, revoke that grant, temporarily transfer `enterprise_resources` ownership to that LOGIN, assert verification rejects it, and restore original ownership in `finally`/`afterAll`.
- Modify the same integration fixture to seed principal B as a member of tenant A and add a same-tenant resource grant for B as well as A. Through the restricted directory connection with `app.user_id=userA`, prove A's principal/membership/tenant is visible and B's principal/membership/tenant is not. Through the restricted data connection with tenant/principal/user A context, prove A's grant is visible and B's same-tenant grant is not; without context prove no grants are visible.
- Modify `server/tests/enterprise/tenancy-connections.test.ts` only if needed for fast SQL-contract coverage of LOGIN direct ACL and owner predicates. No test may pass solely because an injected mock returns false without exercising the SQL or its live PostgreSQL behavior.

**Consumes:** verified role-scoped RLS migrations and restricted-connection verifier; T1-B/T1-C contract; prior PostgreSQL evidence and findings.

**Produces:** verifier that fails closed for misconfigured underlying LOGINs and real PostgreSQL evidence for the directory self-policy, data own-grant restrictive policy, direct LOGIN table grant rejection, and LOGIN table-owner rejection.

**Steps:**

1. RED: extend the live PostgreSQL test to intentionally add each direct privilege and owner condition and assert the current verifier rejects neither case yet; keep one existing valid login positive to protect legitimate operation. Add directory and same-tenant grant visibility assertions. Run a focused check and record expected failure against the current checkpoint.
2. Implement catalog checks using explicit `session_user` ownership and `pg_class.relacl` / `pg_attribute.attacl` / `pg_namespace.nspacl` ACL expansion (or an equally precise catalog approach). Identify the target database from `current_database()`. Avoid outputting login/password data.
3. Ensure a temporarily transferred table owner and direct table grant are always reverted; use exception-safe cleanup. If the test process terminates, the controller drops its uniquely named test database.
4. Run focused pure tests, scoped TSC, Biome and diff check. Controller runs migrations and all real PostgreSQL tenancy/RLS tests on a fresh test DB, then verifies fixture counts are zero and drops all temporary roles/database.
5. Capture the R2-1B before/after snapshots and full incremental package. Independent backend validation and review must both pass on the exact after hash before R2-1 is closed.

**Verification:** `bun --no-env-file test tests/enterprise/tenancy-connections.test.ts tests/enterprise/enterprise-test-database.test.ts tests/enterprise/authz.integration.test.ts`; `bun --no-env-file test tests/enterprise/tenancy.integration.test.ts tests/enterprise/authz.integration.test.ts tests/enterprise/tenancy-rls.integration.test.ts` using a fresh guarded test DB and three capability connections; assigned-file strict TSC, Biome, Drizzle check and `git diff --check`. Expected direct-grant/owner verification errors fail closed, normal capability URLs work, directory/data queries return only intended rows, all RLS/tenant/revocation tests pass, all fixture counts are zero, and temporary database/logins are removed.

**Failure handling:** A missing isolated runtime URL, non-fresh DB, or non-restricted role blocks R2-1B. Do not replace live RLS assertions with mocks or run as only a superuser. No R2-2 or T03 until this node is verified.

## Finding map

| Finding | Fix | Evidence |
|---|---|---|
| R2-1-R01 High | R2-1B | verifier rejects direct session_user ACLs and ownership; negative live tests for grant and owner login |
| R2-1-R02 Medium | R2-1B | directory self/other user and same-tenant own/other grant RLS assertions through restricted handles |
