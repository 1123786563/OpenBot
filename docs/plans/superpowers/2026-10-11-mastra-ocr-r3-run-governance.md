# Mastra OCR R3 Run Governance Repair Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Close R3's supported workspace/principal isolation and monotonic per-Run usage findings across budget, invocation capability, Run lease, and compatibility gateway paths.

**Architecture:** OpenBot remains authoritative for Run identity, budgets, lease fencing, and settlement. Every operation must prove the trusted tenant/workspace/principal/Run owner; uncertain dispatched usage stays charged at its full bound; gateway output and duration rules are explicit. Execute three serial backend slices with independent validator and review gates.

**Tech Stack:** TypeScript, Bun, Drizzle ORM, PostgreSQL 17, OpenAI/Anthropic-compatible HTTP SSE, Mastra PlanModel.

**Spec:** Approved design docs/superpowers/specs/2026-10-10-mastra-intelligence-migration-design.md section 6; root migration Task 3 in docs/superpowers/plans/2026-10-10-mastra-intelligence-migration.md; OCR adjudication .superpowers/sdd/2026-10-10-mastra-intelligence-migration/reports/adjudication-runtime.md; repair DAG .superpowers/sdd/2026-10-10-mastra-intelligence-migration/ocr-repair-dag.md R3. Prerequisite R2 verified in .superpowers/sdd/2026-10-11-mastra-ocr-r2-schema/progress.md.

## Global Constraints

- Every model call receives a caller-supplied positive maxOutputTokens; no implicit default and no substitution of the Run-wide ceiling.
- All user-triggered synchronous calls share the persisted Run ceiling; every budget and lease mutation checks tenant, workspace, principal, and Run.
- After provider dispatch, ambiguous or missing usage is charged at the full invocation maximum; ordinary operations cannot reduce unknown usage or release consumed usage.
- Confirmed spend never expires. Only an expired capability proven still reserved may be renewed after active Run/attempt validation. Legacy reservations have no dispatch marker and are not automatically released on expiry.
- One model request uses one admission mechanism: budget reservation or capability. Distinct records in both tables remain cumulatively counted. No same-request dual path was observed; if this ruling is wrong, its cost is conservative over-reservation/denial, not under-accounting.
- Gateway timeout policy: non-stream operation and time to provider headers are bounded to 120 seconds by default; finite total stream deadline defaults to 5 minutes and is capped at 15 minutes from provider dispatch. Caller abort applies throughout; no idle timeout. A timed-out dispatched call cancels its reader and settles unknown once. Streams over five minutes require internal configuration; a stalled stream remains bounded.
- Outbox publish diagnostics are assigned to R7; do not edit server/src/enterprise/runs/outbox.ts in R3. Invalid concurrency and attachment-order allegations, low-style items, and conditional claims without evidence remain governed by adjudication.
- No commits, shared database/container changes, stash, reset, push, or merge. Use only a disposable PostgreSQL 17 fixture on guarded 127.0.0.1:5434; never touch 5432 or 5435.

## Review Focus

- Same-tenant callers from another workspace/principal cannot replay an idempotency key or confirm/release another owner's budget.
- A Run ceiling cannot use a custom key or exceed its configured maximum; distinct reservation and capability records both draw down the same ceiling.
- Unknown, consumed, and confirmed usage remain conservative after expiry; only a current active-attempt never-consumed capability can be renewed.
- currentAttempt and expireLease cannot reveal or rotate another owner's Run; renewal uses the configured Run duration.
- Missing/invalid output caps fail before provider dispatch; failed confirmation falls back to one unknown settlement; long but bounded streams and cancellation behave correctly. Runtime stream `type` discriminators that are non-string or contain credentials fail closed: cancel the stream, settle usage as unknown, and do not confirm usage; valid protocol labels remain preserved.

---

### Task 1: Budget reservation and invocation capability invariants

**Depends on:** Verified OCR R2. **Roles:** backend_implementer → fresh backend_validator → independent reviewer. Serial; no commit.

