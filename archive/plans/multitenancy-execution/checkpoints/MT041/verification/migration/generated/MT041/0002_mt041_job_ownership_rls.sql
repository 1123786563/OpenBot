-- multitenancy migrate-test
REVOKE ALL PRIVILEGES ON TABLE "job_ownership" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;
--> statement-breakpoint
ALTER TABLE "job_ownership" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "job_ownership_data_read" ON "job_ownership" AS PERMISSIVE FOR SELECT TO ob_ent_data
  USING ("job_ownership"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))
--> statement-breakpoint
CREATE POLICY "job_ownership_operator_read" ON "job_ownership" AS PERMISSIVE FOR SELECT TO ob_ent_operator
  USING ("job_ownership"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))
--> statement-breakpoint
CREATE POLICY "job_ownership_operator_insert" ON "job_ownership" AS PERMISSIVE FOR INSERT TO ob_ent_operator
  WITH CHECK ("job_ownership"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))
--> statement-breakpoint
GRANT SELECT ON TABLE "job_ownership" TO ob_ent_data, ob_ent_operator;
--> statement-breakpoint
GRANT INSERT ON TABLE "job_ownership" TO ob_ent_operator;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "job_config_snapshots" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;
--> statement-breakpoint
ALTER TABLE "job_config_snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "job_config_snapshots_data_read" ON "job_config_snapshots" AS PERMISSIVE FOR SELECT TO ob_ent_data
  USING (exists (select 1 from job_ownership where job_ownership.kind = job_config_snapshots.kind and job_ownership.object_id = job_config_snapshots.object_id and job_ownership.tenant_id = nullif(current_setting('app.tenant_id', true), '')))
--> statement-breakpoint
CREATE POLICY "job_config_snapshots_operator_read" ON "job_config_snapshots" AS PERMISSIVE FOR SELECT TO ob_ent_operator
  USING (exists (select 1 from job_ownership where job_ownership.kind = job_config_snapshots.kind and job_ownership.object_id = job_config_snapshots.object_id and job_ownership.tenant_id = nullif(current_setting('app.tenant_id', true), '')))
--> statement-breakpoint
CREATE POLICY "job_config_snapshots_operator_insert" ON "job_config_snapshots" AS PERMISSIVE FOR INSERT TO ob_ent_operator
  WITH CHECK (exists (select 1 from job_ownership where job_ownership.kind = job_config_snapshots.kind and job_ownership.object_id = job_config_snapshots.object_id and job_ownership.tenant_id = nullif(current_setting('app.tenant_id', true), '')))
--> statement-breakpoint
GRANT SELECT ON TABLE "job_config_snapshots" TO ob_ent_data, ob_ent_operator;
--> statement-breakpoint
GRANT INSERT ON TABLE "job_config_snapshots" TO ob_ent_operator;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "job_leases" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;
--> statement-breakpoint
ALTER TABLE "job_leases" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "job_leases_data_read" ON "job_leases" AS PERMISSIVE FOR SELECT TO ob_ent_data
  USING ("job_leases"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))
--> statement-breakpoint
CREATE POLICY "job_leases_operator_read" ON "job_leases" AS PERMISSIVE FOR SELECT TO ob_ent_operator
  USING ("job_leases"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))
--> statement-breakpoint
CREATE POLICY "job_leases_operator_insert" ON "job_leases" AS PERMISSIVE FOR INSERT TO ob_ent_operator
  WITH CHECK ("job_leases"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))
--> statement-breakpoint
CREATE POLICY "job_leases_operator_update" ON "job_leases" AS PERMISSIVE FOR UPDATE TO ob_ent_operator
  USING ("job_leases"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("job_leases"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))
--> statement-breakpoint
GRANT SELECT ON TABLE "job_leases" TO ob_ent_data, ob_ent_operator;
--> statement-breakpoint
GRANT INSERT ON TABLE "job_leases" TO ob_ent_operator;
--> statement-breakpoint
GRANT UPDATE ON TABLE "job_leases" TO ob_ent_operator;
