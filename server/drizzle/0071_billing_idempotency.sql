-- Billing batch 1: the credit ledger's write side gets its idempotency anchor, and the payment
-- orders get their one-open-order-per-pair database fact. Two independent statements, one
-- migration, because they ship together.
--
-- Statement 1: `credit_grants.idempotency_key` (NOT NULL) + a plain unique index. Every grant
-- carries a writer-derived key: `plan:<orderId>` makes a retried payment activation ONE grant
-- (INSERT ... ON CONFLICT DO NOTHING in credits-writer.ts), and a random `auto:` key keeps an
-- admin's two promo presses two grants. Plain (not partial) on purpose: Postgres cannot infer a
-- partial index for ON CONFLICT without the WHERE spelled in-statement, and the column being
-- NOT NULL is what makes the plain index both inferable and total. No data change was needed:
-- the table has never had a writer (P0-1), so the column lands empty-to-be-filled.
-- The old `status` comment's "sweeper" was a lie — reads always derived the live status
-- (credits.ts `deriveGrantStatus`); the corrected schema notes the column is a birth state only.
--
-- Statement 2: `payment_orders` partial unique index on (plan_code, provider) WHERE
-- status='pending'. Before this, two concurrent createPurchase calls both passed the
-- read-before-insert replay check and both QR codes went live (P1-1: double collection, one
-- entitlement, no anomaly). The store's INSERT ... ON CONFLICT DO NOTHING now makes the losing
-- racer replay into the winner's order. Partial on pending — the WHERE lives in the index only,
-- never in an ON CONFLICT clause — because a plan's terminal history (paid / expired / canceled
-- / blocked) is exactly what repeated buying should accumulate.
--
-- Deployment note: the pending-pair index creation fails if a database already holds TWO
-- pending orders on one (plan, provider) pair — the double the index exists to prevent. A
-- deployment in that state should cancel the older pending order first (the admin cancel
-- endpoint is idempotent); no automatic cleanup is baked in, on purpose, because choosing
-- which pending order dies is an operator's decision, not a migration's.
ALTER TABLE "credit_grants" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_grants_idempotency_key_unique_idx" ON "credit_grants" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_orders_pending_pair_unique_idx" ON "payment_orders" USING btree ("plan_code","provider") WHERE "payment_orders"."status" = 'pending';