**Files:** Modify server/src/enterprise/models/budget.ts, server/src/enterprise/runs/model-capability.ts, and server/src/enterprise/runs/service.ts (only the canonical ceiling-key use); add a forward-only `0064` grant migration, journal entry, and same-schema fresh-ID/prevId snapshot; modify only budget/capability cases and the minimal platform-conversation fixture prerequisite in server/tests/enterprise/runs.integration.test.ts. Existing fixture setup calls getOrCreate without Mastra storage; current production contract correctly fails closed for new Mastra-backed conversations. Seed each scoped test platform conversation (the shared setup thread and each per-Run thread) through createConversationStore before getOrCreate so Run integration tests exercise their owned Run behavior without weakening the production contract.

**Interfaces:** Consume PlatformScope, BudgetInput, ModelInvocationCapabilityInput, locked Run/attempt fencing, and the two persisted budget tables. Produce one exported helper runCeilingIdempotencyKey(runId: string): string in budget.ts for Run creation and capability issue. Budget lookup/mutation requires the full owner scope. Capability confirmation accepts only a consumed claim; an active-attempt expired reserved same-key issue renews its existing row and returns a new expiry-bound capability.

- [x] Step 1 — RED: Add integration tests named budget reservation idempotency and mutation require exact owner scope; Run creation and capability issue use the same canonical key, and configured maximum is enforced; unknown invocation usage cannot be confirmed downward; expired undispatched capability retries without releasing its ceiling. Assert cross-workspace/principal replay/confirm/release reject without mutation or ID disclosure; custom ceiling key and ceiling above configuredLimitTokens reject; unknown→confirmed and reserved→confirmed reject; an expired reserved same-request capability renews only for the current attempt and identical immutable inputs; expired consumed/unknown remain charged and unavailable. Include a mixed Run with two distinct requests, one reserved through each admission mechanism, and assert their cumulative maximums both consume the same ceiling.
- [x] Step 2 — Confirm RED: Run these named tests on the isolated guarded PostgreSQL fixture, saving failures and exact source hashes. Environment failure is not product RED.
- [x] Step 3 — Implement: Include tenant/workspace/principal ownership in idempotency read and confirm/release SELECT and UPDATE. Force the shared canonical ceiling key and reject its maximum above the configured budget. Preserve serialized Run lock. Renew only an expired reserved capability when Run and active attempt remain current; preserve record ID, owner, route, request ID, generation and maximum; advance expiry so old signed token no longer matches. Do not alter consumed, unknown, confirmed, or legacy reservation rows on expiry. confirmUsage allows consumed→confirmed and same-value confirmed replay only. Keep distinct records cumulatively counted.
- [x] Step 4 — GREEN: Run bun test server/tests/enterprise/runs.integration.test.ts server/tests/enterprise/mastra-model.test.ts server/tests/enterprise/mastra-model.integration.test.ts; all cases execute and pass. Run Biome on owned paths and scoped git diff --check.
- [x] Step 5 — Freeze exact before/after manifest and increment patch. Fresh backend validator repeats relevant DB tests, then independent reviewer returns Spec compliance and code quality. Do not start Task 2 before both gates pass.

**Failure handling:** If expired capability renewal cannot preserve one-use binding, leave the row closed; never refund or reuse consumed/unknown claims. Owner mismatch returns safe not-found/conflict without exposing another owner's data.

### Task 2: Run lease scope and configured renewal duration

**Depends on:** Task 1 verified. **Roles:** fresh backend_implementer → fresh backend_validator → independent reviewer. Serial; no commit.

**Files:** Modify server/src/enterprise/runs/store.ts and server/src/enterprise/runs/service.ts; add lease cases only to server/tests/enterprise/runs.integration.test.ts.

**Interfaces:** Consume trusted PlatformScope and validated RunServiceDependencies.leaseMilliseconds (default 30,000 ms; permitted 1,000–900,000 ms). Produce createRunStore(data, { leaseMilliseconds }); currentAttempt and expireLease enforce exact owner scope; lease renewal uses the same duration as Run start.

