# Governed Run Success Terminalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement the assigned Task. Steps use checkbox (`- [ ]`) syntax for tracking. The coordinator dispatches independent validation and Review.

**Goal:** Add an owner-lease-fenced `RunService.complete` operation so a governed model executor can truthfully mark a successfully settled Run as succeeded.

**Architecture:** Extend the existing RunStore terminal transaction and service façade; do not add a second Run state machine. A success transition requires the same exact scope, run, attempt, generation, owner token and current owner lease expiry checks as the reviewed failure path, and writes the existing succeeded outbox event. Event append and usage settlement remain the later executor's responsibility and must occur before it calls this API.

**Tech Stack:** TypeScript, Bun, Drizzle SQL builder, PostgreSQL contract (DB-free synthetic tests now; isolated DB acceptance later).

**Spec:** `docs/specs/superpowers/2026-10-11-mastra-intelligence-only-design.md`; parent T2 `docs/plans/2026-10-11-mastra-intelligence-only-dag.md`; accepted T2 production continuation `docs/plans/2026-10-12-mastra-t2-production-cutover.md`.

**Source evidence:** `.superpowers/sdd/2026-10-12-mastra-t2-production-cutover/reports/governed-success-route-architecture.md` (SHA256 `70091d421fa9c8151a0bbec9fb39c700d4376e83cdff8b3f115228e1698b3417`), §§2 and 6. The architecture report was read before the SSE reviewer settled; the coordinator separately verified SSE validator and reviewer PASS at the pinned hashes. Its suggestion to complete after a malformed/aborted stream is **not adopted**: the user requires runtime stream-type boundary failure to cancel and settle usage as unknown, and a failed Run cannot become succeeded.

## Global Constraints

- Do not change the accepted `RunService.fail` refusal code or the reviewed failure lease fence in this task. Success is a separate service operation and must not weaken failure behavior.
- A success request without a live exact owner lease never returns true or writes a terminal event. Stale generation, expired/replaced lease, stop/cancel, and prior terminal state return false.
- Preserve current schema, migrations, user modifications, existing Task B and SSE code, and existing agent/tool/HITL behavior. No model call is enabled by this task alone.
- No commit, stage, stash, reset, rebase, merge, push, PR, publish, worktree deletion, local database service operation, production database access, or isolated database probe. Database transaction/concurrency/RLS verification stays unverified until the user finishes configuring the isolated test DB.
- Record an uncommitted Task checkpoint with HEAD, full git-visible before/after manifests, exact content of owned existing files before and after, a task-only patch, SHA256, RED/GREEN outputs, and protected-file equality. Never treat an empty BASE..HEAD range as Review evidence.

## Review Focus

- A caller holding an old lease after `renewRequestLease` cannot complete with the old expiry; the focused test checks old false/new true.
- A caller whose owner token was replaced, released, or expired cannot mark another request's attempt succeeded; the focused test checks all three.
- `stop`/`cancel` racing with success cannot yield both successful and canceled state; the store test checks both serialized orderings.
- A request lease with `status: "succeeded"` and an error code is invalid; a failure lease with the reviewed fixed code continues to work.
- An event appended after `complete` is refused because the attempt is no longer active; the focused event-order test verifies the executor must append before terminalization.

---

### Task 1: Add fenced successful Run terminalization

**Dependency:** Verified DB-free T2-SSE checkpoint at `.superpowers/sdd/2026-10-12-mastra-t2-runner-sse-admission/checkpoints/task-1-continuation/checkpoint-manifest.json`; independent validator report SHA256 `193681c325af511a12f262fa0b08d218222b60919ecb2e47442ea4e40e33b91d`, reviewer SHA256 `d9d942794fa633be1f01ffc5b05d130a978c872062943661308f70d1c064390a`. This task precedes production governed execution; it does not depend on remote-stale-test repair, whose files are disjoint.

**Owner role:** backend_implementer. **Validator role:** backend_validator. **Reviewer:** independent reviewer.

**Files:**

- Modify: `server/src/enterprise/contracts.ts` — add the one method to `RunService`.
- Modify: `server/src/enterprise/runs/service.ts` — validate exact `RunnerRequestLease` and delegate to store.
- Modify: `server/src/enterprise/runs/store.ts` — admit fenced success and add a status-specific SQL fence without changing failure semantics.
- Create: `server/tests/enterprise/run-success-contract.test.ts` — DB-free service/store behavior and SQL-shape tests using the existing synthetic Drizzle pattern.
- Modify only if a shared fixture signature demands it: `server/tests/enterprise/run-failure-contract.test.ts`; preserve every existing failure assertion. Record the exact fixture reason in the report before editing.

**Consumes:** `PlatformScope`, `RunnerRequestLease`, `RunStore.transitionTerminal(scope, { runId, attemptId, generation, status, errorCode?, requestLease? }): Promise<boolean>`, existing `RunService.fail`, and existing outbox/attempt transaction. Before edit, require the source hashes listed in the architecture report: contracts `ee344de3…a72d`, service `ea08a8cb…8bb7`, store `3f4bda64…9053`. Exact full hashes are in that report.

