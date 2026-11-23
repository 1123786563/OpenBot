CREATE TABLE "billing_suspension_history" (
  "account_id" uuid NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone NOT NULL,
  CONSTRAINT "billing_suspension_history_account_id_started_at_pk" PRIMARY KEY ("account_id", "started_at"),
  CONSTRAINT "billing_suspension_history_time" CHECK ("billing_suspension_history"."ended_at" >= "billing_suspension_history"."started_at")
);--> statement-breakpoint
ALTER TABLE "billing_suspension_history" ADD CONSTRAINT "billing_suspension_history_account_id_test_credit_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."test_credit_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_orders" ADD COLUMN "switched_from_order_id" uuid;--> statement-breakpoint
ALTER TABLE "paid_orders" ADD COLUMN "checkout_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "paid_orders" ADD COLUMN "renews_order_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "paid_orders_switch_once" ON "paid_orders" USING btree ("switched_from_order_id");--> statement-breakpoint
CREATE INDEX "paid_orders_checkout_attempt" ON "paid_orders" USING btree ("checkout_attempt_id");
