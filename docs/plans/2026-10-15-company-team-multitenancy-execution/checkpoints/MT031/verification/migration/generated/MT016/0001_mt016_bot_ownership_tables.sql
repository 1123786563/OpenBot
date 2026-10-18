-- multitenancy migrate-test
CREATE TABLE "enterprise_bot_ownership" (
	"tenant_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_principal_id" text NOT NULL,
	"display_name" text NOT NULL,
	"default_config" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"acl_epoch" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_bot_ownership_tenant_id_agent_id_pk" PRIMARY KEY("tenant_id","agent_id"),
	CONSTRAINT "enterprise_bot_ownership_status" CHECK ("enterprise_bot_ownership"."status" in ('active','deleted')),
	CONSTRAINT "enterprise_bot_ownership_versions" CHECK ("enterprise_bot_ownership"."revision" > 0 and "enterprise_bot_ownership"."acl_epoch" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_bot_ownership_agent_id_global_uq" ON "enterprise_bot_ownership" USING btree ("agent_id");
--> statement-breakpoint
ALTER TABLE "enterprise_bot_ownership" ADD CONSTRAINT "enterprise_bot_ownership_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_bot_ownership" ADD CONSTRAINT "enterprise_bot_ownership_tenant_id_owner_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","owner_principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "enterprise_bot_preferences" (
	"tenant_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"preferences" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_bot_preferences_tenant_id_agent_id_principal_id_pk" PRIMARY KEY("tenant_id","agent_id","principal_id")
);
--> statement-breakpoint
ALTER TABLE "enterprise_bot_preferences" ADD CONSTRAINT "enterprise_bot_preferences_tenant_id_agent_id_enterprise_bot_ownership_tenant_id_agent_id_fk" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "public"."enterprise_bot_ownership"("tenant_id","agent_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_bot_preferences" ADD CONSTRAINT "enterprise_bot_preferences_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;
