-- OpenBot's bounded run-observation export jobs (Issue #40/T34).
-- Scoped by the trusted workbench scope key; see src/db/schema/ai-observability-exports.ts.
-- Hand-merged rather than generated (T07/T19 precedent): the check constraints below are the
-- security facts of this ticket, expressed where no later code change can route around them.
CREATE TABLE "ai_observation_export_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_key" text NOT NULL,
	"actor_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"row_limit" integer NOT NULL,
	"row_count" integer,
	"error_code" text,
	"redaction_policy_version" text NOT NULL,
	"artifact" jsonb,
	"locator_workspace" text NOT NULL,
	"locator_project" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	CONSTRAINT "ai_observation_export_jobs_state_check" CHECK ("ai_observation_export_jobs"."state" IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "ai_observation_export_jobs_artifact_completed_check" CHECK ("ai_observation_export_jobs"."artifact" IS NULL OR "ai_observation_export_jobs"."state" = 'completed'),
	CONSTRAINT "ai_observation_export_jobs_error_failed_check" CHECK ("ai_observation_export_jobs"."error_code" IS NULL OR "ai_observation_export_jobs"."state" = 'failed'),
	CONSTRAINT "ai_observation_export_jobs_settled_terminal_check" CHECK (("ai_observation_export_jobs"."settled_at" IS NULL AND "ai_observation_export_jobs"."state" IN ('queued', 'running')) OR ("ai_observation_export_jobs"."settled_at" IS NOT NULL AND "ai_observation_export_jobs"."state" NOT IN ('queued', 'running'))),
	CONSTRAINT "ai_observation_export_jobs_row_count_completed_check" CHECK ("ai_observation_export_jobs"."row_count" IS NULL OR "ai_observation_export_jobs"."state" = 'completed'),
	CONSTRAINT "ai_observation_export_jobs_row_limit_positive_check" CHECK ("ai_observation_export_jobs"."row_limit" > 0)
);--> statement-breakpoint
CREATE INDEX "ai_observation_export_jobs_scope_created_idx" ON "ai_observation_export_jobs" USING btree ("scope_key","created_at");--> statement-breakpoint
CREATE INDEX "ai_observation_export_jobs_active_actor_idx" ON "ai_observation_export_jobs" USING btree ("actor_id") WHERE "ai_observation_export_jobs"."state" IN ('queued', 'running');
