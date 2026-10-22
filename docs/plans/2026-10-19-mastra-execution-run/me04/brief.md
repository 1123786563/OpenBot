# ME04 Task Brief — Bot 通过本人授权的连接器工具完成多步工作 (#476)

Workspace (work ONLY here): `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`, branch `1123786563/mastra-exec`, BASE `bf64d0f2`. **No git commit/push/merge; no issue writes.** ME01–ME03 are implemented, independently reviewed and OCR-closed IN THIS UNCOMMITTED TREE (reports under `docs/plans/2026-10-19-mastra-execution-run/me0{1,2,3}/`). Build on them; do not redo them.

## Required reading (authoritative)

1. `docs/tickets/mastra-agent-execution/issues/me04.md` — the 6 acceptance criteria.
2. `docs/specs/2026-10-19-mastra-agent-execution-migration-design.md` §3 (model governance incl. the 100→70→30 budget example), §4 (tools: grant/policy/audit, untrusted wrapping, operationId), Testing Decisions.
3. `docs/plans/2026-10-19-mastra-agent-execution-migration.md` §7 (T2 tools.ts), §10 (T5 multi-step governed), §3 frozen interfaces.
4. Production seams (read before writing): `server/src/plugins/tools.ts` (GrantedTool: schema/execute already flowing through grant→policy→credential→audit) and `server/src/plugins/selection.ts` (tool filtering — reuse read-only); ME02's `server/src/mastra/execution.ts` (ExecutionRequest.tools — currently unused; text-only refusal `MASTRA_TEXT_ONLY_SLICE` in copilot.ts must be superseded by this ticket), `governed-agent.ts` (per-step capability + binding checks; controller pre-approved extending this file's binding-issuance pattern), `stream-events.ts` (tool chunks incl. `tool-error`→RUN_ERROR already handled; `tool-calls` finish reason currently treated as non-terminal like suspended), `server/tests/mastra-governed-execution.test.ts` (existing 100→70→≤30 capability math), me01-fixture (loopback provider with tool_call scripting + counting wrapper).

## What to build (plan T2 tools + T5 multi-step)

### 1. Controlled tool wrapping — new `server/src/mastra/tools.ts`

`createMastraTools(tools: readonly GrantedTool[]): Record<string, Tool>` (Tool from `@mastra/core/tools`): wrap each GrantedTool's schema/execute as a Mastra tool preserving initiator + call ID; the wrapped execute MUST call the original GrantedTool execute so every call still passes the existing grant→policy→credential→audit path (never mount raw MCP tools; discovery ≠ grant). Reserved-name/invalid-name collisions and unknown tools are explicit named refusals; vendor errors keep their untrusted wrapping semantics (reuse the existing marking used by stream-events/markUntrusted where applicable); external results enter context only as persisted receipts or real results. Operation identity: one operationId + argsDigest per logical operation; retries/recovery keep the same operationId (ME05 builds on this).

### 2. Multi-step governed loop — extend `server/src/mastra/execution.ts` + `governed-agent.ts`

- When `ExecutionRequest.tools` is non-empty, wire the wrapped tools into the per-run Mastra Agent (per-call instance; no cross-binding sharing) and REMOVE the text-only refusal for tool-carrying Bots selected onto mastra (update `MASTRA_TEXT_ONLY_SLICE` in copilot.ts to fire only for the genuinely unsupported surface it was protecting — keep failing closed for learned-skills/computer-guidance paths until ME06/ME08, and keep any selector-level exclusion consistent).
- The model loop cap stays at the existing 8 steps: reaching the cap yields a real terminal with a truthful reason (map to `length`-style finish semantics already in stream-events — never fabricate a complete success).
- Every step already re-issues its own capability via the governed model (ME02 tests prove 100→70→≤30); extend tests to the tool-loop shape: step1 tool-call (capability #1), tool executes exactly once through the wrapped grant/policy/audit path, step2 consumes the result (capability #2 ≤ remaining). Budget refusal is terminal — no retry, no route/payer switch.
- Revocation/owner-loss: before each external tool execution, re-check grant validity (the GrantedTool execute path already re-checks; assert it) and that the run's lease/owner is still current — after `stop`/revocation no NEW external call may start (hook the existing abort signal + a lease-current check; reuse the runner's fencing rather than inventing a second one).
- `tool-calls` finish reason: now becomes reachable mid-loop — keep it non-terminal (no success) exactly as stream-events already does; the loop continues. `tool-error` keeps mapping to RUN_ERROR.

### 3. Tests (RED → GREEN; names are contract)

New `server/tests/mastra-tools.test.ts` (wrapper unit) + `server/tests/mastra-governed-tools.test.ts` (loop integration on the me01/me03 fixture pattern; DB via docker exec psql bootstrap only where receipts/grants need a real store):
`granted_tool_executes_once`, `ungranted_tool_is_absent`, `two_bindings_do_not_share_tools_or_prompt`, `vendor_error_remains_untrusted`, `reserved_name_collision_refused`, `each_step_issues_distinct_capability`, `budget_100_70_next_le_30`, `budget_402_no_retry_no_route_switch`, `tool_loop_cap_eight_truthful_terminal`, `revoked_grant_blocks_new_external_call`, `lost_lease_blocks_new_external_call`, `operation_receipt_associated_once`. Existing suites must stay green: all 6 guard suites + ME03's message/conversation suites + app compat tests. `bun run --cwd server typecheck` adds ZERO errors beyond the 3 baseline (`scripts/bootstrap-local-gateway.ts`); scoped `bunx biome check` clean. Manifest regen only if you add files (`directoryIslands` + prefix islands must survive — the script reuses lib `groupsOf()`; do not regress).

## Scope fence

Touch only: new `server/src/mastra/tools.ts`, new test files, minimal extensions to `execution.ts`/`governed-agent.ts`/`stream-events.ts` (tool-loop enablement — pre-approved pattern) and the `MASTRA_TEXT_ONLY_SLICE` refusal in `copilot.ts`. Read-only reuse of `plugins/tools.ts`/`selection.ts`. Do NOT touch: schema/migrations, approvals/continuation (ME05), routines/headless (ME09+), `index.ts`, conversation runtime (ME03). DB fixtures follow the me01/me03 pattern (disposable DB, restricted role, drop teardown; never dev `DATABASE_URL`; no `.env`; `ME01_TEST_PG_PORT=5433`).

## Report contract

Full report → `docs/plans/2026-10-19-mastra-execution-run/me04/report.md` (commands+exit codes, real pass/fail/skip counts, per-AC verdicts for the 6 criteria with evidence, files+line refs, deviations). Reply with ONLY: STATUS (DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED), one-line test summary, concerns. You may dispatch NO subagents. An OCR over the current tree may be running concurrently — ignore unrelated `docs/plans/**` churn and never edit files outside your fence. Be economical with turns.
