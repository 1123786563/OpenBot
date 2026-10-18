-- OpenBot's observability retention policy tables (Issue #41/T35; branch-local number leaves
-- 0127/0128 free for the parallel streams, renumbering happens at integration — T22 precedent).
-- Scoped by the trusted workbench scope key; see src/db/schema/ai-observability-retention.ts.
-- Hand-merged rather than generated (T07/T19 precedent): the check constraints below are the
-- facts of this ticket, expressed where no later code change can route around them.
CREATE TABLE "ai_observation_retention_overrides" (
	"scope_key" text PRIMARY KEY NOT NULL,
	"runs_days" integer,
	"datasets_days" integer,
	"experiments_days" integer,
	"exports_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_observation_retention_overrides_runs_days_check" CHECK ("ai_observation_retention_overrides"."runs_days" IS NULL OR ("ai_observation_retention_overrides"."runs_days" >= 1 AND "ai_observation_retention_overrides"."runs_days" <= 3650)),
	CONSTRAINT "ai_observation_retention_overrides_datasets_days_check" CHECK ("ai_observation_retention_overrides"."datasets_days" IS NULL OR ("ai_observation_retention_overrides"."datasets_days" >= 1 AND "ai_observation_retention_overrides"."datasets_days" <= 3650)),
	CONSTRAINT "ai_observation_retention_overrides_experiments_days_check" CHECK ("ai_observation_retention_overrides"."experiments_days" IS NULL OR ("ai_observation_retention_overrides"."experiments_days" >= 1 AND "ai_observation_retention_overrides"."experiments_days" <= 3650)),
	CONSTRAINT "ai_observation_retention_overrides_exports_days_check" CHECK ("ai_observation_retention_overrides"."exports_days" IS NULL OR ("ai_observation_retention_overrides"."exports_days" >= 1 AND "ai_observation_retention_overrides"."exports_days" <= 3650)),
	CONSTRAINT "ai_observation_retention_overrides_says_something_check" CHECK ("ai_observation_retention_overrides"."runs_days" IS NOT NULL OR "ai_observation_retention_overrides"."datasets_days" IS NOT NULL OR "ai_observation_retention_overrides"."experiments_days" IS NOT NULL OR "ai_observation_retention_overrides"."exports_days" IS NOT NULL)
);--> statement-breakpoint
CREATE TABLE "ai_observation_retention_deletions" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_key" text NOT NULL,
	"actor_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"kind" text NOT NULL,
	"target_id" text NOT NULL,
	"locator_workspace" text,
	"locator_project" text,
	"upstream_kind" text,
	"upstream_id" text,
	"retention_days" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ai_observation_retention_deletions_kind_check" CHECK ("ai_observation_retention_deletions"."kind" IN ('run', 'dataset', 'experiment', 'export')),
	CONSTRAINT "ai_observation_retention_deletions_state_check" CHECK ("ai_observation_retention_deletions"."state" IN ('pending', 'upstream_done', 'deleted', 'failed')),
	CONSTRAINT "ai_observation_retention_deletions_deleted_coherence_check" CHECK (("ai_observation_retention_deletions"."deleted_at" IS NULL AND "ai_observation_retention_deletions"."state" <> 'deleted') OR ("ai_observation_retention_deletions"."deleted_at" IS NOT NULL AND "ai_observation_retention_deletions"."state" = 'deleted')),
	CONSTRAINT "ai_observation_retention_deletions_error_failed_check" CHECK ("ai_observation_retention_deletions"."last_error" IS NULL OR "ai_observation_retention_deletions"."state" = 'failed'),
	CONSTRAINT "ai_observation_retention_deletions_upstream_kind_check" CHECK ("ai_observation_retention_deletions"."upstream_kind" IS NULL OR "ai_observation_retention_deletions"."upstream_kind" IN ('trace', 'dataset')),
	CONSTRAINT "ai_observation_retention_deletions_upstream_pair_check" CHECK (("ai_observation_retention_deletions"."upstream_kind" IS NULL) = ("ai_observation_retention_deletions"."upstream_id" IS NULL)),
	CONSTRAINT "ai_observation_retention_deletions_locator_pair_check" CHECK (("ai_observation_retention_deletions"."locator_workspace" IS NULL AND "ai_observation_retention_deletions"."locator_project" IS NULL) OR ("ai_observation_retention_deletions"."locator_workspace" IS NOT NULL AND "ai_observation_retention_deletions"."locator_project" IS NOT NULL)),
	CONSTRAINT "ai_observation_retention_deletions_attempts_positive_check" CHECK ("ai_observation_retention_deletions"."attempts" >= 0),
	CONSTRAINT "ai_observation_retention_deletions_retention_days_check" CHECK ("ai_observation_retention_deletions"."retention_days" >= 1 AND "ai_observation_retention_deletions"."retention_days" <= 3650)
);--> statement-breakpoint
CREATE UNIQUE INDEX "ai_observation_retention_deletions_kind_target_uq" ON "ai_observation_retention_deletions" USING btree ("kind","target_id");--> statement-breakpoint
CREATE INDEX "ai_observation_retention_deletions_state_updated_idx" ON "ai_observation_retention_deletions" USING btree ("state","updated_at");
