ALTER TABLE "payment_orders" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
UPDATE "payment_orders"
SET "paid_at" = "terminal_at"
WHERE "status" = 'paid' AND "paid_at" IS NULL;--> statement-breakpoint