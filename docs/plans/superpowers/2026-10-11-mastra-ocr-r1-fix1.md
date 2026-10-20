# Mastra OCR R1 Role and Migration Safety Fix1 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close R1-REV-01/02/03 by making every supported migration command share the guarded runtime migrator, bootstrapping roles only on explicitly trusted fresh local/test deployments, and proving behavior on isolated PostgreSQL.

**Architecture:** `server/scripts/migrate.ts` is the sole application-migration entry point. An explicit `OPENBOT_BOOTSTRAP_ENTERPRISE_ROLES=on` option runs the atomic `roles.sql` through postgres.js simple-file execution before the existing preflight; it is enabled only for local Compose, embedded PostgreSQL, and disposable CI/test fixtures. External deployment credentials remain DBA-managed. CI provisions a separate reserved enterprise PostgreSQL service and exercises the real setup and runtime role paths.

**Tech Stack:** TypeScript, Bun, Drizzle runtime migrator, postgres.js, PostgreSQL 17, GitHub Actions, Docker Compose.

**Spec:** `.superpowers/sdd/2026-10-10-mastra-intelligence-migration/ocr-repair-dag.md` R1; prior implementation plan `docs/plans/superpowers/2026-10-11-mastra-ocr-r1-role-safety.md`; exact independent findings in `.superpowers/sdd/2026-10-11-mastra-ocr-r1-role-safety/reports/review.md` (R1-REV-01 High, R1-REV-02 High, R1-REV-03 Medium); migration entry-point evidence from researcher `/root/r1_migration_paths` and harness evidence from `/root/r1_pg_test_harness`.

## Global Constraints

- Capability roles remain DBA-managed, `NOLOGIN`, non-escalating, and separate from runtime login identities.
- The four roles remain `ob_ent_directory`, `ob_ent_data`, `ob_ent_operator`, and `ob_ent_identity_operator`.
- `roles.sql` requires a direct superuser and remains atomic; it does not create LOGIN identities or credentials.
- External production migrations default to preflight-only; automatic role bootstrap requires the explicit environment opt-in and a direct-superuser URL.
- Preserve the repository test URL guard: only localhost port 5434 and database `openbot_enterprise_r2_codex_20261009`; never use application/test DB 5432 or existing 5435 container for enterprise integration.
- CI enterprise database must be a distinct isolated service, with synthetic test-only login credentials and runtime URLs setting exactly one expected capability role.
- Migration preflight must execute before Drizzle migration DDL; all supported CLI/Compose/embedded entry points invoke the same script.
- Preserve existing PUBLIC relation/column rejection and allowed ordinary PUBLIC schema `USAGE`; no unrelated tenancy or Mastra changes.
- No commit, stash, reset, push, or mutation of unrelated dirty files.

## Review Focus

1. Fresh embedded and Compose installs create capability roles before migration and fail startup on bootstrap/preflight errors.
2. Direct local, CI, and enterprise-test migration commands cannot bypass the role preflight.
3. Missing/unsafe roles fail before the migration journal or application objects are created.
4. The real PostgreSQL bootstrap rejects non-superuser identity, unsafe pre-existing `REPLICATION`, and protected ownership atomically.
5. Real runtime verification rejects PUBLIC enterprise relation/column grants while allowing ordinary PUBLIC schema `USAGE`.

---

### Task 1: Unify migration entry points and prove role behavior on PostgreSQL

**Depends on:** Original R1-T1 implementation checkpoint `R1-T1-CP1`; findings R1-REV-01/02/03.

**Roles:** `backend_implementer` → `backend_validator` → independent `reviewer`.

