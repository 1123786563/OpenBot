-- multitenancy migrate-test
REVOKE ALL PRIVILEGES ON TABLE "enterprise_oauth_states" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_oauth_states" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_oauth_states" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_oauth_state_operator_insert" ON "enterprise_oauth_states"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_oauth_states"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_oauth_state_state_read" ON "enterprise_oauth_states"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_oauth_states"."id" = nullif(current_setting('app.oauth_state', true), ''));
--> statement-breakpoint
CREATE POLICY "enterprise_oauth_state_state_consume" ON "enterprise_oauth_states"
  FOR UPDATE TO ob_ent_operator
  USING ("enterprise_oauth_states"."id" = nullif(current_setting('app.oauth_state', true), ''))
  WITH CHECK ("enterprise_oauth_states"."id" = nullif(current_setting('app.oauth_state', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "enterprise_oauth_states" TO ob_ent_operator;
