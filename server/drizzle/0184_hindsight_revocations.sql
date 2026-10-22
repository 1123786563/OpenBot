-- Hindsight 13 (#390): the durable revocation ledger behind immediate blocking.
--
-- Forgetting a memory or revoking a source must stop every use NOW, from OpenBot's own
-- authoritative state, before any remote deletion is initiated — and must survive Hindsight
-- outages, background retries, stale index hits and (via replay) backup restores. The
-- authority-row tombstones are that immediate block; this table is the durable record of WHAT
-- was blocked and how far the remote copy cleanup got:
--
--   - one row per blocked Hindsight document (kind=memory: the forgotten row's document;
--     kind=source/bot: every document the revoked authorization had fed, including dependent
--     derived judgments, which the revocation tombstones with their evidence);
--   - deletion_state stays pending/failed until the service confirms the single document's
--     deletion (2xx or 404). "All controlled copies cleared" is NOT this table's claim —
--     completion evidence belongs to the deletion-evidence track (#14); the person-facing
--     status says "stopped being used" and reports cleanup progress separately;
--   - the retry drain (retryOutstandingDeletions) walks unfinished rows oldest-first, so a
--     Hindsight outage delays only the remote cleanup, never the block itself;
--   - replayRevocations re-applies blocks from this ledger after a backup restore — the
--     restore is not allowed to re-open recall until the forgetting and revocation records
--     have been replayed.
CREATE TABLE "hindsight_revocations" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"principal_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text,
	"target_id" text NOT NULL,
	"document_id" text NOT NULL,
	"bank_id" text NOT NULL,
	"bank_kind" text NOT NULL,
	"blocked_at" timestamp with time zone NOT NULL,
	"deletion_state" text NOT NULL DEFAULT 'pending',
	"deletion_attempted_at" timestamp with time zone,
	"deletion_error" text,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "hindsight_revocations_tenant_id_id_pk" PRIMARY KEY ("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "hindsight_revocations" ADD CONSTRAINT "hindsight_revocations_kind" CHECK ("hindsight_revocations"."kind" in ('memory', 'source', 'bot'));
--> statement-breakpoint
ALTER TABLE "hindsight_revocations" ADD CONSTRAINT "hindsight_revocations_deletion_state" CHECK ("hindsight_revocations"."deletion_state" in ('pending', 'confirmed', 'failed'));
--> statement-breakpoint
ALTER TABLE "hindsight_revocations" ADD CONSTRAINT "hindsight_revocations_subject_shape" CHECK ((("hindsight_revocations"."kind" = 'memory') = ("hindsight_revocations"."subject_type" is not null)));
--> statement-breakpoint
ALTER TABLE "hindsight_revocations" ADD CONSTRAINT "hindsight_revocations_bank_kind" CHECK ("hindsight_revocations"."bank_kind" in ('user', 'team', 'source', 'bot'));
--> statement-breakpoint
ALTER TABLE "hindsight_revocations" ADD CONSTRAINT "hindsight_revocations_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hindsight_revocations" ADD CONSTRAINT "hindsight_revocations_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "enterprise_memberships"("tenant_id","principal_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "hindsight_revocations_document_idx" ON "hindsight_revocations" USING btree ("tenant_id","document_id");
--> statement-breakpoint
CREATE INDEX "hindsight_revocations_deletion_idx" ON "hindsight_revocations" USING btree ("tenant_id","deletion_state","blocked_at");
