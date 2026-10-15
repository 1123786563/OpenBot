# M02 R1C Final Acceptance Re-audit Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development for the independent validator and reviewer gates. Steps use checkbox syntax for tracking.

**Goal:** Determine whether M02-R8 is fully addressed after the R1D behavioral evidence repair and M02-R1D-01 fix, using one exact final source/test snapshot.

**Architecture:** This is a read-only acceptance audit. A backend validator reruns the four serial database suites and targeted static checks against the final snapshot. An independent reviewer maps each original R1C finding and the R1D follow-up to direct tests and source boundaries, returning separate Spec Compliance and Code Quality judgments. No production or test source edits are in scope.

**Tech Stack:** TypeScript/Bun, Drizzle/PostgreSQL, frozen source/test content snapshots.

**Spec:** Approved Mastra migration spec §§4–5, 10; root migration plan Task 2 and acceptance M02-R8; R1D repair plan and FIX1 plan.

## Global Constraints

- Treat `.superpowers/sdd/2026-10-10-m02-r1c-final-acceptance-reaudit/snapshots/final-inputs.json` as the exact source/test review boundary; verify every input hash before and after checks.
- Use only the approved synthetic loopback PostgreSQL credentials in the R1A brief; never fall back to `DATABASE_URL`, and do not persist credential values.
- Keep database suites serial; the reviewer is read-only and must not run tests.
- No source/test edits, commits, stash, reset, external services, or production cutover claims.
- Distinguish this tested migration contract from Task 12's production cutover CAS and in-flight transition behavior, which remain separately owned.

## Review Focus

1. New message writes go only through `ConversationService.append`; the legacy repository is resolve/history-only.
2. Accepted public writes survive restricted tenant-pool close/recreation and remain absent from platform message rows.
3. Forged/foreign identities, channel/private scopes, tenant storage identities, backend version dispatch, and legacy revocation behave as specified.
4. Foreign, revoked-membership, and deleted-channel attachment denials on Mastra leave no storage write, finalized intent, or attachment stamp.
5. The database journal remains at the expected migrated baseline with no audit-time migrations.

---

### Task R1C-FINAL: M02-R8 evidence and contract re-audit

**Depends on:** R1B verified; R1D validator PASS; R1D reviewer finding resolved by FIX1; FIX1 validator and reviewer PASS. **Roles:** `backend_validator` and independent `reviewer` in parallel after the final input snapshot is controller-verified.

**Files:** Read only these final snapshot inputs: `server/src/enterprise/conversations/service.ts`, `server/src/enterprise/conversations/mastra-intent-reconciler.ts`, `server/src/mastra/conversations.ts`, `server/src/mastra/tenant-storage.ts`, `server/src/channels/attachments.ts`, `server/tests/enterprise/conversations.integration.test.ts`, `server/tests/enterprise/mastra-storage.integration.test.ts`, `server/tests/attachment-sweeper.test.ts`, and `server/tests/attachment-store.test.ts`. Write validator and reviewer reports only under `.superpowers/sdd/2026-10-10-m02-r1c-final-acceptance-reaudit/reports/`.

**Interfaces:**

- Consumes the approved spec, root Task 2, original R1C review, R1D implementation/validation/review, FIX1 implementation/validation/review, and exact final snapshot.
- Produces serial runtime evidence for all four suites, an R1C-to-final-test acceptance mapping, separate review verdicts, and a disposition for M02-R8.

- [ ] **Step 1 — Snapshot gate:** Controller captures all nine named files with exact full bytes/hashes and verifies each path against the live worktree before dispatch. Record HEAD and package/report dependencies. No edits permitted.
- [ ] **Step 2 — Runtime validation:** Backend validator serially runs Mastra storage integration, conversations integration, attachment-store, and attachment-sweeper suites, then targeted Biome and `git diff --check`. It verifies all nine hashes before and after. Expected: all commands pass, no migration run, no credential disclosure.
- [ ] **Step 3 — Spec review:** Reviewer checks the original M02-R8 acceptance and R1C-01/02/03 against the exact final snapshot, including FIX1's foreign-owned-thread attachment case. Reviewer returns separate Spec Compliance and Code Quality verdicts and records every remaining severity with evidence.
- [ ] **Step 4 — Completion ruling:** If validator PASS and reviewer Spec/Code PASS with no valid critical/high/medium item, controller maps all M02-R8 criteria, marks R1C and M02 verified, and records Task 12 exclusions. Otherwise create a new scoped repair plan and leave R1C/M02 open.

**Acceptance:** M02-R8 closes only with complete snapshot-bound runtime evidence and independent Spec/Code PASS, no effective critical/high/medium finding, no missing acceptance mapping, and no unsupported Task 12 claim.

## Pre-dispatch consistency

| Node | Owned boundary | Consumes / produces | Dependency | Verification |
|---|---|---|---|---|
| R1C-FINAL | Nine exact source/test inputs; reports only | Consumes R1D/FIX1 checkpoints; produces final R8 evidence and verdict | R1D/FIX1 gates complete | Four serial DB suites, hash stability, targeted lint, independent spec/quality review |

DAG: one audit node, all input names unique and present, no cycles. Original R1C gaps map to direct final source/test evidence and the R1D/FIX1 validator/reviewer checkpoints; any unmapped criterion remains open.
