-- OpenBot's per-scope observation retention overrides (Issue #41/T35).
-- Scoped by the trusted workbench scope key; see src/db/schema/ai-observability-retention.ts.
-- Hand-merged rather than generated (T07/T19 precedent): drizzle-kit cannot run in this repo.
-- 0 is a deliberate value ("keep forever"), so the CHECK bounds at non-negative, not positive.
CREATE TABLE "ai_observation_retention_policies" (
	"scope_key" text PRIMARY KEY NOT NULL,
	"runs_days" integer NOT NULL,
	"datasets_days" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_observation_retention_policies_runs_days_check" CHECK ("ai_observation_retention_policies"."runs_days" >= 0),
	CONSTRAINT "ai_observation_retention_policies_datasets_days_check" CHECK ("ai_observation_retention_policies"."datasets_days" >= 0)
);
