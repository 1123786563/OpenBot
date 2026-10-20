# Opik #4 wave 1 repair and integration plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Orca Claude workers implement and independently review; coordinator only plans, adjudicates, integrates, validates and records evidence.

**Goal:** Close verified findings for #9, #11 and #12; integrate reviewed #7 and #8; release the next DAG frontier.

**Architecture:** Keep each ticket's own files and public handoff; repair the source worktree, independently review the exact delta, then transfer only reviewed files to the isolated `opik-integration` worktree. Do not change production ownership or Opik authority boundaries.

**Tech Stack:** Bun, TypeScript, Biome, Docker Compose, Orca orchestration.

**Sources:** `docs/specs/2026-10-14-opik-integration-design.md`, `CONTEXT.md`, relevant ADR 0001–0004, `docs/plans/evidence/2026-10-15-issue4/issue-tree.json`, `docs/plans/2026-10-15-opik-issue4-dag.json`, `docs/plans/evidence/2026-10-14-opik/findings-register-wave1.md`, the five ticket plans and committed review reports.

## Global Constraints

- Opik is optional and may receive only safe projected content. Unknown enterprise scope rejects without fallback.
- No push, merge, release, or local commit for this wave. Workers use complete uncommitted checkpoints with SHA256 manifests and report paths.
- Each worker owns only the listed files; workers are not alone in the codebase and must not revert anyone else's edits. No shared stash.
- Implementation and review use different Claude workers. Reviewers may write only their reports.
- A success claim requires actual gates and a reviewed content hash. Missing Opik or skipped real-instance checks remain incomplete.

## Review Focus

- PEM and AWS secrets on every permitted projection path; structured and free text fail closed.
- Prototype keys and truncation flags reflect actual safe output.
- Scope-derived job and cache keys are injective and regression tested.
- Deployment guard inspects rendered Compose configuration and fails on exposed ports or floating image references.
- Transfer from worker to coordinator preserves exact diff and file hashes.

## Shared file and interface preflight

| Task | Source | Owned files | Consumes | Produces | Shared-state lock |
| --- | --- | --- | --- | --- | --- |
| R03 | #9/T03 | `server/tests/opik-deployment.test.ts`, `docs/tickets/opik-4/checkpoints/T03.md` | T03 Compose and pinned manifest | rendered-config regression checks | no Opik instance; test-only |
| R05 | #11/T05 | `server/src/ai-observability/redaction.ts`, `server/tests/opik-redaction.test.ts`, `shared/ai-observability.ts`, `docs/tickets/opik-4/checkpoints/T05.md` | existing safe projection API | same API with closed leakage and truthful omission | no shared build artifacts |
| R06 | #12/T06 | `server/src/ai-observability/contracts.ts`, `server/src/ai-observability/scope.ts`, `server/tests/opik-scope.test.ts`, `docs/tickets/opik-4/checkpoints/T06.md` | existing trusted scope API | injective derived keys and reviewed scope contract | no shared build artifacts |
| I01 | #7/T01 | exact five source/test files plus `T01.md` in DAG | T01 approved review | integrated route seam | coordinator sequential transfer |
| I02 | #8/T02 | exact i18n files plus `T02.md` in DAG | T02 approved review | integrated UI names | coordinator sequential transfer |

R03/R05/R06 have disjoint write sets and may run together in separate Orca child worktrees. Test commands use separate worktrees and no shared service. I01/I02 are coordinator integrations only, after hash capture and targeted tests. No downstream Task consumes a merely reviewed worktree; integration and validation are required.

## Task R03: Repair #9 deployment verification

**Depends on:** T03's accepted source and review. **Role:** Claude implementation worker. **Validation:** independent Claude Spec/quality reviewer plus coordinator gate. **Acceptance:** Existing #9 acceptance and T03-F1/F2 detection are real.

- [ ] RED: Add a mutation fixture to `server/tests/opik-deployment.test.ts` where rendered Compose exposes `0.0.0.0` on the Opik UI or Collector, and one fixture where a YAML anchor hides a floating image. Both must fail the guard before the fix.
- [ ] GREEN: Parse `docker compose -f docker/compose/opik.yml config` for actual rendered `ports` and `image` values. Fail closed if rendering is unavailable or returns no target services; assert nonempty matching sets. Do not edit deployment images or ports unless a real violation is found.
- [ ] REFACTOR: Keep the test deterministic and avoid depending on a running Opik. Run `bun test server/tests/opik-deployment.test.ts` and the relevant Biome check. Record exact command, exit, counts, file hashes and checkpoint.
- [ ] Failure: report a missing Compose executable or unsupported syntax; do not call skip a pass.

