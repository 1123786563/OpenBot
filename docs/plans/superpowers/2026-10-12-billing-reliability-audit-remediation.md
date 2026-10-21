# Billing Reliability Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two model-usage accounting gaps found in the 2026-10-12 audit and obtain reproducible evidence for the six billing reliability plans.

**Architecture:** Keep the existing reservation, model wrapper, usage outbox, delivery worker, and read-only reconciler. Admit a billed model call only when its configured reservation bounds can be enforced on the actual provider request. Treat persistence of the finish usage fact as part of successful stream completion; a failed write produces a visible failed run and leaves the already durable reservation for reconciliation. Verify the final branch against a dedicated PostgreSQL test database and an independent full-range review.

**Tech Stack:** TypeScript, Bun Test, AI SDK model wrapper, Drizzle ORM, PostgreSQL, OCR.

**Spec:** `docs/specs/superpowers/2026-10-11-billing-reliability-design.md`

## Global Constraints

- This is a repair plan for `docs/plans/superpowers/2026-10-11-billing-reliability-00-master.md` and subplans 01–05; do not reimplement their verified work.
- Hard-cap admission requires an atomic pre-call reservation and a provable bound on actual billable input and output. A reservation alone is not a provider limit.
- Preserve integer/rational credit arithmetic, stable `eventId`, independently retryable Lago and credit targets, and the existing payment/webhook/bill policies.
- No completed billed model stream may be reported as successful when its finish usage fact failed to persist. A database outage cannot magically preserve usage that the provider has already produced; make this failure visible and retain the durable hold for investigation.
- Do not release a reservation for completed, chargeable work merely because its outbox write failed. Do not mark either delivery target successful without its actual effect.
- Integration commands require an explicit, dedicated `TEST_DATABASE_URL`; never fall back to `DATABASE_URL`. Append migrations; never edit an applied migration.
- This plan is planning only. Execution uses the repository's SDD task review and OCR gates; no task is accepted from a checkbox or prior test log alone.

## Review Focus

- A prompt whose billable input can exceed its configured ceiling must be refused before the provider call. Task 1 tests this.
- A provider that cannot enforce the configured output ceiling must be refused before the provider call. Task 1 tests this.
- A finish chunk with usage above an advertised bound must fail visibly and remain traceable by reservation/event ID; it cannot disappear as a logged success. Tasks 1–2 test this.
- An outbox insert failure after provider work must error the stream, retain the reservation, and later appear in reservation reconciliation. Tasks 2–3 test this.
- A crash or second replica retrying a committed event must not duplicate Lago or credit effects. Task 3 tests this against PostgreSQL.

---

## Task map and dependencies

| Task | Source acceptance | Depends on | Owner / validator | Owned files | Produces |
| --- | --- | --- | --- | --- | --- |
| 1. Bound billed model calls | 03 Task 3A; master hard cap | none | backend_implementer / backend_validator | `server/src/copilot.ts`, `server/src/index.ts`, focused model tests | Enforced input/output bound or pre-call refusal |
| 2. Make finish persistence decisive | 01 Task 3; 03 Task 3A | Task 1 | backend_implementer / backend_validator | `server/src/copilot.ts`, `server/src/index.ts`, focused model tests | Successful finish means `usage_outbox.record` committed |
| 3. Prove durable recovery | 01 Tasks 1–4; 03 Task 4 | Task 2 | backend_implementer / backend_validator | billing reconciliation and integration tests only if a missing finding is demonstrated | PostgreSQL evidence for failed writes, holds, replay and delivery |
| 4. Revalidate plans 00–05 | six-plan acceptance | Tasks 1–3 | reviewer / backend_validator | verification reports under `docs/plans/superpowers/` | Full acceptance matrix and OCR report |

Execution order is 1 → 2 → 3 → 4. Tasks 1 and 2 both touch the model wrapper and assembly, so they run serially in the same reviewed worktree. Preserve the starting BASE and task checkpoints in the execution ledger. The user has authorized a plan, not implementation or commits; an eventual execution brief must choose the authorized commit/checkpoint strategy before dispatch.

### Task 1: Enforce the reserved model usage bounds before work

**Files:**
- Modify: `server/src/copilot.ts`
- Modify: `server/src/index.ts`
- Test: `server/tests/copilot-usage-meter.test.ts`
- Test: `server/tests/workshop-metering.test.ts`

**Interfaces:**
- Consumes the configured `BillingModelCreditPolicyEntry` from `server/src/config.ts`, including `input.maximumTokens`, `output.maximumTokens`, and `maximumReservationUnits`.
- Extend the model gate's admitted lifecycle with a typed provider-bound contract. It must supply the exact limits enforced on `inner.doStream`, or refuse admission. The same limits must be used by `calculateExactModelUsageCharge` after finish.
- Input must be bounded by an exact pre-call token count for the effective provider request or by a verified provider-enforced input ceiling. An approximate character count is not an admission authority. Output must use a provider-enforced token limit on this invocation. If either guarantee is unavailable, throw a typed billing refusal before `inner.doStream` and release any reservation already created.
- Preserve an unbilled deployment's existing model behavior.

