ALTER TABLE "paid_corrections" ADD COLUMN "available_before_microcredits" bigint;--> statement-breakpoint
ALTER TABLE "paid_corrections" ADD COLUMN "available_after_microcredits" bigint;--> statement-breakpoint
ALTER TABLE "paid_corrections" ADD COLUMN "correction_credits_microcredits" bigint;