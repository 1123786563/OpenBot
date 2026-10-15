-- OpenBot's evaluation experiments: a configuration that freezes once submitted (Issue #28/T22; branch-local number 0125, renumbered to the next free slot at integration).
-- Scoped by the trusted workbench scope key; see src/db/schema/ai-observability-experiments.ts.
-- The two triggers at the end are database facts drizzle-kit's snapshot model does not describe;
-- this file is hand-merged and its snapshot is a copy of 0124's plus the table (T07 precedent).
CREATE TABLE "ai_observation_experiments" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_key" text NOT NULL,
	"actor_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"name" text NOT NULL,
	"dataset_version_id" text NOT NULL,
	"dataset_content_hash" text NOT NULL,
	"config" jsonb NOT NULL,
	"config_hash" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"frozen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_observation_experiments_state_check" CHECK ("ai_observation_experiments"."state" IN ('draft', 'frozen')),
	CONSTRAINT "ai_observation_experiments_frozen_coherence_check" CHECK ((("ai_observation_experiments"."state" = 'draft' AND "ai_observation_experiments"."frozen_at" IS NULL) OR ("ai_observation_experiments"."state" = 'frozen' AND "ai_observation_experiments"."frozen_at" IS NOT NULL AND "ai_observation_experiments"."config_hash" <> '')))
);--> statement-breakpoint
ALTER TABLE "ai_observation_experiments" ADD CONSTRAINT "ai_observation_experiments_dataset_version_id_ai_observation_dataset_versions_id_fk" FOREIGN KEY ("dataset_version_id") REFERENCES "public"."ai_observation_dataset_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_observation_experiments_scope_name_uq" ON "ai_observation_experiments" USING btree ("scope_key","name");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_observation_experiments_scope_config_hash_frozen_uq" ON "ai_observation_experiments" USING btree ("scope_key","config_hash") WHERE "ai_observation_experiments"."state" = 'frozen';--> statement-breakpoint
CREATE FUNCTION "ai_observation_experiments_reject_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	-- The one legal transition is draft -> frozen, and it happens on a row that is still a
	-- draft here. A frozen row refuses every UPDATE, whoever asks and whatever code path let
	-- them: the submitted configuration is a fact of the database, not a discipline.
	IF OLD."state" = 'frozen' THEN
		RAISE EXCEPTION 'frozen experiments are immutable'
			USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "ai_observation_experiments_immutable" BEFORE UPDATE ON "ai_observation_experiments" FOR EACH ROW EXECUTE FUNCTION "ai_observation_experiments_reject_update"();--> statement-breakpoint
CREATE FUNCTION "ai_observation_experiments_reject_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	-- IS DISTINCT FROM, never <>: on a fresh connection current_setting(..., true) is NULL,
	-- and NULL <> 'on' is NULL, which an IF reads as false — the guard would fail open
	-- exactly there (0124's lesson). No production path sets this flag yet: experiment
	-- retention deletion is a later ticket, and until it ships the refusal is total.
	IF current_setting('ai_observation.experiment_cleanup', true) IS DISTINCT FROM 'on' THEN
		RAISE EXCEPTION 'experiments are removed only through the experiment cleanup path'
			USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "ai_observation_experiments_cleanup_only" BEFORE DELETE ON "ai_observation_experiments" FOR EACH ROW EXECUTE FUNCTION "ai_observation_experiments_reject_delete"();
