ALTER TABLE "billing_subscriptions" ADD COLUMN "owner_payer_kind" text;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "owner_payer_id" text;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "allowance_period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "allowance_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_owner_pair_check" CHECK (("billing_subscriptions"."owner_payer_kind" IS NULL) = ("billing_subscriptions"."owner_payer_id" IS NULL));--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_owner_kind_check" CHECK ("billing_subscriptions"."owner_payer_kind" IS NULL OR "billing_subscriptions"."owner_payer_kind" IN ('personal', 'company', 'legacy_deployment', 'unknown_owner'));--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_allowance_pair_check" CHECK (("billing_subscriptions"."allowance_period_start" IS NULL) = ("billing_subscriptions"."allowance_period_end" IS NULL));--> statement-breakpoint
CREATE INDEX "billing_subscriptions_owner_idx" ON "billing_subscriptions" USING btree ("owner_payer_id","owner_payer_kind");
