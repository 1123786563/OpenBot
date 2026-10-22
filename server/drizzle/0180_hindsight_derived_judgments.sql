-- The derived judgment candidates of Hindsight 11 (#388), and their complete evidence
-- relation.
--
-- One candidate row = one judgment the system synthesized out of MULTIPLE confirmed
-- experiences, all inside ONE scope (the general personal memory, or exactly one authorized
-- source), waiting for the person's decision. Confirming/editing/rejecting is #389, so this
-- migration creates the lifecycle columns but only 'unreviewed' is ever written here:
--
--   - Unreviewed judgments are structurally unrecallable: no recall seam or degradation path
--     reads this table, and the candidate path never retains — the hdj_ document identity is
--     assigned at creation so it never depends on the review outcome, but nothing is sent to
--     Hindsight until a confirm (#389) drains it through the sync queue.
--   - The scope columns carry the restriction the judgment INHERITS from all of its evidence
--     (ADR 0005): shape-checked the same way source_bound_memories is, so a general judgment
--     holds no target and a restricted one holds exactly one.
--   - proposal_digest dedupes leads at the storage layer: the partial unique index allows at
--     most ONE unreviewed candidate per (tenant, principal, digest), so a replayed
--     observation cannot stack a second copy for the person to dismiss.
--
-- derived_judgment_evidence keeps the complete basis: ordered references (position 1..n) to
-- the authority rows the judgment was derived from, by OpenBot record id. Content is never
-- copied — the review surface re-reads the authority rows live, and whether the candidate
-- still stands is re-decided by the same eligibility/authorization gates at read time, which
-- is what "a judgment whose evidence is missing or de-authorized is not proposed" tests.
CREATE TABLE "derived_judgment_candidates" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"principal_id" text NOT NULL,
	"scope_kind" text NOT NULL,
	"workspace_id" text,
	"source_id" text,
	"agent_id" text,
	"content" text NOT NULL,
	"provenance" text NOT NULL,
	"review_state" text DEFAULT 'unreviewed' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"proposal_digest" text NOT NULL,
	"hindsight_document_id" text NOT NULL,
	"synced_content_digest" text,
	"synced_at" timestamp with time zone,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "derived_judgment_candidates_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "derived_judgment_scope_kind" CHECK ("derived_judgment_candidates"."scope_kind" in ('general','team','source','bot')),
	CONSTRAINT "derived_judgment_review_state" CHECK ("derived_judgment_candidates"."review_state" in ('unreviewed','confirmed','edited','rejected')),
	CONSTRAINT "derived_judgment_scope_shape" CHECK ((("derived_judgment_candidates"."scope_kind" = 'team') = ("derived_judgment_candidates"."workspace_id" is not null)) and (("derived_judgment_candidates"."scope_kind" = 'source') = ("derived_judgment_candidates"."source_id" is not null)) and (("derived_judgment_candidates"."scope_kind" = 'bot') = ("derived_judgment_candidates"."agent_id" is not null)))
);
--> statement-breakpoint
CREATE TABLE "derived_judgment_evidence" (
	"tenant_id" text NOT NULL,
	"judgment_id" text NOT NULL,
	"position" integer NOT NULL,
	"evidence_type" text NOT NULL,
	"evidence_id" text NOT NULL,
	CONSTRAINT "derived_judgment_evidence_tenant_id_judgment_id_position_pk" PRIMARY KEY("tenant_id","judgment_id","position"),
	CONSTRAINT "derived_judgment_evidence_type" CHECK ("derived_judgment_evidence"."evidence_type" in ('preference','source_bound','derived_judgment')),
	CONSTRAINT "derived_judgment_evidence_position" CHECK ("derived_judgment_evidence"."position" >= 1)
);
--> statement-breakpoint
ALTER TABLE "derived_judgment_candidates" ADD CONSTRAINT "derived_judgment_candidates_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "derived_judgment_candidates" ADD CONSTRAINT "derived_judgment_candidates_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "derived_judgment_candidates" ADD CONSTRAINT "derived_judgment_candidates_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "derived_judgment_evidence" ADD CONSTRAINT "derived_judgment_evidence_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "derived_judgment_evidence" ADD CONSTRAINT "derived_judgment_evidence_tenant_id_judgment_id_derived_judgment_candidates_tenant_id_id_fk" FOREIGN KEY ("tenant_id","judgment_id") REFERENCES "public"."derived_judgment_candidates"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "derived_judgment_candidates_document_idx" ON "derived_judgment_candidates" ("tenant_id","hindsight_document_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "derived_judgment_candidates_lead_idx" ON "derived_judgment_candidates" ("tenant_id","principal_id","proposal_digest") WHERE review_state = 'unreviewed';
--> statement-breakpoint
CREATE INDEX "derived_judgment_candidates_review_idx" ON "derived_judgment_candidates" ("tenant_id","principal_id","review_state");
