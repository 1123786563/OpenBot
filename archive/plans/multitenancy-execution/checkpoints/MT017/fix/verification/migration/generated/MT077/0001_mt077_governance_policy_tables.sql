-- multitenancy migrate-test
CREATE TABLE "enterprise_governance_policies" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"document" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_governance_policy_revision" CHECK ("enterprise_governance_policies"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "enterprise_governance_policies" ADD CONSTRAINT "enterprise_governance_policies_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "enterprise_governance_overrides" (
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"document" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_governance_overrides_tenant_id_workspace_id_pk" PRIMARY KEY("tenant_id","workspace_id"),
	CONSTRAINT "enterprise_governance_override_revision" CHECK ("enterprise_governance_overrides"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "enterprise_governance_overrides" ADD CONSTRAINT "enterprise_governance_overrides_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "enterprise_template_installs" (
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"template_ref" text NOT NULL,
	"source_revision" integer NOT NULL,
	"document" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_template_installs_tenant_id_workspace_id_template_ref_pk" PRIMARY KEY("tenant_id","workspace_id","template_ref"),
	CONSTRAINT "enterprise_template_install_source_revision" CHECK ("enterprise_template_installs"."source_revision" > 0),
	CONSTRAINT "enterprise_template_install_revision" CHECK ("enterprise_template_installs"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "enterprise_template_installs" ADD CONSTRAINT "enterprise_template_installs_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
