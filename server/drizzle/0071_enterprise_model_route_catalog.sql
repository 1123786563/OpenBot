CREATE TABLE "enterprise_model_routes" (
	"tenant_id" text NOT NULL,
	"route_ref" text NOT NULL,
	"schema_version" integer NOT NULL CHECK ("enterprise_model_routes"."schema_version" > 0),
	"agent_id" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_model_routes_tenant_id_route_ref_pk" PRIMARY KEY("tenant_id","route_ref"),
	CONSTRAINT "enterprise_model_routes_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "enterprise_model_routes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_model_routes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "enterprise_model_routes_data_scope" ON "enterprise_model_routes" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING ("enterprise_model_routes"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK ("enterprise_model_routes"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "enterprise_model_routes" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "enterprise_model_routes" TO ob_ent_data;
