-- OpenBot's dataset subjects and their immutable frozen versions (Issue #25/T19).
-- Scoped by the trusted workbench scope key; see src/db/schema/ai-observability-datasets.ts.
-- The immutability trigger at the end is a database fact drizzle-kit's snapshot model does not
-- describe; it is why this file is hand-merged rather than generated (T07 precedent).
CREATE TABLE "ai_observation_datasets" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_key" text NOT NULL,
	"actor_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"name" text NOT NULL,
	"locator_workspace" text NOT NULL,
	"locator_project" text NOT NULL,
	"opik_dataset_id" text,
	"sync_state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_observation_datasets_sync_state_check" CHECK ("ai_observation_datasets"."sync_state" IN ('pending', 'syncing', 'synced', 'failed')),
	CONSTRAINT "ai_observation_datasets_synced_requires_upstream_check" CHECK ("ai_observation_datasets"."opik_dataset_id" IS NOT NULL OR "ai_observation_datasets"."sync_state" <> 'synced')
);--> statement-breakpoint
CREATE TABLE "ai_observation_dataset_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_key" text NOT NULL,
	"dataset_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"redaction_policy_version" text NOT NULL,
	"cases" jsonb NOT NULL,
	"locator_workspace" text NOT NULL,
	"locator_project" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "ai_observation_dataset_versions" ADD CONSTRAINT "ai_observation_dataset_versions_dataset_id_ai_observation_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."ai_observation_datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_observation_datasets_scope_name_uq" ON "ai_observation_datasets" USING btree ("scope_key","name");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_observation_datasets_scope_opik_dataset_uq" ON "ai_observation_datasets" USING btree ("scope_key","opik_dataset_id") WHERE "ai_observation_datasets"."opik_dataset_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_observation_dataset_versions_scope_dataset_hash_uq" ON "ai_observation_dataset_versions" USING btree ("scope_key","dataset_id","content_hash");--> statement-breakpoint
CREATE FUNCTION "ai_observation_dataset_versions_reject_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'dataset versions are immutable'
		USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "ai_observation_dataset_versions_immutable" BEFORE UPDATE ON "ai_observation_dataset_versions" FOR EACH ROW EXECUTE FUNCTION "ai_observation_dataset_versions_reject_update"();
