# Billing OCR Round-5 Repair Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Date:** 2026-10-12 · **Source:** `2026-10-12-ocr-remediation-round5-committed.md` (full-range OCR over `241e6879..ccaa38c6`, 43/46 source groups reviewed; the 3 failures were generated drizzle snapshot JSONs) plus workspace rounds 2–4.

**Scope note:** these findings are against the six-plan delivery, not the audit-remediation diff. Two high/medium items were fixed directly on 2026-10-12 (see "Fixed"); the items below are the validated remainder, for a follow-up session.

## Fixed on 2026-10-12 (with tests, 58 pass in the two touched files)

- [x] **[high]** `credits-writer.reserveCredits` replayed a TERMINAL reservation's idempotency key as `reserved: true` — admission with zero held capacity. Now throws `CreditReservationConflictError` naming the terminal state; pinned replay-while-reserved behaviour unchanged (`billing-credits-writer.integration.test.ts`).
- [x] **[medium]** `config.ts` accepted `maximumReservationUnits === 0n` (zero rate/token product), which made every call of that model fail at runtime inside `reserveCredits` with no boot-time signal. Zero is now an `out_of_range` boot issue.

## Rejected as conflicting with pinned, deliberate behaviour

- **[high]** "blocked orders accumulate `amount_unreadable` strike rows" — `qa-batch2-unreadable-fourth.integration.test.ts` explicitly pins that every unreadable delivery records its evidence row ("a blocked status does not erase evidence"). The unbounded-growth concern is a design debate (bounded evidence vs complete evidence), not a regression; take it up there if channel noise is observed.
- **[high]** `enforceableTokenBudget` hardcoded false — this is plan 00's documented code-run fail-closed terminal state ("not silently counted as a functioning billed code run"). The follow-up below tracks the enabling mechanism.
- Pricing-refusal release/reservation suggestions from round 5 against `index.ts` — the working tree already restructured that path (`billing-usage-charge-refused`, hold retained), and releasing the hold on invalid usage contradicts the remediation plan's explicit reconciliation contract.

## Open items (route each through SDD when picked up)

### Item 1 — Expired reservations permanently consume capacity [medium · bug] — **ABSORBED 2026-10-13**

> Absorbed by `2026-10-13-billing-reliability-audit-remediation.md` Task 3 (F4): option (a) decided and implemented — the `held` subquery now excludes `expires_at <= now()`, `reserveCredits` rejects a past expiry, no sweep. Tests live in `billing-credits-writer.integration.test.ts` ("expired hold no longer occupies capacity"). Do not execute separately.

`credits-writer.ts` `held` subquery counts every `status='reserved'` row regardless of `expires_at`; a crash between reserve and finish leaves a hold that suppresses `availableBalance` until an operator acts on `expired_reserved_reservation`. Decide: exclude expired holds from the capacity sum (`r.expires_at > now()`), add an expiry-release sweep, or both. `reserveCredits` should also reject a past `expiresAt`. Tests: `billing-credits-writer.integration.test.ts`.

### Item 2 — Cross-customer idempotency race surfaces a raw 23505 [medium · bug]

Two different customers racing the same `idempotencyKey` both pass the pre-check; the loser exits on `credit_reservations_idempotency_key_unique_idx` as an untyped driver error instead of `CreditReservationConflictError`. Catch the unique violation in the insert and map it. Tests: concurrent reserve with mismatched customers.

### Item 3 — Pending-order replay exposes any creator's checkout payload [medium · security]

`payments/service.ts` replay branch returns the deployment-unique pending order to ANY creator (QR payload included) while the read routes are strictly actor-scoped. Either document the deployment-shared checkout semantics or filter the replay/conflict branches by `createdBy`. Tests: `qa-batch1-payment-service` / `qa-batch1-payment-store`.

### Item 4 — A createSession failure occupies the deployment-wide purchase slot [medium · bug]

