DROP INDEX "payment_orders_pending_pair_unique_idx";--> statement-breakpoint
ALTER TABLE "payment_orders" ADD COLUMN "deployment_scope" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_orders_pending_scope_unique_idx" ON "payment_orders" USING btree ("deployment_scope") WHERE "payment_orders"."status" = 'pending';