# M02 R1C — Behavioral Acceptance Audit

> **For agentic workers:** Execute this verification-only plan after R1B is verified. Do not modify product source or tests under this node. If the audit exposes an acceptance gap, stop and return the evidence; the controller will create a separately numbered implementation repair task and assign the correct implementer role.

**Goal:** Close parent finding M02-R8 only if the cumulative Task 2 implementation has executable, passing behavior evidence for the approved trusted Mastra storage and conversation contracts.

**Facts:** Approved source spec `docs/superpowers/specs/2026-10-10-mastra-intelligence-migration-design.md`; Task 2 implementation brief `.superpowers/sdd/2026-10-10-mastra-intelligence-migration/task-2-brief.md`; original independent review `.superpowers/sdd/2026-10-10-mastra-intelligence-migration/reports/task-2-review.md`; R1B repair ledger `.superpowers/sdd/2026-10-10-m02-r1b-r2-reconciliation-fairness/progress.md`. No separate CONTEXT.md or ADR was found. R1B is verified. This is a read-only validation/review node; it has no product code owner.

**Workspace and checkpoint:** `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`, current HEAD recorded in `.superpowers/sdd/2026-10-10-m02-r1c-behavioral-acceptance-audit/snapshots/m02-r1c-audit-inputs.json`. Inputs include exact hashes for the service, Mastra repository/storage, attachment authorization, reconciler, and four integration suites. Validation and review bind to this input snapshot and the referenced R1A/R1B packages. No commit, stash, reset, or source/test mutation.

## Global constraints

- Use only the reserved synthetic PostgreSQL test identity from `m02-r1a-brief.md`; verify database/current role/journal before DB tests. Never use a `DATABASE_URL` fallback.
- The backend validator alone runs PostgreSQL suites, serially, and may not edit product or test source.
- The reviewer is read-only, does not run tests, and returns separate Spec Compliance and Code Quality verdicts.
- Do not call a mocked storage path proof of real provisioned tenant storage. Distinguish service-level fake-adapter behavior from restricted-role/PostgresStore integration behavior.
- No test skip, incomplete fixture, or environment failure counts as acceptance evidence. Report every gap explicitly; do not infer coverage from a test name alone.
- Persistent registry cleanup is not claimed by the in-memory registry lookup fixture. Existing unrelated M17 typecheck diagnostic remains outside this node.

## Review focus and acceptance mapping

The independent reviewer must map each assertion below to a concrete test name, exact source lines, and either the frozen R1A/R1B evidence or a reproducible validator command. A missing row is an acceptance gap, not a pass.

| M02-R8 acceptance claim | Minimum evidence to locate/check |
|---|---|
| Two provisioned tenant runtime roles cannot read each other's Mastra schema; runtime role cannot create schema/table or read registry | Real provisioner + restricted-login test; actual session identity and denied cross-tenant operations |
| Trusted storage binding rejects unverified scope and mismatched tenant/registry location | `createTenantMastraStorage` negative tests before any tenant storage lookup |
| Request-facing Mastra conversation appends and reads only Mastra once; no platform message dual-write; persisted backend controls dispatch | Public `ConversationService` path test, actual persisted backend assertions, message-table absence; legacy/platform path checks remain compatible |
| Forged or cross-principal conversation/thread and revoked membership/resource grant cannot cause Mastra writes | Service/API boundary tests with write counters or actual storage proof; separate access denial from a fake repository-only assertion |
| Private resources use trusted tenant+principal; channel resources use trusted tenant+channel and remain disjoint | Explicit identity assertions for two principals, tenants, and channels or equivalent invariant plus behavior tests |
| Accepted write survives process/pool recreation and history uses stable monotonic bounded cursors | PostgreSQL reopen test; equal timestamp/concurrent/retry/page traversal tests with no gaps/duplicates/full-history reads |
| Membership revocation is fenced against an in-flight Mastra append, and revocation before authorization creates no Mastra side effect | Barrier-controlled tests for both orderings; include applicable legacy-channel mapping path |
| Attachments preserve authorization and lifecycle; pending intent blocks delete/cull; exact retry/reconciliation does not save after revoke | Unauthorized and successful attach tests, sweeper/store tests, intent/reconcile exact/mismatch/absent and lock-order cases |
| Production tenant storage inspection is read-only and validates exact identity tuple | Real provisioned restricted role + actual PostgresStore adapter, exact/absent/all mismatch dimensions, unchanged stored row count |

## Tasks

### R1C-1 — Independent backend behavior validation

- **Depends on:** R1B verified.
- **Role:** `backend_validator`; no source/test edits.
- **Inputs:** input hash snapshot above, Task 2 brief/review, R1A validation and R1B/R1B-R2 reports.
- **Run, serially from `server/`:**
  1. exact synthetic database identity/journal query;
  2. `bun test --timeout 60000 --max-concurrency 1 tests/enterprise/mastra-storage.integration.test.ts`;
  3. `bun test --timeout 60000 --max-concurrency 1 tests/enterprise/conversations.integration.test.ts`;
  4. `bun test --max-concurrency 1 tests/attachment-store.test.ts`;
  5. `bun test --max-concurrency 1 tests/attachment-sweeper.test.ts`;
  6. targeted Biome for the four suites and owned Mastra/conversation sources, plus `git diff --check`.
- **Report:** `.superpowers/sdd/2026-10-10-m02-r1c-behavioral-acceptance-audit/reports/m02-r1c-validation.md`. Include exact input/package hashes, database identity, commands, counts, skips, cleanup, gaps, and status. Report only behavior evidenced by the tests run.

### R1C-2 — Independent Spec and code review

- **Depends on:** frozen input snapshot (may run concurrently with R1C-1; read-only, no database tests).
- **Role:** `reviewer`; inspect Task 2/R1B behavior against each mapping row and confirm input hashes.
- **Report:** `.superpowers/sdd/2026-10-10-m02-r1c-behavioral-acceptance-audit/reports/m02-r1c-review.md`; return separate Spec Compliance and Code Quality verdicts, finding IDs/severities, and explicit M02-R8 disposition. Do not overstate tests as request-level or production adapter coverage when they use fakes.

## Completion criteria and failure handling

R1C is verified only if validator PASS and reviewer Spec/Code PASS, all input hashes remain stable, and every matrix row has direct evidence sufficient for its stated claim. If a valid Critical/High/Medium gap or a required case with no evidence remains, do not complete R1C or mark M02-R8 closed. Create a numbered follow-up implementation task with a narrow plan/brief and role-correct ownership; preserve the current audit reports. Do not use the audit task to implement a source fix.

**Review focus:** trust boundaries, tenant isolation, single-writer conversation path, revocation fencing, attachment saga, storage read-only inspection, and whether each claimed integration boundary is actually exercised.
