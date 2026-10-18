-- OpenBot's isolated experiment executions (Issue #29/T23; 0128 — 0127 is reserved for the parallel T17 integration, so this entry sits one slot ahead).
-- Scoped by the trusted workbench scope key; see src/db/schema/ai-observability-executions.ts.
CREATE TABLE "ai_observation_experiment_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_key" text NOT NULL,
	"actor_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"experiment_id" text NOT NULL,
	"experiment_config_hash" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"case_count" integer,
	"tool_rejections" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	CONSTRAINT "ai_observation_experiment_executions_state_check" CHECK ("ai_observation_experiment_executions"."state" IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "ai_observation_experiment_executions_config_hash_frozen_check" CHECK ("ai_observation_experiment_executions"."experiment_config_hash" <> ''),
	CONSTRAINT "ai_observation_experiment_executions_result_completed_check" CHECK ("ai_observation_experiment_executions"."result" IS NULL OR "ai_observation_experiment_executions"."state" = 'completed'),
	CONSTRAINT "ai_observation_experiment_executions_error_failed_check" CHECK ("ai_observation_experiment_executions"."error_code" IS NULL OR "ai_observation_experiment_executions"."state" = 'failed'),
	CONSTRAINT "ai_observation_experiment_executions_case_count_completed_check" CHECK ("ai_observation_experiment_executions"."case_count" IS NULL OR "ai_observation_experiment_executions"."state" = 'completed'),
	CONSTRAINT "ai_observation_experiment_executions_settled_terminal_check" CHECK ((("ai_observation_experiment_executions"."settled_at" IS NULL AND "ai_observation_experiment_executions"."state" IN ('pending', 'running')) OR ("ai_observation_experiment_executions"."settled_at" IS NOT NULL AND "ai_observation_experiment_executions"."state" NOT IN ('pending', 'running'))))
);--> statement-breakpoint
ALTER TABLE "ai_observation_experiment_executions" ADD CONSTRAINT "ai_observation_experiment_executions_experiment_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."ai_observation_experiments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_observation_experiment_executions_scope_created_idx" ON "ai_observation_experiment_executions" USING btree ("scope_key","created_at");--> statement-breakpoint
CREATE INDEX "ai_observation_experiment_executions_experiment_created_idx" ON "ai_observation_experiment_executions" USING btree ("experiment_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_observation_experiment_executions_active_actor_idx" ON "ai_observation_experiment_executions" USING btree ("actor_id") WHERE "ai_observation_experiment_executions"."state" IN ('pending', 'running');
