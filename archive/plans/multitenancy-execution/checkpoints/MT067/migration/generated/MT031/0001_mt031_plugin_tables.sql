-- multitenancy migrate-test
CREATE TABLE "enterprise_plugin_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"vendor" text NOT NULL,
	"source" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_plugin_catalog_kind" CHECK ("enterprise_plugin_catalog"."kind" in ('mcp','composio','open-connector')),
	CONSTRAINT "enterprise_plugin_catalog_source" CHECK ("enterprise_plugin_catalog"."source" in ('first-party','custom')),
	CONSTRAINT "enterprise_plugin_catalog_metadata_shape" CHECK ("enterprise_plugin_catalog"."metadata" ? 'summary' and not "enterprise_plugin_catalog"."metadata" ?| array['envelope','plaintext','secret','value','password','token','config','apiKey','api_key','secretRef','encryptedValue','encrypted_value'])
);
--> statement-breakpoint
CREATE TABLE "enterprise_plugin_installs" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"catalog_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"installed_by" text NOT NULL,
	"config" jsonb NOT NULL,
	"envelope" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_plugin_installs_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_plugin_install_status" CHECK ("enterprise_plugin_installs"."status" in ('active','disabled')),
	CONSTRAINT "enterprise_plugin_install_config_shape" CHECK (not "enterprise_plugin_installs"."config" ?| array['envelope','plaintext','secret','value','password','token','config','apiKey','api_key','secretRef','encryptedValue','encrypted_value'])
);
--> statement-breakpoint
ALTER TABLE "enterprise_plugin_installs" ADD CONSTRAINT "enterprise_plugin_installs_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_plugin_installs" ADD CONSTRAINT "enterprise_plugin_installs_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_plugin_installs" ADD CONSTRAINT "enterprise_plugin_installs_tenant_id_installed_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","installed_by") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_plugin_installs" ADD CONSTRAINT "enterprise_plugin_installs_catalog_id_enterprise_plugin_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."enterprise_plugin_catalog"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "enterprise_plugin_install_tenant_created_idx" ON "enterprise_plugin_installs" ("tenant_id","created_at","id");
--> statement-breakpoint
CREATE INDEX "enterprise_plugin_install_catalog_idx" ON "enterprise_plugin_installs" ("catalog_id");
--> statement-breakpoint
CREATE TABLE "enterprise_plugin_connections" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"install_id" text NOT NULL,
	"bound_by" text NOT NULL,
	"vendor_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_plugin_connections_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_plugin_connection_vendor_ref" CHECK (char_length("enterprise_plugin_connections"."vendor_ref") between 1 and 512)
);
--> statement-breakpoint
ALTER TABLE "enterprise_plugin_connections" ADD CONSTRAINT "enterprise_plugin_connections_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_plugin_connections" ADD CONSTRAINT "enterprise_plugin_connections_tenant_id_install_id_enterprise_plugin_installs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","install_id") REFERENCES "public"."enterprise_plugin_installs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_plugin_connections" ADD CONSTRAINT "enterprise_plugin_connections_tenant_id_bound_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","bound_by") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "enterprise_plugin_connection_install_idx" ON "enterprise_plugin_connections" ("tenant_id","install_id");
