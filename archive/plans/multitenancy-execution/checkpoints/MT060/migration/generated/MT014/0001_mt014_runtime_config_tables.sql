-- multitenancy migrate-test
CREATE TABLE "enterprise_runtime_configs" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"document" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_runtime_config_revision" CHECK ("enterprise_runtime_configs"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "enterprise_runtime_configs" ADD CONSTRAINT "enterprise_runtime_configs_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "enterprise_runtime_config_overrides" (
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"document" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_runtime_config_overrides_tenant_id_workspace_id_pk" PRIMARY KEY("tenant_id","workspace_id"),
	CONSTRAINT "enterprise_runtime_config_override_revision" CHECK ("enterprise_runtime_config_overrides"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "enterprise_runtime_config_overrides" ADD CONSTRAINT "enterprise_runtime_config_overrides_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
