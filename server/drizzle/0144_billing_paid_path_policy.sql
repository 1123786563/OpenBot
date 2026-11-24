ALTER TABLE "billing_spending_authorizations" ADD COLUMN "credit_type" text;--> statement-breakpoint
ALTER TABLE "test_credit_operations" ADD COLUMN "reconciliation_cutoff_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "test_credit_operations" ADD COLUMN "pilot_resource" text;--> statement-breakpoint
ALTER TABLE "test_credit_operations" ADD COLUMN "requested_credit_type" text;--> statement-breakpoint
CREATE INDEX "test_credit_operations_paid_cutoff_idx" ON "test_credit_operations" USING btree ("reconciliation_cutoff_at","account_id","id") WHERE "test_credit_operations"."state" = 'pending' AND "test_credit_operations"."cutoff_hold" IS NULL AND "test_credit_operations"."reconciliation_cutoff_at" IS NOT NULL;