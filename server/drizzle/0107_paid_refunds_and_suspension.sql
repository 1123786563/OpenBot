CREATE TABLE "paid_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "paid_refunds_amounts" CHECK ("paid_refunds"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "test_credit_accounts" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "paid_refunds" ADD CONSTRAINT "paid_refunds_order_id_paid_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."paid_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_refunds" ADD CONSTRAINT "paid_refunds_account_id_test_credit_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."test_credit_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paid_refunds_order" ON "paid_refunds" USING btree ("order_id");