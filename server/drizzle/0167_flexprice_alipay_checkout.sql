ALTER TABLE "paid_orders" ADD COLUMN "flexprice_checkout" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "paid_orders" ADD COLUMN "flexprice_invoice_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "paid_orders_flexprice_invoice" ON "paid_orders" USING btree ("flexprice_invoice_id");--> statement-breakpoint
CREATE INDEX "paid_orders_flexprice_pending" ON "paid_orders" USING btree ("id") WHERE "paid_orders"."flexprice_invoice_id" is not null and "paid_orders"."state" = 'pending';--> statement-breakpoint
ALTER TABLE "paid_orders" ADD CONSTRAINT "paid_orders_flexprice_checkout" CHECK ("paid_orders"."flexprice_invoice_id" is null or "paid_orders"."flexprice_checkout");