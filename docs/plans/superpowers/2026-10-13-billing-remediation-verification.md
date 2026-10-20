# Billing Reliability 2026-10-13 Remediation — Verification Record

**Plan:** `2026-10-13-billing-reliability-audit-remediation.md` · **Date:** 2026-10-13 ·
**Base:** `d590e51d` (merge of origin/main) · **Head at verification:** this document's commit.

## Task 1 — Exact reconciler arithmetic (F1, F2) — VERIFIED

- `server/src/billing/reconcile.ts`: both identity sums read `COALESCE(SUM(...),0)::bigint`
  as strings (`sql<string>`), stored as `BigInt`, compared as `BigInt`, printed as exact
  decimals in the finding; the four usage-outbox counts read `COUNT(*)::bigint` behind
  `exactCount`, a safe-integer guard that throws `RangeError` rather than silently rounding
  a backlog it cannot represent. `ReconcileReport` shape unchanged (`usageDeliveryTargets`
  stays numeric — the guard is the boundary).
- Precision test seeds 2×4,194,304 max-value rows server-side (`generate_series`) so the
  grants sum is exactly 2^53 = 9007199254740992 and the ledger's 2^53+1; the one-unit split
  fires `grants_ledger_divergence` with both exact decimal strings, and equalising the
  make-up row silences it. Confirmed RED before the fix (the split compared equal through
  `Number()`), GREEN after.
- Step 4 review: no other reconciler read can exceed safe range — reservation `maximum` and
  per-allocation `amount` are 32-bit integers bounded by `MAX_STORED_UNITS` at admission
  (`reserveCredits`) and the settle clamp; `allocated` sums to at most `maximum`. Verified in
  code at `server/src/billing/credits-writer.ts` (bounds) and the reserved-rows join.

## Task 2 — Targeted paid-fact conflict (F3) — VERIFIED

- `server/src/billing/payments/store.ts` `confirmPaid`: the fact insert's
  `onConflictDoNothing` now names the channel-transaction partial index
  (`channel_transaction_id WHERE kind='fact' AND state='paid'`); a `payment_events_pkey`
  23505 redraws the `pe-` id through the same bounded-retry loop `insertOrder` uses
  (`isUniqueViolationOn` refactor, five retries, terminal `BillingError("invalid_response")`),
  re-running CAS and insert together. The replay verdict (`alreadyKnown`) remains the
  transaction index's alone.
- Collision test (`payment-store.integration.test.ts`) pre-seeds the `pe-` id, spies
  `generateOutTradeNo`, asserts `claimed: true` with the fact under the redrawn id.
  Confirmed RED before (the collision answered `alreadyKnown: true`).

## Task 3 — Expired-hold recovery (F4) — VERIFIED, option (a)

- Decision recorded in `2026-10-11-billing-reliability-design.md` ("Expired-hold capacity"):
  capacity accounting stops counting an expired hold; no sweep; `release_reason` vocabulary
  unchanged.
- `server/src/billing/credits-writer.ts`: the `held` subquery gains
  `r.expires_at > now()`; `reserveCredits` rejects `expiresAt <= now()` at admission
  (`TypeError`, message updated to "a future expiry").
- Tests (`billing-credits-writer.integration.test.ts`): a fresh 700 reserve succeeds against
  capacity held only by an expired 700 hold; the late settlement of the expired hold draws
  its own allocation in full; an overlapping second settlement is clamped to what the grant
  has left (`applied: 300` of 700) — the recorded overdrawn-but-honest consequence.
  Past-expiry admission rejects with `TypeError`. Both confirmed RED before.
- Step 5 review: the reconciler's `expired_reserved_reservation` finding keeps its full
  meaning — option (a) mutates nothing, so the stuck row stays visible as operator evidence
  and the two existing finding tests in `billing-reconcile.integration.test.ts` pass
  unchanged. No migration added (none needed; 84 migrations stand).

## Task 4 — Billed admission decision (F5) — RECORDED, stay closed

- Decision recorded in the design spec ("Billed admission per surface", 2026-10-13): both
  surfaces stay fail-closed. Model call flips only with an input bound provable on the
  outgoing provider request (`counted` via a provider count-tokens contract, or
  `provider_cap`); code run flips only with a sandbox contract that enforces the configured
  token budget end to end. Lago-only code-run metering REFUSED (the rate is part of the
  approved hard-cap policy).
- `reference/configuration.md` now states that enabling the hard-cap block refuses billed model
  calls (`input_bound_unsupported`) and code runs (`billing-token-budget-unavailable`), and
  points at the decision record. No enabling code written (Step 3 N/A).

## Task 5 — Usage source attribution (F6) — VERIFIED

- `server/src/usage-origin.ts`: `UsageOrigin = "web" | "api" | "unknown"` (controlled
  vocabulary, enforced at the two doors that set it) on an `AsyncLocalStorage`, the
  `request-tracking.ts` pattern.
- `copilot.ts` reads `currentUsageOrigin()` at `doStream` and carries it on
  `ModelUsageGateInput.client`; the gate's outbox write (`index.ts`) records `input.client`.
  `workshop/metering.ts` records `currentUsageOrigin()` for code runs. `app.ts` sets `web`
  on the `/api/*` session floor (registered with the enterprise gate, before every API route
  including the CopilotKit runtime) and the worker's bearer dispatch sets `api` inside it.
