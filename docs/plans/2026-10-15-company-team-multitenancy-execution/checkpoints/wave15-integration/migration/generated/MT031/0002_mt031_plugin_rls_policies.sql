-- multitenancy migrate-test
REVOKE ALL PRIVILEGES ON TABLE "enterprise_plugin_catalog" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_plugin_catalog" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_plugin_catalog" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_plugin_catalog_data_read" ON "enterprise_plugin_catalog"
  FOR SELECT TO ob_ent_data
  USING (true);
--> statement-breakpoint
CREATE POLICY "enterprise_plugin_catalog_operator_read" ON "enterprise_plugin_catalog"
  FOR SELECT TO ob_ent_operator
  USING (true);
--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_plugin_catalog" TO ob_ent_data, ob_ent_operator;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "enterprise_plugin_installs" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_plugin_installs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_plugin_installs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_plugin_install_data_read" ON "enterprise_plugin_installs"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_plugin_installs"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_plugin_install_operator_read" ON "enterprise_plugin_installs"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_plugin_installs"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_plugin_install_operator_insert" ON "enterprise_plugin_installs"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_plugin_installs"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_plugin_install_operator_update" ON "enterprise_plugin_installs"
  FOR UPDATE TO ob_ent_operator
  USING ("enterprise_plugin_installs"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("enterprise_plugin_installs"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_plugin_install_operator_delete" ON "enterprise_plugin_installs"
  FOR DELETE TO ob_ent_operator
  USING ("enterprise_plugin_installs"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_plugin_installs" TO ob_ent_data, ob_ent_operator;
--> statement-breakpoint
GRANT INSERT, UPDATE, DELETE ON TABLE "enterprise_plugin_installs" TO ob_ent_operator;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "enterprise_plugin_connections" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_plugin_connections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_plugin_connections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_plugin_connection_data_read" ON "enterprise_plugin_connections"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_plugin_connections"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_plugin_connection_operator_read" ON "enterprise_plugin_connections"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_plugin_connections"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_plugin_connection_operator_insert" ON "enterprise_plugin_connections"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_plugin_connections"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_plugin_connection_operator_delete" ON "enterprise_plugin_connections"
  FOR DELETE TO ob_ent_operator
  USING ("enterprise_plugin_connections"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_plugin_connections" TO ob_ent_data, ob_ent_operator;
--> statement-breakpoint
GRANT INSERT, DELETE ON TABLE "enterprise_plugin_connections" TO ob_ent_operator;
