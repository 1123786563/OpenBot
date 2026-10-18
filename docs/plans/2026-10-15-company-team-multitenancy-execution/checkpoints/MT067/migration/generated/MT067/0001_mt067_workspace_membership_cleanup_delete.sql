-- multitenancy migrate-test
DO $mt067$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'enterprise_workspace_memberships'
      AND policyname = 'enterprise_workspace_membership_operator_delete'
  ) THEN
    CREATE POLICY "enterprise_workspace_membership_operator_delete" ON "enterprise_workspace_memberships"
      FOR DELETE TO ob_ent_operator
      USING ("enterprise_workspace_memberships"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
        AND "enterprise_workspace_memberships"."principal_id" = nullif(current_setting('app.operator_principal_id', true), ''));
  END IF;
END
$mt067$;
--> statement-breakpoint
GRANT DELETE ON TABLE "enterprise_workspace_memberships" TO ob_ent_operator;
