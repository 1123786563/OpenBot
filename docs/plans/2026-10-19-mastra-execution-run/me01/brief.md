# ME01 Task Brief — 锁定 Mastra 兼容组合并演示可持久恢复的最小执行 (#473)

You are the backend implementer for ticket ME01. Workspace (work ONLY here):
`/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`, branch `1123786563/mastra-exec`,
BASE `bf64d0f2`. Dependencies installed. **No git commit/push/merge. No issue comments/closes.**

## Required reading (authoritative)

1. `docs/tickets/mastra-agent-execution/issues/me01.md` — the 6 acceptance criteria you must satisfy.
2. `docs/specs/2026-10-19-mastra-agent-execution-migration-design.md` §3 (model governance), §6 (continuation), Testing Decisions.
3. `docs/plans/2026-10-19-mastra-agent-execution-migration.md` §6 (Task 1 HOW — file-level guidance).
4. `server/src/mastra/compatibility.ts` + `server/tests/enterprise/mastra-compatibility.test.ts` — the existing probe and its 3 tests (must keep passing).
5. `docs/adr/0008-test-runner-tester-army-e2e.md` — test runner rules.

## Facts

- Pinned versions (from lockfile; verify in node_modules, do not upgrade): `@mastra/core@1.64.0`, `@mastra/client-js@1.43.0`, `@mastra/memory@1.20.0`, `@mastra/pg@1.25.0`, `@mastra/hono@1.5.0`, `@ag-ui/mastra@1.1.6`, `ai@6.0.264`, `zod ^4.4.3`, Bun 1.4.x.
- Tests run on the **Bun runtime** (driven by e2e; server suites stay on Bun per ADR 0008). Existing server tests import `expect, test` from `../../../tests/support/bun-test-compat` (adjust relative depth for your file).
- The probe already proves: AG-UI text chunk via `getLocalAgents`, **same-process Workflow** suspend/resume, Hono mount, InMemory + Postgres store constructors. It does **not** yet prove Agent tool loop with a custom LanguageModelV3, nor **cross-process Agent resume**.
- A local test Postgres container `openbot-test-pg` runs on host port 5433. Credentials: discover via `docker exec openbot-test-pg printenv | grep POSTGRES` (local introspection only). Do NOT use any `.env`/`DATABASE_URL` — this run must not touch the shared development database. Create a disposable database named `openbot_mastra_me01_<random>` (or dedicated schema), prefer a dedicated restricted role (NOSUPERUSER, NOBYPASSRLS) for the Mastra store connection, and DROP what you created in teardown. If credentials/capability are unobtainable, record the DB-backed criterion as **UNVERIFIED with the exact failure** — never silently skip.

## What to build

1. **Extend `probeMastraCompatibility()`** in `server/src/mastra/compatibility.ts` with new report fields (keep every existing field and the existing 3 tests green):
   - `toolLoop`: an Agent turn where a fake loopback provider (same pattern as the existing provider) first requests ONE tool call, the tool executes exactly once, and the second model step consumes the tool result and returns a final answer. Model = a custom LanguageModelV3 instance passed to the Agent (mirror how the existing probe builds `createOpenAI(...).chat(...)` against the loopback, or wrap a minimal custom v3 model). Count per-step model invocations; assert no provider-string routing, no hidden retry/fallback, and no extra title/summary/embedding calls.
   - `agentSuspendResume`: prove an Agent tool can suspend mid-run and that a **different OS process** resumes the exact pending operation from **persistent storage** (PostgresStore against your disposable database). If `@mastra/core@1.64.0` cannot do agent-level cross-process resume, DO NOT fake it with in-memory or Workflow-only tests: set the capability false, capture the concrete API evidence (file/line of the installed `agent.d.ts`/`tool-approval.d.ts`), and report the blocker. That finding stops ME02.
   - `fullStreamShapes`: sanitized representative chunk samples for text, tool args delta, tool result, error, suspension, terminal.
   - `languageModelVersion` and `packageFingerprint`: exact resolved versions of the packages above + Bun/Node.
2. **Create `server/tests/mastra-agent-resume-process.test.ts`** proving cross-process resume: parent test persists a suspended agent run, spawns a real child process (`spawn("bun", [...])`), the child loads the same storage, resumes the exact pending operation, prints the answer + its PID; parent asserts a different PID and that the operation executed once. Unique DB, teardown drops it.
3. Additional assertions: tool executes once; second step uses result; custom model used every step; suspension emits no success terminal; unknown/corrupt control chunks are rejected (not silently dropped).
4. **RED before GREEN**: write tests first, run and capture the real failure, then implement. Separate report dirs:
   `E2E_UNIT_SCOPE=server E2E_UNIT_OUTPUT=.e2e/mastra-ME01-red bunx e2e run --config e2e.unit.config.ts server/tests/mastra-agent-resume-process.test.ts server/tests/enterprise/mastra-compatibility.test.ts`
   then again with `.e2e/mastra-ME01-green`. Also `bun run --cwd server typecheck` and scoped `bunx biome check <files you touched>`.

## Scope fence

Touch only: `server/src/mastra/compatibility.ts`, `server/tests/enterprise/mastra-compatibility.test.ts`, new `server/tests/mastra-agent-resume-process.test.ts`, and (if truly needed) one new test-support fixture file. Do NOT touch `copilot.ts`, `index.ts`, schema, or any production execution path. ME01 is a compatibility slice: no production routing changes.

## Report contract

Write the full report to `docs/plans/2026-10-19-mastra-execution-run/me01/report.md`: commands + exit codes, actual pass/fail/skip counts, resolved package fingerprint, per-acceptance-criterion verdict (PASS/FAIL/UNVERIFIED + evidence), API findings, files touched with line refs. Return ONLY: STATUS (DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED), one-line test summary, and concerns.
