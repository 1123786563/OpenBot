-- multitenancy migrate-test
REVOKE ALL PRIVILEGES ON TABLE "openmuse_task_scopes" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;
--> statement-breakpoint
ALTER TABLE "openmuse_task_scopes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "openmuse_task_scopes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "openmuse_task_scope_data_tenant_read" ON "openmuse_task_scopes"
  FOR SELECT TO ob_ent_data
  USING ("openmuse_task_scopes"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "openmuse_task_scope_data_self_read" ON "openmuse_task_scopes"
  AS RESTRICTIVE
  FOR SELECT TO ob_ent_data
  USING ("openmuse_task_scopes"."principal_id" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
CREATE POLICY "openmuse_task_scope_operator_read" ON "openmuse_task_scopes"
  FOR SELECT TO ob_ent_operator
  USING ("openmuse_task_scopes"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "openmuse_task_scopes"."principal_id" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
CREATE POLICY "openmuse_task_scope_operator_insert" ON "openmuse_task_scopes"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("openmuse_task_scopes"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "openmuse_task_scopes"."principal_id" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
CREATE POLICY "openmuse_task_scope_operator_delete" ON "openmuse_task_scopes"
  FOR DELETE TO ob_ent_operator
  USING ("openmuse_task_scopes"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "openmuse_task_scopes"."principal_id" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
CREATE POLICY "openmuse_task_scope_operator_sweep_read" ON "openmuse_task_scopes"
  FOR SELECT TO ob_ent_operator
  USING (current_setting('app.scan_sweep', true) = 'on');
--> statement-breakpoint
GRANT SELECT ON TABLE "openmuse_task_scopes" TO ob_ent_data, ob_ent_operator;
--> statement-breakpoint
GRANT INSERT ON TABLE "openmuse_task_scopes" TO ob_ent_operator;
--> statement-breakpoint
GRANT DELETE ON TABLE "openmuse_task_scopes" TO ob_ent_operator;
