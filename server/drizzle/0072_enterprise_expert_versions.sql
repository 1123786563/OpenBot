CREATE TABLE "enterprise_expert_versions" (
  "tenant_id" text NOT NULL,
  "expert_version_ref" text NOT NULL,
  "schema_version" integer NOT NULL CHECK ("enterprise_expert_versions"."schema_version" > 0),
  "agent_id" text NOT NULL,
  "snapshot" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "enterprise_expert_versions_tenant_id_expert_version_ref_pk" PRIMARY KEY("tenant_id", "expert_version_ref"),
  CONSTRAINT "enterprise_expert_versions_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "enterprise_expert_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_expert_versions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_expert_versions_data_scope" ON "enterprise_expert_versions" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING ("enterprise_expert_versions"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK ("enterprise_expert_versions"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "enterprise_expert_versions" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "enterprise_expert_versions" TO ob_ent_data;
