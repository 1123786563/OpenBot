# Task 2 Review Fixes: Capability Roles, RLS Fixtures, and Revocation Consistency

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Execute the serial repair DAG in order; do not start downstream migration tasks before every repair node is verified.

**Goal:** Close independent review findings T02-R01 (High), T02-R02 (High), and T02-R03 (Medium) without weakening the approved tenancy and RLS contracts.

**Architecture:** Follow the approved enterprise tenancy plan `docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md`, especially T1-B and T1-C, and platform spec §6.4. Directory reads, business data reads, and offline tenant operations use separate NOLOGIN capability roles and separately supplied LOGIN connections. The API receives only directory/data connections; offline provisioning accepts only a verified operator connection. RLS policies are scoped to those capabilities, with PUBLIC access revoked. Role creation remains a separately managed DBA operation, never a migration-created password or runtime privilege escalation. Go has no business DB connection.

**Facts / prior review:** T02 implementation snapshot `../.superpowers/sdd/2026-10-09-trpc-intelligence-migration/snapshots/task-02-after.json`; failed review `../.superpowers/sdd/2026-10-09-trpc-intelligence-migration/reports/task-2-review.md`; validator report `../.superpowers/sdd/2026-10-09-trpc-intelligence-migration/reports/task-2-validation.md`; approved source plan `2026-10-09-enterprise-ai-02-tenancy.md`. T02 remains unverified until the repaired restricted-role PostgreSQL tests execute.

**Commit policy:** No commits. Use complete before/after uncommitted checkpoints and content-hashed review packages.

## Global Constraints

- Never read or write the original checkout `/Users/wuyongjun/trea/OpenBot`; all changes stay in the managed isolated worktree.
- Never use the application database or existing `openbot_enterprise_test` contents. Tests use a fresh database in the dedicated enterprise-test PostgreSQL instance, a validated `TEST_DATABASE_URL` setup/cleanup identity, separate restricted directory/data/operator identities, synthetic per-run records, and FK-safe cleanup.
- No passwords, URLs, production `.env`, or secrets enter source, reports, snapshots, or logs. Role SQL defines only NOLOGIN capability roles. Existing roles must have attributes verified; conflicts fail closed.
- No API/request path receives an operator database handle. Role bootstrap and migration owner remain outside the app runtime. Directory/data/operator handles are runtime-verified against `current_user`, role attributes and role memberships before being branded for the respective service.
- RLS policies and SQL grants must match the approved T1-B matrix; `TO public` is forbidden for protected-table access policies. No application role may own, bypass RLS, become a migration owner, or inherit another capability role.
- A failed/missing DB environment is a blocker, never a skipped test or pass. Use only named `TEST_DATABASE_URL` for setup/cleanup and explicit dedicated restricted test-role variables for behavioral assertions; never fall back to `DATABASE_URL`.

## Review Focus

1. Capability boundaries are enforced by actual PostgreSQL role attributes, membership, table grants and RLS policy targets, not only TypeScript types or freely settable GUCs.
2. Restricted positive and negative RLS cases use distinct connections; setup/cleanup privileges cannot contaminate the asserted `current_user`.
3. Tenant member removal and Bot mapping are observed from one PostgreSQL statement snapshot, so channel visibility cannot return true after a concurrent membership revocation becomes visible.
4. Migration numbering follows the isolated worktree journal and retains every prior user migration unchanged.

## Task R2-1 — Install capability boundaries and make real PostgreSQL acceptance executable

**Depends on:** T02 implementation (currently under repair). **Role:** backend_implementer → backend_validator → reviewer.

**Owned files:**

- Create `server/ops/enterprise/roles.sql`, defining only `ob_ent_directory`, `ob_ent_data`, `ob_ent_operator`, and `ob_ent_identity_operator` as NOLOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE roles, with fail-closed attribute validation and no passwords.
- Create `server/src/enterprise/tenancy/connections.ts` to validate supplied handles against their exact `current_user` capability, `rolsuper=false`, `rolbypassrls=false`, no table-owner privileges and no membership that allows capability escalation; expose branded directory/data/operator handle types. Keep identity operator distinct and unavailable to this task's API.
- Modify `server/src/enterprise/tenancy/store.ts` so ScopeResolver consumes directory handle and ResourceReader consumes data handle; modify `provision.ts` so offline mutation functions require the verified operator handle.
- Modify `server/drizzle/0055_enterprise_tenancy_rls.sql` before delivery to scope policies/grants to the correct roles and revoke PUBLIC privileges; because the migration is not applied or shipped, keep this task's final migration chain clean and document the replacement in the repair ledger. If generator constraints require a following migration, add the next number after rereading the journal and ensure the final chain cannot leave broad policies enabled.
- Modify `server/tests/enterprise/tenancy.integration.test.ts` and `authz.integration.test.ts`; create `server/tests/enterprise/tenancy-rls.integration.test.ts` and `server/scripts/enterprise-test-db.ts`. Use setup/cleanup and three restricted runtime role connections; explicitly prove the runtime data role has a valid positive read, no-context/foreign tenant denial, no write/TRUNCATE, operator-only membership/grant mutation, and `rolsuper`/`rolbypassrls`/role-membership constraints. Teardown synthetic users, grants, resources, workspaces, events, memberships, principals and tenant in FK-safe order from a `finally`/`afterAll` path.
- Modify `server/src/enterprise/tenancy/store.ts`, `provision.ts`, schema/migration and fixtures only where required by these findings; preserve exact downstream produced interfaces or add a documented adapter.

