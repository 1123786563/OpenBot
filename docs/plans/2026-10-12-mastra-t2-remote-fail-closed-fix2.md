# T2 Remote Fail-Closed — Review Fix 2

> **For agentic workers:** perform only this small test-clarity repair. Do not commit, stage, stash, reset, rebase, access a DB, or touch production behavior.

**Goal:** Resolve the Low reviewer finding in Remote Fail-Closed Fix1 by making test names/comments describe their current fail-closed assertions.

**Source of truth:** Approved route/budget ruling and parent Task 2 plan/Ledger; Fix1 plan, report and independent review under `.superpowers/sdd/2026-10-12-mastra-t2-remote-fail-closed-fix1/`.

## Scope

**Role:** mechanical_worker. **Validator:** backend_validator. **Reviewer:** reviewer. **Owned file:** `server/tests/copilot.test.ts` only.

Fix only stale test names and comments identified in the Fix1 review: tests named “sends one standing role message ahead of the conversation,” “keeps the standing role out of forwarded props and agent state,” the edited-role remote test/comment claiming role content is asserted on the wire, and “a remote Bot's run fails naming the attachment it could not load.” Rename/reword them to state that remote requests are refused before transport and that no role/attachment delivery is being asserted. Do not change test behavior/assertions or delete meaningful built-in behavior coverage.

## Required sequence

1. Verify current file hash equals Fix1 after hash `798efbc5c96618036b77f0de98d174dab2eb1837c2eabae0120df495f5c7389d`; capture before hash.
2. Make naming/comment-only edits to the named stale cases.
3. Run `bun test tests/copilot.test.ts`, scoped Biome, and `git diff --check`.
4. Freeze before/after hashes and report at `.superpowers/sdd/2026-10-12-mastra-t2-remote-fail-closed-fix2/reports/task-1-implementer-report.md`.

**Acceptance:** Tests still pass and clearly assert refusal, not remote role or attachment delivery. No production source or other tests change.
