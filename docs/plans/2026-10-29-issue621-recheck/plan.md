# Issue 621 Public Interface Cycle Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Detect newly introduced module dependency cycles even when imports use public Interfaces, while preserving the existing deep-reference exception rules.

**Architecture:** Extend the existing import checker and its fixture tests. Track all business-to-business module edges for cycle detection; continue treating public exports as legal deep references. Account for existing cycles explicitly, without silently broadening baseline exceptions. Current tree has unrelated baseline violations, which remain a delivery blocker unless individually resolved under their owning scope.

**Tech Stack:** TypeScript, Bun, root e2e runner.

**Spec:** GitHub 1123786563/OpenBot#621 v1; docs/plans/modular-architecture/migration-plan.md AR01/AR02 (design draft).

## Global Constraints

- Preserve product behavior, stable IDs, Payer, public wire, same-connection transactions and revocation/audit contracts.
- Do not introduce candidate BA/Personal Space, restore old #6/ADR 0004 or KB, or force package extraction.
- Keep unrelated collaborators' changes; do not silently absorb other tickets' defects or expand exemptions.
- Use independent behavior validation, Spec and quality review, and complete OCR before delivery.

## Review Focus

- A two-module cycle through public exports is rejected; a one-way public import remains legal.
- Mixed public/deep cycles are detected and existing exact exceptions remain traceable.
- Type-only, relative, alias and workspace imports retain their existing handling.
- No unrelated pre-existing violations are masked by baseline regeneration.
- Unknown mapping and phantom exceptions still fail.

### Task 1: Diagnose and repair public-export cycle detection

**Owner:** backend implementer. **Validator:** independent backend validator. **Depends on:** none.

**Files:** modify `scripts/check-module-imports.ts` and `tests/module-imports.test.ts`; inspect `tests/config/module-imports.json` read-only. Do not edit application code or baseline exceptions.

**Interfaces:** Consumes `runCheck(config: CheckConfig, options: { cwd: string; scanRoots?: string[]; ignoreExceptions?: boolean }): CheckResult`; preserves this signature and CLI failure contract.

- [ ] Add fixture tests for two modules mutually importing `public.ts`, a mixed public/deep cycle, and one-way public import; assert cycle violation for cycles and success for the one-way case.
- [ ] Run root e2e test target and record the new cases failing before implementation; retain the known baseline failure separately.
- [ ] Implement the smallest change that includes public business edges in cycle analysis and reports newly introduced cycles without turning legal one-way public imports into deep-reference violations. If this cannot distinguish existing cycles from new ones without changing the exception contract, stop and report the exact design and scope conflict instead of widening exemptions.
- [ ] Run the same target and verify the new cases pass; record all test counts, skipped cases and baseline failures. Independently inspect alias/workspace/type handling and exact exception behavior.
- [ ] Produce a complete checkpoint and independent behavior verification plus Spec/quality review. OCR the authorized change with complete input coverage; resolve valid critical/high/medium findings.

### Task 2: Reconcile full #621 acceptance

**Owner:** researcher; independent backend validator and reviewer. **Depends on:** Task 1 when fixing code; baseline investigation may run read-only independently.

**Files:** all application code read-only. Evidence belongs under the run archive; no other ticket's business code is owned by this task.

**Consumes:** current target SHA, #621 acceptance, original feature contracts, current runtime consumers and Task 1 checkpoint. **Produces:** current-version Web text-chat write/remote-action inventory and acceptance mapping, identifying unknown ownership and gaps.

- [ ] Trace both applicable Web text-chat entry paths through HTTP, Run, conversation, model, billing and remote effects; name each writer, source location, data/remote action and transaction.
- [ ] Reconcile the existing 63 unmatched cycle edges and 39 changed-category exceptions to their introducing changes and owners. Preserve each genuine violation; do not bulk accept or modify unrelated tickets under #621.
- [ ] Verify exact-version test and review evidence; where unavailable, independently run the applicable tests and retain source manifest, test counts and output. Block any acceptance that lacks evidence.
- [ ] Complete full issue acceptance and original feature contract mapping, then rescan requirements, policies, target SHA and delivery gates before any authorized external write.

**Failure handling:** retain the workspace, baseline output and incomplete evidence; do not mark #621 verified or close it while a required acceptance, independent review or OCR is missing. Roll back only this task's changes and preserve all business facts and existing exceptions.

### Repair R1: Pin exact exception behavior while preserving fail-closed reporting

**Owner:** backend implementer; independent validator and reviewer. **Depends on:** frozen_failed Task 1 checkpoint. **Files:** `tests/module-imports.test.ts`; checker read-only unless reproduction identifies an implementation error; baseline config read-only.

- [ ] Add a fixture with a valid exact deep-reference exception and a newly added public reverse edge. Assert the cycle is reported and the category-mismatched exception is phantom; remove the reverse edge and assert the exact exception is consumed.
- [ ] Add integration-export and three-module cycle fixture cases. Use root e2e and record counts and failures.
- [ ] Independently review whether the checker fails closed and whether the original unresolved baseline remains visible. Do not treat fail-closed reporting as completed baseline migration.

**Ruling:** Existing config records deep-reference exceptions but not historical public edges. The issue requires new cycles to fail, so preserve exact category semantics and report category drift rather than silently grandfathering it. Current tree baseline failure remains blocking; a verified graph/exception reconciliation is a separate prerequisite to full #621 acceptance.
