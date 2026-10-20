# OCR Round-1 Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement one assigned Task at a time. Steps use checkbox (`- [ ]`) syntax for tracking. The coordinator dispatches independent validation and Review per Task.

**Goal:** Repair every valid High/Medium finding from OCR rounds r1–r3 (workspace + committed-range review of the full Mastra migration delivery) through the standard SDD loop; lows are fixed only opportunistically inside files a task already owns.

**Architecture:** Four serial repair waves with disjoint file ownership: R1 migration tooling/config, R2 conversations/tenancy hot path, R3 run lease/terminalization core (the two High correctness defects), R4 observability/robustness smalls. Each wave owns its before/after checkpoint, RED→GREEN, scoped Biome/typecheck and passes independent validation + Spec/quality review before the next wave.

**Tech Stack:** TypeScript, Bun, Drizzle SQL builder, postgres.js, synthetic DB-free tests.

**Spec:** `docs/specs/superpowers/2026-10-11-mastra-intelligence-only-design.md`; OCR reports `.superpowers/sdd/2026-10-13-mastra-ocr-t2gov/reports/ocr-r{1,2,3}-workspace.txt` and `ocr-r1-base-to-head.txt`.

## Global Constraints

- Exact workspace `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`; detached HEAD `b1532dbe4ec4d2e64b58fd31c57a7c1863ffd155`; uncommitted-checkpoint strategy.
- No commit/stage/stash/reset/rebase/merge/push/PR/publish/worktree removal; no local/production database access, service operation, migration run or isolated DB probe. DB-free synthetic tests only; PostgreSQL acceptance stays unverified.
- Preserve every file NOT owned by the current task at its frozen hash. In particular the T2-GOV frozen checkpoints are baselines, and editing them is allowed ONLY for tasks in THIS plan that name the file in Files.
- TDD: named RED case first with saved full output; smallest implementation; GREEN with exact suites; scoped `bunx biome check`; `git diff --check`; `bun run typecheck` with only the known baseline `scripts/enterprise-runtime-probe.ts(63,26) TS2345` and zero owned-file diagnostics.
- Serial execution order R1 → R2 → R3 → R4 (shared worktree; R3 and R4 both touch `runs/store.ts`).
- Do not weaken any reviewed fail-closed semantics: unknown usage is never confirmed; a failed Run never becomes succeeded; refusal codes stay fixed; remote stays `REMOTE_RUN_BUDGET_UNVERIFIED`.

## Review Focus

1. A stream longer than the request lease stays live: renewal extends the request lease AND the run/attempt main leases, the renewed lease is propagated into the fenced settlement path (exact `expiresAt` equality), and renewal loss fails closed (HIGH-2).
2. No path leaves a Run permanently active: disconnect, terminal-less completion, lease-acquire failure and crashed processes all terminalize truthfully or become reclaimable; a live-leased run still conflicts (HIGH-3).
3. `drizzle-kit generate` can never see `enterprise_expert_versions` as absent (HIGH-1).
4. Classification uses structured codes with text matching only as fallback; drift vs infrastructure faults are distinguishable in logs.
5. Conversations/tenancy hot path holds no advisory lock during external I/O, preserves error causes, and does not serialize per-member transactions.

## Finding adjudication (recorded rulings)

