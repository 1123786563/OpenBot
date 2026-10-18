-- multitenancy migrate-test
REVOKE ALL PRIVILEGES ON TABLE "enterprise_runtime_configs" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_runtime_configs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_runtime_configs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_runtime_config_data_read" ON "enterprise_runtime_configs"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_runtime_configs"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_runtime_config_operator_read" ON "enterprise_runtime_configs"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_runtime_configs"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_runtime_config_operator_insert" ON "enterprise_runtime_configs"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_runtime_configs"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_runtime_config_operator_update" ON "enterprise_runtime_configs"
  FOR UPDATE TO ob_ent_operator
  USING ("enterprise_runtime_configs"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("enterprise_runtime_configs"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_runtime_configs" TO ob_ent_data, ob_ent_operator;
--> statement-breakpoint
GRANT INSERT ON TABLE "enterprise_runtime_configs" TO ob_ent_operator;
--> statement-breakpoint
GRANT UPDATE ("document", "revision", "updated_at") ON TABLE "enterprise_runtime_configs" TO ob_ent_operator;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "enterprise_runtime_config_overrides" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_runtime_config_overrides" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_runtime_config_overrides" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_runtime_config_override_data_read" ON "enterprise_runtime_config_overrides"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_runtime_config_overrides"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_runtime_config_override_operator_read" ON "enterprise_runtime_config_overrides"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_runtime_config_overrides"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_runtime_config_override_operator_insert" ON "enterprise_runtime_config_overrides"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_runtime_config_overrides"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_runtime_config_override_operator_update" ON "enterprise_runtime_config_overrides"
  FOR UPDATE TO ob_ent_operator
  USING ("enterprise_runtime_config_overrides"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_runtime_config_overrides"."workspace_id" = nullif(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("enterprise_runtime_config_overrides"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_runtime_config_overrides"."workspace_id" = nullif(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_runtime_config_overrides" TO ob_ent_data, ob_ent_operator;
--> statement-breakpoint
GRANT INSERT ON TABLE "enterprise_runtime_config_overrides" TO ob_ent_operator;
--> statement-breakpoint
GRANT UPDATE ("document", "revision", "updated_at") ON TABLE "enterprise_runtime_config_overrides" TO ob_ent_operator;
