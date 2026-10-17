ALTER TABLE "payment_orders" ADD COLUMN "owner_payer_kind" text;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD COLUMN "owner_payer_id" text;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_owner_pair_check" CHECK (("payment_orders"."owner_payer_kind" IS NULL) = ("payment_orders"."owner_payer_id" IS NULL));--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_owner_kind_check" CHECK ("payment_orders"."owner_payer_kind" IS NULL OR "payment_orders"."owner_payer_kind" IN ('personal', 'company', 'legacy_deployment', 'unknown_owner'));--> statement-breakpoint
CREATE INDEX "payment_orders_owner_idx" ON "payment_orders" USING btree ("owner_payer_id","owner_payer_kind");
