-- multitenancy migrate-test
REVOKE ALL PRIVILEGES ON TABLE "enterprise_personal_bots" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_personal_bots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_personal_bots" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_personal_bot_data_tenant_read" ON "enterprise_personal_bots"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_personal_bots"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_personal_bot_data_self_read" ON "enterprise_personal_bots"
  AS RESTRICTIVE
  FOR SELECT TO ob_ent_data
  USING ("enterprise_personal_bots"."principal_id" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_personal_bot_operator_read" ON "enterprise_personal_bots"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_personal_bots"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_personal_bots"."principal_id" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_personal_bot_operator_insert" ON "enterprise_personal_bots"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_personal_bots"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_personal_bots"."principal_id" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_personal_bot_operator_update" ON "enterprise_personal_bots"
  FOR UPDATE TO ob_ent_operator
  USING ("enterprise_personal_bots"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_personal_bots"."principal_id" = nullif(current_setting('app.principal_id', true), ''))
  WITH CHECK ("enterprise_personal_bots"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_personal_bots"."principal_id" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_personal_bot_operator_delete" ON "enterprise_personal_bots"
  FOR DELETE TO ob_ent_operator
  USING ("enterprise_personal_bots"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_personal_bots"."principal_id" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_personal_bots" TO ob_ent_data, ob_ent_operator;
--> statement-breakpoint
GRANT INSERT ON TABLE "enterprise_personal_bots" TO ob_ent_operator;
--> statement-breakpoint
GRANT UPDATE ("display_name", "template_ref", "template_source_revision", "document", "revision", "updated_at") ON TABLE "enterprise_personal_bots" TO ob_ent_operator;
--> statement-breakpoint
GRANT DELETE ON TABLE "enterprise_personal_bots" TO ob_ent_operator;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "enterprise_personal_bot_field_ownership" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_personal_bot_field_ownership" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_personal_bot_field_ownership" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_personal_bot_field_data_tenant_read" ON "enterprise_personal_bot_field_ownership"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_personal_bot_field_ownership"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_personal_bot_field_data_self_read" ON "enterprise_personal_bot_field_ownership"
  AS RESTRICTIVE
  FOR SELECT TO ob_ent_data
  USING ("enterprise_personal_bot_field_ownership"."principal_id" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_personal_bot_field_operator_read" ON "enterprise_personal_bot_field_ownership"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_personal_bot_field_ownership"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_personal_bot_field_ownership"."principal_id" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_personal_bot_field_operator_insert" ON "enterprise_personal_bot_field_ownership"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_personal_bot_field_ownership"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_personal_bot_field_ownership"."principal_id" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_personal_bot_field_operator_update" ON "enterprise_personal_bot_field_ownership"
  FOR UPDATE TO ob_ent_operator
  USING ("enterprise_personal_bot_field_ownership"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_personal_bot_field_ownership"."principal_id" = nullif(current_setting('app.principal_id', true), ''))
  WITH CHECK ("enterprise_personal_bot_field_ownership"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_personal_bot_field_ownership"."principal_id" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_personal_bot_field_operator_delete" ON "enterprise_personal_bot_field_ownership"
  FOR DELETE TO ob_ent_operator
  USING ("enterprise_personal_bot_field_ownership"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_personal_bot_field_ownership"."principal_id" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_personal_bot_field_ownership" TO ob_ent_data, ob_ent_operator;
--> statement-breakpoint
GRANT INSERT ON TABLE "enterprise_personal_bot_field_ownership" TO ob_ent_operator;
--> statement-breakpoint
GRANT UPDATE ("managed_by", "updated_at") ON TABLE "enterprise_personal_bot_field_ownership" TO ob_ent_operator;
--> statement-breakpoint
GRANT DELETE ON TABLE "enterprise_personal_bot_field_ownership" TO ob_ent_operator;
