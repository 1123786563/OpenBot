# Issue #6 Wave 2 Task Briefs

Run context: Orca Run `run_b2bd1c513221`; execution worktree `/Users/wuyongjun/orca/workspaces/OpenBot/company-team-multitenancy-execution`; immutable Git BASE `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`; no commits. Both tasks below have verified DAG prerequisites integrated as uncommitted hash-backed checkpoints. Each task has a separate Orca child worktree and its own test PostgreSQL instance to avoid port/database contention. Both workers and reviewers must be `--agent pi`.

## Task A — MT003 / Issue #46 secure task-scoped migration tool

**DAG prerequisites:** MT001 verified and integrated (review package `MT001-fix.json`, digest `0965ecfa…30c9`). MT002 is not a dependency.

**Role:** `backend_implementer`; after completion, a separate Pi reviewer and `backend_validator` evidence review.

**Owned paths:**
- Create `server/scripts/multitenancy/migrate-test.ts`.
- Create `server/tests/multitenancy/migration-tool.test.ts`.
- Create only task report/checkpoint paths under `archive/plans/multitenancy-execution/reports/MT003.md` and `archive/plans/multitenancy-execution/checkpoints/MT003/**`.
- Do not alter production migrations, Drizzle config/journal, package manifests/locks, shared test support, or MT001/MT002 files.

**Consumes:** Verified MT001 inventory and DAG; `server/scripts/runtime-test-environment.ts` (`runtimeTestEnvironment(environment)` reads only `TEST_DATABASE_URL`, returns `databaseUrl/databaseName`); existing `server/tests/support/enterprise-database.ts` URL validation patterns as read-only reference. Do not consume an unintegrated copy or regenerate/modify the MT001 inventory.

**Produces:** A test-only task migration generator/runner with an explicit allowlist of task IDs, fixed task-derived names and monotonically checked numeric IDs, a default dry-run plan, and apply gated by a caller-provided manifest. All environment resolution is explicit and never loads `.env`; missing/invalid/production-target URLs refuse before any process/database side effect. Report exact manifest and planned statement/impact summaries. No business migration body is created by this Ticket.

**Test resources:** Dedicated ephemeral PostgreSQL `openbot-i6-mt003-test-pg`, host `127.0.0.1:55433`, database `openbot_enterprise_mt003_test`, verified empty at dispatch. Use `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55433/openbot_enterprise_mt003_test` only for this Task. Do not use the other test container or any development/production URL. Database storage is task-ephemeral; no persistent volume.

**Interfaces / verification:** `bun test server/tests/multitenancy/migration-tool.test.ts`; also `cd server && bun run typecheck` and targeted Biome. Tests must cover each Issue #46 criterion, including unknown task/command refusal, missing/production URL rejection with no fallback, deterministic names/sequence gap/duplicate checks, dry-run by default, required manifest for apply, and real apply only on the assigned dedicated test DB. Preserve migration ordering and do not execute production migrations.

**Task Brief policy:** Use Superpowers TDD RED→GREEN→REFACTOR. Save before/after HEAD, staged/unstaged and owned untracked files, full content hashes and Review Package. No commit, push, merge, deploy, production migration, enablement, release, or shared stash. Do not claim skipped checks passed. Findings go to coordinator; do not self-approve.

## Task B — MT131 / Issue #174 isolated acceptance harness

**DAG prerequisites:** MT001 and MT002 verified and integrated. Transfer their exact reviewed files into this task child worktree and verify hashes before the worker starts: MT001 inventory generator/test and MT002 `support/fixture.ts`, `support/scenarios.ts`, `fixtures.test.ts`. MT002's shared database module is already tracked at BASE; read-only unless coordinator approves an interface change.

**Role:** `backend_implementer`; after completion, a separate Pi reviewer and `backend_validator` evidence review.

