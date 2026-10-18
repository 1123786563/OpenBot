-- multitenancy migrate-test
CREATE TABLE "enterprise_resource_shares" (
	"tenant_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"action" text DEFAULT 'read' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_resource_shares_tenant_id_resource_id_principal_id_action_pk" PRIMARY KEY("tenant_id","resource_id","principal_id","action"),
	CONSTRAINT "enterprise_share_action" CHECK ("enterprise_resource_shares"."action" = 'read'),
	CONSTRAINT "enterprise_share_validity" CHECK ("enterprise_resource_shares"."expires_at" > "enterprise_resource_shares"."created_at")
);
--> statement-breakpoint
ALTER TABLE "enterprise_resource_shares" ADD CONSTRAINT "enterprise_resource_shares_tenant_id_resource_id_enterprise_resources_tenant_id_id_fk" FOREIGN KEY ("tenant_id","resource_id") REFERENCES "public"."enterprise_resources"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_resource_shares" ADD CONSTRAINT "enterprise_resource_shares_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_resource_shares" ADD CONSTRAINT "enterprise_resource_shares_tenant_id_granted_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","granted_by") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;
