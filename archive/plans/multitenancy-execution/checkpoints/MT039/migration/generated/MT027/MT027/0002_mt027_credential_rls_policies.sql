-- multitenancy migrate-test
REVOKE ALL PRIVILEGES ON TABLE "enterprise_credentials" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_credentials" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_credentials" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_credential_data_read" ON "enterprise_credentials"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_credentials"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_credential_operator_read" ON "enterprise_credentials"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_credentials"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_credential_operator_insert" ON "enterprise_credentials"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_credentials"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_credential_operator_update" ON "enterprise_credentials"
  FOR UPDATE TO ob_ent_operator
  USING ("enterprise_credentials"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("enterprise_credentials"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_credentials" TO ob_ent_data, ob_ent_operator;
--> statement-breakpoint
GRANT INSERT, UPDATE ON TABLE "enterprise_credentials" TO ob_ent_operator;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "enterprise_credential_actions" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_credential_actions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_credential_actions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_credential_action_data_read" ON "enterprise_credential_actions"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_credential_actions"."tenant_id" = nullif(current_setting('app.tenant_id', true), '') AND "enterprise_credential_actions"."principal_id" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_credential_action_operator_read" ON "enterprise_credential_actions"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_credential_actions"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_credential_action_operator_insert" ON "enterprise_credential_actions"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_credential_actions"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_credential_action_operator_delete" ON "enterprise_credential_actions"
  FOR DELETE TO ob_ent_operator
  USING ("enterprise_credential_actions"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_credential_actions" TO ob_ent_data, ob_ent_operator;
--> statement-breakpoint
GRANT INSERT, DELETE ON TABLE "enterprise_credential_actions" TO ob_ent_operator;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "enterprise_credential_audit" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_credential_audit" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_credential_audit" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_credential_audit_data_insert" ON "enterprise_credential_audit"
  FOR INSERT TO ob_ent_data
  WITH CHECK ("enterprise_credential_audit"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_credential_audit_operator_read" ON "enterprise_credential_audit"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_credential_audit"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
GRANT INSERT ON TABLE "enterprise_credential_audit" TO ob_ent_data;
--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_credential_audit" TO ob_ent_operator;
