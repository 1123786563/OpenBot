-- multitenancy migrate-test
REVOKE ALL PRIVILEGES ON TABLE "enterprise_resource_shares" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_resource_shares" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_resource_shares" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_share_data_read" ON "enterprise_resource_shares"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_resource_shares"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_resource_shares"."principal_id" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_share_operator_read" ON "enterprise_resource_shares"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_resource_shares"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_share_operator_insert" ON "enterprise_resource_shares"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_resource_shares"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_share_operator_delete" ON "enterprise_resource_shares"
  FOR DELETE TO ob_ent_operator
  USING ("enterprise_resource_shares"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_resource_shares"."resource_id" = nullif(current_setting('app.resource_id', true), '')
    AND "enterprise_resource_shares"."granted_by" = nullif(current_setting('app.operator_principal_id', true), ''));
--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_resource_shares" TO ob_ent_data, ob_ent_operator;
--> statement-breakpoint
GRANT INSERT ON TABLE "enterprise_resource_shares" TO ob_ent_operator;
--> statement-breakpoint
GRANT DELETE ON TABLE "enterprise_resource_shares" TO ob_ent_operator;