**Consumes:** verified Task 1 wire contracts, current Task 2 service APIs, T1-B/T1-C role/RLS/provisioning contract, isolated test database guard.

**Produces:** separate verified `DirectoryDatabase`, `DataDatabase`, and `OperatorDatabase` capabilities; role-scoped PostgreSQL policies; a reproducible no-dotenv isolated test DB runner; successful real PostgreSQL AC-05 evidence using restricted runtime connections and a setup-only role.

**Implementation steps:**

1. RED: add tests that prove a generic/unverified DB cannot be used by directory/data/operator services, capability mismatches and elevated/owner roles are refused, data cannot mutate or TRUNCATE protected rows, role self/foreign access is bounded, and setup role is not the asserted data role. Run the exact focused command and preserve expected failure output.
2. Inspect only the named dedicated test container and verify `TEST_DATABASE_URL` names a newly created empty database; never target `openbot` or existing `openbot_enterprise_test`. If test credentials for restricted roles are unavailable, create only ephemeral local test role credentials in that isolated test container, do not write their passwords anywhere, and remove those roles/database in cleanup after evidence capture. No global test DB reuse.
3. Implement capability SQL and typed/runtime connection verification. Ensure all protected-table grants start revoked from PUBLIC. Directory can read only its authenticated user's principal/member/tenant rows; data can read only current tenant and own grant rows; operator can do approved tenant-scoped writes and append/read only the operation rows needed for idempotency. Identity operator receives no role membership or business API route in this task.
4. Regenerate/replace the not-yet-applied T02 RLS migration from the authoritative Drizzle custom migration path. Re-read journal first; verify the final migration sequence on an empty isolated DB. No manual edits to prior unrelated numbered migrations.
5. Adapt the integration fixture so test-only setup/cleanup is separate from the restricted handles. Run setup, migrations, tests and teardown with synthetic records only. Assert concrete PostgreSQL SQLSTATE/object for privilege, RLS and FK denials; a generic `toThrow()` is insufficient for security boundaries.
6. GREEN/refactor; run focused tests, schema/metadata check, TSC scoped to owned files, Biome, and `git diff --check`. Record DB instance/database identity with credentials redacted and exact migration/test outputs.
7. Capture the task after-snapshot and incremental package; validator and reviewer inspect the same hash. Resolve every C/H/M finding before marking verified.

**Verification:** `bun --no-env-file server/scripts/enterprise-test-db.ts migrate`; `bun test server/tests/enterprise/tenancy.integration.test.ts server/tests/enterprise/authz.integration.test.ts server/tests/enterprise/tenancy-rls.integration.test.ts`; exact role-catalog assertions; Drizzle metadata check; scoped TSC; Biome; `git diff --check`. Expected: all DB behavior tests execute with no skipped assertions; restricted runtime roles show `rolsuper=false`, `rolbypassrls=false`, no owner/other capability membership; task hashes match the review package.

**Failure handling:** Missing G0 credentials or non-isolated DB means R2-1 blocked and no downstream Task R2-2 or T03. Do not use an owner or superuser result as substitute evidence. Stop if catalog attributes or database identity differ from the explicit test boundary.

## Task R2-2 — Make legacy channel visibility revocation-consistent

**Depends on:** R2-1 verified (serial DAG policy). **Role:** backend_implementer → backend_validator → reviewer.

**Owned files:** `server/src/enterprise/authz/legacy-channel-scope.ts`, new `server/tests/enterprise/legacy-channel-scope.test.ts`.

**Consumes:** verified current `channelMemberships`, `channels`, and `channelAgents` schema; locked database query APIs.

**Produces:** `canReadLegacyChannel` evaluates current membership, channel state, and optional Bot membership in a single SQL statement/snapshot; denies on deletion, missing membership, missing Bot mapping, malformed inputs, and DB errors. No extra query window may re-open access following revocation.

**Steps:** RED tests first for a valid member/Bot, non-member, deleted channel, exited member and unmapped Bot; include a deterministic concurrent-revocation test using a transaction barrier or a single-statement query assertion. Implement a single statement with joins/exists predicates. Run scoped focused tests, TSC, Biome and diff check; capture hashes; validator/reviewer independently pass before verified.

**Verification:** `bun test server/tests/enterprise/legacy-channel-scope.test.ts server/tests/enterprise/authz.integration.test.ts`; target TSC/Biome and `git diff --check`.

**Failure handling:** Preserve current channel/Bot semantics; any schema ambiguity blocks this node rather than weakening the predicate.

## Task-to-finding mapping

| Finding | Repair | Required evidence |
|---|---|---|
| T02-R01 High | R2-1 | Catalog-verified role attributes, memberships, table grants, intended RLS visibility and prohibited mutations on restricted connections |
| T02-R02 High | R2-1 | Fresh isolated DB migration, nonempty valid read, two tenants/two principals, grant/member revocation, admin no implicit read, synthetic cleanup |
| T02-R03 Medium | R2-2 | Single-statement membership + Bot visibility semantics, tests for removal and Bot path |