## Task R05: Repair #11 safe projection

**Depends on:** T05 source and review. **Role:** Claude implementation worker. **Validation:** independent Claude Spec/quality reviewer plus coordinator canary check. **Acceptance:** T05-F1/F2/F4/F5/F6, #11 four criteria and A4.

- [ ] RED: Add canaries for bare PEM, newline/colon PEM, AWS secret with label before the value, Slack token, connection string, account ID and raw attachment URL. Add inherited-property and `__proto__` cases, UTF-8 boundary case and 100-item truncation case; prove at least the reported failures first.
- [ ] GREEN: Fix the PEM anchor and AWS context handling; use own-property lookup and a null-prototype output where needed. Ensure a dropped array/key or cut code point is marked truncated/omitted under the existing API. Keep free text fail-closed and never introduce raw input into diagnostic output.
- [ ] REFACTOR: Run `bun test server/tests/opik-redaction.test.ts`, typecheck and Biome on owned files. Record counts, exit codes, file hashes and checkpoint. If the public projection API changes, stop and ask through Orca before editing another ticket's files.
- [ ] Failure: if a canary remains reachable via any safe projection path, report failed and do not claim acceptance.

## Task R06: Repair #12 trusted scope

**Depends on:** T06 source and review. **Role:** Claude implementation worker. **Validation:** independent Claude Spec/quality reviewer plus coordinator key-collision check. **Acceptance:** T06-F1/F3 and #12's scope isolation criteria.

- [ ] RED: Add equal-length and separator collision assertions for `cacheKey`, `jobKey`, `exportKey`; include two scopes with the same resource ID and unknown enterprise scope rejection.
- [ ] GREEN: Encode each key component injectively, for example with length-prefixing used by `scopeKey`; maintain stable deterministic keys for equal input. Update any affected test expectation deliberately. Format and commit nothing.
- [ ] REFACTOR: Run `bun test server/tests/opik-scope.test.ts` plus Biome format/check and typecheck on owned files; capture before/after tracked and untracked contents and SHA256. Correct the checkpoint's gate statement and cursor-invalidation obligation.
- [ ] Failure: any remaining collision or unknown-scope fallback blocks integration.

## Task I01/I02: Integrate accepted #7/#8

**Depends on:** T01/T02 independent review and coordinator adjudication. **Role:** coordinator integration. **Validation:** targeted Bun tests and post-transfer SHA256 comparison.

- [ ] Preserve HEAD, staged/unstaged diff and untracked content before transfer. Generate a binary patch from each task's actual merge-base to reviewed source HEAD; compare patch file list with the task ownership manifest and report.
- [ ] Apply only that patch to `opik-integration`. Copy the untracked T02 checkpoint explicitly and hash it. Reject unexpected file overlap; never use stash.
- [ ] Run `bun test server/tests/opik-module-skeleton.test.ts app/src/lib/i18n/ai-observability.test.ts` and applicable type/lint checks. Save exact results and post-transfer hashes. Record integrated checkpoint IDs in the DAG and Ledger.
- [ ] If current coordinator files conflict, stop that transfer and resolve ownership with a new reviewed checkpoint; do not mark verified.

## Downstream release

T04 (#10) becomes ready only after T03 is independently reviewed and integrated. T07 (#13) becomes ready only after T06 is independently reviewed and integrated. Other tasks follow the validated DAG and need a ticket-level plan and file/interface preflight before dispatch.

## Gate repair R01: #7 changed-file Biome errors

**Depends on:** I01 transfer gate. **Owned files:** `server/src/ai-observability/routes/index.ts`, `server/src/app.ts`, `server/src/index.ts`, `server/tests/opik-module-skeleton.test.ts`. **Role:** Claude implementation worker. **Acceptance:** Run the locked Biome binary in file mode; organize imports and fix formatting or a newly introduced diagnostic in owned changed lines. Preserve the route seam's behavior and re-run the 15 server tests and server typecheck. Compare any remaining diagnostics with the source branch's parent baseline in file mode; list pre-existing warnings separately. No commit. Independent Claude re-review after repair.

## Gate repair R02: #8 changed-file Biome errors

**Depends on:** I02 transfer gate. **Owned files:** `app/src/lib/i18n/i18next.d.ts`, `app/src/lib/i18n/index.ts`, `app/src/lib/i18n/ai-observability.test.ts`, the eight new locale JSON files. **Role:** Claude implementation worker. **Acceptance:** Organize imports in the two changed i18n modules, keep both locale key sets and eight states equal, run the six i18n tests, app typecheck and locked Biome file-mode gate on owned files. No commit. Independent Claude re-review after repair.
