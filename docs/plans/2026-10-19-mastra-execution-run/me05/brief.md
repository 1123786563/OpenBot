# ME05 Task Brief — 危险操作与用户问答可持久挂起并准确恢复 (#477)

Workspace (work ONLY here): `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`, branch `1123786563/mastra-exec`, BASE `bf64d0f2`. **No git commit/push/merge; no issue writes.** ME01–ME04 are implemented, independently reviewed and OCR-closed IN THIS UNCOMMITTED TREE (reports: `docs/plans/2026-10-19-mastra-execution-run/me0{1,2,3,4}/report.md`). Build on them.

## Required reading (authoritative)

1. `docs/tickets/mastra-agent-execution/issues/me05.md` — the 7 acceptance criteria.
2. `docs/specs/2026-10-19-mastra-agent-execution-migration-design.md` §5 (lifecycle: waiting_approval vs suspended vs terminal; forbid-list), §6 (continuation & cross-store consistency — THIS is your core spec section), Testing Decisions.
3. `docs/plans/2026-10-19-mastra-agent-execution-migration.md` §3 (T6 continuation interfaces — frozen names below), §11 (Task 6 detail).
4. Installed-API evidence (ME01, reviewed): durable tool suspension engages ONLY via tool-level `requireApproval` (durable toolCallStep); persistence is PostgresStore workflow snapshots; cross-process resume proven by `server/tests/mastra-agent-resume-process.test.ts` via `listSuspendedRuns()` → `resumeStream(resumeData, { runId, toolCallId })`; `approveToolCall`/`declineToolCall` exist on Agent.
5. Existing approvals subsystem to PRESERVE (not replace): `server/src/approvals/**` (store, native-context, question-resume, execute, policy) + `server/tests/approvals-*.test.ts` — deny/expire/revoke semantics are the product authority; ME05 adds the Mastra continuation layer that CONSUMES those decisions.

## Frozen continuation contracts (from the plan §3 — extend, never rename)

```ts
interface ContinuationPayload {
  readonly schemaVersion: 1;
  readonly engine: "mastra";
  readonly packageFingerprint: string;   // from the ME01 probe fingerprint
  readonly kind: "approval" | "question" | "frontend_tool";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly argsDigest: string;           // canonical JSON digest (reuse message-parts canonicalJson)
  readonly snapshotRef: string;          // opaque ref into restricted storage; never keys/capabilities/functions/AbortSignals
}
type ResumeDecision =
  | { kind: "approved"; approvalId: string; argsDigest: string }
  | { kind: "declined"; approvalId: string; reason: string }
  | { kind: "answered"; responseId: string }
  | { kind: "tool_result"; receiptId: string };
interface ClaimedContinuation {
  readonly ref: ResumeRef;               // { continuationId, revision }
  readonly binding: ExecutionBinding;    // execution-contracts.ts
  readonly payload: ContinuationPayload;
  readonly claimToken: string;           // server-only; never logged
}
type ContinuationOutcome = "resumed" | "declined" | "failed_unknown";
```

Produces (names frozen):
- `saveContinuation(binding: ExecutionBinding, payload: ContinuationPayload): Promise<ResumeRef>`
- `claimContinuation(scope: PlatformScope, ref: ResumeRef, decision: ResumeDecision): Promise<ClaimedContinuation>`
- `finishContinuation(claim: ClaimedContinuation, outcome: ContinuationOutcome): Promise<void>`

## What to build

1. **Durable continuation store** — new `server/src/db/schema/mastra-execution-continuations.ts` + migration (take the ACTUAL next drizzle migration number from `server/src/db/drizzle` meta journal; record it) + `server/src/mastra/continuation-store.ts`: rows bound to tenant/workspace/principal/bot/run/attempt/generation + toolCallId + argsDigest + engine fingerprint + protected snapshot ref + revision (CAS) + claim state with expiry + terminal state. JSON-schema v1 validation on payload; claim token unforgeable (HMAC w/ server secret or random + storage-side binding); CAS revision on claim/finish.
2. **Accurate recovery** — new `server/src/mastra/approvals.ts`: on approve/decline/answer/tool_result, verify identity (actor membership), tool grant still valid, argsDigest MATCHES the pending toolCall (tamper → refuse), generation is current, then claim (CAS, single winner) and drive Mastra `resumeStream`/`approveToolCall`/`declineToolCall` against the stored runId. Completed receipts are REUSED (a receipt with the same operationId → return it, never re-execute); unknown external effect → `failed_unknown` + user-visible 待处置, never auto-replay. Refusals: `MASTRA_CONTINUATION_ARGS_MISMATCH`, `_REVISION_CONFLICT`, `_CLAIM_EXPIRED`, `_FINGERPRINT_INCOMPATIBLE`, `_GRANT_REVOKED`, `_GENERATION_STALE` (names contract).
3. **Run lifecycle wiring**: suspension saves the continuation BEFORE publishing the waiting state (never publish recoverable without recovery data); `waiting_approval` vs `suspended` map to the existing product events; suspension never completes the run; resume requires current owner (T8/T9 leaseCurrent injection later must slot in without signature change — design the claim check so a lease probe slots in).
4. Cross-store consistency: approval decision write and continuation claim are two stores — use the revision CAS + idempotent decision ids; a crash between them leaves the decision re-appliable (claim is idempotent on decision id).

## Tests (RED → GREEN; names are contract)

New: `server/tests/mastra-continuations.test.ts` (store unit on the disposable-DB fixture pattern) + `server/tests/enterprise/mastra-continuations.integration.test.ts` (real DB, cross-process + concurrency). Minimum set:
`approval_matches_exact_tool_and_args`, `two_resumers_only_one_claim`, `revoked_source_blocks_resume`, `new_process_can_resume`, `frontend_tool_waits_without_fake_result`, `unknown_external_effect_is_not_replayed`, `completed_receipt_reused_not_reexecuted`, `claim_expiry_requires_receipt_evidence`, `fingerprint_mismatch_isolates_not_executes`, `tampered_args_refused`, `generation_stale_refused`, `crash_between_decision_and_claim_is_reappliable`.
DB fixtures: `docker exec openbot-test-pg psql` bootstrap (`ME01_TEST_PG_PORT=5433`), disposable DB `openbot_me05_<rand>` + restricted role, drop in teardown (pattern: me01/me03 fixtures; never dev `DATABASE_URL`; no `.env`). Cross-process: spawn a real child (`spawn("bun", [...])`) like me01-child.ts.
Existing suites must stay green: approvals-* family, all 6 mastra guard suites, ME03/ME04 suites, app compat. `bun run --cwd server typecheck` = exactly the 3 baseline errors in `scripts/bootstrap-local-gateway.ts`; scoped `bunx biome check` clean; manifest regen only if you add files (islands must survive).

## Scope fence

Touch only: new schema file + ONE new migration, new `continuation-store.ts`/`approvals.ts`, minimal wiring in `server/src/mastra/execution.ts`/`copilot.ts` (suspension save + resume entry — controller pre-approves these two), new test files, fixture. Do NOT touch: existing approvals product semantics, routines/headless (ME09), conversations service (ME03), ME04 tools wrapper (consume it). UI work is NOT in this backend slice (waiting/approval rendering exists; ME05's frontend facet verifies via the existing approval UI tests).

## Report contract

Full report → `docs/plans/2026-10-19-mastra-execution-run/me05/report.md` (commands+exit codes, real pass/fail/skip counts, per-AC verdicts for the 7 criteria with evidence, migration number, files+line refs, deviations). Reply with ONLY: STATUS (DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED), one-line test summary, concerns. No subagents. Be economical with turns.
