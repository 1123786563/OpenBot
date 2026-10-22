# ME03 Task Brief — 聊天刷新与附件往返保留完整历史和稳定顺序 (#475)

Workspace (work ONLY here): `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`, branch `1123786563/mastra-exec`, BASE `bf64d0f2`. **No git commit/push/merge; no issue writes.** Prior tickets ME01+ME02 are implemented, independently reviewed and OCR-closed IN THIS WORKING TREE (uncommitted) — build on them; their modules live in `server/src/mastra/` and are covered by `docs/plans/2026-10-19-mastra-execution-run/{me01,me02}/report.md`.

## Required reading (authoritative)

1. `docs/tickets/mastra-agent-execution/issues/me03.md` — the 6 acceptance criteria.
2. `docs/specs/2026-10-19-mastra-agent-execution-migration-design.md` §4 (tools/messages/events), Testing Decisions.
3. `docs/plans/2026-10-19-mastra-agent-execution-migration.md` §9 (Task 4 file map + interfaces + RED case names), §17 (Task 12 client compat), §20 (shared-file order: ConversationService/schema owned T4→T6→T11; frontend contract T3/T6 defined → T12 verifies).
4. `docs/adr/0008` (runner), ADR 0004/0006 (scope isolation).
5. Production seams (read before writing): `server/src/enterprise/conversations/service.ts` (ConversationService, resolveMastraBinding), `server/src/mastra/conversations.ts` + `contracts.ts` + `tenant-storage.ts` (intent/seq/locks, `MastraIntentMessageIdentity`), `server/src/mastra-intent-reconciler.ts`, `server/src/channels/attachments.ts`, `server/src/copilot.ts` (`sanitizeSeededHistory`, `inlineAttachments`, `historyOrEmpty`), ME02's `server/src/mastra/execution.ts` + `stream-events.ts` (where server-rebuilt history enters ExecutionRequest).

## What to build (plan T4 backend + T12 frontend-verification)

### T4 — full-message persistence + authorized history load

New files: `server/src/mastra/message-parts.ts`, `server/src/mastra/conversation-runtime.ts`. Extend (minimally): `server/src/mastra/conversations.ts`, `server/src/enterprise/conversations/service.ts`, `server/src/mastra-intent-reconciler.ts`, and `server/src/enterprise/contracts.ts` ONLY if the internal message interface needs a versioned full-parts representation (public MessageDTO stays compatible).

Frozen interfaces (names from the plan §3; extend, never rename):
```ts
loadExecutionInput(scope: PlatformScope, input: RunAgentInput): Promise<RunAgentInput>;        // history rebuilt server-side; drops client-supplied system/tool history
persistExecutionMessages(binding: ExecutionBinding, messages: readonly Message[]): Promise<void>;  // Message = AG-UI message type; records engine message id -> stable OpenBot message identity
```

Behavior contracts:
- Full parts (text, file/image references, tool-call/result pairs, activity/state/approval metadata) persisted with metadata; the display text projection is NOT the model history.
- One idempotency key → one message intent; output retries do not duplicate; stable seq + pagination; non-finalized content never enters model context (candidate seq invisible until finalized).
- ConversationService stays the ONLY writer for a conversation; Mastra Memory auto-append stays OFF (ME01 evidence: no Memory attached); snapshot persistence and conversation writes are separately managed.
- Attachments: thread + tenant/workspace/personal scope verified BEFORE bytes are read or a download is signed; unknown IDs from another user/team/tenant get the same denial shape (no existence leak). Preserve `sanitizeSeededHistory` and `inlineAttachments` behavior.
- Corrupt/missing history fails explicitly — never fall back to empty history and continue. Cross-system writes use the existing persistent intent + reconciler, never double-write.

### T12 — client compatibility verification (frontend)

Verify the EXISTING app client against the ME02/Mastra-backed runtime: refresh, pagination/reconnect, stop, waiting states. `app/tests/mastra-runtime-compat.test.tsx` (new, driven per manifest regen) covering: `partial_text_and_tool_result_render_once`, `refresh_waiting_approval_can_resume` (UI state only; resume itself is ME05), `stop_targets_current_run`, `reconnect_does_not_duplicate_answer`, `incompatible_legacy_pause_has_clear_next_action`. Fix ONLY real gaps in the client (allowed files: `app/src/components/channels/channel-chat.tsx`, `app/src/lib/copilot/approval-tools.tsx`, `handoff-resume.ts`, `thread-messages.ts`, `stopped-turn.ts` — touch only what a failing test proves broken). Do not redesign UI; server-issued idempotency keys stay authoritative; no browser-held model credentials or client-constructed scope.

## Tests (RED → GREEN; ADR 0008)

Backend: `server/tests/mastra-message-parts.test.ts` (pure conversions) + `server/tests/enterprise/mastra-conversation-runtime.integration.test.ts` (real DB). Minimum case set (names are contract):
`tool_pairs_roundtrip`, `attachment_scope_checked_before_bytes`, `same_input_key_one_intent`, `retry_assistant_output_does_not_duplicate`, `candidate_seq_not_visible_until_finalized`, `other_resource_cannot_read_thread`, plus restart/pending-intent-repair and cross-tenant DB-role isolation (identity matrix: two tenants, two teams, second user).
DB fixtures follow `server/tests/support/me01-fixture.ts` pattern (docker exec psql bootstrap, disposable DB `openbot_me03_<rand>`, restricted role, drop in teardown; NEVER dev `DATABASE_URL`; no `.env` in this worktree). Use `ME01_TEST_PG_PORT=5433` to reach the local test Postgres.

Commands: RED then GREEN `E2E_UNIT_SCOPE=server E2E_UNIT_OUTPUT=.e2e/mastra-ME03-red|.e2e/mastra-ME03-green bunx e2e run --config e2e.unit.config.ts <files>`; after `node scripts/e2e-file-audit.mjs && node scripts/e2e-bun-manifest.mjs` (keep `directoryIslands` + prefix islands — the manifest script now uses lib `groupsOf()`, do not regress it), drive via `E2E_UNIT_SCOPE=tests E2E_BUN_ONLY="<group>" ... tests/bun-suites.test.ts`. All existing mastra suites (48 cases) must stay green: `mastra-agent-resume-process`, `enterprise/mastra-compatibility`, `mastra-stream-events`, `mastra-ag-ui-agent`, `mastra-governed-execution`, `mastra-browser-runner`. `bun run --cwd server typecheck` must add ZERO errors beyond the 3 baseline in `scripts/bootstrap-local-gateway.ts`; scoped `bunx biome check` clean.

## Scope fence

Touch only: the new/extended files above, new test files, manifest regen, and — only when a test proves a real gap — the listed frontend files. Do NOT touch: schema/migration numbering (no new drizzle migration unless strictly required; if required, take the actual next number and record it), approvals, routines, `index.ts`, ME02's governed/stream modules (consume them via imports; changes there need a controller ruling first). ME03 boundary: no legacy-platform full-history import (ME13), no auto long-term memory.

## Report contract

Full report → `docs/plans/2026-10-19-mastra-execution-run/me03/report.md` (commands+exit codes, real pass/fail/skip counts, per-AC verdicts for the 6 criteria with evidence, files+line refs, deviations). Reply with ONLY: STATUS (DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED), one-line test summary, concerns. You may dispatch NO subagents. Be economical with turns.