**Files:**
- Modify: `server/scripts/migrate.ts`
- Modify: `server/package.json`
- Modify: `docker-compose.yml`
- Modify: `docker/s6/scripts/migrate.sh`
- Modify: `server/scripts/enterprise-test-db.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `server/tests/support/enterprise-database.ts`
- Modify: `server/tests/enterprise/enterprise-test-database.test.ts`
- Modify: `server/tests/enterprise/tenancy-rls.integration.test.ts`
- Create/modify: focused integration fixture/test source as needed under `server/scripts/` and `server/tests/enterprise/`; keep exact paths in the task report.
- Modify: `reference/deployment.md`, `reference/development.md`

**Interfaces:**
- Consumes `assertEnterpriseRolePreconditions(rows)` and the existing direct-superuser guard in `server/ops/enterprise/roles.sql`.
- Produces one canonical migration command: `bun scripts/migrate.ts` from `server/` (or `bun --env-file=../.env scripts/migrate.ts` for local package use).
- `OPENBOT_BOOTSTRAP_ENTERPRISE_ROLES=on` is the only opt-in for executing `server/ops/enterprise/roles.sql`; absent/other values preserve fail-closed preflight-only behavior.
- Enterprise setup URL is `ENTERPRISE_TEST_SETUP_DATABASE_URL`; generic `TEST_DATABASE_URL` continues to identify the regular test DB.

- [ ] **Step 1: Add failing migration routing and fixture tests.** Pin package/Compose/test-wrapper/embedded command routing to the runtime migrator; pin unset opt-in to preflight-only. Update enterprise setup URL contract tests. Add PostgreSQL-backed checks for direct-superuser bootstrap, unsafe role/ownership rejection and rollback, PUBLIC relation/column rejection with ordinary schema `USAGE` acceptance, and preflight failure before any migration journal/object exists.
- [ ] **Step 2: Reproduce expected RED.** Run the focused Bun unit tests and the reserved-port guarded PostgreSQL suite after starting only the isolated fixture service described by the plan. Confirm new behavior tests fail on CP1 for the reported reasons.
- [ ] **Step 3: Add explicit atomic role bootstrap to the canonical runner.** In `server/scripts/migrate.ts`, when and only when the exact opt-in value is `on`, execute the unparameterized `roles.sql` file through postgres.js simple query and close/fail on error; then always run the existing role preflight before `migrate()`. Reuse the same database connection if possible and preserve `finally` closure. Do not enable opt-in for external production deployment by default.
- [ ] **Step 4: Route supported migration commands through the canonical runner.** Change Compose, `server/package.json db:migrate`, `enterprise-test-db.ts migrate`, CI application migrations, and embedded s6 migration to invoke `scripts/migrate.ts`. Enable role bootstrap explicitly only for Compose/embedded fresh local clusters and disposable CI/enterprise fixtures. Keep generation/custom commands on Drizzle CLI.
- [ ] **Step 5: Provision an isolated CI enterprise service and exercise the live contract.** Bind the second pgvector service only to `127.0.0.1:5434`, exact reserved database name, and test-only setup/login identities. Before applying migrations, invoke the canonical runner with bootstrap disabled and assert the expected preflight error plus absence of journal/application DDL; invoke with opt-in, then create three test LOGIN roles, grant exactly one matching capability membership apiece, and run `tenancy-rls.integration.test.ts`. Keep ordinary suite DB on port 5432.
- [ ] **Step 6: Update documentation and setup URL tests.** Explain local Compose/embedded automatic bootstrap, external DBA role provisioning, explicit opt-in security boundary, unified migration command, and separate CI enterprise fixture. State which identity must be direct PostgreSQL superuser.
- [ ] **Step 7: Run focused verification.** Run migration/preflight unit tests, PostgreSQL role/bootstrap/RLS tests on only the dedicated port-5434 fixture, `bunx biome check` on owned TypeScript, server typecheck (record only known unrelated errors), and scoped `git diff --check`. Do not use ports 5432/5435 as enterprise targets.
- [ ] **Step 8: Freeze checkpoint.** Record before/after file hashes, task patch hash, actual command output, fixture identity/port, diff ownership, and no-commit status. Then stop for independent backend validation and scoped review.

**Acceptance:** R1-REV-01/02 are closed by a working fresh embedded/Compose path and one preflight-bearing migration seam used by all supported invocations. R1-REV-03 is closed by live isolated PostgreSQL evidence for bootstrap identity/atomic rollback, unsafe role and ownership, PUBLIC ACL behavior, allowed schema usage, and missing-role fail-before-DDL. Focused tests, Biome and diff checks pass; no shared/application DB is mutated.

**Failure handling:** If a dedicated PostgreSQL fixture cannot be started safely, stop its database steps and report the exact unavailable resource; do not silently substitute another port/database. If postgres.js cannot atomically execute the unparameterized file, use explicit `psql --single-transaction --set=ON_ERROR_STOP=1` only in setup contexts and revise the plan/task before implementation. Any role/login teardown must be confined to the disposable fixture container.

## Predispatch consistency scan

| Task pair / task | Shared files or internal consistency | Result |
|---|---|---|
| Task 1 × Task 1 interfaces | All entry points converge on `server/scripts/migrate.ts`; CI/test opt-in is explicit; runtime external path stays preflight-only. | Consistent; implementer must test absent and exact `on` values. |
| Task 1 files vs tests | Setup URL moves to `ENTERPRISE_TEST_SETUP_DATABASE_URL`, while generic DB retains `TEST_DATABASE_URL`; integration tests use port 5434 guard. | Consistent; update contract tests and CI env together. |
| Task 1 bootstrap vs migration | SQL direct-superuser assertion runs before the existing `pg_roles` preflight and Drizzle DDL. | Consistent; live test must establish failure leaves journal/application objects absent. |
| Task 1 CI vs local runtime | CI has two isolated DB services; only enterprise fixture runs destructive ACL/RLS tests. | Consistent; normal DB stays on 5432 and no parallel jobs share the reserved fixture. |
| Task 1 docs vs deployment behavior | Compose/embedded enable explicit bootstrap; external deployment does not. | Consistent; document exact environment boundary. |

Ruling: Keep the fix as one cohesive task because routing, opt-in bootstrap, isolated DB provisioning, and end-to-end proof form a single independently reviewable migration contract; splitting before the seam is stable would create partially routed states. Cost if wrong: the task review is larger, but the implementer/reviewer can assess the exact unified path and fixture together.
