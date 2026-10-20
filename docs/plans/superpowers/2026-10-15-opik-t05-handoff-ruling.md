# Opik #11 handoff wording repair plan

> **For agentic workers:** Execute as one Orca Claude documentation task under Superpowers SDD. Independent Claude review follows; coordinator owns integration and ledger updates.

**Goal:** Resolve R05 review finding T05-F7 in the current local ticket manifest before any downstream implementation consumes the T05 contract.

**Architecture:** Preserve the published GitHub Issue and historical publication snapshots. Correct only the local current manifest that supplies coordinator Task Briefs. The public implementation exports six named projection functions and the version constant; the generic `projectSafe()` name does not exist.

**Sources:** Approved Opik Spec A4; Issue #11 snapshot; `reviews/R05-review.md`; `server/src/ai-observability/redaction.ts` in the reviewed R05 source worktree; `docs/plans/tickets/opik-4/manifest.json`.

## Global Constraints

- Do not edit GitHub Issues, historical snapshot files, production code, tests, or other ticket interfaces.
- Owned file: `docs/plans/tickets/opik-4/manifest.json`; report under `docs/plans/evidence/2026-10-15-issue4/repairs/`.
- Preserve all task dependencies, statuses, and non-T05 contracts.
- No commit, push, merge, publish, or stash.

## Review Focus

- T05's `produces` is precise: `projectSafeText`, `projectSafeUrl`, `projectSafeName`, `projectSafeRecord`, `projectSafeMetadata`, `projectSafeException`, and `REDACTION_POLICY_VERSION`.
- Every local downstream `consumes` reference to T05 uses those real exported names and makes clear content policy version is included.
- Valid JSON, diff limited to the owned manifest and report, historical GitHub artifacts untouched.

## Task 1: Correct current manifest handoff

**Depends on:** R05 review approval and T05 source review. **Role:** Claude implementation worker. **Validator:** independent Claude reviewer. **Consumes:** reviewed R05 exports in `opik-r05-redaction`. **Produces:** corrected current manifest handoff only. **Verification:** JSON parse; search proves no generic `projectSafe()` reference remains in the current manifest; exact T05 function names match source exports; inspect diff and hashes. Failure means report blocked without editing published Issue data.
