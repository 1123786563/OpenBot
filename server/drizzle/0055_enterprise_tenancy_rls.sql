-- Capabilities are provisioned separately by server/ops/enterprise/roles.sql.
-- Start with no inherited PUBLIC access or stale grants from an earlier draft.
REVOKE ALL PRIVILEGES ON TABLE
  "enterprise_tenants",
  "enterprise_principals",
  "enterprise_memberships",
  "enterprise_workspaces",
  "enterprise_resources",
  "enterprise_resource_grants",
  "enterprise_security_events"
FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;--> statement-breakpoint

ALTER TABLE "enterprise_tenants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enterprise_principals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enterprise_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enterprise_workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enterprise_resources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enterprise_resource_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enterprise_security_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "enterprise_principal_self_read" ON "enterprise_principals"
  FOR SELECT TO ob_ent_directory
  USING ("enterprise_principals"."user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_principal_data_read" ON "enterprise_principals"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_principals"."id" = nullif(current_setting('app.principal_id', true), '')
    AND "enterprise_principals"."user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_principal_operator_read" ON "enterprise_principals"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_principals"."id" = nullif(current_setting('app.operator_principal_id', true), ''));--> statement-breakpoint

CREATE POLICY "enterprise_membership_self_read" ON "enterprise_memberships"
  FOR SELECT TO ob_ent_directory
  USING (EXISTS (
    SELECT 1 FROM "enterprise_principals" p
    WHERE p."id" = "enterprise_memberships"."principal_id"
      AND p."user_id" = nullif(current_setting('app.user_id', true), '')
  ));--> statement-breakpoint
CREATE POLICY "enterprise_membership_data_read" ON "enterprise_memberships"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_memberships"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_memberships"."principal_id" = nullif(current_setting('app.principal_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_membership_operator_read" ON "enterprise_memberships"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_memberships"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_membership_operator_insert" ON "enterprise_memberships"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_memberships"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_membership_operator_update" ON "enterprise_memberships"
  FOR UPDATE TO ob_ent_operator
  USING ("enterprise_memberships"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_memberships"."principal_id" = nullif(current_setting('app.operator_principal_id', true), ''))
  WITH CHECK ("enterprise_memberships"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_memberships"."principal_id" = nullif(current_setting('app.operator_principal_id', true), ''));--> statement-breakpoint

CREATE POLICY "enterprise_tenant_member_read" ON "enterprise_tenants"
  FOR SELECT TO ob_ent_directory
  USING (EXISTS (
    SELECT 1 FROM "enterprise_memberships" m
    JOIN "enterprise_principals" p ON p."id" = m."principal_id"
    WHERE m."tenant_id" = "enterprise_tenants"."id"
      AND p."user_id" = nullif(current_setting('app.user_id', true), '')
  ));--> statement-breakpoint
CREATE POLICY "enterprise_tenant_data_read" ON "enterprise_tenants"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_tenants"."id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_tenant_operator_read" ON "enterprise_tenants"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_tenants"."id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_tenant_context_write" ON "enterprise_tenants"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_tenants"."id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint

CREATE POLICY "enterprise_workspace_tenant_scope" ON "enterprise_workspaces"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_workspaces"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_workspace_operator_read" ON "enterprise_workspaces"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_workspaces"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_workspace_operator_insert" ON "enterprise_workspaces"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_workspaces"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint

CREATE POLICY "enterprise_resource_tenant_scope" ON "enterprise_resources"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_resources"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_resource_operator_read" ON "enterprise_resources"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_resources"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_resource_operator_insert" ON "enterprise_resources"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_resources"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_resource_operator_update" ON "enterprise_resources"
  FOR UPDATE TO ob_ent_operator
  USING ("enterprise_resources"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_resources"."id" = nullif(current_setting('app.resource_id', true), ''))
  WITH CHECK ("enterprise_resources"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_resources"."id" = nullif(current_setting('app.resource_id', true), ''));--> statement-breakpoint

CREATE POLICY "enterprise_grant_data_tenant_read" ON "enterprise_resource_grants"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_resource_grants"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_grant_self_read" ON "enterprise_resource_grants" AS RESTRICTIVE
  FOR SELECT TO ob_ent_data
  USING ("enterprise_resource_grants"."principal_id" = nullif(current_setting('app.principal_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_grant_operator_read" ON "enterprise_resource_grants"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_resource_grants"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_grant_operator_insert" ON "enterprise_resource_grants"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_resource_grants"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_grant_operator_delete" ON "enterprise_resource_grants"
  FOR DELETE TO ob_ent_operator
  USING ("enterprise_resource_grants"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_resource_grants"."resource_id" = nullif(current_setting('app.resource_id', true), '')
    AND "enterprise_resource_grants"."principal_id" = nullif(current_setting('app.operator_principal_id', true), ''));--> statement-breakpoint

CREATE POLICY "enterprise_security_event_tenant_scope" ON "enterprise_security_events"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_security_events"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_security_events"."id" = nullif(current_setting('app.operation_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_security_event_operator_insert" ON "enterprise_security_events"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_security_events"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_security_events"."id" = nullif(current_setting('app.operation_id', true), ''));--> statement-breakpoint

REVOKE CREATE ON SCHEMA public FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO ob_ent_directory, ob_ent_data, ob_ent_operator;--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_principals", "enterprise_memberships", "enterprise_tenants" TO ob_ent_directory;--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_principals", "enterprise_memberships", "enterprise_tenants", "enterprise_workspaces", "enterprise_resources", "enterprise_resource_grants" TO ob_ent_data;--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_tenants", "enterprise_principals", "enterprise_memberships", "enterprise_workspaces", "enterprise_resources", "enterprise_resource_grants", "enterprise_security_events" TO ob_ent_operator;--> statement-breakpoint
GRANT INSERT ON TABLE "enterprise_tenants", "enterprise_memberships", "enterprise_workspaces", "enterprise_resources", "enterprise_resource_grants", "enterprise_security_events" TO ob_ent_operator;--> statement-breakpoint
GRANT UPDATE ("status", "epoch") ON TABLE "enterprise_memberships" TO ob_ent_operator;--> statement-breakpoint
GRANT UPDATE ("acl_epoch") ON TABLE "enterprise_resources" TO ob_ent_operator;--> statement-breakpoint
GRANT DELETE ON TABLE "enterprise_resource_grants" TO ob_ent_operator;--> statement-breakpoint

ALTER TABLE "enterprise_tenants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enterprise_principals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enterprise_memberships" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enterprise_workspaces" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enterprise_resources" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enterprise_resource_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enterprise_security_events" FORCE ROW LEVEL SECURITY;