- [ ] **Step 1: Write failing wrapper tests.** Use a fake `doStream` that records whether it ran and its effective request parameters. Cover input over limit, unsupported input counting/enforcement, unsupported output limit, exactly-at-limit input/output, and provider output over its claimed limit. Assert every unsupported/over-limit case makes zero provider calls, except the deliberately misbehaving provider case, which must produce a visible failure and a retained hold rather than a successful finish.
- [ ] **Step 2: Run RED.** Run `bun test server/tests/copilot-usage-meter.test.ts server/tests/workshop-metering.test.ts`. Expected: the new pre-call bound assertions fail because `meteredModel` currently passes `params` straight to `inner.doStream` and validates the maximum only after finish.
- [ ] **Step 3: Implement the bound contract.** Trace the actual built-in model invocation and its provider request type. Apply only a limit that the invoked provider contract demonstrably enforces; prove this through an adapter-level test that inspects the outgoing request. Compare the effective input token count to the configured input maximum before calling the provider. Use the configured output maximum as that invocation's provider output cap. If the current adapter cannot prove either side, make billed admission fail closed for that adapter and record the unsupported capability as the refusal reason. Do not reuse the unrelated Craft descriptor's `maxOutputTokens`.
- [ ] **Step 4: Run GREEN and typecheck.** Run `bun test server/tests/copilot-usage-meter.test.ts server/tests/workshop-metering.test.ts` and `bun run --filter server typecheck`. Expected: exit 0, with a test showing that the actual provider request carries the configured cap and the pre-call input check prevents an over-budget provider call.
- [ ] **Step 5: Review the task increment.** The independent reviewer checks that the tested provider path is the production path, that every billed model ID is covered or refused, and that the reservation maximum cannot be lower than the enforceable token maximum's worst-case charge.

### Task 2: Require a committed usage fact for a successful finish

**Files:**
- Modify: `server/src/copilot.ts`
- Modify: `server/src/index.ts`
- Test: `server/tests/copilot-usage-meter.test.ts`
- Test: `server/tests/billing-usage-delivery.test.ts`

**Interfaces:**
- Consumes Task 1's admitted lifecycle and the existing `UsageOutbox.record(input): Promise<{ inserted: boolean }>`.
- `ModelUsageGateLifecycle.finish` resolves only after the immutable usage fact has committed (or the identical event already exists); it rejects with a stable, credential-free persistence error otherwise.
- `meteredModel` awaits `finish` before forwarding the provider's finish chunk or closing the stream. A rejection errors the stream, logs the stable `eventId`/reservation ID, and does not call `releaseReservation` for chargeable work.
- An invalid or over-bound provider usage is a distinct failure: do not invent an actual charge, do not emit a successful finish, and leave the hold visible for operator reconciliation.

- [ ] **Step 1: Write failing stream tests.** Inject an outbox `record` that throws once after a provider finish with positive usage. Assert the consumer sees a rejected stream, never a successful finish; the same stable event ID is logged; the reservation remains `reserved`; neither Lago nor credit delivery ran. Add a same-event retry test where `record` returns `{ inserted: false }` for identical facts and the finish succeeds once.
- [ ] **Step 2: Run RED.** Run `bun test server/tests/copilot-usage-meter.test.ts server/tests/billing-usage-delivery.test.ts`. Expected: the new failure test fails because the current `index.ts` finish callback catches the outbox error and `copilot.ts` catches the callback rejection before enqueueing the finish chunk.
- [ ] **Step 3: Change the finish boundary.** Let the assembly callback propagate the outbox error after logging it. In `meteredModel`, error the stream before enqueueing finish when the lifecycle rejects. Preserve the existing provider-failure and consumer-cancellation cleanup paths; prevent a second cleanup path from releasing a reservation after chargeable provider usage has completed.
- [ ] **Step 4: Run GREEN.** Run the two focused files plus `bun run --filter server typecheck`. Expected: exit 0; successful stream implies an identical durable outbox row, and the failed-write case is visible to its caller.
- [ ] **Step 5: Review the task increment.** The reviewer checks that no runtime error handler reclassifies the failed stream as a successful assistant answer and that logs contain stable identifiers but no raw prompt or credentials.

### Task 3: Prove recovery and reconciliation on real tables

**Files:**
- Modify only if the tests expose a missing finding: `server/src/billing/reconcile.ts`, `server/src/billing/types.ts`
- Test: `server/tests/billing-reconcile.integration.test.ts`
- Test: `server/tests/billing-usage-outbox.integration.test.ts`
- Test: `server/tests/billing-credits-writer.integration.test.ts`
- Test: `server/tests/billing-usage-delivery.test.ts`

