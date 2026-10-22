-- MT046 (Issue #89): execution-surface capability leases.
--
-- The computer/browser execution faces authenticate with deployment-level shared tokens
-- (agent-computer COMPUTER_TOKEN, sandbox x-sandbox-token, supervisor bearer): holding the token
-- makes the caller machine-level equivalent, which is the AC3 gap. This table is the registry that
-- bounds what a service identity may do on those faces: a lease row fixes WHO (tenant, workspace,
-- principal), WHICH instance (bot), WHAT (the closed purpose set — screen viewing, control
-- takeover, instance operation) and FOR HOW LONG (expires_at), exactly the credential-lease shape
-- of MT029 (Issue #72, the listed dependency) applied to execution surfaces. Validation re-reads
-- the live row plus the holder's memberships on every checkpoint, so revocation and expiry take
-- effect at the next checkpoint; a lease presented for anything outside its registered purposes —
-- including any company-data read — is denied with the canonical not-found shape and never
-- mints a PlatformScope.
--
-- RLS follows 0056 (enterprise_tenancy_rls): capabilities are provisioned separately by
-- server/ops/enterprise/roles.sql before migrations run, so the role references here are safe.
-- The data role may read and insert its own tenant rows; the operator role may read and flip
-- status/revoked_at (the revocation arm) — nothing else is updatable, so a lease's binding facts
-- are create-once like every other ownership pin in this schema family.
CREATE TABLE "enterprise_execution_capability_leases" (
	"tenant_id" text NOT NULL,
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"purposes" text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "enterprise_execution_capability_leases_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id", "id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "enterprise_execution_capability_leases_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id", "principal_id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "enterprise_execution_capability_leases_status" CHECK ("enterprise_execution_capability_leases"."status" in ('active', 'revoked')),
	CONSTRAINT "enterprise_execution_capability_leases_purposes" CHECK ("enterprise_execution_capability_leases"."purposes" <@ ARRAY['screen.view', 'control.take', 'instance.operate']::text[]),
	CONSTRAINT "enterprise_execution_capability_leases_ttl" CHECK ("enterprise_execution_capability_leases"."expires_at" > "enterprise_execution_capability_leases"."issued_at")
);--> statement-breakpoint
ALTER TABLE "enterprise_execution_capability_leases" ADD CONSTRAINT "enterprise_execution_capability_leases_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "enterprise_execution_capability_lease_scope_idx" ON "enterprise_execution_capability_leases" USING btree ("tenant_id", "workspace_id", "principal_id", "issued_at");--> statement-breakpoint
CREATE INDEX "enterprise_execution_capability_lease_bot_idx" ON "enterprise_execution_capability_leases" USING btree ("tenant_id", "bot_id");--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "enterprise_execution_capability_leases" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;--> statement-breakpoint
ALTER TABLE "enterprise_execution_capability_leases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "enterprise_execution_capability_lease_data_read" ON "enterprise_execution_capability_leases"
  FOR SELECT TO ob_ent_data
  USING (("enterprise_execution_capability_leases"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_execution_capability_leases"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')
    AND "enterprise_execution_capability_leases"."principal_id" = nullif(current_setting('app.principal_id', true), '')));--> statement-breakpoint
CREATE POLICY "enterprise_execution_capability_lease_data_insert" ON "enterprise_execution_capability_leases"
  FOR INSERT TO ob_ent_data
  WITH CHECK (("enterprise_execution_capability_leases"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_execution_capability_leases"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')
    AND "enterprise_execution_capability_leases"."principal_id" = nullif(current_setting('app.principal_id', true), '')));--> statement-breakpoint
CREATE POLICY "enterprise_execution_capability_lease_operator_read" ON "enterprise_execution_capability_leases"
  FOR SELECT TO ob_ent_operator
  USING (("enterprise_execution_capability_leases"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "enterprise_execution_capability_lease_operator_update" ON "enterprise_execution_capability_leases"
  FOR UPDATE TO ob_ent_operator
  USING ("enterprise_execution_capability_leases"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("enterprise_execution_capability_leases"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "enterprise_execution_capability_leases" TO ob_ent_data;--> statement-breakpoint
GRANT SELECT, UPDATE ("status", "revoked_at") ON TABLE "enterprise_execution_capability_leases" TO ob_ent_operator;
