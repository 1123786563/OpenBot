# Billing Reliability Remediation — Verification Report

**Date:** 2026-10-12
**Scope:** `docs/superpowers/plans/2026-10-12-billing-reliability-audit-remediation.md` (Tasks 1–3) plus revalidation of the six-plan suite (`2026-10-11-billing-reliability-00` … `05`).
**Out of scope (unchanged decision):** plan 03 Task 2B (explicit overdraft alternative) — marked DO NOT EXECUTE and remains unimplemented by design.

## 1. Database evidence (Task 4 Step 1)

- Dedicated test database: `postgres://openbot:openbot@127.0.0.1:5432/openbot_test` (container `openbot-postgres-1`, database `openbot_test`, user `openbot` — verified `current_database()=openbot_test`, distinct from the application database `openbot`; `server/tests/support/database.ts` refuses to run against `openbot`).
- Applied migrations on that database at verification time: **83 rows in `drizzle.__drizzle_migrations`**, latest journal entry `0082_naive_nightshade.sql` (matches `server/drizzle/` HEAD). No migration was added by the remediation (no schema change was needed).
- All integration tests below ran with `TEST_DATABASE_URL` set explicitly; the support module throws without it (no `DATABASE_URL` fallback exists).

## 2. Test evidence (Task 4 Step 2)

Commands (from `server/`):

```
TEST_DATABASE_URL='postgres://openbot:openbot@127.0.0.1:5432/openbot_test' bun test <41 files: billing-*, payment-*, copilot-usage-meter, workshop-metering, qa-batch*>
bun run typecheck
```

Results:

| Run | Result |
| --- | --- |
| 41 targeted billing/payment/credit/usage/webhook/statement unit + integration files | **644 pass, 0 fail, 0 skip** (1711 expect calls — final run, after all OCR fix batches) |
| Remediation focused files (`copilot-usage-meter`, `workshop-metering`, `billing-usage-delivery`, `qa-batch1-llm-meter-id`) | **51 pass, 0 fail** |
| Task 3 integration set (`billing-reconcile`, `billing-usage-outbox`, `billing-credits-writer` integration + `billing-usage-delivery`) | **68 pass, 0 fail** (includes the blocked-target delivery guard test) |
| `bun run typecheck` | **exit 0** (after every task and after every OCR fix batch) |

No skipped tests appeared in any run (bun reports skips; none were present).

## 3. Remediation acceptance matrix (Tasks 1–3 of the remediation plan)

