ALTER TABLE "test_credit_operations" ADD COLUMN "gateway_request_id" uuid;--> statement-breakpoint
ALTER TABLE "test_credit_operations" ADD COLUMN "gateway_request_digest" text;--> statement-breakpoint
ALTER TABLE "test_credit_operations" ADD COLUMN "gateway_evidence_check_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "test_credit_operations_gateway_evidence_idx" ON "test_credit_operations" USING btree ("gateway_evidence_check_at") WHERE "test_credit_operations"."gateway_evidence_check_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "test_credit_operations" ADD CONSTRAINT "test_credit_operations_gateway_request_id_unique" UNIQUE("gateway_request_id");