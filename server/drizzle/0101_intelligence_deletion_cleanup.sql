ALTER TABLE "hindsight_memory_projections" ADD COLUMN "cleanup_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opik_evaluations" ADD COLUMN "cleanup_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opik_evaluations" ADD COLUMN "cleanup_first_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opik_evaluations" ADD COLUMN "cleanup_completed_at" timestamp with time zone;