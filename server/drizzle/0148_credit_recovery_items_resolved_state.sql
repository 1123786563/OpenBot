-- Bifrost 08.2 (#277): the recovery item's terminal state.
--
-- A recovery item's lifecycle now ends: pending (unclaimed) → claimed (one worker owns
-- it) → resolved (the handler finished it — 08.2's unacked-result replay marks an item
-- resolved once the persisted result was re-delivered to Settle and acked, or when the
-- record proves delivery already happened). `resolved` keeps the claim's who/when: the
-- worker that finished the item is part of the resolution's evidence, and the failure
-- count / last_reason stay as the history of how many attempts it took.
--
-- A failed replay does NOT move the item here: it hands the item back to pending with
-- failure_count incremented and last_reason naming the stable failure code — the item is
-- retained, never lost (AC: 重放失败不丢失 RecoveryItem). The claim-consistency CHECK
-- keeps pending ↔ NULL claim columns inseparable and claimed|resolved ↔ NOT NULL ones.
ALTER TABLE "credit_recovery_items" DROP CONSTRAINT "credit_recovery_items_state_check";--> statement-breakpoint
ALTER TABLE "credit_recovery_items" ADD CONSTRAINT "credit_recovery_items_state_check" CHECK ("credit_recovery_items"."state" IN ('pending', 'claimed', 'resolved'));--> statement-breakpoint
ALTER TABLE "credit_recovery_items" DROP CONSTRAINT "credit_recovery_items_claim_consistency_check";--> statement-breakpoint
ALTER TABLE "credit_recovery_items" ADD CONSTRAINT "credit_recovery_items_claim_consistency_check" CHECK (("credit_recovery_items"."state" = 'pending' AND "credit_recovery_items"."claimed_at" IS NULL AND "credit_recovery_items"."claimed_by" IS NULL) OR ("credit_recovery_items"."state" IN ('claimed', 'resolved') AND "credit_recovery_items"."claimed_at" IS NOT NULL AND "credit_recovery_items"."claimed_by" IS NOT NULL));
