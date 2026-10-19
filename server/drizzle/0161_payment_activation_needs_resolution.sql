-- Billing payment BP03 (#371): 已收款订单的订阅与积分交付恢复.
--
-- The activation state gains `needs_resolution`: a paid order whose entitlement is owned by
-- another overlapping order (duplicate_paid) is a deterministic conflict no retry can settle.
-- It leaves the sweep's retry list and is never `applied`, while the money facts and the
-- anomaly evidence stay untouched for the operator's resolution queue (BP05/#373).
--
-- `activation_failure_reason` and `activation_next_retry_at` retain, per failed attempt, why
-- the activation did not land (one stable word: grant_write_failed, provider_unreachable,
-- duplicate_paid, the refusal rule's name, …) and when the sweep's next pass runs. The sweep
-- interval is the scheduler; the columns are the recorded fact, rewritten per failure and
-- cleared the moment activation lands (recordActivation applied).
ALTER TABLE "payment_orders" DROP CONSTRAINT "payment_orders_activation_state_check";
--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_activation_state_check" CHECK ("payment_orders"."activation_state" IN ('pending', 'applied', 'failed', 'needs_resolution'));
--> statement-breakpoint
ALTER TABLE "payment_orders" ADD COLUMN "activation_failure_reason" text;
--> statement-breakpoint
ALTER TABLE "payment_orders" ADD COLUMN "activation_next_retry_at" timestamp with time zone;
