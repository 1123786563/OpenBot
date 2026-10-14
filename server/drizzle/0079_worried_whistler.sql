DROP INDEX "usage_outbox_lago_pending_created_idx";--> statement-breakpoint
DROP INDEX "usage_outbox_credits_pending_created_idx";--> statement-breakpoint
CREATE INDEX "usage_outbox_lago_pending_updated_idx" ON "usage_outbox" USING btree ("lago_status","updated_at");--> statement-breakpoint
CREATE INDEX "usage_outbox_credits_pending_updated_idx" ON "usage_outbox" USING btree ("credits_status","updated_at");