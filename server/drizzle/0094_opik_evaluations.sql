CREATE TABLE "opik_evaluation_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"memory_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"content_sha256" text NOT NULL,
	"purpose" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "opik_evaluations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"operator_id" text NOT NULL,
	"project" text NOT NULL,
	"kind" text DEFAULT 'synthetic' NOT NULL,
	"target" text,
	"workspace" text,
	"cases" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "opik_evaluations_kind_request_id_unique" UNIQUE("kind","request_id")
);
--> statement-breakpoint
CREATE INDEX "opik_eval_grants_active_source_idx" ON "opik_evaluation_grants" USING btree ("memory_id") WHERE "opik_evaluation_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "opik_eval_grants_revoked_idx" ON "opik_evaluation_grants" USING btree ("revoked_at","id") WHERE "opik_evaluation_grants"."revoked_at" is not null;--> statement-breakpoint
CREATE INDEX "opik_evaluations_budget_idx" ON "opik_evaluations" USING btree ("created_at");
--> statement-breakpoint
CREATE FUNCTION revoke_opik_grants_for_changed_memory() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
      NEW.content, NEW.enabled, NEW.deleted_at, NEW.review_state, NEW.owner_user_id,
      NEW.formed_by, NEW.source_id, NEW.source_ref, NEW.source_app
    ) IS NOT DISTINCT FROM (
      OLD.content, OLD.enabled, OLD.deleted_at, OLD.review_state, OLD.owner_user_id,
      OLD.formed_by, OLD.source_id, OLD.source_ref, OLD.source_app
    ) THEN
    RETURN NULL;
  END IF;

  UPDATE opik_evaluation_grants
  SET revoked_at = clock_timestamp()
  WHERE memory_id = OLD.id AND revoked_at IS NULL;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER revoke_opik_grants_after_memory_change
AFTER UPDATE OF content, enabled, deleted_at, review_state, owner_user_id, formed_by, source_id, source_ref, source_app
OR DELETE ON personal_memories
FOR EACH ROW EXECUTE FUNCTION revoke_opik_grants_for_changed_memory();
