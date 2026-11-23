CREATE TABLE "paid_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"operation_id" text,
	"entitlement_id" uuid,
	"kind" text NOT NULL,
	"amount_microcredits" bigint NOT NULL,
	"reason" text NOT NULL,
	"evidence" text NOT NULL,
	"by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paid_corrections_amounts" CHECK ("paid_corrections"."amount_microcredits" > 0)
);
--> statement-breakpoint
ALTER TABLE "paid_entitlements" ALTER COLUMN "order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "paid_corrections" ADD CONSTRAINT "paid_corrections_account_id_test_credit_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."test_credit_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_corrections" ADD CONSTRAINT "paid_corrections_entitlement_id_paid_entitlements_id_fk" FOREIGN KEY ("entitlement_id") REFERENCES "public"."paid_entitlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paid_corrections_account" ON "paid_corrections" USING btree ("account_id","created_at");