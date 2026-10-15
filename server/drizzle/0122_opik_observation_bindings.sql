-- OpenBot's authoritative ownership record for observed run attempts (Issue #13/T07).
-- Scoped by the trusted workbench scope key; see src/db/schema/ai-observability-bindings.ts.
CREATE TABLE "ai_observation_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_key" text NOT NULL,
	"actor_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"run_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"opik_trace_id" text,
	"locator_workspace" text NOT NULL,
	"locator_project" text NOT NULL,
	"capability" text NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_observation_bindings_capability_check" CHECK ("ai_observation_bindings"."capability" IN ('basic', 'detailed', 'unavailable')),
	CONSTRAINT "ai_observation_bindings_state_check" CHECK ("ai_observation_bindings"."state" IN ('running', 'completed', 'failed', 'canceled', 'interrupted', 'unknown'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "ai_observation_bindings_scope_run_attempt_uq" ON "ai_observation_bindings" USING btree ("scope_key","run_id","attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_observation_bindings_scope_opik_trace_uq" ON "ai_observation_bindings" USING btree ("scope_key","opik_trace_id") WHERE "ai_observation_bindings"."opik_trace_id" IS NOT NULL;