**Produces:** `RunService.complete(scope: PlatformScope, input: { lease: RunnerRequestLease }): Promise<boolean>`. `true` means one exact live owner transitioned the run to `succeeded`, the attempt to `completed`, cleared the request-owner claim, and wrote `run.succeeded` once. `false` means no successful transition and no success outbox. The later governed executor calls this only after successful stream termination and usage settlement, and after appending final events while owner is active.

- [ ] **Step 1 — Preflight and RED test file.** Capture HEAD, full manifest and complete before bytes for the three owned existing production files and any touched test fixture; verify their pinned hashes. Write `run-success-contract.test.ts` with cases `complete_requires_live_exact_owner`, `old_renewed_lease_is_stale`, `stop_then_complete_is_false`, `complete_then_stop_remains_succeeded`, `success_attempt_update_has_status_fence`, and `event_append_after_complete_is_stale`. Use existing `run-failure-contract.test.ts` synthetic Drizzle/fake transaction patterns; no DB URL. The service method and success-specific fence are absent before implementation.
- [ ] **Step 2 — Run RED.** From `server/`, run `bun test tests/enterprise/run-success-contract.test.ts`. Expected: nonzero exit because `RunService.complete` is absent and the store rejects a `requestLease` on `status: "succeeded"`; save full output. Do not weaken the tests to obtain RED.
- [ ] **Step 3 — Add the service contract.** Add `complete(scope, { lease }): Promise<boolean>` to `RunService` in `contracts.ts`. In `service.ts`, validate `assertTrustedScope(scope)` plus nonempty `runId/attemptId/ownerToken`, safe positive generation and valid lease expiry using the same rules as `fail`'s `validateRunFailureInput`, with no error-code parameter. Delegate to `store.transitionTerminal` with `status: "succeeded"`, the lease tuple and `requestLease: lease`; return its boolean exactly. Do not call `cancel` or claim success from a false result.
- [ ] **Step 4 — Fence success in the store transaction.** Replace the hardcoded request-lease failure-only guard with two allowed tuples: `(status === "failed", errorCode === "MODEL_EXECUTION_UNAVAILABLE")` and `(status === "succeeded", errorCode === undefined)`. Keep the existing run/attempt row locks, live run/attempt/owner expiry predicates and exact owner-token/expiry equality. Add a success-specific attempt-update fence requiring that the just-written run row is still `status='succeeded'` with no error code; use that fence only for leased success, retaining `runFailureRunLeaseFence` for leased failure. Reuse the existing attempt `completed`, owner-clear, `run.succeeded` outbox path; no new schema or raw non-transactional write.
- [ ] **Step 5 — GREEN and protected regressions.** Run `bun test tests/enterprise/run-success-contract.test.ts tests/enterprise/run-failure-contract.test.ts tests/enterprise/run-active-lookup.test.ts tests/enterprise/expert-run-admission.test.ts tests/enterprise/runner-production.test.ts tests/enterprise/runner-events.test.ts` from `server/`. Expected: all pass, with the previously reviewed failure/refusal semantics unchanged. Run `bunx biome check` on the owned production/test files and `git diff --check` on the task increment; expected no new diagnostics. Run the targeted TypeScript check used by the repository or whole-server `tsc --noEmit`; if the known unrelated `scripts/enterprise-runtime-probe.ts:63` error persists, report it with exact output and show no new diagnostics in owned files. Do not run DB-gated integration tests.
- [ ] **Step 6 — Freeze and self-review.** Save full before/after owned content, hashes, incremental patch, full test/static outputs, protected non-owned hash comparison and report under `.superpowers/sdd/2026-10-13-mastra-governed-run-success/`. Verify no other source/test file changed from the captured baseline. Report exact API semantics, race and stale-lease outcomes, RED→GREEN evidence, known TypeScript baseline diagnostic, and unverified database concurrency/RLS. The coordinator dispatches same-hash independent backend validation and Spec/quality Review before downstream T2-GOV work.

**Acceptance:** The public Run service has a single reviewed lease-fenced success operation, the existing failure path remains byte/behavior compatible except the narrow shared store guard, the focused DB-free tests and protected suites pass, and the exact checkpoint passes independent validation and Review. This task alone does not execute a model or complete T2.

## Shared-file and interface preflight

| File/interface | Writer | Consumer | Integration rule |
| --- | --- | --- | --- |
| `contracts.ts` / `service.ts` / `store.ts` | This task only, after remote test repair is frozen in the serial worktree | Later T2-GOV executor, T3-CORE | Freeze complete content and review `complete` before downstream dispatch |
| `run-failure-contract.test.ts` | Protected by default; this task may update a fixture only with exact documented need | This task's GREEN suite | Keep all fixed-code failure assertions and rerun suite |
| `runner.ts`, `copilot.ts`, `index.ts` | No writer in this task | Later T2-GOV execution | SHA256 must remain SSE reviewed values |
| Three remote-stale tests | Separate backend test worker | Its independent validator/reviewer | File ownership disjoint; no concurrent source edit in this task |

Self-review: Each Review Focus risk has a named RED case in Step 1 and a GREEN check in Step 5. The method signature is stable for the later executor. This plan covers only the smallest independently reviewable success API, leaving route rebind, per-step cap, model execution, failure-code expansion and headless cutover to separately specified downstream tasks. No accepted design boundary is changed.
