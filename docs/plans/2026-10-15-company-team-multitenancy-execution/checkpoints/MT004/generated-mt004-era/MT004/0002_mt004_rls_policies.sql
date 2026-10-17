-- multitenancy migrate-test
REVOKE ALL PRIVILEGES ON TABLE "enterprise_workspace_memberships" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_workspace_memberships" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_workspace_membership_self_read" ON "enterprise_workspace_memberships"
  FOR SELECT TO ob_ent_directory
  USING (EXISTS (
    SELECT 1 FROM "enterprise_principals" p
    WHERE p."id" = "enterprise_workspace_memberships"."principal_id"
      AND p."user_id" = nullif(current_setting('app.user_id', true), '')
  ));
--> statement-breakpoint
CREATE POLICY "enterprise_workspace_membership_data_read" ON "enterprise_workspace_memberships"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_workspace_memberships"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_workspace_memberships"."principal_id" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_workspace_membership_operator_read" ON "enterprise_workspace_memberships"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_workspace_memberships"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_workspace_membership_operator_insert" ON "enterprise_workspace_memberships"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_workspace_memberships"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_workspace_membership_operator_update" ON "enterprise_workspace_memberships"
  FOR UPDATE TO ob_ent_operator
  USING ("enterprise_workspace_memberships"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_workspace_memberships"."principal_id" = nullif(current_setting('app.operator_principal_id', true), ''))
  WITH CHECK ("enterprise_workspace_memberships"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_workspace_memberships"."principal_id" = nullif(current_setting('app.operator_principal_id', true), ''));
--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_workspace_memberships" TO ob_ent_directory, ob_ent_data, ob_ent_operator;
--> statement-breakpoint
GRANT INSERT ON TABLE "enterprise_workspace_memberships" TO ob_ent_operator;
--> statement-breakpoint
GRANT UPDATE ("status", "epoch") ON TABLE "enterprise_workspace_memberships" TO ob_ent_operator;
