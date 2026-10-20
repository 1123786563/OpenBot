-- General personal preferences confirmed for Hindsight-backed cross-Bot recall (Hindsight 05 / #382).
--
-- One row = one preference the person confirmed AND explicitly marked as general: the OpenBot
-- authority record the recall seam re-loads verbatim. Hindsight only ever ranks these; the
-- confirmed original text a Bot receives always comes back from this table, so the row carries
-- the full lifecycle a hit must still satisfy at recall time (review state, enabled, forgotten),
-- plus the stable document identity the row is indexed under (hindsight_document_id, derived
-- once at confirm and never changed: re-confirming an edit replaces the remote document in
-- place instead of leaving a second one behind) and the digest of the content last retained
-- (so a later sync pass can tell "in step" from "pending", the retry queue itself being #384).
--
-- Attribution follows the MT039 shape: the composite foreign keys embed tenant_id, so a
-- preference row for one company structurally cannot reference another company's membership.
CREATE TABLE "generic_personal_preferences" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"principal_id" text NOT NULL,
	"content" text NOT NULL,
	"provenance" text NOT NULL,
	"review_state" text DEFAULT 'unreviewed' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"marked_generic_at" timestamp with time zone NOT NULL,
	"hindsight_document_id" text NOT NULL,
	"synced_content_digest" text,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generic_personal_preferences_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "generic_personal_preference_review_state" CHECK ("generic_personal_preferences"."review_state" in ('unreviewed','confirmed','edited')),
	CONSTRAINT "generic_personal_preference_marked_generic_at" CHECK ("generic_personal_preferences"."marked_generic_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "generic_personal_preferences" ADD CONSTRAINT "generic_personal_preferences_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "generic_personal_preferences" ADD CONSTRAINT "generic_personal_preferences_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "generic_personal_preferences_document_idx" ON "generic_personal_preferences" ("tenant_id","hindsight_document_id");
--> statement-breakpoint
CREATE INDEX "generic_personal_preferences_subject_idx" ON "generic_personal_preferences" ("tenant_id","principal_id");