**Owned paths:**
- Create `server/scripts/multitenancy/acceptance-harness.ts` if a runnable CLI is required by the actual repo seam.
- Create `server/tests/multitenancy/acceptance-harness.test.ts`.
- Create `archive/plans/multitenancy-execution/reports/MT131-harness.md` and `archive/plans/multitenancy-execution/checkpoints/MT131/**`.
- Do not modify shared MT001 inventory, MT002 fixture/scenario support, any other Ticket files, dependency manifests, or global application/server entrypoints.

**Consumes:** `CoverageInventory` schema v1 from MT001, including additive `serviceSurfaces`; only `entrances` represent enumerated routes and service surfaces marked `unassembled/not_enumerated` must remain uncovered. Consumes MT002 exports `FIXTURE_IDENTITIES`, `SPEC_IDENTITY_MATRIX`, `createIsolationFixture(domain: IsolationDomain, options?: CreateIsolationFixtureOptions)`, and scenario registry `registerIsolationDomain`, `runIsolationScenario`, `registeredIsolationDomains`; preserve their exact current signatures. Unregistered/missing scenarios are uncovered, never synthetic passes.

**Produces:** A directly runnable, documented acceptance harness that isolates its database, port, and external namespace; consumes current inventory entrances, produces machine-readable per-entrance positive/denial coverage with missing sides marked uncovered, and proves the harness detects an intentionally injected unauthorized observation before accepting evidence. No identity-matrix behavior Ticket is included; no service surface counts as route coverage.

**Test resources:** Dedicated ephemeral PostgreSQL `openbot-i6-mt131-test-pg`, host `127.0.0.1:55434`, database `openbot_enterprise_mt131_test`, verified empty at dispatch. Use the task-private environment file `/tmp/mt131-env.sh` (created outside the repository with generated test-only role passwords) for this Task; source it with shell tracing disabled, never print or copy its contents, and remove it after reviewer reruns finish. It sets `TEST_DATABASE_URL`, `ENTERPRISE_TEST_SETUP_DATABASE_URL`, and the three restricted role URLs for `openbot_enterprise_mt131_test`. Reserve only loopback HTTP port `45435` for harness-local server tests. External namespace prefix is `issue6_mt131_<run-id>` and all temporary files go under a task-specific temp directory; do not call live third-party providers or shared dev services. If a required real provider credential is absent, record that provider check as an environment gap, not pass.

**Interfaces / verification:** `bun test server/tests/multitenancy/acceptance-harness.test.ts`; also `cd server && bun run typecheck` and targeted Biome. Tests must cover isolation configuration, non-pollution of development names, missing environment hard failure, poisoned positive-control discovery, output schema and both positive/denial results, missing-side uncovered status, and a newly added inventory entrance appearing as uncovered. Documentation must include setup, exact run command, output schema/example, cleanup, and explicit limitations.

**Task Brief policy:** Use Superpowers TDD RED→GREEN→REFACTOR. Save before/after HEAD, staged/unstaged and owned untracked files, full content hashes and Review Package. No commit, push, merge, deploy, production migration, enablement, release, or shared stash. Do not claim skipped checks passed. Findings go to coordinator; do not self-approve.

## Shared-file and resource preflight

- Code ownership is disjoint: MT003 owns only `migrate-test.ts` and `migration-tool.test.ts`; MT131 owns only `acceptance-harness.ts` and `acceptance-harness.test.ts`; neither edits shared support or application entrypoints.
- MT131 consumes `createIsolationFixture(domain: IsolationDomain, options?: CreateIsolationFixtureOptions)` exactly; the restricted role environment is task-private and is not part of archive/plans/multitenancy-execution/reports/checkpoints. The only shared inputs are frozen/read-only prerequisites. MT003 consumes MT001; MT131 consumes MT001 and MT002. Their PostgreSQL instances (ports 55433 and 55434), local harness HTTP port (45435), temp namespaces, and child worktrees are distinct.
- Both are backend business tasks; neither is split into horizontal DB/backend/frontend tasks.
