-- multitenancy migrate-test
REVOKE ALL PRIVILEGES ON TABLE "enterprise_sso_configs" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_sso_configs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_sso_configs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_sso_config_data_read" ON "enterprise_sso_configs"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_sso_configs"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_sso_config_operator_read" ON "enterprise_sso_configs"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_sso_configs"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_sso_config_operator_insert" ON "enterprise_sso_configs"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_sso_configs"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_sso_config_operator_update" ON "enterprise_sso_configs"
  FOR UPDATE TO ob_ent_operator
  USING ("enterprise_sso_configs"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("enterprise_sso_configs"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_sso_configs" TO ob_ent_data, ob_ent_operator;
--> statement-breakpoint
GRANT INSERT ON TABLE "enterprise_sso_configs" TO ob_ent_operator;
--> statement-breakpoint
GRANT UPDATE ("document", "revision", "updated_at") ON TABLE "enterprise_sso_configs" TO ob_ent_operator;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "enterprise_scim_directory_bindings" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_scim_directory_bindings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_scim_directory_bindings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_scim_binding_operator_read" ON "enterprise_scim_directory_bindings"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_scim_directory_bindings"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_scim_binding_connection_read" ON "enterprise_scim_directory_bindings"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_scim_directory_bindings"."connection_key" = nullif(current_setting('app.scim_connection_key', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_scim_binding_operator_insert" ON "enterprise_scim_directory_bindings"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_scim_directory_bindings"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_scim_binding_operator_update" ON "enterprise_scim_directory_bindings"
  FOR UPDATE TO ob_ent_operator
  USING ("enterprise_scim_directory_bindings"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("enterprise_scim_directory_bindings"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_scim_directory_bindings" TO ob_ent_operator;
--> statement-breakpoint
GRANT INSERT ON TABLE "enterprise_scim_directory_bindings" TO ob_ent_operator;
--> statement-breakpoint
GRANT UPDATE ("credential_ref", "status", "last_deprovision_principal_id", "last_deprovision_epoch", "deactivated_at") ON TABLE "enterprise_scim_directory_bindings" TO ob_ent_operator;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "enterprise_identity_binding_intents" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_identity_binding_intents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_identity_binding_intents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_identity_binding_operator_insert" ON "enterprise_identity_binding_intents"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_identity_binding_intents"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_identity_binding_state_read" ON "enterprise_identity_binding_intents"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_identity_binding_intents"."id" = nullif(current_setting('app.identity_binding_state', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_identity_binding_state_consume" ON "enterprise_identity_binding_intents"
  FOR UPDATE TO ob_ent_operator
  USING ("enterprise_identity_binding_intents"."id" = nullif(current_setting('app.identity_binding_state', true), ''))
  WITH CHECK ("enterprise_identity_binding_intents"."id" = nullif(current_setting('app.identity_binding_state', true), ''));
--> statement-breakpoint
GRANT INSERT ON TABLE "enterprise_identity_binding_intents" TO ob_ent_operator;
--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_identity_binding_intents" TO ob_ent_operator;
--> statement-breakpoint
GRANT UPDATE ("consumed_at") ON TABLE "enterprise_identity_binding_intents" TO ob_ent_operator;
