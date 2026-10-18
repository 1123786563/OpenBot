-- multitenancy migrate-test
REVOKE ALL PRIVILEGES ON TABLE "enterprise_credential_leases" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_credential_leases" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_credential_leases" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_credential_lease_data_read" ON "enterprise_credential_leases"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_credential_leases"."tenant_id" = nullif(current_setting('app.tenant_id', true), '') AND "enterprise_credential_leases"."principal_id" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_credential_lease_data_insert" ON "enterprise_credential_leases"
  FOR INSERT TO ob_ent_data
  WITH CHECK ("enterprise_credential_leases"."tenant_id" = nullif(current_setting('app.tenant_id', true), '') AND "enterprise_credential_leases"."principal_id" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_credential_lease_operator_read" ON "enterprise_credential_leases"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_credential_leases"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_credential_lease_operator_update" ON "enterprise_credential_leases"
  FOR UPDATE TO ob_ent_operator
  USING ("enterprise_credential_leases"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("enterprise_credential_leases"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "enterprise_credential_leases" TO ob_ent_data;
--> statement-breakpoint
GRANT SELECT, UPDATE ON TABLE "enterprise_credential_leases" TO ob_ent_operator;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "enterprise_credential_lease_audit" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_credential_lease_audit" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_credential_lease_audit" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_credential_lease_audit_data_insert" ON "enterprise_credential_lease_audit"
  FOR INSERT TO ob_ent_data
  WITH CHECK ("enterprise_credential_lease_audit"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_credential_lease_audit_operator_read" ON "enterprise_credential_lease_audit"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_credential_lease_audit"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_credential_lease_audit_operator_insert" ON "enterprise_credential_lease_audit"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_credential_lease_audit"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
GRANT INSERT ON TABLE "enterprise_credential_lease_audit" TO ob_ent_data;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "enterprise_credential_lease_audit" TO ob_ent_operator;