- Tests: `copilot-usage-meter.test.ts` streams a real agent under `withUsageOrigin("cli")`
  and asserts the gate receives `client: "cli"`; `workshop-metering.test.ts` asserts a code
  run records `"cli"` under the context and `"unknown"` without one (the existing
  hardcoded-`"web"` assertion updated to `"unknown"` — the honest no-context value). Both
  RED before.

## Task 6 — Documentation convergence (F7) — VERIFIED

- Dated "As-built notes (2026-10-13 audit, F7)" appended to plans 01 and 05: settleReservation
  delivery vs `consumeCredits` (commit `b616ccaa`), `updated_at` retry rotation vs creation
  order (commit `195ca54b`), `duplicate_paid` anomaly rows vs per-plan/scope counting
  (commit `c3c2a206`). `maintenance.ts` header now names the production wiring in
  `index.ts`.
- Spot-check: every interface name the six plans' Interfaces sections lean on
  (`settleReservation`, `releaseReservation`, `reserveCredits`, `recordUsage`, `confirmPaid`,
  `createUsageOutbox`, `startUsageDeliverySweeps`, `createReconciler`,
  `expectedPlanCredits`, and the finding codes) resolves in `server/src` — no further
  divergence found.

## Task 7 — Integrated verification

- **Database:** dedicated `TEST_DATABASE_URL`
  (`postgres://openbot:...@127.0.0.1:5432/openbot_test`); migrations applied previously
  stand at **84**; this remediation adds none.
- **Full targeted suite** (all billing/payment/credit/usage/webhook/statement files plus
  `copilot-usage-meter` and `workshop-metering`):
  `TEST_DATABASE_URL=... bun test server/tests/billing-*.test.ts server/tests/payment-*.test.ts server/tests/copilot-usage-meter.test.ts server/tests/workshop-metering.test.ts`
  → **592 pass / 0 fail** across 28 files, 1499 expect calls, 218.60s. Baseline at audit time
  was 533 pass / 0 fail; the plan-named files did not regress (59 new assertions' worth of
  tests added). `bun run --filter server typecheck` → exit 0.
  Note: the precision suite seeds and deletes ~8.4M rows; the reconcile file now runs
  ~210s and its teardown carries a 240s budget with the cascade delete first.
- **OCR review:** run over `d590e51d..HEAD` with `--audience agent --concurrency 3` and the
  remediation constraints as background; report dispositioned below.
- **Ledger close-out:** OCR round-5 Item 1 marked ABSORBED, Item 6's decision half marked
  DECIDED (implementation stays open there), Item 10's `"web"`-literal and `maintenance.ts`
  comment bullets marked absorbed; the 2026-10-13 finding ledger carries per-finding status
  and evidence.

## OCR findings disposition

`ocr review --audience agent --from d590e51d --to HEAD --concurrency 3` (report archived at
`/tmp/ocr-billing-remediation.txt`; 6 findings, none blocking). Each was verified against the
code before disposition — all six held and were fixed in the follow-up commit:

| # | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| 1 | low | app.ts middleware comment claimed the worker dispatch overrides the session floor's `web` "underneath" it — the dispatch route is `/internal/routines/run`, not under `/api/*`, so no `web` floor exists on that request. | **Valid, fixed** — both comments rewritten: the route names `api` standalone, not as an inner override. |
| 2 | low | The dispatch-site comment made the same non-existent nesting claim. | **Valid, fixed** — same rewrite. |
| 3 | low | `ModelUsageGateInput.client` typed `string` while its docblock claims the controlled vocabulary; `UsageOrigin` exists and narrows it at compile time. | **Valid, fixed** — `client: UsageOrigin`, type imported. |
| 4 | medium | The tests call `withUsageOrigin("cli", ...)` but `"cli"` was not in the union — passing only because tests are outside today's typecheck (a recorded known gap); a future CLI surface could not compile against the vocabulary. | **Valid, fixed** — `"cli"` added to `UsageOrigin` (the vocabulary's intended fourth door; no server entry point sets it yet), docblock updated to say the type plus the setting doors are the fence. |
| 5 | low | "every API surface" over-promised: four earlier-mounted `/api/*` surfaces (`/api/capabilities`, `/api/auth/*`, desktop-connection, provider-proxy) never pass the floor (Hono registration order). None records usage today. | **Valid, fixed** — comment now scopes the floor to "usage-bearing API surfaces mounted below this point" and names the earlier mounts plus the rule for future ones. |
| 6 | low | Two clocks for one "is it expired" decision: admission used `Date.now()` while the `held` subquery used the database's `now()` — a skewed pair reopens the capacity leak at the boundary (a hold admitted as live that the capacity sum already vacates). | **Valid, fixed** — `freeGrants` binds one app-side instant `at` for both the grant-liveness filter and the hold-expiry filter (parameter-bound), documented in the function header. |

Post-fix verification: `bun run --filter server typecheck` exit 0; `workshop-metering` +
`copilot-usage-meter` (32 tests) and `billing-credits-writer.integration` (23 tests) all
pass, 0 fail.
