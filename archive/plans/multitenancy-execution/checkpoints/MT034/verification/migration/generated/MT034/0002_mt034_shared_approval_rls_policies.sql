-- multitenancy migrate-test
REVOKE ALL PRIVILEGES ON TABLE "enterprise_shared_use_requests" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_shared_use_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_shared_use_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_shared_use_request_data_read" ON "enterprise_shared_use_requests"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_shared_use_requests"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_shared_use_request_data_insert" ON "enterprise_shared_use_requests"
  FOR INSERT TO ob_ent_data
  WITH CHECK ("enterprise_shared_use_requests"."tenant_id" = nullif(current_setting('app.tenant_id', true), '') AND "enterprise_shared_use_requests"."requested_by" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_shared_use_request_data_withdraw" ON "enterprise_shared_use_requests"
  FOR UPDATE TO ob_ent_data
  USING ("enterprise_shared_use_requests"."tenant_id" = nullif(current_setting('app.tenant_id', true), '') AND "enterprise_shared_use_requests"."requested_by" = nullif(current_setting('app.principal_id', true), '') AND "enterprise_shared_use_requests"."status" = 'pending')
  WITH CHECK ("enterprise_shared_use_requests"."tenant_id" = nullif(current_setting('app.tenant_id', true), '') AND "enterprise_shared_use_requests"."requested_by" = nullif(current_setting('app.principal_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_shared_use_request_operator_read" ON "enterprise_shared_use_requests"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_shared_use_requests"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_shared_use_request_operator_update" ON "enterprise_shared_use_requests"
  FOR UPDATE TO ob_ent_operator
  USING ("enterprise_shared_use_requests"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("enterprise_shared_use_requests"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "enterprise_shared_use_requests" TO ob_ent_data;
--> statement-breakpoint
GRANT SELECT, UPDATE ON TABLE "enterprise_shared_use_requests" TO ob_ent_operator;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "enterprise_shared_use_approvals" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_shared_use_approvals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_shared_use_approvals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_shared_use_approval_data_read" ON "enterprise_shared_use_approvals"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_shared_use_approvals"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_shared_use_approval_operator_read" ON "enterprise_shared_use_approvals"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_shared_use_approvals"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_shared_use_approval_operator_insert" ON "enterprise_shared_use_approvals"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_shared_use_approvals"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_shared_use_approvals" TO ob_ent_data;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "enterprise_shared_use_approvals" TO ob_ent_operator;
