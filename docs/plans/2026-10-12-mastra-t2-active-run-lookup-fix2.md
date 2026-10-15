# T2 Active Run Lookup Fix 2 — Persisted Scope and Lease Exclusions

> **For agentic workers:** close only the residual M1 coverage noted in Fix1 review; retain the existing one-test DB-gated design and do not touch production source.

**Goal:** Extend the existing DB-gated active lookup regression to cover persisted wrong-thread, cross-principal scope, and expired lease exclusions, alongside replacement attempt and stale-stop fencing.

**Source of truth:** Original active lookup plan and Fix1 plan; Fix1 implementation/validation/review reports; residual M1 in \`.superpowers/sdd/2026-10-12-mastra-t2-active-run-lookup-fix1/reports/task-1-review-report.md\`.

## Global Constraints

- Modify only the existing appended test block in \`server/tests/enterprise/runs.integration.test.ts\`.
- Reuse this suite's verified database fixtures and scoped resolver patterns. The task must not start/probe/access DB or run any DB-backed test.
- No production/schema/migration edits or unrelated integration test rewrite.
- No commit/stage/stash/reset/rebase/merge/push/release/worktree deletion.
- New and old DB assertions remain unexecuted/unverified pending explicit disposable DB readiness.

## Review Focus

- Wrong-thread returns \`null\` in persisted lookup.
- A different legitimately resolved principal in the same tenant/workspace cannot find the original principal's Run.
- Expired Run/attempt lease returns \`null\` after the stale-stop assertion is completed.
- Existing replacement lookup, stale-stop rejection, and terminal exclusion assertions remain intact; cleanup still runs on assertion failure.

## Task 1 — Extend gated regression

**Role:** backend_implementer. **Validator:** backend_validator. **Reviewer:** reviewer. **Dependency:** Fix1 checkpoint. **Commit policy:** uncommitted checkpoint only.

**Owned file:** \`server/tests/enterprise/runs.integration.test.ts\`; edit only the appended "active thread lookup returns replacement attempt and fences stale stop" test.

1. Verify HEAD and full before manifest; verify current test file hash equals Fix1 after \`f13fcb77d2833679de176c3f438294337bdedc6232cbb9155a253e1f213a252f\`.
2. Within the same test, assert lookup for a wrong thread is \`null\`; seed a second test principal/member and resolve it through existing \`createScopeResolver\`, then assert that principal cannot retrieve the original thread's active Run.
3. After replacement and stale-stop checks, expire the live Run/attempt lease in a scoped transaction with narrowly scoped row updates, assert active lookup returns \`null\`, and use existing cleanup to terminate the Run.
4. Run only DB-free checks (scoped Biome, diff check, targeted type/static checks); never run suite, DB URL detection that opens services, migrations, or database commands.
5. Save before/after manifests, exact test increment/hash, commands and report at \`.superpowers/sdd/2026-10-12-mastra-t2-active-run-lookup-fix2/reports/task-1-implementer-report.md\`.

**Acceptance:** Fix1 reviewer residual M1 coverage is addressed in one existing gated regression; DB assertions remain clearly unexecuted.

**Failure handling:** If safe cleanup or trusted alternate scope cannot be constructed using suite conventions, stop before edits and document evidence.
