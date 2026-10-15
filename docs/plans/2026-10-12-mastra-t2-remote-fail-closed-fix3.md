# T2 Remote Fail-Closed — Review Fix 3

> **For agentic workers:** make only the named test-clarity edits. No production or assertion changes; no database or Git repository-control operations.

**Goal:** Finish the Low clarity correction carried over from remote fail-closed Fix2.

**Source:** Fix1 policy/ruling, Fix2 plan and reports. Current baseline `server/tests/copilot.test.ts` SHA256 `0075190a62d601fcb49d66eb8bdfc215e70da34c63db0032feadfd4f52cd719c`.

## Ownership

**Role:** mechanical_worker. **Validator:** backend_validator. **Reviewer:** reviewer. **Only owned file:** `server/tests/copilot.test.ts`.

## Required edits

1. Rename test at the current line near 800, `sends one standing role message ahead of the conversation`, to state remote role delivery is refused/blocked.
2. Rename test near line 820, `keeps the standing role out of forwarded props and agent state`, to state fail-closed refusal, not role serialization.
3. Rename test near line 942, `rebuilds each agent from the loader so an edited role applies to the next run`, to state the remote Bot is refused after rebuild; remove/rewrite comments claiming the edited role is observed on the wire.
4. Rewrite stale comments near `runWithVendors`/standing-role references (e.g. “role can be asserted on the wire”) only where they claim those remote cases still prove remote delivery.

Do not edit assertions, test setup, source code, or unrelated tests. The attachment case at ~2009 already has an accurate fail-closed name and must remain untouched.

## Verification

- Capture current baseline hash before edit and preserve complete file before/after hashes in report.
- Run `bun test tests/copilot.test.ts`, scoped Biome, and `git diff --check`.
- Report exact names/comments changed at `.superpowers/sdd/2026-10-12-mastra-t2-remote-fail-closed-fix3/reports/task-1-implementer-report.md`.

**Acceptance:** only the explicitly stale names/comments change; 73 Copilot tests pass; no assertion or production behavior changes.
