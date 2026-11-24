ALTER TABLE "direct_chat_runs" ADD COLUMN "dispatched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "direct_chat_runs" ADD COLUMN "external_outcome" text;--> statement-breakpoint
ALTER TABLE "direct_chat_runs" ADD COLUMN "stop_reason" text;--> statement-breakpoint
UPDATE "direct_chat_runs"
SET "dispatched_at" = "started_at", "external_outcome" = 'dispatching'
WHERE "status" = 'running';
