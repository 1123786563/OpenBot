ALTER TABLE "usage_outbox" ADD COLUMN "lago_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_outbox" ADD COLUMN "credits_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_outbox" ADD CONSTRAINT "usage_outbox_lago_attempts_check" CHECK ("usage_outbox"."lago_attempts" >= 0);--> statement-breakpoint
ALTER TABLE "usage_outbox" ADD CONSTRAINT "usage_outbox_credits_attempts_check" CHECK ("usage_outbox"."credits_attempts" >= 0);