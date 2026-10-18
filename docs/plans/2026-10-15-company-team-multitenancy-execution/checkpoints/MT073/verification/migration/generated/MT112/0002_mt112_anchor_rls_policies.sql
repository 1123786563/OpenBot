-- multitenancy migrate-test
REVOKE ALL PRIVILEGES ON TABLE "enterprise_deployment_anchors" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_deployment_anchors" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_deployment_anchors" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_deployment_anchor_operator_read" ON "enterprise_deployment_anchors"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_deployment_anchors"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_deployment_anchors" TO ob_ent_operator;
