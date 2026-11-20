CREATE TABLE "hindsight_memory_projections" (
	"memory_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"projected_version" uuid,
	"first_deleted_at" timestamp with time zone,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "personal_memories" ADD COLUMN "version" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
CREATE INDEX "hindsight_memory_projections_due_idx" ON "hindsight_memory_projections" USING btree ("next_check_at");