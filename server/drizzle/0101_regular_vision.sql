ALTER TABLE "openmuse_oauth_pending" ADD COLUMN "nonce" text;--> statement-breakpoint
ALTER TABLE "openmuse_oauth_pending" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "openmuse_oauth_pending" ADD COLUMN "connection_id" text;