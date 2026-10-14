-- Round 6 final hardening: (1) F06's version provenance — the fill's
-- stale-parent check becomes enforceable at the insert (M23); (2) the ops
-- signals reader's outcome_unknown partial index (M33). The generator also
-- emitted a drop/recreate pair for openmuse_reviewed_actions_active_send_uq;
-- removed by hand because 0108 (also this round) already creates the FINAL
-- four-column form directly.
ALTER TABLE "openmuse_file_versions" ADD COLUMN "parent_version_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "openmuse_file_versions_parent_uq" ON "openmuse_file_versions" USING btree ("file_id","parent_version_id") WHERE "openmuse_file_versions"."parent_version_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "openmuse_reviewed_actions_outcome_unknown_idx" ON "openmuse_reviewed_actions" USING btree ("created_at") WHERE "openmuse_reviewed_actions"."status" = 'outcome_unknown';