| ID | Severity | Location | Validity | Disposition |
| --- | --- | --- | --- | --- |
| H1 | high | server/drizzle.config.ts:37 schema list missing enterprise-expert-versions.ts | valid (verified: file exists, exported by schema/index.ts, absent from list) | R1 |
| H2 | high | runs/runner.ts:399 lease never renewed during streaming; renewRequestLease has no production caller; run main lease fixed at creation | valid (verified: no callers; renew caps at never-extended run.leaseExpiresAt) | R3 |
| H3 | high | runs/runner.ts:630 terminal settlement lacks fallback; ACTIVE_RUN_CONFLICT ignores lease; no sweeper | valid (verified: store.ts:390-400 predicate, expireLease unused) | R3 |
| M-a | medium | conversations/service.ts:477 getStore probe inside advisory-lock transaction | valid | R2 |
| M-b | medium | conversations/service.ts:489 catch swallows cause | valid | R2 |
| M-c | medium | tenancy/store.ts:172 serial per-candidate transactions (N+1) | valid | R2 |
| M-d | medium | agents/runtime-agents.ts:51 classification failure silently swallowed | valid | R4 |
| M-e | medium | scripts/migration-runner.ts:202 caret-range deps vs 3.4.9 shim assumptions | valid; fix = runtime fail-fast assertion (bun.lock already pins installs; exact-pinning package.json rejected to avoid lockfile churn in a no-install workspace) | R1 |
| M-f | medium | scripts/migration-runner.ts:104 undocumented 65/66 boundary | valid | R1 |
| M-g | medium | scripts/migration-runner.ts:110 no `when` monotonicity guard at boundary (fresh-DB fail-open) | valid | R1 |
| M-h | medium | runs/runner.ts:260 STALE substring matching | valid | R3 |
| M-i | medium | runs/service.ts:265 stop input validation weak/asymmetric | valid | R3 |
| M-j | medium | runs/governed-execution.ts:246 rebind catch folds infra faults into silence | valid | R4 |
| M-k | medium | runs/governed-execution.ts:116 failure classification by text includes() | valid | R4 |
| M-l | medium | runs/events.ts:389 subscribe polls inside transaction from afterSeq 0 | valid; fix = non-transactional read-only replay path (cursor-resume API deferred — requires client contract change) | R4 |
| M-m | medium | runs/runner.ts:433 stop has no AbortSignal linkage to executing stream | valid | R3 |
| M-n | medium | runs/request-context.ts dead file | INVALID — false positive: copilot.ts:61-104 imports and wraps run/connect with withRunnerRequestContext/currentRunnerRequest | not fixed |
| L-* | low | see OCR r1/r2/r3 reports | valid but low | fixed only when file already owned (R1: advisory-key comment, 55P03 redundancy; R2: routes dead branch, 503 unions, tenancy DATA_DATABASE_UNAVAILABLE classification, typed matches; R3: contracts inline import hoist; R4: events schemaVersion passthrough + cursor typeof guard, store dead export + naming, model-route-catalog cause, governed-execution lease dead field). Deferred: drizzle 0070/0071 REVOKE/style (frozen migration checkpoints, zero current exposure; belong to the DB-gated wave), copilot prompt duplication/factory/doc comments, agent-resolver duplication, events cursor-resume, 0068 retention policy, service lease-validator extraction — all recorded in Ledger for follow-up. |

---

### Task R1: Migration tooling repairs

**Role:** backend_implementer / backend_validator / independent reviewer.

**Files:**
- Modify: `server/drizzle.config.ts` (baseline `137c09b3ab40ca98d82ee75e5d39566f94fbf29d54e1ea797d64351dd2b07d52`)
- Modify: `server/scripts/migration-runner.ts` (baseline `bb7460d1c7c8399c20cc7ce5b1d2b3c25385326767a0621004c573f4d48eec0d`)
- Test: `server/tests/enterprise/migration-entrypoints.test.ts` (extend; baseline recorded at preflight)
- Create: `server/tests/enterprise/migration-runner-guard.test.ts` (DB-free unit tests for pure guards)

**Consumes:** journal shape `Array<{ idx, tag, when, … }>` (migration-runner.ts:20); schema list convention documented at drizzle.config.ts:13-19.

**Produces:** no interface changes visible to other waves.

- [ ] **Step 1 — RED.** In `migration-runner-guard.test.ts` (new): export guards via the script's testable seam (extract pure functions if needed, keeping CLI behavior identical): (1) `schema list covers every file in src/db/schema` — read `server/drizzle.config.ts` and `src/db/schema/*.ts` from the test, assert every schema file appears in the list (fails today on `enterprise-expert-versions.ts`); (2) boundary guard: prefix entries with `when >= entries[66].when` throw (feed a synthetic journal with regression; expect throw; ordered journal passes); (3) reserve() precondition: an object already exposing `options` or `begin` is rejected by the pinning helper. In `migration-entrypoints.test.ts` extend with: config list parity assertion (same as (1) at import level if reachable). Run `bun test tests/enterprise/migration-runner-guard.test.ts tests/enterprise/migration-entrypoints.test.ts` — expect nonzero exit; save full output.
- [ ] **Step 2 — drizzle.config.ts (H1).** Add `"./src/db/schema/enterprise-expert-versions.ts",` to the schema array immediately before the enterprise-model-routes entry, preserving the comment block above it.
- [ ] **Step 3 — migration-runner guards (M-e/M-f/M-g + lows).** (a) Extract `const validationBoundaryIndex = 65;` and replace the four literals (`idx === 65`, `idx === 66` adjacency uses `validationBoundaryIndex + 1`, `entry.idx <= validationBoundaryIndex`, `file.index <= validationBoundaryIndex`); add the design-intent comment from OCR r3 (`// The validation boundary: migrations through index 65 run first …`). (b) After the position65/66 adjacency check, add the `when` guard: every prefix entry must have `when < journal.entries[position66].when`, else throw the OCR-suggested error naming the drizzle created_at/folderMillis skip semantics. (c) Before `Object.assign(reserved, …)` in the pinning path, fail fast when `Object.hasOwn(reserved, "options") || Object.hasOwn(reserved, "begin")` with the OCR-suggested message. (d) Add the advisory-lock key provenance comment above `migrationLockKey` (no behavior change). (e) Simplify `sqlStateFromError(error, "55P03") !== "55P03"` to `=== undefined` form (low).
- [ ] **Step 4 — GREEN + static.** `bun test tests/enterprise/migration-runner-guard.test.ts tests/enterprise/migration-entrypoints.test.ts` exit 0; scoped `bunx biome check` on the three owned files; `git diff --check`; `bun run typecheck` baseline-only. Do NOT run any migration command (no DB).
- [ ] **Step 5 — Freeze.** Before/after bytes + hashes, task increment patch, logs, protected comparison under `.superpowers/sdd/2026-10-14-mastra-ocr-r1-repair/task-r1/`; report with RED/GREEN exit codes.

