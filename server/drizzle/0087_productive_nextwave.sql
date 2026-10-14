-- Upgrade precondition: at most one legacy pending order across ALL plans/providers.
-- This generated migration has been applied only to the disposable local test DB, not deployed.
-- Run the migration transactionally with checkout writes paused. The lock below also prevents
-- new pending rows from racing the preflight until the new index has been installed.
--
-- If refused, operators must reconcile every open provider session, close/cancel unpaid sessions
-- at the provider and through the existing CAS-backed local cancellation flow, and retain paid
-- facts, order price snapshots and anomaly evidence for manual resolution. Do not pick a winner,
-- delete orders, or blindly auto-cancel: an old remote session can still collect money.
-- Verify no more than one pending order remains, then rerun the migration.
DO $$
BEGIN
  LOCK TABLE "payment_orders" IN ACCESS EXCLUSIVE MODE;
  IF (SELECT count(*) FROM "payment_orders" WHERE "status" = 'pending') > 1 THEN
    RAISE EXCEPTION 'Payment purchase migration refused: conflicting legacy pending orders.'
      USING HINT = 'Pause checkout; reconcile/cancel open provider sessions and local pending orders, preserve payment evidence, then rerun with at most one pending order.';
  END IF;
END $$;--> statement-breakpoint
DROP INDEX "payment_orders_pending_pair_unique_idx";--> statement-breakpoint
ALTER TABLE "payment_orders" ADD COLUMN "deployment_scope" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_orders_pending_scope_unique_idx" ON "payment_orders" USING btree ("deployment_scope") WHERE "payment_orders"."status" = 'pending';