- [x] Step 1 — RED: Add current attempt and lease expiry hide runs from another workspace or principal and expired attempt renewal uses configured run lease duration. Forged same-tenant scopes must reject safely and leave generation, attempt status and lease timestamps unchanged. With authorized expired attempt and a nondefault duration of 90,000 ms, Run and next attempt expire at supplied test now + 90,000 ms, not a fixed 30 seconds.
- [x] Step 2 — Confirm RED on the isolated fixture and record exact failures/hashes.
- [x] Step 3 — Implement tenant/workspace/principal predicates on Run loads and conditional updates; preserve row locks/fencing. Pass the one already validated duration into createRunStore; default 30,000 and cap 900,000 as RunService already does. Do not add a per-call override bypassing service validation.
- [x] Step 4 — GREEN: Run server/tests/enterprise/runs.integration.test.ts; all tests pass. Run Biome on owned paths and scoped diff check.
- [x] Step 5 — Freeze Task 2 increment against Task 1 verified checkpoint; fresh validator and reviewer pass before Task 3.

**Failure handling:** If expireLease has no production consumer, keep its existing exported/tested behavior scoped and configured without creating a new external API. Do not alter outbox or capability lease semantics here.

### Task 3: Explicit gateway output, settlement, and bounded stream duration

**Depends on:** Tasks 1 and 2 verified. **Roles:** fresh backend_implementer → fresh backend_validator → independent reviewer. Serial; no commit.

**Files:** Modify server/src/enterprise/models/gateway.ts and server/tests/enterprise/model-gateway.test.ts.

**Interfaces:** Consume ModelInvocationContext.maximumTokens only as the Run ceiling, caller-supplied max_tokens, confirmUsage, markUnknown, and Request.signal. Produce positive explicit per-invocation max_tokens validation; requestTimeoutMs default 120,000 ms; streamTimeoutMs default 300,000 ms, capped at 900,000 ms; a single settlement coordinator falling back from failed confirmation to one markUnknown attempt; finite stream cancellation and unknown settlement.

- [ ] Step 1 — RED: Add missing output limit is rejected before provider dispatch; confirmation failure marks usage unknown once for JSON and SSE; stream may outlive the connection deadline after headers; stream deadline cancels and marks unknown once; caller abort applies through the entire stream. Missing/zero/fractional/negative max_tokens returns safe 400 before route/credential/provider access. Valid request forwards exactly caller cap, bounded by Run ceiling. Synthetic JSON and SSE confirmation rejection calls markUnknown once and keeps errors safe. Synthetic reader plus injectable small timers/fake clock proves a healthy stream may outlive the header deadline, while total deadline or caller abort cancels reader and marks unknown once. Non-string and credential-bearing runtime stream type tags fail closed, cancel, settle unknown once, and never confirm; valid protocol type tags are preserved.
- [ ] Step 2 — Confirm RED with deterministic synthetic providers; record assertion failures/source hashes. No live providers.
- [ ] Step 3 — Implement: remove context.maximumTokens as output fallback; require caller cap. Keep whole non-stream and provider-header timeout at 120 seconds; cancel the header timer after headers. Start a separately finite total stream timer immediately before provider dispatch (300 seconds default, 900 seconds max); compose request cancellation through both phases. Use the same policy for PlanModel and provider SSE. Timeout/abort after dispatch cancels upstream reader and settles unknown once. Failed usage confirmation triggers one conservative markUnknown attempt; never release dispatched claim.
- [ ] Step 4 — GREEN: Run bun test server/tests/enterprise/model-gateway.test.ts server/tests/enterprise/mastra-model.test.ts server/tests/enterprise/mastra-model.integration.test.ts; all execute and pass. Run Biome, bun run --filter server typecheck (report any pre-existing unowned error precisely), and scoped diff check.
- [ ] Step 5 — Freeze exact hashes/patch; fresh backend validator and reviewer pass. Preserve all three task packages in the repair workspace.

**Failure handling:** Use deterministic provider/network fakes. On non-stream confirmation failure return the existing safe failure response after unknown fallback. Invalid runtime stream discriminators follow the same post-dispatch unknown settlement and cancellation policy. If SSE headers are already sent, terminate body without exposing settlement errors. Outbox diagnostics remain R7 work.
