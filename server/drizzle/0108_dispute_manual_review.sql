ALTER TABLE "paid_refunds" ADD COLUMN "opened_by" text DEFAULT 'channel' NOT NULL;--> statement-breakpoint
ALTER TABLE "paid_refunds" ADD COLUMN "used_microcredits" bigint;--> statement-breakpoint
ALTER TABLE "paid_refunds" ADD COLUMN "manual_review_cents" integer;