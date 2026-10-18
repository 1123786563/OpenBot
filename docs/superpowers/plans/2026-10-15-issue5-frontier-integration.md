# Issue #5 Frontier Checkpoint Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development and superpowers:test-driven-development. This plan is executed only through Orca-supervised Pi workers in isolated child worktrees. No commits.

**Goal:** Integrate the reviewed, independent checkpoints for #207, #209, #215 and #234 into one BASE-derived execution worktree, resolve shared-file and migration numbering conflicts, and close #215's migration snapshot finding with evidence.

**Architecture:** Preserve each ticket's reviewed behavior and ownership contracts. Transfer exact files from the four source worktrees after recording full hashes. Reconcile shared config/schema/journal files as reviewed additions. Serialize the three independent table migrations as 0122–0124, with matching SQL names, journal indexes/tags/timestamps and a continuous Drizzle snapshot chain whose each new snapshot is based on the previous snapshot and adds exactly the appropriate table subtree. Preserve pre-existing historical snapshot collisions; do not rewrite history.

## Sources and constraints

- Original BASE: `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`.
- Parent plan, Issue snapshot, DAG, AC map, approved Specs, ADRs, and `CONTEXT.md` are under this execution workspace.
- Checkpoint reports/reviews live in sibling Orca worktrees `issue5-207`, `issue5-207-timeout`, `issue5-209`, `issue5-215`, and `issue5-234`; each checkpoint must be transferred with a complete SHA-256 manifest and matched before integration.
- Accepted independent reviews: #207 F1 repair Spec PASS / Code APPROVE; #209 concurrency repair Spec PASS / Code APPROVE; #215 Spec PASS / Code APPROVE but F1 requires a correctly sequenced snapshot; #234 Spec PASS / Code APPROVE.
- No production code edits by coordinator; no commit, push, merge, deploy, production migration/cleanup, gateway enablement, or release. Dedicated test data only.
- Keep all changes uncommitted. Do not use shared git stash. Do not edit source/user-owned worktrees.

## Task 1: Transfer and integrate the four reviewed checkpoints

**Owner:** Pi implementation worker; independent Pi reviewer after completion.

**Owned files:** Only the exact source checkpoint production/test files from #207/#209/#215/#234 plus necessary merged shared files (`server/src/config.ts`, schema exports/config, Drizzle journal and new migration SQL/meta files) and integration checkpoint documents under `archive/execution-ledgers/checkpoints/frontier-integration/`.

**Steps:**

1. Copy this plan into the new child worktree and record its BASE/HEAD, staged/unstaged diff, and source worktree identities.
2. Read all four implementation reports and all independent reviews. Transfer each production/test deliverable from its exact reviewed source checkpoint. Record full SHA-256 before/after transfer and byte equality. For #207 repair, use the final reviewed child checkpoint, not the pre-repair checkpoint.
3. Resolve `config.ts` additions without altering either reviewed contract. Combine payer/bot schema exports and Drizzle schema config registration without dropping fields.
4. Rename migrations in a stable deterministic order: `0122_gateway_endpoint_config.sql`, `0123_payer_accounts.sql`, `0124_bot_services.sql`. Journal entries must have matching idx/tag and monotonically increasing `when` values. Rebuild snapshots from 0121→0122→0123→0124: each snapshot must have `prevId` equal to the preceding snapshot's `id`, preserve all existing schema trees, and add only the corresponding table subtree. Do not alter any historical snapshot. Preserve exact reviewed SQL semantics.
5. Add the missing #215 payer snapshot and update checkpoint evidence to resolve its Medium finding. Record why the historical 0054/0055 and 0086/0096 collisions remain pre-existing and unchanged.
6. Add/adjust only integration-specific tests as needed; do not broaden Ticket behavior. Run targeted unit/integration tests serially against dedicated test DB(s), apply migrations to a freshly-created dedicated test database using the normal migration runner, and verify all three tables, constraints, journal hashes, and 124 total migrations. Never connect to development/production databases.
7. Run server typecheck, lint/format on changed files, `drizzle-kit check`, and a `drizzle-kit generate` dry verification in a disposable copy if possible. Do not allow a generated migration to be written into the delivery workspace.
8. Save full uncommitted checkpoint: BASE/HEAD, staged and unstaged diffs, all changed/untracked file contents and SHA-256, exact commands/results, integration decisions, limitations, and report. No commit.

**Observable acceptance:** all transferred source hashes match; all accepted code changes are present; unique sequential migration names/indices and continuous snapshots 0121→0124; no previous snapshots changed; payer and gateway behavior tests and bot registry checks pass on dedicated test data; typecheck/lint pass; uncommitted checkpoint is complete.

## Task 2: Independent integration review

**Owner:** Different read-only Pi reviewer, launched only after Task 1 settles.

Verify the exact Task 1 checkpoint hashes and staged/unstaged/untracked full scope; compare source transfer hashes; check shared config/schema contracts, sequential migration and snapshot invariants, SQL/schema consistency, and the original reviews. Independently run targeted safe validations on dedicated test data. Give separate Spec compliance and code quality decisions and findings. Do not edit files.

## Failure handling

Stop and ask the coordinator if a source hash differs, a ticket contract conflicts, a snapshot subtree cannot be traced to reviewed schema, a migration would require data migration, a test DB cannot be proved dedicated, or a command would contact a non-test environment. Preserve the checkpoint and report; do not commit or silently omit a ticket.
