-- Hindsight 14 (#392): pause-learning and pause-usage, stored as two SEPARATE switches.
--
-- One row per (tenant, principal); each switch is the instant it took effect, or null while
-- inactive — no row at all means both behaviors are active. The separation is the ticket's
-- first acceptance clause made physical: resuming one control clears its own instant and
-- touches nothing else, and neither switch carries side effects of its own (no candidate is
-- confirmed, no source authorization widened).
--
-- Semantics (parent spec #376, rule 6): pause-learning blocks the AUTOMATIC candidate
-- proposals at the candidate-generation seam only — the person's own confirm, review,
-- correction and forgetting stay available; pause-usage blocks recall of confirmed content at
-- every recall seam's entry, BEFORE any remote call, so the SQL degradation path (which is
-- only reached through a seam's unavailability signal) is covered by the same gate. Neither
-- switch deletes or rewrites any memory row.
CREATE TABLE "hindsight_pause_controls" (
	"tenant_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"learning_paused_at" timestamp with time zone,
	"usage_paused_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "hindsight_pause_controls_tenant_id_principal_id_pk" PRIMARY KEY ("tenant_id","principal_id")
);
--> statement-breakpoint
ALTER TABLE "hindsight_pause_controls" ADD CONSTRAINT "hindsight_pause_controls_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hindsight_pause_controls" ADD CONSTRAINT "hindsight_pause_controls_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "enterprise_memberships"("tenant_id","principal_id") ON DELETE no action ON UPDATE no action;