| Acceptance item | Evidence (file:line) | Proving test | Result |
| --- | --- | --- | --- |
| **T1** A prompt whose billable input can exceed its ceiling is refused before the provider call | `server/src/copilot.ts:604-638` (typed refusals `input_over_limit` / `input_bound_unsupported`, zero provider calls, reservation released via `fail` with `bound_refused`) | `copilot-usage-meter.test.ts` — "input over the configured maximum…", "an input bound this deployment cannot prove…", "a failing or non-whole input count…" | PASS |
| **T1** A provider that cannot enforce the configured output ceiling is refused pre-call | `server/src/copilot.ts:627-629` (`output_bound_unsupported`); cap written into the request at `copilot.ts:630-660` (bigint-domain comparison — no `Number()` rounding between admission and settlement) | "an output cap this provider cannot enforce…", "exactly-at-limit input is admitted and the configured cap reaches the provider request" | PASS |
| **T1** Typed provider-bound contract on the admitted lifecycle | `server/src/copilot.ts:408-431` (`ModelUsageInputBound`/`ModelUsageOutputBound`/`ModelUsageProviderBounds`), lifecycle field `bounds` at `copilot.ts:437`; no-bounds admission refused at `copilot.ts:624-625` (gate return type narrowed to a full lifecycle — `undefined` is a refusal, not an exemption) | "an admitted lifecycle without bounds is refused before the provider call" | PASS |
| **T1** The tested provider path is the production path; the outgoing request carries the cap | `server/src/copilot.ts:366-375` (`createOpenAI({baseURL}).chat(...)` — same construction the adapter test uses); adapter maps `maxOutputTokens`→`max_tokens` (`@ai-sdk/openai` 3.0.99 chat, verified by adapter-level test inspecting the outgoing body) | "the real OpenAI chat adapter carries the configured cap on the outgoing request" (asserts `max_tokens: 7` in the POSTed JSON); "an over-budget input makes zero provider requests through the real adapter" | PASS |
| **T1** Production declaration for the billed built-in path | `server/src/index.ts:3228-3241` — output `provider_cap` (provable via `max_tokens`), input `unsupported` (no exact pre-call token count and no provider-enforced input ceiling exists for the OpenAI-compatible chat adapter) → every billed model call fails closed with `input_bound_unsupported` before the provider; string-form models refuse with `UnmeterableModelError` (copilot.ts) — not the credits sentinel, since the balance is not what is wrong | "a billed run without a provable input bound is refused before the provider" (LLMock E2E: `runAgent()` rejects, 0 provider calls, hold released as `bound_refused`); "string-form built-in models fail closed when billing admission is wired" | PASS (fail-closed terminal state, per plan) |
| **T1** Same limits price the finished usage; exactly-at-limit admitted | `server/src/workshop/metering.ts:84-111` (`calculateExactModelUsageCharge` uses the same `input/output.maximumTokens`); reservation maximum = ceiling-product sum at `server/src/config.ts:1502-1511` (≥ any enforceable worst case) | `workshop-metering.test.ts` — "usage exactly at the configured token ceiling charges at the ceiling cost" | PASS |
| **T1** Finish usage above an advertised bound fails visibly, stays traceable | `server/src/copilot.ts:786-796` (stream errors with `usage_over_bound` via the shared `failSettlement` exit, hold NOT released, finish chunk not forwarded, `eventId` logged) | "a finish above the advertised bound fails visibly and keeps the hold" | PASS |
| **T2** Successful finish implies the committed outbox fact | `server/src/copilot.ts:686-702` (`settleFinish` awaits `lifecycle.finish` — the durable fact — before the meter, before enqueue) + `server/src/index.ts:3243-3280` (finish: charge + `usageOutbox.record` in one try; failure logged with `eventId`+`reservationId` then rethrown as `ModelUsageSettlementError`) | "a finish whose durable write fails rejects the stream and keeps the hold" (finish chunk never forwarded; no `fail` → hold retained; neither delivery target can run) | PASS |
| **T2** Same-event retry succeeds once | `server/src/billing/usage-outbox.ts:269-291` (`record` returns `{inserted:false}` for identical facts) | "a retried finish for the identical event succeeds once"; "record inserts a usage event once and an identical replay is a no-op" | PASS |
| **T2** Invalid/over-bound usage is a distinct failure; no invented charge, hold retained | `server/src/copilot.ts:778-783` (`usage_invalid`) and the removed release-on-invalid path in `index.ts` (probe pins its absence) | "malformed finish usage is not charged as normal usage" (lifecycle untouched, meter empty, stream errors `usage_invalid`); static pins in `qa-batch1-llm-meter-id.test.ts` | PASS |
| **T2** No runtime handler reclassifies a failed stream as success; logs carry stable ids only | `copilot.ts:805-830` errors the stream before the finish part; log fields are `eventId`/`code`/`reservationId` only (`index.ts:360-375`); consumer cancellation settles as `cancelled`, not `stream_error` | LLMock E2E refusal tests; `billing-usage-delivery.test.ts` log-stability tests ("logs only stable fields", "not.toContain('secret')") | PASS |
| **T3** Expired `usage:<eventId>` hold with no outbox row is found by reservation id + event id + age, claiming no usage | `server/src/billing/reconcile.ts:470-500` (read-only enhancement: `idempotency_key=`, `usage_event_id=`, `expired_age_ms=`, remediation; no token figures; prefix from the shared `USAGE_IDEMPOTENCY_KEY_PREFIX` the gate writes with) | `billing-reconcile.integration.test.ts` — "an expired hold keyed usage:<eventId> with no outbox row…" (rows unchanged before/after; detail excludes `input_tokens`/`output_tokens`) | PASS |
| **T3** A committed outbox row replays under its original event id; only the pending target executes; a second replica/restart cannot duplicate either effect | `server/src/billing/usage-delivery.ts:117-203` (per-target pending gate + per-target persisted result) | `billing-usage-outbox.integration.test.ts` — "a second store instance replays only the pending target under the original event id" (fresh database/store instance; delivered Lago target never re-sent; replay of the replay is a no-op) | PASS |
| **T3** Reconciliation leaves all seeded rows unchanged | Read-only pass (`reconcile.ts` — selects only) | snapshot before/after equality in every reconcile integration test | PASS |

## 4. Six-plan revalidation (plans 00–05, active tasks)

