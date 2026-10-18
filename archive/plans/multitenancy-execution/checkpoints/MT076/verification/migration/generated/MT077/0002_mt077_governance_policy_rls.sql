-- multitenancy migrate-test
REVOKE ALL PRIVILEGES ON TABLE "enterprise_governance_policies" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_governance_policies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_governance_policies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_governance_policy_data_read" ON "enterprise_governance_policies"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_governance_policies"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_governance_policy_operator_read" ON "enterprise_governance_policies"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_governance_policies"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_governance_policy_operator_insert" ON "enterprise_governance_policies"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_governance_policies"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_governance_policy_operator_update" ON "enterprise_governance_policies"
  FOR UPDATE TO ob_ent_operator
  USING ("enterprise_governance_policies"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("enterprise_governance_policies"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_governance_policies" TO ob_ent_data, ob_ent_operator;
--> statement-breakpoint
GRANT INSERT ON TABLE "enterprise_governance_policies" TO ob_ent_operator;
--> statement-breakpoint
GRANT UPDATE ("document", "revision", "updated_at") ON TABLE "enterprise_governance_policies" TO ob_ent_operator;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "enterprise_governance_overrides" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_governance_overrides" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_governance_overrides" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_governance_override_data_read" ON "enterprise_governance_overrides"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_governance_overrides"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_governance_override_operator_read" ON "enterprise_governance_overrides"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_governance_overrides"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_governance_override_operator_insert" ON "enterprise_governance_overrides"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_governance_overrides"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_governance_override_operator_update" ON "enterprise_governance_overrides"
  FOR UPDATE TO ob_ent_operator
  USING ("enterprise_governance_overrides"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_governance_overrides"."workspace_id" = nullif(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("enterprise_governance_overrides"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_governance_overrides"."workspace_id" = nullif(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_governance_overrides" TO ob_ent_data, ob_ent_operator;
--> statement-breakpoint
GRANT INSERT ON TABLE "enterprise_governance_overrides" TO ob_ent_operator;
--> statement-breakpoint
GRANT UPDATE ("document", "revision", "updated_at") ON TABLE "enterprise_governance_overrides" TO ob_ent_operator;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "enterprise_template_installs" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_template_installs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_template_installs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_template_install_data_read" ON "enterprise_template_installs"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_template_installs"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_template_install_operator_read" ON "enterprise_template_installs"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_template_installs"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_template_install_operator_insert" ON "enterprise_template_installs"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_template_installs"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_template_install_operator_update" ON "enterprise_template_installs"
  FOR UPDATE TO ob_ent_operator
  USING ("enterprise_template_installs"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_template_installs"."workspace_id" = nullif(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("enterprise_template_installs"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_template_installs"."workspace_id" = nullif(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_template_installs" TO ob_ent_data, ob_ent_operator;
--> statement-breakpoint
GRANT INSERT ON TABLE "enterprise_template_installs" TO ob_ent_operator;
--> statement-breakpoint
GRANT UPDATE ("document", "revision", "source_revision", "updated_at") ON TABLE "enterprise_template_installs" TO ob_ent_operator;
