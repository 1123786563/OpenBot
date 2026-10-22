-- Bifrost 18.4 (#336): the item-level cancellation semantics — the `cancelled`
-- classification, the batch's `cancelled` terminal state, and the cancelled count.
--
-- A CANCELLATION IS A TERMINAL FACT WITH TWO MONEY SHAPES. An item the provider executed
-- and then cancelled was BILLED for what ran: it settles its actual cost in full (丢账 —
-- a lost charge — is half of what this ticket exists to prevent), so its outcome row
-- carries the usage that prices it. An item cancelled BEFORE anything ran releases — but
-- only on `cancelled_unbilled` evidence (the provider's own cancellation
-- acknowledgement), never on the client's wish: a cancel request is not no-charge
-- evidence, and without either shape the item is `unknown` and keeps the hold. The
-- extended shape CHECK pins the pair: a cancelled row carries usage OR evidence, never
-- neither and never the contradiction of both (a billed item cannot claim unbilled).
--
-- THE ITEM ID IS THE IDEMPOTENCY KEY. `batch_item_outcomes` is keyed by item_id (one row
-- per item, ever — a duplicate notification increments its counter, never a second row)
-- and `credit_batch_settlement_details` likewise (one charge line per item, ever) — with
-- the reservation's own one-settle fence, three layers answer the ticket's "同一条目不
-- 会被结算两次".
--
-- THE BATCH STATE. An all-cancelled batch records `cancelled`; any mix with completion
-- records `partial` (18.3's rule, unchanged). `cancelled_count` joins the per-class
-- counts the status view reads.

ALTER TABLE "batch_item_outcomes" DROP CONSTRAINT "batch_item_outcomes_classification_check";
ALTER TABLE "batch_item_outcomes" ADD CONSTRAINT "batch_item_outcomes_classification_check" CHECK ("classification" IN ('completed', 'failed_billable', 'not_dispatched', 'unknown', 'cancelled'));

ALTER TABLE "batch_item_outcomes" DROP CONSTRAINT "batch_item_outcomes_shape_check";
ALTER TABLE "batch_item_outcomes" ADD CONSTRAINT "batch_item_outcomes_shape_check" CHECK (
  ("classification" IN ('completed', 'failed_billable') AND "terminal_state" IS NOT NULL AND "usage" IS NOT NULL)
  OR ("classification" = 'not_dispatched' AND "evidence" IS NOT NULL)
  OR ("classification" = 'cancelled' AND (("terminal_state" IS NOT NULL AND "usage" IS NOT NULL) OR "evidence" IS NOT NULL))
  OR ("classification" = 'unknown')
);

ALTER TABLE "batch_jobs" ADD COLUMN "cancelled_count" integer NOT NULL DEFAULT 0;

ALTER TABLE "batch_jobs" DROP CONSTRAINT "batch_jobs_counts_check";
ALTER TABLE "batch_jobs" ADD CONSTRAINT "batch_jobs_counts_check" CHECK (
  "completed_count" >= 0 AND "failed_billable_count" >= 0
  AND "released_count" >= 0 AND "unknown_count" >= 0 AND "cancelled_count" >= 0
);

ALTER TABLE "batch_jobs" DROP CONSTRAINT "batch_jobs_state_check";
ALTER TABLE "batch_jobs" ADD CONSTRAINT "batch_jobs_state_check" CHECK ("state" IN ('submitted', 'dispatch_unconfirmed', 'partial', 'completed', 'failed', 'cancelled'));

ALTER TABLE "batch_jobs" DROP CONSTRAINT "batch_jobs_dispatch_shape_check";
ALTER TABLE "batch_jobs" ADD CONSTRAINT "batch_jobs_dispatch_shape_check" CHECK (
  ("state" = 'submitted' AND "provider_batch_id" IS NOT NULL AND "dispatched_at" IS NOT NULL)
  OR ("state" = 'dispatch_unconfirmed' AND "provider_batch_id" IS NULL)
  OR ("state" IN ('partial', 'completed', 'failed', 'cancelled') AND "provider_batch_id" IS NOT NULL AND "settled_at" IS NOT NULL)
);
