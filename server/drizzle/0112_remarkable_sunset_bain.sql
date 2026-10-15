ALTER TABLE "openmuse_tasks" ADD COLUMN "monitor_condition" jsonb;--> statement-breakpoint
ALTER TABLE "openmuse_tasks" ADD COLUMN "next_check_at" timestamp with time zone;