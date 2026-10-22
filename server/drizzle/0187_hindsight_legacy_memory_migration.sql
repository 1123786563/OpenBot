-- Hindsight 16 (#394): the persistent state of the legacy confirmed-memory migration.
--
-- Three tables make one migration resumable and reconcilable:
--
--   - hindsight_migration_map: old_record_id (globally unique in personal_memories) → the new
--     subject. The new record id IS the old id — deterministic, so a re-run cannot create a
--     second active copy of one old record: the insert conflicts on the new table's primary
--     key and the map's own key folds the mapping. What the record became (general preference
--     vs a restricted source-bound row) is recorded per row for the before/after
--     reconciliation.
--   - hindsight_migration_quarantine: the controlled isolation list. An old record whose
--     company attribution cannot be PROVEN — the owner has no enterprise principal, no active
--     membership, or more than one (a global user id never names a tenant) — lands here with
--     its old id, owner and reason, and NO content: the list is controlled precisely because
--     it must not become a shadow copy of the memories it holds back.
--   - hindsight_migration_runs: the run's durable cursor and counters. Every processed old
--     record advances cursor_old_id and refreshes the counts in the same write, so a failed
--     run resumes strictly after the cursor without re-doing (let alone duplicating) active
--     content — the same persistence discipline the sync queue (#384) applies to retains.
CREATE TABLE "hindsight_migration_map" (
	"old_record_id" text PRIMARY KEY,
	"owner_user_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"new_record_id" text NOT NULL,
	"run_id" text NOT NULL,
	"migrated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "hindsight_migration_map" ADD CONSTRAINT "hindsight_migration_map_subject_type" CHECK ("hindsight_migration_map"."subject_type" in ('preference', 'source_bound'));
--> statement-breakpoint
ALTER TABLE "hindsight_migration_map" ADD CONSTRAINT "hindsight_migration_map_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hindsight_migration_map" ADD CONSTRAINT "hindsight_migration_map_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "enterprise_memberships"("tenant_id","principal_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "hindsight_migration_map_tenant_idx" ON "hindsight_migration_map" USING btree ("tenant_id","principal_id");
--> statement-breakpoint
CREATE TABLE "hindsight_migration_quarantine" (
	"old_record_id" text PRIMARY KEY,
	"owner_user_id" text NOT NULL,
	"reason" text NOT NULL,
	"quarantined_at" timestamp with time zone NOT NULL DEFAULT now(),
	"run_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hindsight_migration_quarantine" ADD CONSTRAINT "hindsight_migration_quarantine_reason" CHECK ("hindsight_migration_quarantine"."reason" in ('no-principal', 'no-active-membership', 'ambiguous-company'));
--> statement-breakpoint
CREATE INDEX "hindsight_migration_quarantine_owner_idx" ON "hindsight_migration_quarantine" USING btree ("owner_user_id");
--> statement-breakpoint
CREATE TABLE "hindsight_migration_runs" (
	"id" text PRIMARY KEY,
	"state" text NOT NULL DEFAULT 'running',
	"cursor_old_id" text,
	"processed" integer NOT NULL DEFAULT 0,
	"migrated" integer NOT NULL DEFAULT 0,
	"skipped_pending_review" integer NOT NULL DEFAULT 0,
	"skipped_inactive" integer NOT NULL DEFAULT 0,
	"quarantined" integer NOT NULL DEFAULT 0,
	"last_error" text,
	"started_at" timestamp with time zone NOT NULL DEFAULT now(),
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "hindsight_migration_runs" ADD CONSTRAINT "hindsight_migration_run_state" CHECK ("hindsight_migration_runs"."state" in ('running', 'succeeded', 'failed'));
