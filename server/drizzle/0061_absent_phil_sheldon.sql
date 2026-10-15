ALTER TABLE "enterprise_run_outbox" ADD COLUMN "claim_id" uuid;--> statement-breakpoint
ALTER TABLE "enterprise_run_outbox" ADD COLUMN "claim_owner_id" text;--> statement-breakpoint
ALTER TABLE "enterprise_run_outbox" ADD COLUMN "claim_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "enterprise_run_outbox_claim_idx" ON "enterprise_run_outbox" USING btree ("claim_expires_at","created_at") WHERE "enterprise_run_outbox"."delivered_at" is null;--> statement-breakpoint
ALTER TABLE "enterprise_run_outbox" ADD CONSTRAINT "enterprise_run_outbox_claim_check" CHECK (("enterprise_run_outbox"."claim_id" is null and "enterprise_run_outbox"."claim_owner_id" is null and "enterprise_run_outbox"."claim_expires_at" is null) or ("enterprise_run_outbox"."claim_id" is not null and "enterprise_run_outbox"."claim_owner_id" is not null and "enterprise_run_outbox"."claim_expires_at" is not null));--> statement-breakpoint
GRANT UPDATE ("delivered_at", "delivery_attempts", "claim_id", "claim_owner_id", "claim_expires_at") ON TABLE "enterprise_run_outbox" TO ob_ent_data;
