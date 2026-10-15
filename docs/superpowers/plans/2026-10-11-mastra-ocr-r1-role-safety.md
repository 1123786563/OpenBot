# Mastra OCR R1 Role and Migration Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the DBA-managed enterprise capability roles and supported migration path fail closed on replication, unsafe ownership, PUBLIC enterprise grants, missing role prerequisites, and insufficient setup identity.

**Architecture:** Keep capability role creation separate from application migrations. Harden the existing bootstrap SQL and runtime catalog verifier, add a read-only migration preflight for the four required roles, and document the DBA bootstrap as an atomic one-time step before migrations. The setup test guard must match the privilege required to inspect `pg_authid`.

**Tech Stack:** PostgreSQL role/catalog SQL, TypeScript, Drizzle, Bun tests, Biome.

**Spec:** `.superpowers/sdd/2026-10-10-mastra-intelligence-migration/ocr-repair-dag.md` R1; approved Mastra design and inherited enterprise tenancy design; complete OCR evidence in `.superpowers/sdd/2026-10-10-mastra-intelligence-migration/reports/adjudication-schema.md`; source report range `fbdecc29cd786952c4b496abc68384b31a320b17..2054397cd9c4fb1b161086c9f991c15a11f6d4fe`.

## Global Constraints

- Capability roles remain DBA-managed, `NOLOGIN`, non-escalating, and separate from runtime login identities.
- Reject `REPLICATION` alongside `SUPERUSER`, `BYPASSRLS`, `CREATEDB`, and `CREATEROLE` for capability and runtime login roles.
- Reject any direct enterprise relation/column privilege granted to a runtime login or `PUBLIC`; do not reject ordinary `USAGE` on the `public` schema solely because it is granted to `PUBLIC`.
- Preserve explicit role grants from migration 0055; do not broaden grants to `PUBLIC` or `ob_ent_identity_operator`.
- The one-time role bootstrap requires a direct DBA superuser session because it inspects `pg_authid.rolpassword`; execute it atomically with stop-on-error before application migrations.
- PostgreSQL documents `pg_authid` as containing passwords and therefore not publicly readable; `pg_roles` masks password values. See [pg_authid](https://www.postgresql.org/docs/18/catalog-pg-authid.html) and [pg_roles](https://www.postgresql.org/docs/18/view-pg-roles.html).
- Do not create LOGIN users or passwords in `server/ops/enterprise/roles.sql`.
- Do not change RLS ownership or maintenance behavior beyond the R1 findings; no `FORCE ROW LEVEL SECURITY`.
- No commit, stash, reset, or push. Preserve unrelated dirty files and record hash-bound uncommitted checkpoints.

## Review Focus

1. A pre-existing capability role with `REPLICATION` must be rejected by bootstrap and migration preflight before migration changes the database.
2. A runtime login with `REPLICATION` or a `PUBLIC` grant on an enterprise relation/column must not receive a verified branded handle.
3. `PUBLIC` privileges on unrelated objects and ordinary `USAGE` on schema `public` must remain allowed.
4. An existing capability role that owns an enterprise table, schema, or database must fail the bootstrap safety check.
5. Setup through a non-superuser `BYPASSRLS` role must fail with an actionable identity error; bootstrap errors must roll back all statements in the documented invocation.

---

### Task 1: Harden enterprise role and migration preconditions

**Depends on:** R0 verified at `R16-Fix5-CP1`; no other task.

**Roles:** `backend_implementer` → `backend_validator` → independent `reviewer`.

**Files:**
- Modify: `server/ops/enterprise/roles.sql`
- Modify: `server/src/enterprise/tenancy/connections.ts`
- Create: `server/scripts/enterprise-role-preflight.ts`
- Modify: `server/scripts/migrate.ts`
- Modify: `server/tests/enterprise/tenancy-connections.test.ts`
- Create: `server/tests/enterprise/enterprise-role-preflight.test.ts`
- Modify: `server/tests/enterprise/tenancy-rls.integration.test.ts` only for static role-artifact assertions or a safe, transaction-scoped test on the verified dedicated test database.
- Modify: `docs/deployment.md`
- Modify: `docs/development.md`

**Consumes / produces:** Consumes role names `ob_ent_directory`, `ob_ent_data`, `ob_ent_operator`, `ob_ent_identity_operator`, migration 0055's existing explicit grants, and `R16-Fix5-CP1`. Produces one consistent role-safety contract: the bootstrap rejects unsafe pre-existing capability attributes and protected ownership; runtime verification rejects unsafe capability/login attributes and PUBLIC enterprise relation/column grants; `scripts/migrate.ts` fails before applying any migration if required capability roles are missing or unsafe; the DBA invocation for `roles.sql` verifies a direct superuser session before reading `pg_authid`. The preflight row interface is `EnterpriseRoleCatalogRow = { rolname: string; rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolreplication: boolean }`.

- [ ] **Step 1: Add failing tests.** Extend connection tests with a catalog-negative case for replication and rendered-SQL assertions for both capability/login `rolreplication` checks and `grantee = 0` on enterprise relation/column ACLs. Extend bootstrap assertions for `NOREPLICATION`, direct-superuser preflight, and unsafe owner checks. Add pure migration-preflight tests for all four roles present/safe, a missing role, and each unsafe attribute.
- [ ] **Step 2: Run the focused tests and record expected RED.** Run `bun test server/tests/enterprise/tenancy-connections.test.ts server/tests/enterprise/enterprise-role-preflight.test.ts`. Expected: newly added assertions fail against the frozen baseline; unrelated fixture or compilation errors must be investigated rather than counted as RED.
- [ ] **Step 3: Harden role bootstrap and runtime verification.** Require `session_user = current_user` and `rolsuper` at the start of the bootstrap with a clear failure message. Add `NOREPLICATION` to each created role and validate `NOT rolreplication` for existing roles. Expand bootstrap ownership checks to the same enterprise relation kinds as runtime plus the protected `public` schema/current database. In `connections.ts`, reject REPLICATION for capability and login and include grantee OID 0 only in enterprise relation/column privilege checks, preserving the existing schema-ACL policy for `PUBLIC`.
- [ ] **Step 4: Add the migration preflight.** Implement `assertEnterpriseRolePreconditions(rows: readonly EnterpriseRoleCatalogRow[]): void` in `server/scripts/enterprise-role-preflight.ts`; query `pg_roles` for the exact four required roles in `server/scripts/migrate.ts` and reject missing or unsafe attributes with `ENTERPRISE_ROLE_PREREQUISITES_UNSAFE` plus the DBA bootstrap action. Call it before `migrate()`. Test all accepted/rejected catalog sets without a live database.
- [ ] **Step 5: Make the DBA bootstrap contract explicit.** Document the one-time DBA command as `psql --dbname "$ENTERPRISE_SETUP_DATABASE_URL" --single-transaction --set=ON_ERROR_STOP=1 --file=server/ops/enterprise/roles.sql` against the target database before deployment migrations, the direct-superuser requirement for the `pg_authid` check, the split between capability roles and LOGIN creation, and the migration preflight behavior. Clarify local development's corresponding sequence. Preserve the test migration guard's existing BYPASSRLS contract because the test migration script does not inspect `pg_authid`.
- [ ] **Step 6: Verify R1 behavior.** Run the focused two-file unit command above, `bun test server/tests/enterprise/tenancy-rls.integration.test.ts` only after confirming the configured URL resolves through the repository's reserved-database guard to the dedicated test database, `bunx biome check` on all owned TypeScript files, and `git diff --check` on the task-only owned files. If the reserved database is unavailable, report the live PostgreSQL check as blocked and retain unit/static evidence; do not point tests at another running container or application database.
- [ ] **Step 7: Freeze an uncommitted checkpoint.** Record before/after file hashes, task-only patch hash, exact command outputs, and no-commit state in the SDD workspace; then stop for independent backend validation and review before R2.

**Acceptance:** capability bootstrap and runtime checks reject replication and unsafe ownership/enterprise PUBLIC grants; migration execution fails before applying SQL if roles are missing/unsafe; the DBA bootstrap checks its `pg_authid` privilege contract; the DBA and local setup sequence is explicit and atomic; focused tests, Biome, and diff check pass. Any unavailable dedicated PostgreSQL run is an explicit validation limit, never a claimed pass.

**Failure handling:** If test harness/role safety cannot be established without mutating a shared database, stop the live test and document the exact boundary; continue unit/static checks. If PostgreSQL catalog behavior differs from the intended ACL/role checks, revise the task plan and rerun plan self-review before implementation continues.
