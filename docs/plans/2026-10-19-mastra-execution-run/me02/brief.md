# ME02 Task Brief — 现有聊天入口通过 Mastra 完成受预算约束的文本回答 (#474)

Workspace (work ONLY here): `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`, branch `1123786563/mastra-exec`, BASE `bf64d0f2`. **No git commit/push/merge; no issue writes.**

## Required reading (authoritative)

1. `docs/tickets/mastra-agent-execution/issues/me02.md` — the 7 acceptance criteria.
2. `docs/specs/2026-10-19-mastra-agent-execution-migration-design.md` §1–§5 (authority split, main seam, model governance, events, lifecycle), Testing Decisions.
3. `docs/plans/2026-10-19-mastra-agent-execution-migration.md` §3 (frozen interfaces + file map), §7 (T2), §8 (T3), §10 (T5), §14 (T8), §20 (shared-file order).
4. `docs/adr/0008` (test runner), `docs/adr/0001/0003` (bounds, admission), `docs/adr/0010`.
5. ME01 deliverables already reviewed: `server/src/mastra/compatibility.ts` (`agentToolLoop`, `agentExecution` probe), `server/tests/support/me01-fixture.ts` (loopback provider + counting model + disposable DB pattern), `server/tests/mastra-agent-resume-process.test.ts`.
6. Existing production seams (read before writing): `server/src/copilot.ts` `builtInAgentConfiguration` (~L2136), `buildAgents`/`buildAgent` (~L2420/2795), `resolveRuntimeAgents` (~L3931), `mountCopilotRuntime` (~L4183); `server/src/agents/agent-resolver.ts` (`AgentResolutionContext.governedModel`); `server/src/enterprise/runs/governed-execution.ts` (`GovernedModelRequest`, `GovernedModelExecution`); `server/src/enterprise/runs/runner.ts` (admission→lease→relay→settle, `RelayedRunState`); `server/src/enterprise/models/ai-sdk-v3-gateway-adapter.ts`.

## ME01 facts you build on (verified, reviewed)

- `@mastra/core@1.64.0`: `Agent.stream(messages, { runId })` → `MastraModelOutput` with `fullStream` (ReadableStream), `finishReason` (`'stop'|'suspended'|'error'`), `text`, `suspendPayload`. Chunk types observed: `start, step-start, text-start, text-delta, text-end, tool-call-input-streaming-start, tool-call-delta, tool-call-input-streaming-end, tool-call, tool-result, step-finish, finish, error`.
- A custom LanguageModelV3 proxy works as the Agent `model`; a counting wrapper proves per-step usage.
- Agent tool suspension engages only through the durable toolCallStep (`requireApproval`) — not needed for ME02 (text-only).
- Test partition: suites importing `tests/support/bun-test-compat` are driven; regenerate the manifest with `node scripts/e2e-file-audit.mjs && node scripts/e2e-bun-manifest.mjs` after adding files. Isolated worktree has NO `.env`: never use dev `DATABASE_URL`; DB tests create disposable DBs via `docker exec openbot-test-pg psql` (see me01-fixture).

## What to build (ticket-internal order T2 → T3 → T5 → T8)

### T2 — execution contracts + instructions (new `server/src/mastra/execution-contracts.ts`, `instructions.ts`, `execution.ts`)

Freeze these names exactly (later tickets extend, never rename):

```ts
interface ExecutionBinding {
  readonly scope: PlatformScope;        // from ../enterprise/contracts
  readonly botId: string;
  readonly runId: string;               // OpenBot identity
  readonly attemptId: string;
  readonly generation: number;
  readonly executionKey: string;        // server-generated, maps to Mastra runId
}
interface ResumeRef { readonly continuationId: string; readonly revision: number; }
interface ExecutionRequest {
  readonly binding: ExecutionBinding;
  readonly input: RunAgentInput;        // history rebuilt server-side (ME03 deepens this)
  readonly instructions: readonly string[];
  readonly tools: readonly GrantedTool[];   // ME02: usually empty (text-only slice)
  readonly governedModel: GovernedModelRequest;
  readonly resume?: ResumeRef;          // unused in ME02; typed for later tickets
  readonly signal: AbortSignal;
}
type ExecuteMastra = (request: ExecutionRequest) => Observable<BaseEvent>;  // BaseEvent from @ag-ui/core
```

- `buildInstructions(parts: readonly string[]): string` — compose existing role, standing instructions, `PROVENANCE_GUIDANCE`, `UNTRUSTED_GUIDANCE` (import from `copilot.ts` or extract if not exported; do not duplicate text). Client `context`/`forwardedProps` must never override the trusted role.
- `execution.ts`: one execution instance per call/subscription; builds a Mastra `Agent` per request with the injected governed model; consumes `request.signal` before model/tool starts. No auto retry/fallback/title/summary/embedding: construct the Agent with `maxRetries: 0` equivalent on the model path and do not attach Memory (ME01 evidence: Memory triggers hidden model calls).

### T3 — stream normalization to AG-UI (new `server/src/mastra/stream-events.ts`, `ag-ui-agent.ts`)

