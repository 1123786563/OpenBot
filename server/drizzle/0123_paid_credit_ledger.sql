CREATE TABLE "paid_entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"anchor_day" integer,
	"credits_microcredits" bigint NOT NULL,
	"state" text DEFAULT 'granted' NOT NULL,
	"arrived_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paid_entitlements_amounts" CHECK ("paid_entitlements"."credits_microcredits" > 0 AND ("paid_entitlements"."kind" <> 'subscription' OR ("paid_entitlements"."period_start" IS NOT NULL AND "paid_entitlements"."period_end" IS NOT NULL AND "paid_entitlements"."period_end" > "paid_entitlements"."period_start" AND "paid_entitlements"."anchor_day" BETWEEN 1 AND 31)))
);
--> statement-breakpoint
CREATE TABLE "paid_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"product_code" text NOT NULL,
	"product_version" integer NOT NULL,
	"price_cents" integer NOT NULL,
	"channel" text NOT NULL,
	"channel_order_ref" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paid_orders_amounts" CHECK ("paid_orders"."product_version" > 0 AND "paid_orders"."price_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "paid_products" (
	"code" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"version" integer NOT NULL,
	"priceCents" integer NOT NULL,
	"credits_microcredits" bigint NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paid_products_amounts" CHECK ("paid_products"."version" > 0 AND "paid_products"."priceCents" > 0 AND "paid_products"."credits_microcredits" > 0)
);
--> statement-breakpoint
ALTER TABLE "paid_entitlements" ADD CONSTRAINT "paid_entitlements_account_id_test_credit_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."test_credit_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_entitlements" ADD CONSTRAINT "paid_entitlements_order_id_paid_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."paid_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_orders" ADD CONSTRAINT "paid_orders_account_id_test_credit_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."test_credit_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paid_entitlements_one_future" ON "paid_entitlements" USING btree ("account_id") WHERE kind = 'subscription' AND state = 'future';--> statement-breakpoint
CREATE INDEX "paid_entitlements_account" ON "paid_entitlements" USING btree ("account_id","arrived_at");--> statement-breakpoint
CREATE UNIQUE INDEX "paid_orders_channel_ref" ON "paid_orders" USING btree ("channel","channel_order_ref");