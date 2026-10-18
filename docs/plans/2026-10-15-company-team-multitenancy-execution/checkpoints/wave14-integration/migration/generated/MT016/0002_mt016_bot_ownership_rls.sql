-- multitenancy migrate-test
REVOKE ALL PRIVILEGES ON TABLE "enterprise_bot_ownership" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_bot_ownership" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_bot_ownership" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_bot_ownership_data_read" ON "enterprise_bot_ownership"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_bot_ownership"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_bot_ownership_operator_read" ON "enterprise_bot_ownership"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_bot_ownership"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_bot_ownership_operator_insert" ON "enterprise_bot_ownership"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_bot_ownership"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_bot_ownership_operator_update" ON "enterprise_bot_ownership"
  FOR UPDATE TO ob_ent_operator
  USING ("enterprise_bot_ownership"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("enterprise_bot_ownership"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_bot_ownership_operator_delete" ON "enterprise_bot_ownership"
  FOR DELETE TO ob_ent_operator
  USING ("enterprise_bot_ownership"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_bot_ownership" TO ob_ent_data, ob_ent_operator;
--> statement-breakpoint
GRANT INSERT ON TABLE "enterprise_bot_ownership" TO ob_ent_operator;
--> statement-breakpoint
GRANT UPDATE ("display_name", "default_config", "status", "revision", "acl_epoch", "updated_at") ON TABLE "enterprise_bot_ownership" TO ob_ent_operator;
--> statement-breakpoint
GRANT DELETE ON TABLE "enterprise_bot_ownership" TO ob_ent_operator;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "enterprise_bot_preferences" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_bot_preferences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_bot_preferences" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_bot_preference_data_tenant_read" ON "enterprise_bot_preferences"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_bot_preferences"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_bot_preference_data_self_read" ON "enterprise_bot_preferences"
  AS RESTRICTIVE
  FOR SELECT TO ob_ent_data
  USING ("enterprise_bot_preferences"."principal_id" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_bot_preference_operator_read" ON "enterprise_bot_preferences"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_bot_preferences"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_bot_preferences"."principal_id" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_bot_preference_operator_insert" ON "enterprise_bot_preferences"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_bot_preferences"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_bot_preferences"."principal_id" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_bot_preference_operator_update" ON "enterprise_bot_preferences"
  FOR UPDATE TO ob_ent_operator
  USING ("enterprise_bot_preferences"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_bot_preferences"."principal_id" = nullif(current_setting('app.principal_id', true), ''))
  WITH CHECK ("enterprise_bot_preferences"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_bot_preferences"."principal_id" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_bot_preference_operator_delete" ON "enterprise_bot_preferences"
  FOR DELETE TO ob_ent_operator
  USING ("enterprise_bot_preferences"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_bot_preferences"."principal_id" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_bot_preferences" TO ob_ent_data, ob_ent_operator;
--> statement-breakpoint
GRANT INSERT ON TABLE "enterprise_bot_preferences" TO ob_ent_operator;
--> statement-breakpoint
GRANT UPDATE ("preferences", "updated_at") ON TABLE "enterprise_bot_preferences" TO ob_ent_operator;
--> statement-breakpoint
GRANT DELETE ON TABLE "enterprise_bot_preferences" TO ob_ent_operator;