- Map observed chunk types → existing canonical events: `RUN_STARTED`, `TEXT_MESSAGE_START/CONTENT/END`, `TOOL_CALL_START/ARGS/END/RESULT` (stable message/call IDs), error → `RUN_ERROR` (vendor text stays untrusted/wrapped), `finish` → terminal only. Preserve ME02 contract: `suspension has no success terminal`; `error never becomes success`; stream ending without a terminal is a failure, not success.
- Unknown control chunk semantics: reject (fail the run) rather than silently drop; non-control diagnostic chunks go on an explicit allow-list (derive it from the ME01 type list).
- `createMastraAgUiAgent(execute: ExecuteMastra, binding: ExecutionBinding): AbstractAgent` — returns the AbstractAgent the existing runtime/runner consumes; clone keeps the same binding and abort wiring, never copies a live subscription.
- Distinguish Mastra engine finish, OpenBot product completion, and transport end. The adapter NEVER cancels the business Run on unsubscribe (existing runner owns lease/stop).

### T5 — governed model only (new `server/src/mastra/governed-agent.ts`; touch `execution.ts` only)

- `executeGovernedMastra: ExecuteMastra` — the ONLY model injected is `request.governedModel.model` (the existing gateway adapter); `maxOutputTokens` from `governedModel`; `markConsumed()` semantics preserved (runner checks it).
- Never construct provider clients from strings; no client-visible route/credential fields; `forwardedProps` cannot select engine/route/run identity (server-side engine selection only).
- Reuse existing settlement: do not read Mastra usage as authoritative; gateway adapter confirmUsage/markUnknown rules stay. Malformed usage / 402 budget refusal must surface as run failure with the existing failure codes (`classifyGovernedRunFailure` markers stay intact).
- Subscription/API-credit paths: do not change payer selection; subscription path keeps its PlanModel contract (compat test only; do not rewire).

### T8 — wire the browser entry behind server-side engine selection (modify `copilot.ts`, `agents/agent-resolver.ts` minimally)

- `builtInAgentConfiguration` gains a server-selected Mastra path: when a server-side flag/config resolves this Bot+run to the `mastra` engine, return an agent built from `createMastraAgUiAgent(...)` using the same `governedModel`, prompt parts, and attribution — the governed Runner keeps admission, lease, persist-before-publish, settle-then-complete, and exact stop. The legacy BuiltInAgent path stays for non-selected scopes (no removal in this ticket; ME16 removes it).
- Default remains the existing engine: the Mastra path activates only where a server config/test assembly selects it. Do not flip global defaults.
- Keep every existing export/behavior; positional-argument discipline in this file is strict (see its own comments).

## Tests (RED → GREEN; driven/native per ADR 0008)

New files: `server/tests/mastra-stream-events.test.ts`, `server/tests/mastra-ag-ui-agent.test.ts`, `server/tests/mastra-governed-execution.test.ts`, `server/tests/mastra-browser-runner.test.ts`; extend `server/tests/enterprise/runner-production.test.ts` only if assembly requires.

Minimum case set (names are contract):
- stream-events: `text_chunks_normalize_to_content`, `error_never_becomes_success`, `suspension_has_no_success_terminal`, `missing_terminal_is_failure`, `unknown_control_chunk_rejects`.
- ag-ui-agent: `clone_keeps_binding_and_abort`, `unsubscribe_does_not_cancel_run`.
- governed: `two_steps_issue_distinct_capabilities`, budget 100→70 leaves ≤30 next step, `budget_402_no_retry`, `malformed_usage_no_clean_finish`, `client_route_override_inert`, `subscription_never_falls_back_from_credit_refusal`.
- browser-runner (mounted Hono/CopilotSseRuntime + fake loopback provider, real admission/lease path): `authorized_browser_run_uses_mastra`, `forged_run_and_model_ignored`, `event_append_failure_prevents_success`, `suspended_run_not_completed`, `stale_attempt_cannot_complete`, `disconnect_does_not_product_cancel`.
- Two users on one logical Bot: no instruction/model/credential/message cross-talk (`two_users_no_context_cross_talk`).

Commands: RED then GREEN with `E2E_UNIT_SCOPE=server E2E_UNIT_OUTPUT=.e2e/mastra-ME02-red|.e2e/mastra-ME02-green bunx e2e run --config e2e.unit.config.ts <your files>`; driven groups after manifest regen via `E2E_UNIT_SCOPE=tests E2E_BUN_ONLY="<group>"`. Existing suites that must stay green: `copilot.test.ts`, `enterprise/runner-production.test.ts`, `enterprise/mastra-compatibility.test.ts`, `mastra-agent-resume-process.test.ts`. Also `bun run --cwd server typecheck` (only the 3 pre-existing `scripts/bootstrap-local-gateway.ts` errors are baseline) and scoped `bunx biome check`.

## Scope fence

Touch only: new `server/src/mastra/{execution-contracts,instructions,execution,stream-events,ag-ui-agent,governed-agent}.ts`; minimal edits to `server/src/copilot.ts` + `server/src/agents/agent-resolver.ts` for the server-selected engine path; new test files; manifest regen. Do NOT touch schema, conversations service, approvals, routines, `index.ts` boot assembly, or remove any legacy path. DB fixtures follow the me01-fixture pattern (disposable DB, restricted role, drop in teardown). If a required existing symbol is not exported, prefer a narrow export over duplication, and record it in the report.

## Report contract

Full report → `docs/plans/2026-10-19-mastra-execution-run/me02/report.md` (commands, exit codes, real pass/fail/skip counts, per-AC verdicts for the 7 criteria with evidence, files+line refs, deviations). Reply here with ONLY: STATUS (DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED), one-line test summary, concerns. You may dispatch NO subagents.
