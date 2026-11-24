ALTER TABLE "paid_orders" ADD COLUMN "locked_kind" text;--> statement-breakpoint
ALTER TABLE "paid_orders" ADD COLUMN "locked_microcredits" bigint;--> statement-breakpoint
ALTER TABLE "paid_orders" ADD COLUMN "test_merchant" text;