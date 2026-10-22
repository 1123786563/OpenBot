-- Bifrost 08.4 (#279): the retry's own column on the recovery item — when the background
-- retry scheduler may claim the item again.
--
-- WHAT THE COLUMN IS. The durable carrier of the backoff schedule. A failed recovery
-- attempt (08.2's replay failing to re-deliver, 08.5's query answering still-unknown)
-- moves the item back to `pending` AND stamps `next_retry_at = now + backoff(failure_count)`:
-- the scheduler's due-read claims the item only at or after that instant, so retries
-- space out exponentially instead of free-spinning every sweep. NULL means "due now":
-- a fresh scan-inserted item (failure_count 0, never attempted) is claimable immediately,
-- and an item whose failure count reached the threshold is written back to NULL — no next
-- retry exists for it, which together with the due-read's failure_count gate is how the
-- item leaves the automatic lanes and lives only in 08.9's manual disposal queue.
--
-- WHY A COLUMN AND NOT `updated_at` ARITHMETIC. The backoff is a fact about the item's
-- lifecycle the operator reads on the review surface, not an implementation detail of one
-- scheduler: deriving it from `updated_at` would make any unrelated write (a handback, a
-- racing claim) silently re-arm the clock. A column the failure path alone writes keeps
-- the schedule the item's own truth, restart-proof across processes and replicas.

ALTER TABLE "credit_recovery_items" ADD COLUMN "next_retry_at" timestamp with time zone;

-- The retry scheduler's due-read: pending items whose retry is due now, oldest detection
-- first. Partial (state is always filtered) so the index never carries resolved rows.
CREATE INDEX "credit_recovery_items_state_next_retry_idx" ON "credit_recovery_items" USING btree ("state", "next_retry_at", "detected_at");
