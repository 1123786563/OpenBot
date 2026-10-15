ALTER TABLE "billing_webhook_events" ADD COLUMN "body_hash" text;--> statement-breakpoint
CREATE INDEX "billing_webhook_events_body_hash_idx" ON "billing_webhook_events" USING btree ("body_hash");
