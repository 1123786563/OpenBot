-- Company subscription renewal and period correction (BP05 / #373).
--
-- The billing provider namespaces external subscription ids per customer: a personal
-- deployment's subscription and a company's can share the id string. billing_subscriptions
-- keyed the row by the bare string, so the second upsert would re-home the first row to
-- another customer while leaving its owner pair untouched — one row standing for two
-- accounts' subscriptions, and one renewal payout silently refusing the other's. The row's
-- identity becomes the (external_customer_id, external_subscription_id) pair, the same
-- domain the provider itself answers in. The renewal payout's ledger key carries the
-- account too (server/src/billing/plan-renewals.ts), so the two payouts cannot collapse on
-- credit_grants' globally-unique idempotency index either.
--
-- Existing rows are untouched: every one already carries its own customer, and no company
-- subscriptions existed before this change (company purchases land with BP01), so the
-- collision this constraint exists to prevent was never representable in stored data.
ALTER TABLE "billing_subscriptions" DROP CONSTRAINT "billing_subscriptions_pkey";
ALTER TABLE "billing_subscriptions"
  ADD PRIMARY KEY ("external_customer_id", "external_subscription_id");
