-- Source-bound personal memories and their authorization registry (Hindsight 06 / #383).
--
-- One row = one business fact the person confirmed out of a team conversation or a connected
-- source, and whose visibility STAYS bound to the scope that formed it: confirming does not
-- lift it into the general-preference bank, so team B's Bots never see team A's facts through
-- the recall seam — the bank set a recall searches is derived from the CURRENT authorization
-- snapshot, and every hit is re-verified against this table (and that snapshot) after the
-- remote answers, so a revocation landing between hit and load is still blocked.
--
-- `restriction` is exactly one of team/source/bot and the matching target column is the only
-- one set (row-level CHECK): the restriction names the bank the document is retained into
-- (ob_t_/ob_s_/ob_b_ derivations of bank-scope.ts) and, at recall time, the fact that must
-- still be authorized. The tombstone discipline is the preference table's (deleted_at +
-- enabled), unchanged.
--
-- The registry table below is the honest state for the two authorizations no existing
-- tenant-scoped table records: whether a connected source is still enabled for this person
-- (来源停用) and whether a Bot still holds the app it read from (Bot 失去应用权限). Team
-- authorization is NOT here — workspace membership already lives in
-- enterprise_workspace_memberships, which the recall reads live.
CREATE TABLE "source_bound_memories" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"principal_id" text NOT NULL,
	"restriction" text NOT NULL,
	"workspace_id" text,
	"source_id" text,
	"agent_id" text,
	"content" text NOT NULL,
	"provenance" text NOT NULL,
	"review_state" text DEFAULT 'unreviewed' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"formed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hindsight_document_id" text NOT NULL,
	"synced_content_digest" text,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_bound_memories_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "source_bound_memory_restriction" CHECK ("source_bound_memories"."restriction" in ('team','source','bot')),
	CONSTRAINT "source_bound_memory_review_state" CHECK ("source_bound_memories"."review_state" in ('unreviewed','confirmed','edited')),
	CONSTRAINT "source_bound_memory_target_shape" CHECK (
		(("source_bound_memories"."restriction" = 'team') = ("source_bound_memories"."workspace_id" is not null)) and
		(("source_bound_memories"."restriction" = 'source') = ("source_bound_memories"."source_id" is not null)) and
		(("source_bound_memories"."restriction" = 'bot') = ("source_bound_memories"."agent_id" is not null))
	)
);
--> statement-breakpoint
ALTER TABLE "source_bound_memories" ADD CONSTRAINT "source_bound_memories_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "source_bound_memories" ADD CONSTRAINT "source_bound_memories_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "source_bound_memories" ADD CONSTRAINT "source_bound_memories_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "source_bound_memories_document_idx" ON "source_bound_memories" ("tenant_id","hindsight_document_id");
--> statement-breakpoint
CREATE INDEX "source_bound_memories_subject_idx" ON "source_bound_memories" ("tenant_id","principal_id");
--> statement-breakpoint
CREATE INDEX "source_bound_memories_restriction_idx" ON "source_bound_memories" ("tenant_id","principal_id","restriction");
--> statement-breakpoint
CREATE TABLE "hindsight_memory_grants" (
	"tenant_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"kind" text NOT NULL,
	"target_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hindsight_memory_grants_tenant_id_principal_id_kind_target_id_pk" PRIMARY KEY("tenant_id","principal_id","kind","target_id"),
	CONSTRAINT "hindsight_memory_grant_kind" CHECK ("hindsight_memory_grants"."kind" in ('source','bot')),
	CONSTRAINT "hindsight_memory_grant_target_id" CHECK ("hindsight_memory_grants"."target_id" <> '')
);
--> statement-breakpoint
ALTER TABLE "hindsight_memory_grants" ADD CONSTRAINT "hindsight_memory_grants_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hindsight_memory_grants" ADD CONSTRAINT "hindsight_memory_grants_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;
