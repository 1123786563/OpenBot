# Billing Reliability Design

## Goal

Make subscription purchase, payment settlement, credit accounting, usage metering, and billing history recoverable and reconcilable without weakening the existing integer-money, idempotency, and transaction invariants.

## Current shape

- Lago owns the subscription state and provider-side usage events; local `billing_subscriptions` rows are projections. Payment orders and the credit ledger are local records. A bill is currently a view of a payment order rather than a provider-issued invoice.
- Payment confirmation atomically changes a payment order and inserts a paid fact. Subscription activation and plan-credit payout follow as external/local steps and are retried by the activation sweep.
- Credit balances are stored as integer hundredths of a credit. Credit consumption locks eligible grants and writes the ledger and grant usage in one database transaction.
- Model and code-run token usage is reported after work finishes. The model meter uses a process-local counter in its Lago and ledger idempotency key; both reporting paths are non-blocking.
- Purchase checks for an existing live subscription before inserting an order. The database prevents duplicate pending orders for a single `(plan_code, provider)` pair, not across plans or providers.
- The read-only reconciler checks payment/fact agreement, presence of a live subscription for applied orders, and aggregate grant-used/ledger-applied equality.

## Design

Treat the work as separate, testable changes with one dependency overview:

1. **Usage event identity and delivery:** give every model call a stable, globally unique occurrence identity that survives process restarts and replicas. Persist completed usage as durable work before asynchronous delivery to Lago and the credit ledger; retries reuse the same identity. Include code-run reporting in the same reliability contract.
2. **Purchase and activation concurrency:** make the “no live subscription → open purchase” decision serialize at the deployment/customer scope across plans and channels. Preserve order price snapshots and the paid-fact transaction. Keep external activation retryable, record durable outcomes, and expose collected-money/unfulfilled-entitlement cases for recovery rather than acknowledging failed settlement as success.
3. **Credit enforcement semantics:** after the business policy is decided, make pre-call admission and post-call charging agree. If balances are hard limits, reserve estimated usage atomically and settle/release against actual usage; if overdraft is allowed, record and expose it explicitly and define how later grants interact with it. Both model and code-run paths must follow the chosen rule.
4. **Webhook retry behavior:** only mark a delivery complete after its projection update is durable. Classify storage/provider failures so retryable failures receive retryable HTTP responses; preserve idempotent replay handling.
5. **Billing history and reconciliation:** use immutable per-order period and charge snapshots for historical bills, distinguish payment time from other terminal times, and apply the agreed access scope. Extend reconciliation to cover activation/grant drift, unreconciled durable usage, and individual payment anomalies without discarding distinct transaction evidence.

## Decisions required before affected implementation

- **Credit policy — decided:** enforce a hard spending ceiling with atomic pre-call reservation, then settle actual cost and release unused capacity. Price by configured model and input/output token class, with a separate configured code-run rate. Configure a per-model maximum reservation (or equivalent token ceiling) for each model call; configure a corresponding maximum for each code-run class. Reject work before invoking the provider/sandbox if its maximum cannot be reserved. Missing applicable rate or maximum-reservation configuration fails closed; do not use the old placeholder rate as a fallback. Numeric rate values and limits are deployment inputs. When rate arithmetic produces a fractional scaled-credit unit, accumulate the exact remainder per customer rather than rounding each event upward.
- **Credit-policy deployment contract — decided:** the deployment names exact hard-cap inputs with four environment keys: `BILLING_MODEL_CREDIT_RATES` (JSON object: model id → `{ input, output }` rational rates), `BILLING_MODEL_MAX_RESERVATION_TOKENS` (JSON object: model id → `{ input, output }` token ceilings), `BILLING_CODE_RUN_CREDIT_RATE` (one rational rate), and `BILLING_CODE_RUN_MAX_RESERVATION_TOKENS` (one whole-token ceiling). Every rate is an integer numerator/denominator in scaled credit units per token (`CREDIT_SCALE = 100`); every maximum is whole tokens. Configuration resolves to a typed `configured | unconfigured` result rather than a fabricated fallback price. A missing, malformed, negative, zero-denominator, or out-of-range value leaves the policy unconfigured so later metered work can refuse before provider/sandbox execution.
- **Billing visibility — decided:** scope orders, bills, and checkout material to the authenticated user. `AuthenticatedActor.id` is the stable user key available to the purchase route and is persisted as `payment_orders.created_by`; the actor contract has no tenant identifier, so do not invent tenant ownership or tenant columns. Every invoice/order read, pending-order read, and checkout-material read must filter by that same owner and return not-found for another user's records.
- **Late/duplicate collections — decided:** preserve every confirmed payment fact and retain later collections for manual operator resolution. Do not automatically refund a duplicate collection or issue the same entitlement/credit payout twice. Any refund or automated disposition requires a separate future decision.
- **Code-run budget requirement:** the current server-to-sandbox contract exposes a timeout but no enforceable token ceiling. A reservation without a sandbox-enforced maximum cannot guarantee the hard cap. Keep code-run billing/admission fail-closed until the sandbox contract can enforce the configured token budget; never treat timeout as a usage cap.

## Boundaries and dependencies

- Usage reliability and purchase concurrency can proceed independently after the policy decisions that affect them.
- Credit enforcement depends on the credit policy and the stable usage identity from the usage-event work.
- Webhook retry semantics are independent of purchase locking but must retain the current authoritative re-read behavior.
- Historical bill snapshots depend on the agreed bill visibility scope; reconciliation should follow the resulting usage, order, and credit record shapes.
- Keep the payment provider adapters, Lago adapter, credit writer, and HTTP routes behind their existing module interfaces where possible. Add a new seam only where the durable work or serialization mechanism actually varies.

## Error handling and verification

- Do not acknowledge a payment callback as successful when its durable paid fact was not committed.
- Keep amounts and credit units as integers in storage; do not introduce binary floating-point accounting.
- Use database uniqueness/transactions or durable idempotency records as the correctness authority; read-before-write checks may remain optimizations only.
- Test restart/replay and concurrent requests against real database constraints, and test retry responses for injected storage/provider failures.
- Verify invoice history against multiple orders and periods, and verify reconciliation catches both one-sided and correlated omissions.
