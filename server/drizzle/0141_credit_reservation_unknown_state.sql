-- Bifrost 06.8 (#259, Q12/AC15): the unknown-result hold state.
--
-- A provider call whose result never reliably arrived (stream error, missing usage,
-- cancellation) may still have produced billable work, so its hold is not release
-- evidence. `unknown` is that state: the hold keeps occupying capacity no matter how
-- far the clock advances past `expires_at` — the expiry field fences only plain
-- reserved holds and new admissions, never an unknown one — and only recovery settles
-- it (the ordinary settle path, same reservation id) or the recovery release moves it.
--
-- `unknown_at`/`unknown_reason` record the instant and the unsettled reason the hold
-- entered the state (the evidence 08.x's recovery and an evidenced admin disposal stand
-- on). Both stay on the row as history after a later terminal state; a hold that was
-- never unknown has neither, and a plain `reserved` hold may not carry them.
--
-- Numbered 0141 on purpose: 0140 is reserved for the pending #256 (06.5) delivery, so
-- this worktree's migration does not collide with it. Renumber at integration if the
-- chain requires it (the #231 precedent).
ALTER TABLE "credit_reservations" ADD COLUMN "unknown_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD COLUMN "unknown_reason" text;
--> statement-breakpoint
ALTER TABLE "credit_reservations" DROP CONSTRAINT "credit_reservations_status_check";
--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_status_check" CHECK ("credit_reservations"."status" IN ('reserved', 'unknown', 'settled', 'released'));
--> statement-breakpoint
ALTER TABLE "credit_reservations" DROP CONSTRAINT "credit_reservations_terminal_check";
--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_terminal_check" CHECK (("credit_reservations"."status" IN ('reserved', 'unknown') AND "credit_reservations"."terminal_at" IS NULL) OR ("credit_reservations"."status" IN ('settled', 'released') AND "credit_reservations"."terminal_at" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "credit_reservations" DROP CONSTRAINT IF EXISTS "credit_reservations_unknown_evidence_check";
--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_unknown_evidence_check" CHECK (("credit_reservations"."unknown_at" IS NULL) = ("credit_reservations"."unknown_reason" IS NULL) AND ("credit_reservations"."status" <> 'reserved' OR "credit_reservations"."unknown_at" IS NULL) AND ("credit_reservations"."status" <> 'unknown' OR "credit_reservations"."unknown_at" IS NOT NULL));
