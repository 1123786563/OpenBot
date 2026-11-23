ALTER TABLE "test_credit_operations"
  ADD COLUMN "embedding_input_digest" text,
  ADD COLUMN "embedding_result" jsonb,
  ADD COLUMN "embedding_result_expires_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "test_credit_embedding_result_expiry_idx"
  ON "test_credit_operations" ("embedding_result_expires_at")
  WHERE "embedding_result_expires_at" IS NOT NULL;
