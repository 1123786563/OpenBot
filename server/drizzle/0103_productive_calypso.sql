ALTER TABLE "openmuse_tasks" ADD COLUMN "last_observation_hash" text;--> statement-breakpoint
ALTER TABLE "openmuse_tasks" ADD COLUMN "last_observation_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "openmuse_tasks" ADD COLUMN "monitor_failure_streak" integer DEFAULT 0 NOT NULL;