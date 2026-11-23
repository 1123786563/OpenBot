CREATE TABLE "paid_credit_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"entitlement_id" uuid,
	"position" integer NOT NULL,
	"amount_microcredits" bigint NOT NULL,
	"state" text DEFAULT 'held' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "paid_credit_allocations_amount" CHECK ("paid_credit_allocations"."amount_microcredits" > 0)
);
--> statement-breakpoint
ALTER TABLE "paid_entitlements" DROP CONSTRAINT "paid_entitlements_amounts";--> statement-breakpoint
ALTER TABLE "paid_entitlements" ADD COLUMN "consumed_microcredits" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "paid_credit_allocations" ADD CONSTRAINT "paid_credit_allocations_account_id_test_credit_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."test_credit_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_credit_allocations" ADD CONSTRAINT "paid_credit_allocations_entitlement_id_paid_entitlements_id_fk" FOREIGN KEY ("entitlement_id") REFERENCES "public"."paid_entitlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paid_credit_allocations_operation" ON "paid_credit_allocations" USING btree ("account_id","operation_id","position");--> statement-breakpoint
CREATE INDEX "paid_credit_allocations_holds" ON "paid_credit_allocations" USING btree ("entitlement_id","state");--> statement-breakpoint
ALTER TABLE "paid_entitlements" ADD CONSTRAINT "paid_entitlements_amounts" CHECK ("paid_entitlements"."credits_microcredits" > 0 AND "paid_entitlements"."consumed_microcredits" >= 0 AND "paid_entitlements"."consumed_microcredits" <= "paid_entitlements"."credits_microcredits" AND ("paid_entitlements"."kind" <> 'subscription' OR ("paid_entitlements"."period_start" IS NOT NULL AND "paid_entitlements"."period_end" IS NOT NULL AND "paid_entitlements"."period_end" > "paid_entitlements"."period_start" AND "paid_entitlements"."anchor_day" BETWEEN 1 AND 31)));