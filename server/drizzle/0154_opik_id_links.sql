-- OpenBot↔Opik step-level id mapping (Issue #23/T17).
-- Scoped by the trusted workbench scope key; see src/db/schema/ai-observability-id-links.ts.
CREATE TABLE "ai_observation_id_links" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_key" text NOT NULL,
	"actor_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"local_kind" text NOT NULL,
	"local_id" text NOT NULL,
	"upstream_kind" text NOT NULL,
	"upstream_id" text NOT NULL,
	"run_id" text,
	"observed_trace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_observation_id_links_local_kind_check" CHECK ("ai_observation_id_links"."local_kind" IN ('tool_step', 'retrieval_step')),
	CONSTRAINT "ai_observation_id_links_upstream_kind_check" CHECK ("ai_observation_id_links"."upstream_kind" IN ('span'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "ai_observation_id_links_scope_local_uq" ON "ai_observation_id_links" USING btree ("scope_key","local_kind","local_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_observation_id_links_scope_upstream_uq" ON "ai_observation_id_links" USING btree ("scope_key","upstream_kind","upstream_id");