After the deployment-level unique pending slot, a pending order whose `createSession` retries exhaust holds the ONLY slot with `checkoutPayload: null` until TTL sweep; replay of that order does not reopen a session. Cancel the order on final session failure (no channel credentials exist yet) or let replay open a session for payload-less pending orders.

### Item 5 — Duplicate-paid verdict re-locks every sweep pass [medium · performance]

Duplicate orders keep `activationState='pending'`, so `sweepActivations` re-runs the `resolveActivationOwnership` row-lock transaction every pass. Persist a recognizable terminal state (mind the `activation_retry_exhausted` alarm) or exclude confirmed duplicates from the sweep query.

### Item 6 — Code-run rows guarantee a `missing_reservation` credits failure every run [medium] — **DECIDED 2026-10-13, implementation remains open**

> The decision half is absorbed by `2026-10-13-billing-reliability-audit-remediation.md` Task 4 (F5): both surfaces stay fail-closed, and Lago-only code-run metering is REFUSED (the code-run rate is part of the approved hard-cap policy; metering a surface whose ceiling cannot be enforced is what the policy exists to prevent). See `2026-10-11-billing-reliability-design.md` "Billed admission per surface". The residual engineering (sandbox-enforced budget, or the explicit credits-target skip once a budget exists) stays here and stays open.

`code_run` outbox rows never carry reservation facts, so the credits target always blocks with a warn. Either skip the credits target for rows without reservation facts (Lago-only code-run metering), or build the code-run reservation chain. Also relevant: `index.ts`'s code-run path then never touches local credits — confirm that is the intended v1 semantics.

### Item 7 — Database-level invariant gaps in 0077/0078/0082 [medium · bug]

- `credit_reservations_settled_check` NULL-passes (SQL three-valued logic): add explicit `IS NOT NULL` terms (schema + a new migration; never edit applied ones).
- Same shape for a `released` terminal check (`applied = 0`, `released = maximum`, `release_reason` present).
- 0082's backfill used `terminal_at` as `paid_at`; prefer the order's `paid` fact `created_at`, falling back to `terminal_at`. New migration + adjustment.
- `usage_outbox.status` is untyped text on a billing-fact column; narrow it (`completed | failed | timeout | refused` + CHECK) in a new migration.

### Item 8 — `TEST_DATABASE_URL` precedence in `drizzle.config.ts` [medium · bug]

`TEST_DATABASE_URL ?? DATABASE_URL` can silently divert `db:migrate` to the test database. Warn when both are set; document unset-before-migrating for production.

### Item 9 — Retry cap/backoff for poison delivery events [low]

Recurring rounds 1–5: no `attempts` column or backoff; persistent failures retry every 30s forever. Add attempts + threshold → `blocked`.

### Item 10 — Assorted low items (one per line, no elaboration)

- `readLatestPaidOrder` dead after its last caller was deleted (store + interface).
- Orphaned cross-order duplicate comment in `service.ts` describes a removed path.
- `lockedRowOf` hardcodes `currency: "CNY"`; unused `deploymentScope` in its row type.
- `(errno ?? code) === "23505"` and `sqlState.startsWith` non-string guards (`store.ts` ×2).
- `statements.ts` optional `scope` parameter — make it required (fail-closed tenant isolation).
- `usage-delivery.ts` metric literals vs `CODE_RUN_METRIC`; `"web"` client literal shared. — **ABSORBED 2026-10-13 (the `"web"` half): the client literal now reads the usage-origin context (`server/src/usage-origin.ts`, audit F6).**
- `delivered` counter optimism when the sibling target is blocked.
- `maintenance.ts` stale "nothing starts this in production yet" comment; mixed timeout/interval handle cleanup. — **ABSORBED 2026-10-13 (the comment half): header now names the production wiring in `index.ts`. The timeout/interval cleanup half remains open.**
- `metering.ts` docstring: note `occurredAt` must be the persisted finish time for replay idempotency.
- Snapshot EOF-newline policy for drizzle-generated files.
- `config.ts` bigint rate components unbounded (denominator past 70 digits reaches `MAX_ACTUAL_DENOMINATOR` at settle time); bound at parse.