**Interfaces:**
- Consumes Task 2's rule that chargeable work with no committed outbox row remains an unsuccessful request with a durable reservation.
- The read-only reconciler must identify an expired or stuck `reserved` hold by reservation ID and idempotency key even if there is no outbox row. It must not claim to know exact usage that was never durably recorded.
- A committed outbox row is retried under its original `eventId`; each target remains independently idempotent.

- [ ] **Step 1: Add real-table tests.** Seed a reservation with key `usage:<eventId>` and no outbox row, age it past the documented threshold, and assert a stable reservation finding. Seed an outbox row with one delivered and one pending target, replay through a second store instance, and assert only the pending target executes. Verify reconciliation leaves all seeded rows unchanged.
- [ ] **Step 2: Run RED where applicable.** With a dedicated migrated database, run `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test server/tests/billing-reconcile.integration.test.ts server/tests/billing-usage-outbox.integration.test.ts server/tests/billing-credits-writer.integration.test.ts`. Expected: the new missing-row finding fails if the existing reservation finding does not identify it; existing correct findings may already pass and must not be rewritten merely to manufacture RED.
- [ ] **Step 3: Add only the missing read-only finding, if needed.** Include reservation ID, event ID derived from the `usage:` idempotency key, age and stable failure classification. Keep the existing bounded result/count behavior; a detailed row omitted by the cap must remain represented in counts.
- [ ] **Step 4: Run GREEN and restart/replay probe.** Re-run the three integration files and `server/tests/billing-usage-delivery.test.ts`; open a fresh database/store instance for the replay. Expected: exit 0, one immutable event, no duplicate target effect, and a finding for the missing-row hold. Record the actual test count and migration version.
- [ ] **Step 5: Review the task increment.** The reviewer checks the finding is based on persisted facts, cannot imply a recovered exact charge, and introduces no reconciliation mutation.

### Task 4: Revalidate all six plans with evidence and independent review

**Files:**
- Create: `docs/plans/superpowers/2026-10-12-billing-reliability-remediation-verification.md` during execution
- Create: round-numbered OCR reports under `docs/plans/superpowers/` during execution

**Interfaces:**
- Consumes the original six plans, their approved spec, Task 1–3 reviewed checkpoints, and the actual original branch BASE.
- Produces an acceptance matrix for every active task in plans 01–05 and every cross-plan criterion in plan 00. The rejected 03 Task 2B remains explicitly out of scope.

- [ ] **Step 1: Prepare the database evidence.** Set a dedicated `TEST_DATABASE_URL`; verify it points to a disposable database other than the application database. Apply all appended Drizzle migrations to that database and record the command, database identifier, migration versions and exit code. If no dedicated database is available, mark database-dependent acceptance blocked, not passed.
- [ ] **Step 2: Run the plan's targeted suites.** Run the full set of referenced billing/payment/credit/usage/webhook/statement integration and unit tests, plus `bun run --filter server typecheck`; record commands, counts, skips and exit codes. Inspect skipped tests rather than treating exit 0 as coverage.
- [ ] **Step 3: Check each acceptance criterion against code and tests.** For each active task, cite the implementing file/line, the assertion or database probe proving the behavior, and the current result. Include migration/backfill, concurrent purchases, callback write failure, webhook rollback, user scope, historical periods, credit reservations, usage replay, and read-only reconciliation. Keep uncertain or environment-blocked items open.
- [ ] **Step 4: Run OCR over the entire delivery.** Use `ocr review --audience agent --background "billing reliability six-plan acceptance and audit remediation" --from <actual-original-BASE> --to <actual-HEAD> --output <round-report>` for committed work. If delivery also has staged, unstaged or untracked files, run workspace mode separately with `--output` and retain both reports. Check exit code, warnings, failed/skipped files and coverage; do not infer approval from a missing report or an interrupted process.
- [ ] **Step 5: Close findings through a new numbered repair plan if needed.** Validate each critical/high/medium OCR finding against code. Route valid fixes through SDD, rerun affected tests and independent task review, then rerun full-range OCR. The final report may say accepted only when every active acceptance item has evidence and OCR covers all delivered changes without unresolved blocking findings.

## Completion gate

The repair is complete only when Task 1 proves pre-call enforcement or a documented fail-closed refusal for every billed model, Task 2 proves a failed durable write cannot yield a successful finish, Task 3 proves persisted recovery evidence and replay on a dedicated PostgreSQL database, and Task 4 records full six-plan verification plus complete independent review. The code-run path remains fail-closed until its sandbox enforces the separately configured token budget; that existing design decision is not silently counted as a functioning billed code run.
