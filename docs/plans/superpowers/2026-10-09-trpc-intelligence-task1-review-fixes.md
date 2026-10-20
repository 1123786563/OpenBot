# Task 1 Review Findings Repair Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four valid findings from Task 1 fix-round-2 review so the SDK wire contract is reproducible and agrees across runtime, portable schema, and locked client behavior.

**Architecture:** Keep Task 1 service contracts and product dependencies unchanged. Add only exact test-time direct dependencies already present in the lockfile, exercise the public locked package entry points, and extend the client-call harness with nonempty pagination, real stop requests, and a replay cursor that is verified by the same supported client transport.

**Tech Stack:** Bun workspaces, TypeScript, CopilotKit 1.77.0, AG-UI 1.0.1, Ajv 8.20.0, Zod, JSON Schema 2020-12.

**Spec:** [Approved migration design](../../specs/superpowers/2026-10-09-trpc-intelligence-migration-design.md); [original plan Task 1](2026-10-09-trpc-intelligence-migration.md); [fix-round-2 independent review](../../.superpowers/sdd/2026-10-09-trpc-intelligence-migration/reports/task-1-fix-2-review.md). This numbered plan covers only T1-F2-H1 and T1-F2-M1–M4.

## Global Constraints

- Keep TypeScript as the sole product control plane and Go as executor; this repair changes only Task 1 contracts/tests and test-time dependencies.
- Do not introduce runtime product dependencies: `@copilotkit/core@1.77.0` and `ajv@8.20.0` are exact `server` devDependencies for compatibility tests.
- Import locked packages via their public module entry points; resolve package metadata from standard `server/node_modules/<name>/package.json` paths, never Bun's private `.bun` layout.
- All uncommitted changes remain based on `fbdecc29cd786952c4b496abc68384b31a320b17`; no commit, push, deployment, or production data access.
- JSON object-property length is measured in Unicode code points and is at most 200 at every nesting level, consistently in canonicalization, strict runtime parsing, and Draft 2020-12 schema.
- Lock request and response facts to actual installed client/server call sites; label any intentionally unconsumed response as such.

## Review Focus

1. Cursor resume must use the same locked transport to request a noninitial cursor and consume only the replayed events after it (T1-R2-1).
2. A thread-list response must include a valid thread and next cursor, and the store must expose them and use the cursor for the next page (T1-R2-1).
3. Stop with an active run must issue the locked POST and `{runId}` body; the recorded server response must match the pinned stop handler and explicitly state that the client ignores it (T1-R2-1).
4. Non-BMP property names must produce the same accept/reject decision in runtime and Ajv against the saved JSON Schema (T1-R2-1).
5. Clean workspace install must resolve tests via direct server devDependencies and public exports (T1-R2-1).

---

### Task 1-R2-1: Make locked client wire evidence complete and reproducible

**Depends on:** Task 1 implementation checkpoint at BASE `fbdecc29cd786952c4b496abc68384b31a320b17`; prior findings H1/H3/M4/M5/M6 and ASCII key cap are already fixed and must remain so. **Roles:** backend_implementer → backend_validator → reviewer.

**Files / ownership:**

- **Modify:** `server/package.json`, `bun.lock`, `server/src/enterprise/wire-schema.ts`, `shared/runtime-compatibility.ts`, `server/tests/enterprise/fixtures/runtime-wire.json`, `server/tests/enterprise/contract-schema.test.ts`, `server/tests/enterprise/sdk-compatibility.test.ts`.
- `@copilotkit/core@1.77.0` and `ajv@8.20.0` go in `server.devDependencies`; package imports use `@copilotkit/core` and `ajv/dist/2020.js` public entry points. The compatibility metadata test reads each standard package path and hashes package metadata against the fixture.

**Interfaces:** Consumes the locked package versions and stop handler contract from `@copilotkit/runtime@1.77.0`; produces regression tests proving `T1-F2-H1`, `T1-F2-M1`, `T1-F2-M2`, `T1-F2-M3`, and `T1-F2-M4` resolved without changing runtime product API.

- [ ] **Step 1 — RED:** Extend client-call tests to assert a nonempty thread list and non-null `nextCursor` are consumed, then request the following page using that cursor. Use a valid locked `Thread` value and assert its ID/title and the next-page query cursor. Add active-run stop assertions for method, JSON body `{runId}`, content type, and the response behavior actually observed from the locked client. Drive reconnect through one transport from cursor request through replay consumption; assert only post-cursor events reach the subscriber. Add 200/201 Unicode code-point boundaries for runtime, strict Zod, and Ajv. Add public-entry-point imports and package hash checks.
- [ ] **Step 2 — Verify RED:** Run the two Task 1 suites. Each new assertion must fail for the expected missing behavior or import resolution before production/test harness corrections; record exact failures.
- [ ] **Step 3 — Implement:** Measure property-name length with Unicode code points. Add exact server devDependencies and update `bun.lock` without changing runtime dependencies. Change SDK tests to public package imports and portable package metadata locations. Use the installed `ProxiedCopilotRuntimeAgent` active-run path for stop; capture the actual handler response shape from the locked stop implementation and record that the client discards the response. For reconnect, use the locked transport's real resume mechanism and tie the requested cursor to the same returned/consumed replay stream. Keep thread-store list/page state assertions on the locked implementation.
- [ ] **Step 4 — GREEN and self-review:** Rerun the focused suites; confirm all old T1 schema, approval/run, fixture lifecycle and TEST_DATABASE_URL cases still pass. Review the dependency diff to ensure only server devDependencies and the lockfile change.
- [ ] **Step 5 — Verify:** `bun test server/tests/enterprise/contract-schema.test.ts server/tests/enterprise/sdk-compatibility.test.ts`; scoped `bunx tsc --noEmit ...` for Task 1 source/tests; `bunx biome check` over all Task 1-owned files plus `server/package.json`; `git diff --check`. Expected: all tests/typecheck/lint/diff checks exit 0 and package imports resolve after a clean workspace install using the committed lock. No DB is needed.
- [ ] **Step 6 — Checkpoint and independent review:** Save full before/after content and hashes, generate a delta review package, and require backend validator plus reviewer Spec Compliance and Task Quality PASS on the exact same source hashes. Keep changes uncommitted and record current BASE/HEAD.

**Acceptance / failure handling:** AC-03, AC-05, AC-12; all four findings are addressed with tested behavior, direct dependency declarations, matching Unicode semantics, and no production dependency changes. If supported SDK transports differ, test and label both explicit contracts rather than combining fixtures. Do not claim completion when an acceptance finding remains valid.
