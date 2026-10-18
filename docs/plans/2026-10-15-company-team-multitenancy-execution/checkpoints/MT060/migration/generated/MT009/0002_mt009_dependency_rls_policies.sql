-- multitenancy migrate-test
REVOKE ALL PRIVILEGES ON TABLE "enterprise_resource_dependencies" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_resource_dependencies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_resource_dependencies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_resource_dependency_data_read" ON "enterprise_resource_dependencies"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_resource_dependencies"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_resource_dependency_operator_read" ON "enterprise_resource_dependencies"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_resource_dependencies"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_resource_dependency_operator_insert" ON "enterprise_resource_dependencies"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_resource_dependencies"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_resource_dependencies" TO ob_ent_data, ob_ent_operator;
--> statement-breakpoint
GRANT INSERT ON TABLE "enterprise_resource_dependencies" TO ob_ent_operator;
