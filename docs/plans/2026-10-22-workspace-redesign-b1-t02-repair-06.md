# Workspace Redesign B1 T02 Static-Check Repair Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`; one frontend implementer, then independent validator and reviewer. No commits.

**Goal:** Clear actionable formatting/import-order and hook/accessibility diagnostics from the four T02-owned shared wrappers without changing their interaction contracts.

**Architecture:** Keep the current HeroUI wrappers and event flow. Make cleanup callbacks stable where effect cleanup depends on them, declare the Dialog callback dependency, mark the context-menu event surface presentational while preserving its descendants, and apply the repository formatter only to the four owned source files.

**Tech Stack:** React, TypeScript, HeroUI v3, Biome, tester-army e2e.

**Spec:** B1 implementation plan `docs/plans/2026-10-20-workspace-redesign-b1.md`; T02 wrapper scope and contracts in `docs/design/2026-10-20-workspace-redesign/handoff/refinement/implementation-spec.md` §§2–3 and `theme-contract.json`; original T02 task report and review records in `docs/plans/reports/T02-impl.md` and `T02-re-review-02.md`.

## Global Constraints

- Preserve wrapper refs, native events, form behavior, anchor behavior, keyboard behavior, and portal/focus behavior.
- Do not change product dependencies, APIs, routes, data, or business behavior.
- Preserve all pre-existing staged, unstaged, and untracked work; do not reset, clean, or stash.
- No commit, push, merge, publish, or deploy.
- Keep this repair within the four T02-owned wrapper files; add no tests unless the implementer demonstrates a specific behavior regression that needs a regression test.

## Review Focus

1. Context-menu children retain their current accessible semantics and right-click, Shift+F10, long-press, cancellation, and cleanup behavior.
2. Dialog Escape listener remains current when `onOpenChange` changes and nested popup/Dialog focus behavior stays intact.
3. Formatter changes are syntax-only outside the two small hook/accessibility fixes.

---

## Task 1: T02 static-check repair

**Depends on:** verified T02 implementation; no upstream tasks.
**Owner / validator / reviewer:** `frontend_implementer` / `frontend_validator` / `reviewer`.
**Checkpoint policy:** no commits. PRE and POST include exact copies and SHA-256 hashes of the four owned source files, HEAD, complete Git status, staged/unstaged diffs, and an inventory of untracked files. The review package is the real PRE→POST file delta, including additions/deletions; do not use BASE..HEAD.

**Files:**

- Modify: `app/src/components/ui/button.tsx`
- Modify: `app/src/components/ui/sheet.tsx`
- Modify: `app/src/components/ui/context-menu.tsx`
- Modify: `app/src/components/ui/dialog.tsx`
- Behavior checks: `app/tests/zz-probe-context-menu.test.tsx`, `app/tests/button-native.test.tsx`, `app/tests/heroui-spike.test.tsx`, `app/tests/bot-setup.test.tsx`
- Report: `docs/plans/reports/T02-R6-impl.md`
- Evidence: `docs/verification/workspace-redesign/t02-r6/`

**Consumes:** current T02 wrapper implementation and the exact diagnostics from `bunx biome check` recorded in the current-session Ledger entry.

**Produces:** all four wrappers pass `bunx biome check`; existing wrapper behavior tests pass; formatter-only hunks do not alter runtime semantics.

- [ ] Step 1: Reproduce the four-file Biome diagnostics and record them in the implementation report before edits.
- [ ] Step 2: Fix the hook dependency/cleanup and static-interaction diagnostics with the smallest behavior-preserving changes; format/import-sort only the four owned source files.
- [ ] Step 3: Run `bunx biome check` on exactly those four files and the focused native test files through the ADR0008-approved runner. Record counts, exits, and output paths.
- [ ] Step 4: Self-review the four-file diff and write the report; do not commit.
- [ ] Step 5: A read-only frontend validator verifies the exact POST hashes, static-check result, and relevant behavior tests; a separate reviewer returns Spec compliance and code-quality verdicts against a PRE→POST package.

**Expected result / failure handling:** Biome exits 0 for all four files, focused behavior suites have zero failures and no new skips, and the delta changes no public wrapper API. Any behavior uncertainty pauses this task and is reported; it does not authorize broader wrapper redesign.