All active tasks were previously delivered on this branch (38 commits, BASE `241e6879` … HEAD `ccaa38c6`) and revalidated now by the 643-test run above with 0 failures. Per-plan anchors:

- **01 usage-events** — Task 1 outbox: `server/src/billing/usage-outbox.ts` + `billing-usage-outbox.integration.test.ts` (9 pass, incl. new replay probe). Task 2 delivery: `usage-delivery.ts` + `billing-usage-delivery.test.ts` (18 pass). Task 3 wiring: `index.ts` gate/outbox seam + `copilot-usage-meter.test.ts` / `qa-batch1-llm-meter-id.test.ts` (remediation-updated pins). Task 4 backlog evidence: reconciler usage findings (`billing-reconcile.integration.test.ts`). PASS.
- **02 payment-ordering** — one pending purchase per deployment, explicit retry-safe settlement, duplicate activation guard: `payment-*` suites (11 files) + `qa-batch1-duplicate-paid`, `qa-batch1-replay-storm`, `payment-ordering-migration.integration.test.ts`. PASS.
- **03 credit-enforcement** — Task 1 policy config (`billing-config.test.ts`), Task 2A reservations (`billing-credits-writer.integration.test.ts` + `qa-batch1-credits-writer`), Task 3A admission wiring (remediation Tasks 1–2 strengthen exactly this seam; string-form models fail closed; code-run path stays fail-closed per plan 00's completion gate), Task 4 reservation reconciliation (`billing-reconcile.integration.test.ts`, incl. the new no-outbox-row finding). **Task 2B remains intentionally unimplemented (DO NOT EXECUTE).** PASS.
- **04 webhook-resilience** — failure classification and transaction-aware projection/inbox: `billing-webhook.test.ts`, `billing-webhook-signature.test.ts`, `billing-sync.test.ts`. PASS.
- **05 bills-reconciliation** — order-specific invoice periods, access policy, plan payout + activation backlog, payment evidence and usage delivery reconciliation: `billing-statements.test.ts`, `billing-routes.test.ts`, `qa-batch2-t5-semantics`, `qa-batch2-unreadable-fourth`, `qa-batch3-reconcile`, `billing-reconcile.integration.test.ts`. PASS.

### Master cross-plan criteria

| Criterion | Evidence |
| --- | --- |
| Replayed usage events never duplicate Lago or credit effects | Second-instance replay probe (Task 3 above); `record` immutable-fact idempotency; per-target delivered-state persistence |
| Simultaneous purchases cannot open two live intents | `payment-store.integration.test.ts` / `qa-batch1-payment-store` (unique pending slot) |
| Transient store failure → retryable callback; success ⇒ fact committed | `qa-batch1-payment-service.test.ts`, `payment-service.test.ts` |
| One credit policy across model calls, code runs, ledger, reconciliation | shared `BillingModelCreditPolicyEntry` (config.ts) consumed by gate, `calculateExactModelUsageCharge`, reconciler |
| Historical bills use the order's own committed period/timestamp | `qa-batch2-t5-semantics.integration.test.ts`, `billing-statements.test.ts` (period fields pinned) |
| Reconciliation reports stable, row-locating identifiers | every reconcile integration test asserts subject/detail precision (incl. new reservation + event id + age) |

## 5. Independent review (Task 4 Step 4)

OCR rounds (reports under `docs/superpowers/plans/`):

- **Round 1** `2026-10-12-ocr-remediation-round1-committed.md` — committed range `241e6879..ccaa38c6`, exit 0 but **44 of 46 review items failed on provider rate limiting (HTTP 429)** — treated as interrupted, not as approval.
- **Round 2** `2026-10-12-ocr-remediation-round2-workspace.md` — workspace mode, exit 0, `copilot.ts` reviewed; `index.ts`/`reconcile.ts` rate-limited.
- **Round 3** `2026-10-12-ocr-remediation-round3-workspace.md` — workspace rerun at `--concurrency 3` after the fix batch, covering the complete remediation diff.
- **Round 4** `2026-10-12-ocr-remediation-round4-workspace.md` — workspace rerun after the round-3 batch (4 findings, all fixed — items 17–20 below).
- **Round 5** `2026-10-12-ocr-remediation-round5-committed.md` — full-range rerun over `241e6879..ccaa38c6` at `--concurrency 2`: **43/46 source review groups succeeded**; the 3 failures are generated drizzle snapshot JSONs (machine-derived artifacts), so every delivered source file was reviewed. 57 findings over the six-plan delivery — validated, then split three ways:
  - **Fixed directly** (2026-10-12, tests re-run): [high] `reserveCredits` replaying a TERMINAL reservation answered `reserved: true` (admission with zero held capacity) → now `CreditReservationConflictError`; [medium] `config.ts` accepted a zero `maximumReservationUnits` (every call of that model would fail at runtime with no boot-time signal) → now an `out_of_range` boot issue.
  - **Rejected as conflicting with pinned, deliberate behaviour**: blocked-order `amount_unreadable` evidence rows (pinned by `qa-batch2-unreadable-fourth`: "a blocked status does not erase evidence"); the code-run `enforceableTokenBudget: false` terminal state (plan 00's documented decision); round-5 suggestions to release the hold on pricing refusal (contradicts the remediation's reconciliation contract; the working tree already split the pricing stage's event).
  - **Deferred to the numbered repair plan** `2026-10-12-billing-ocr-round5-repair.md` (Items 1–10: expired-hold capacity, cross-customer idempotency race, pending-replay checkout exposure, session-failure slot occupation, duplicate re-locking per sweep, code-run credits-target noise, DB constraint gaps, drizzle config precedence, retry backoff, assorted lows).

### Finding disposition (rounds 1–2, all validated against code)

**Fixed (with tests re-run, 644 pass / 0 fail / typecheck 0):**

1. [high] `usage-outbox.ts` `markDelivered` lacked the `pending` guard its siblings have — a stale worker could overwrite a `blocked` manual-review terminal state with `delivered`. Guard + 0-row readback added; new integration test "a stale worker cannot mark a blocked target delivered".
2. [medium] output-cap comparison used `Number(bigint)` (rounding could admit above the settlement bound) and passed through an unvalidated caller `maxOutputTokens`. Comparison now stays in the bigint domain and honours the caller only for whole, non-negative, in-bound values.
3. [medium] gate return type still allowed `undefined` ("exempt") while the new contract treats it as refusal. Type narrowed to a full lifecycle; the semantics are now unenforceable-by-mistake.
4. [medium] string-form billed models reused `CreditGateError` — wrong attribution (told operators to buy credits for a wiring problem). New `UnmeterableModelError` sentinel + test.
5. [medium] consumer cancellation was recorded as `stream_error` in `releaseReason`, polluting reservation audit facts. New `cancelled` reason + test.
6. [medium] a failing (non-refusing) gate was rethrown as `CreditGateError` with no trace. Now logged (`billing-model-gate-failed`, name only — no message that could carry connection details).
7. [low] meter seam could silently drop an async meter's rejection → typed `void | Promise<void>` and awaited; meter moved AFTER the committed finish so "reported" never precedes "persisted".
8. [low] mid-pull cancel could hit `controller.enqueue` on a closed stream → guarded.
9. [low] `usage:` idempotency-prefix literal duplicated across writer (index.ts) and reader (reconcile.ts) → shared `USAGE_IDEMPOTENCY_KEY_PREFIX` in `billing/types.ts`.
10. [low] three duplicated settlement-termination sequences → single `failSettlement` exit; settlement code fields stabilized; stale `meteredModel`/`settleFail` docstrings refreshed.

**Validated and deliberately not applied (recorded):**

- *Settlement timeout / let the stream through on a hung finish* — contradicts the remediation's decisive-boundary contract (a completed billed stream must not report success without the committed fact). The upstream stall guard owns stream-level hangs.
- *`pending()` claiming (`FOR UPDATE SKIP LOCKED` / lease)* — concurrent duplicates are already prevented at the effect level: Lago dedupes by `transaction_id`, `settleReservation` is idempotent by reservation state, and the second-instance replay test proves a retried committed event produces no duplicate effect. Adding a claiming state machine is follow-up work, not an audit gap.
- *`transaction_id` unique-index 23505 handling in `record()`* — both current writers use `transactionId === eventId`; latent until a writer with a distinct transaction id exists.
- *Error `message`/`stack` in the outbox-write-failure log* — the repository's pinned logging discipline (and the sweep probes that assert it) forbids database error payloads in logs; connection strings ride in those messages. The error `name` is logged instead.
- *Splitting `billing-usage-outbox-write-failed` per stage (charge vs write)* — the stable `code` field already distinguishes (`usage_invalid_tokens`/`usage_over_token_max`/… vs `usage_outbox_write_failed`), and the QA probe pins the event type.
- *Retry cap/backoff for poison events, `meteredModelForTests` relocation, `input_bound_unsupported` reason splitting* — follow-up maintainability items, no correctness impact in scope.

### Round 3 (post-fix rerun over the workspace) — additional items fixed

11. [medium] a configured output maximum above `Number.MAX_SAFE_INTEGER` could still round at the `Number()` write — now refused outright (`output_bound_unsupported`), so the provider-side cap and the settlement-side bigint maximum can never disagree.
12. [medium] settlement failures only `releaseLock`ed, leaving the provider's HTTP body unconsumed — the shared exit now `reader.cancel`s upstream (connection reclaimed) before erroring the stream.
13. [low] `maxOutputTokens: 0` passed through (providers reject or ignore it) — zero is no longer an honoured request value.
14. [low] the finish-failure catch duplicated the settlement exit — folded into the one `failSettlement` exit (one place to keep the cancel/log/error sequence honest).
15. [low] the outbox write-failure log now records the error `name`, and `usageOutboxWriteFailureCode` is computed once per failure.
16. [low] the three `usage-outbox` zero-row readbacks share one `assertRecordExists` helper; dropped-chunk enqueues log `billing-model-chunk-dropped` at debug.

After the round-3 fix batch: **644 pass / 0 fail across the 41 targeted files, `bun run typecheck` exit 0.**

### Round 4 (workspace rerun after the round-3 batch) — items fixed

17. [security · medium] the finish-failure exit forwarded a gate implementation's RAW error into the person-visible stream (`controller.error(error)`), where a store failure's message (connection details) could ride the RUN_ERROR serialization to the client. Only `ModelUsageSettlementError` crosses now; anything else is wrapped into the credential-free shape with the stable code it carried.
18. [bug · low] consumer cancellation raced an in-flight pull's `settleFail("no_usage")` — the pull could win and record a real cancellation as `no_usage`. The cancel path now claims the settled flag before tearing the upstream down.
19. [maintainability · low] pricing (`calculateExactModelUsageCharge`) and the outbox write shared one log type and code fallback, so a pricing refusal could be recorded as `usage_outbox_write_failed`. Pricing now has its own `billing-usage-charge-refused` event and stable code (`UsageChargeError.code`, or `usage_charge_failed` for foreign errors); the write path is unchanged and its pins still hold.
20. [maintainability · low] a `countInputTokens` that THREW was indistinguishable from a missing capability — a `billing-model-input-count-failed` log (error name only) now separates a dependency outage from a configuration gap.

After the round-4 fix batch: **644 pass / 0 fail across the 41 targeted files, `bun run typecheck` exit 0.**

### Rounds 5–6 closure

- **Round 6** `2026-10-12-ocr-remediation-round6-workspace.md` — closure pass over the final workspace: **8 findings, all low severity** (no critical/high/medium remain). Five one-line polish items applied (charge-refused log gains `error.name`; `reserveCredits` replay-semantics JSDoc matches the new terminal-replay contract; `input_over_limit` refusal tells the person to shorten the request instead of pointing at administrator configuration; `assertRecordExists` comment uses the outbox's own state names; a dead conditional spread removed). Three declined and recorded: a separate `input_count_failed` refusal code (the `billing-model-input-count-failed` log already distinguishes a dependency outage from a missing capability), a literal-union type for settlement codes (the set is open by design — gate implementations carry their own codes), and a second logging-helper extraction for two occurrences.
- **Final regression after all batches: 644 pass / 0 fail / 0 skip across the 41 targeted files, 1711 expect calls, `bun run typecheck` exit 0.**
- Review acceptance: every delivered source file is covered by a completed OCR group (round 5 for the committed range — the only failures there were generated drizzle snapshot artifacts — rounds 3/4/6 for the working tree), and no critical, high, or medium finding remains unresolved: fixed directly (items 1–20 above), rejected with recorded rationale against pinned behaviour or plan contracts, or routed into `2026-10-12-billing-ocr-round5-repair.md` for follow-up execution.

## 6. Known fail-closed states (documented, not silently counted as functioning)

1. **Billed built-in model calls refuse pre-provider** until a provable input bound exists for the OpenAI-compatible chat adapter (`input_bound_unsupported`, `index.ts:3230-3236`). Output caps are proven and enforced; the input side has no exact in-process counter and no provider-enforced ceiling today.
2. **Code-run billing stays fail-closed** until the sandbox enforces the configured token budget (pre-existing decision from plan 03; unchanged by this remediation).