### Task R2: Conversations/tenancy hot-path repairs

**Role:** backend_implementer / backend_validator / independent reviewer.

**Files:**
- Modify: `server/src/enterprise/conversations/service.ts` (baseline `0616a8f0a2979e596d5505282f0e812d691d5ae98a0babb3fb61aed17b4fea0b`)
- Modify: `server/src/enterprise/conversations/routes.ts` (baseline `1afa21d4de375244be50957ef8deac240fc5588198bae670027fb3b6ec916c87`)
- Modify: `server/src/enterprise/tenancy/store.ts` (baseline `2aba9121d5780db946b6c8f7749f1ebf6b7859da23b2a539451b73545fe27303`)
- Test: extend the existing DB-free conversations/tenancy suites (locate at preflight, e.g. `server/tests/enterprise/` conversation/tenancy tests) and add focused cases there.

**Consumes:** `mastraStorage.getStore` (idempotent, cached); `store.transaction(scope, fn)` advisory-lock semantics; `errorResponse` prefix mapping in routes.ts.

**Produces:** no interface changes visible to other waves.

- [ ] **Step 1 — RED.** Focused DB-free cases: (1) `probe_runs_before_conversation_transaction` — the Mastra probe executes before `store.transaction` begins (assert via synthetic service spying call order: probe called, then transaction opened; fails today with probe inside); (2) `probe_failure_preserves_cause_and_logs` — thrown `MASTRA_STORAGE_UNAVAILABLE` carries `cause` equal to the original error (fails today: no cause); (3) `member_candidates_resolve_in_parallel` — synthetic `data.transaction` returns pending promises tracked by a gate; resolution of two candidates must overlap (fails today: strictly serial); (4) `matches_array_is_typed` — compile-time only (tsc). Run the suites; save nonzero output.
- [ ] **Step 2 — Implement.** (a) Hoist the `mastraStorage.getStore` probe above `store.transaction(scope, …)` in the create path (M-a): move the existing try/catch block, keeping identical binding arguments; throw the same `MASTRA_STORAGE_UNAVAILABLE` Object.assign error but from (b). (b) In that catch, bind `cause` and emit one structured `console.error("MASTRA_STORAGE_PROBE_FAILED", …)` without message contents of the cause beyond its constructor/code (M-b; match the repository's structured-error style used in runtime-agents/buildAgents). (c) In tenancy `resolveForThread`: replace the serial `for (const candidate of candidates) { await data.transaction(...) }` loop with `const foundList = await Promise.all(candidates.map((candidate) => data.transaction(async (tx) => { …same body… })));` then fold into `matches` (M-c); type `matches` explicitly as the OCR-suggested shape (low); classify `data.transaction` execution failures inside `resolveForThread` as `DATA_DATABASE_UNAVAILABLE` (low) — wrap only the directory/match transactions, not `requireAuthenticatedIdentity` path, and do not swallow the cause (attach it). (d) routes.ts: delete the unreachable `message === "MASTRA_STORAGE_UNAVAILABLE"` branch (low) and extend the two `/:threadId/messages` handler status unions to include `503` (low).
- [ ] **Step 3 — GREEN + static.** Full conversations + tenancy DB-free suites (preflight-list them), scoped Biome, `git diff --check`, typecheck baseline-only.
- [ ] **Step 4 — Freeze.** Checkpoint under `.superpowers/sdd/2026-10-14-mastra-ocr-r1-repair/task-r2/` with full artifacts + report.

### Task R3: Run lease renewal and terminal fallback (HIGH-2, HIGH-3)

**Role:** backend_implementer / backend_validator / independent reviewer.

**Files:**
- Modify: `server/src/enterprise/runs/runner.ts` (baseline `1f6d2cd59faf2a6f24350bca77a8d6fba20c030acaf8ad069f562b8d7fb91d5e`)
- Modify: `server/src/enterprise/runs/service.ts` (baseline `9f947a82a496933afd8613409868966503eb40728dcbbafa3b7636fd2bf51cde`)
- Modify: `server/src/enterprise/runs/store.ts` (baseline `4f83ee73741de8e5d61242acbceea668d78b14b07100da101410dc47ab27a7ed`)
- Modify: `server/src/enterprise/contracts.ts` (baseline `bad0b6e589f5db1de35e98a27e17025a7fb51f32c6cdf453d85bc81d89e5d0a0`)
- Test: extend `server/tests/enterprise/runner-production.test.ts` and `server/tests/enterprise/run-execution-failure.test.ts`; new focused cases may live there (no new file unless isolation demands it, reason recorded).

**Consumes:** `RunService.renewRequestLease(scope, lease): Promise<RunnerRequestLease>` (already fenced: exact owner, active statuses, `leaseExpiresAt > now`); `RunDomainError` with `code`; `RunService.fail/complete`; `expireLease(scope, runId)` (store.ts:815, currently unused).

**Produces:** `RunService.renewRunLeases(scope, lease): Promise<RunnerRequestLease>`-equivalent behavior — the request-lease renewal path additionally extends `enterpriseRuns.leaseExpiresAt` (and the active attempt's `leaseExpiresAt` if one exists on the attempt row) to `now + leaseMilliseconds`, still capped by the documented maximum run duration; runner exposes a renewal loop; `stop` validates input; classification of stale errors uses structured codes.

- [ ] **Step 1 — RED (named cases, all DB-free synthetic).** (1) `long_stream_renews_leases_and_settles` — synthetic clock beyond default 30s: runner emits events over >30s; with renewal wired, all events append and terminal `complete` returns true; without renewal (control assertion on pre-fix code) the same scenario throws `RUN_ATTEMPT_STALE` (preserve the failing behavior as the RED). (2) `renewal_extends_run_and_attempt_main_leases` — store-level synthetic transaction asserts the UPDATE statements extend `enterprise_runs.lease_expires_at` and the attempt lease row (SQL-shape assertion per existing run-failure-contract patterns). (3) `renewed_lease_is_propagated_to_settlement` — after renewal, terminalization uses the NEW `expiresAt` (exact-equality fence sees renewed value; old lease object returns false — mirrors existing `old_renewed_lease_is_stale`). (4) `renewal_failure_fails_closed` — synthetic renewal returning `RUN_REQUEST_LEASE_STALE`/throwing does not crash the stream mid-event; the stream terminates failed with usage unknown and the run is not succeeded. (5) `expired_lease_active_run_does_not_block_new_run` — `createRunInTransaction` synthetic: existing active-status row with `lease_expires_at < now` no longer raises `ACTIVE_RUN_CONFLICT`; live-leased row still does. (6) `expired_active_run_is_terminalized_on_conflict` — the stale row is moved to a terminal state via the store (cancelled/expired semantics already provided by `expireLease` — verify and use it; assert exactly-once and no outbox leak beyond one terminal event). (7) `client_disconnect_before_terminal_settles_fallback` — finalize path: run never terminalized ⇒ fallback settlement runs (`fail` with the truthful fixed code for an unterminated stream per taxonomy: `MODEL_EXECUTION_FAILED` only when a model execution context exists, otherwise cancelled/timeout semantics via `stop`-style cancel with reason `timeout`; assert no success). (8) `stream_completes_without_terminal_event_settles_fallback` — same fallback on natural completion lacking RUN_FINISHED/RUN_ERROR. (9) `acquire_lease_failure_after_create_terminalizes_run` — created run is terminalized (not left queued-active). (10) `stop_validates_input_shapes` — object/array runId/attemptId reject with `INVALID_STOP_INPUT` before store. (11) `stale_matching_uses_structured_code` — an error whose message merely contains "STALE" but code differs (e.g. synthetic `RUN_FAILURE_SETTLEMENT_STALE`-named RunDomainError with a different code) is rethrown, not swallowed; true `RUN_ATTEMPT_STALE` code returns false. (12) `stop_aborts_active_stream_and_closes_cleanly` — registry of runId→AbortController; after `stop`, the agent stream sees abort, relay stops emitting, and the observable completes without `RUN_EVENT_APPEND_SETTLEMENT_STALE` surfacing to the client (graceful close). Run all; save RED output.
- [ ] **Step 2 — Implement store/service/contracts.** (a) Extend `renewRequestLease` transaction to also UPDATE `enterpriseRuns` SET `lease_expires_at = now + leaseMilliseconds` (capped by the configured maximum; reuse the `Math.min` pattern) and the active attempt's `lease_expires_at` when the attempt row carries one; keep all existing predicates (exact owner token, active statuses, current leases) and the returned `{ ...lease, expiresAt }` shape (the request-lease expiry remains capped by the — now extended — run lease). (b) `service.ts`: extract `validateRunnerLeaseShape` shared by failure/success validators is OPTIONAL this task (deferred low) — instead only: strengthen `stop` input validation (M-i) per OCR diff (`typeof runId === "string" && runId.trim()` etc.). (c) `contracts.ts`: hoist the inline `import("./experts/version-catalog").ExpertVersionRef` to a top-level `import type` (low). (d) `store.ts` `createRunInTransaction`: change the active-run conflict predicate to require `lease_expires_at > now` (H3); on conflict-candidate with expired lease, invoke the existing expiry/terminalization logic (`expireLease` — read it first; if it only clears the lease, add the truthful status transition to `cancelled` with reason `timeout` semantics inside the same transaction, exactly-once outbox `run.cancel`ed once) before proceeding with creation.
- [ ] **Step 3 — Implement runner.** (a) After `acquireRequestLease`, start a renewal timer at `Math.max(1000, leaseMilliseconds / 2)` that calls `renewRequestLease` and writes the returned lease into BOTH the captured state and the relayed run state consumed by event append/terminalization; clear it in every finalize path; renewal errors set an internal `leaseLost` marker and stop renewing (fail-closed). (b) Add `activeStreams: Map<string, AbortController>`; register on run start, abort in `stop()` after DB cancel, deregister in finalize; thread `signal` into the agent subscription where the runtime supports it (fall back to relay-side filtering if the Agent interface has no signal parameter — record which). (c) Replace the `error.message.includes("STALE")` test with `error instanceof RunDomainError && error.code === "RUN_ATTEMPT_STALE"` (M-h). (d) Finalize fallback (H3): in the release/finalize path, if the run was never terminalized (no complete/fail/cancel happened) and the stream is ending, perform the truthful fallback settlement per RED cases 7-9 (usage unknown via carrier markUnknown when present; never success). (e) acquireRequestLease failure immediately after creation ⇒ terminalize created run (fail `MODEL_EXECUTION_UNAVAILABLE` or cancel `timeout`; pick per taxonomy truth — the model never executed, so `MODEL_EXECUTION_UNAVAILABLE` is the truthful code; assert in RED 9).
- [ ] **Step 4 — GREEN + static.** `bun test` on: runner-production, run-execution-failure, run-failure-contract, run-success-contract, run-active-lookup, expert-run-admission, governed-execution, runner-events, ai-sdk-v3-gateway-adapter (renewal interacts with per-step caps), model-route-rebind, run-output-ceiling. All pass; scoped Biome; `git diff --check`; typecheck baseline-only.
- [ ] **Step 5 — Freeze.** Checkpoint under `.superpowers/sdd/2026-10-14-mastra-ocr-r1-repair/task-r3/` with full artifacts + per-finding repair mapping (H2/H3/M-h/M-i/M-m → tests) + report.

### Task R4: Observability and robustness smalls

**Role:** backend_implementer / backend_validator / independent reviewer.

**Files:**
- Modify: `server/src/agents/runtime-agents.ts` (baseline `5f245e0a538c220eb8345129cdb6cc1f10cfc4c245041d1f2f03ea38335830a5`)
- Modify: `server/src/enterprise/runs/governed-execution.ts` (baseline `e5d074c47d42c441d20d72112d9552f38432ad93941956b59b181d04ee0d5be1`)
- Modify: `server/src/enterprise/runs/events.ts` (baseline `648c5c78f4b4d3a3512a65b2738cccdd24d24dad775d91bea7e830b7a5e069d4`)
- Modify: `server/src/enterprise/runs/store.ts` (baseline = post-R3 hash, recorded at R3 freeze)
- Modify: `server/src/enterprise/runs/model-route-catalog.ts` (baseline `ca0050ceb582766167dc7329776906a46de96a2d46c0b41f763792771ced4dee`)
- Test: extend matching existing suites (runtime-agent/expert-descriptor, governed-execution, runner-events, model-route-catalog).

**Consumes:** adapter error strings (`MODEL_GATEWAY_RUN_BUDGET_EXHAUSTED`); `classifyGovernedRunFailure` carrier ledger; events repository transaction wrapper.

**Produces:** no interface changes beyond an optional `code` property on adapter-thrown errors (Task R3's renewal does not depend on it).

- [ ] **Step 1 — RED.** (1) `classification_prefers_structured_code` — synthetic error `{ code: "MODEL_GATEWAY_RUN_BUDGET_EXHAUSTED", message: "irrelevant text" }` maps to `MODEL_BUDGET_EXCEEDED` even when text lacks keywords; a different code with keyword-bearing text still maps via text fallback. (2) `rebind_infrastructure_failure_is_logged` — synthetic rebind throwing a non-`MODEL_ROUTE_*` error triggers one structured log and returns null; drift errors log nothing. (3) `expert_classification_failure_is_logged` — classifyExpertSource throw produces one structured log then deletion proceeds. (4) `replay_reports_row_schema_version` — synthetic row with schemaVersion 2 is returned as 2. (5) `cursor_rejects_non_string_thread_id` — undefined/numeric threadId yields `RUNNER_EVENT_CURSOR_INVALID` not TypeError. (6) `subscribe_replay_bypasses_transaction` — read-only replay path issues no BEGIN (SQL-shape spy). (7) `catalog_conflict_preserves_corrupt_cause` — put() conflict from corrupt row carries the original as `cause`. (8) `lease_dead_field_removed` — GovernedExecutionBinding compiles without `lease` (update its single binder call). Save RED output.
- [ ] **Step 2 — Implement.** (a) governed-execution: attach `code` to the adapter's exhaustion/distinct errors by extending the existing error creation sites in `ai-sdk-v3-gateway-adapter.ts` ONLY IF that file is touched by its owner — it is NOT in this task's Files; instead read `error.code` defensively in `classifyGovernedRunFailure` (structured-first, text fallback per RED 1) and log infra-vs-drift in `selectModel` catch per RED 2. (b) runtime-agents: structured log per RED 3. (c) events: `schemaVersion: row.schemaVersion`; cursor `typeof threadId === "string" && threadId.trim() && threadId.length <= 200`; add a read-only `replayReadOnly` internal path used by `subscribe` polling that calls the repository without `transaction` (keep `replay` public semantics unchanged for other callers). (d) model-route-catalog: conflict branch rethrows with `cause` preserved (message unchanged so tests stay stable). (e) store: remove the unused `isRunnerRequestLeaseCurrent` export only if no test depends on it after R3 (check; if tests reference it, rename nothing and instead add the explanatory comment); rename `isCurrentRunFailureLeaseSnapshot` → `isCurrentRunLeaseSnapshot` with all references. (f) governed-execution: drop the dead `lease` field from `GovernedExecutionBinding` and its binder call.
- [ ] **Step 3 — GREEN + static.** Affected suites + runner-production + governed-execution + runner-events + expert/admission suites; scoped Biome; `git diff --check`; typecheck baseline-only.
- [ ] **Step 4 — Freeze.** Checkpoint under `.superpowers/sdd/2026-10-14-mastra-ocr-r1-repair/task-r4/` + report.

## Shared-file and interface preflight

| File | Waves touching it | Rule |
| --- | --- | --- |
| runs/store.ts | R3 then R4 | Serial; R4's baseline is R3's frozen after-hash |
| runs/service.ts / contracts.ts / runner.ts | R3 only | Frozen at R3 after-hash for R4 |
| events.ts / governed-execution.ts | R4 only | Consumes R3's final runner behavior |
| All other files | none | Protected at current hashes; any apparent need to edit ⇒ stop and report |

Self-review: every High/Medium in the adjudication table maps to exactly one task; M-n is adjudicated invalid with evidence; deferred lows are enumerated with reasons; no task edits a file outside its Files list; the four GREEN lists cover each task's blast radius; DB gates remain explicitly unverified.
