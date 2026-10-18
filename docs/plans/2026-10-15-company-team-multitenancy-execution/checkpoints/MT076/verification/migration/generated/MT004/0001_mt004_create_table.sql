-- multitenancy migrate-test
CREATE TABLE "enterprise_workspace_memberships" (
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"epoch" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_workspace_memberships_tenant_id_workspace_id_principal_id_pk" PRIMARY KEY("tenant_id","workspace_id","principal_id"),
	CONSTRAINT "enterprise_workspace_member_status" CHECK ("enterprise_workspace_memberships"."status" in ('active','suspended')),
	CONSTRAINT "enterprise_workspace_member_epoch" CHECK ("enterprise_workspace_memberships"."epoch" > 0)
);
--> statement-breakpoint
ALTER TABLE "enterprise_workspace_memberships" ADD CONSTRAINT "enterprise_workspace_memberships_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_workspace_memberships" ADD CONSTRAINT "enterprise_workspace_memberships_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_workspace_membership_principal_tenant" ON "enterprise_workspace_memberships" USING btree ("principal_id","tenant_id","workspace_id");
