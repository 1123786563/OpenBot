CREATE TABLE "enterprise_memberships" (
	"tenant_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"epoch" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_memberships_tenant_id_principal_id_pk" PRIMARY KEY("tenant_id","principal_id"),
	CONSTRAINT "enterprise_member_role" CHECK ("enterprise_memberships"."role" in ('tenant_admin','member','auditor')),
	CONSTRAINT "enterprise_member_status" CHECK ("enterprise_memberships"."status" in ('active','suspended')),
	CONSTRAINT "enterprise_member_epoch" CHECK ("enterprise_memberships"."epoch" > 0)
);
--> statement-breakpoint
CREATE TABLE "enterprise_principals" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_principal_status" CHECK ("enterprise_principals"."status" in ('active','suspended'))
);
--> statement-breakpoint
CREATE TABLE "enterprise_tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"policy_revision" text DEFAULT 'tenancy-v1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_tenant_status" CHECK ("enterprise_tenants"."status" in ('active','suspended'))
);
--> statement-breakpoint
CREATE TABLE "enterprise_workspaces" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_workspaces_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "enterprise_identity_events" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"actor" text NOT NULL,
	"principal_id" text NOT NULL,
	"kind" text NOT NULL,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enterprise_resource_grants" (
	"tenant_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"action" text NOT NULL,
	CONSTRAINT "enterprise_resource_grants_tenant_id_resource_id_principal_id_action_pk" PRIMARY KEY("tenant_id","resource_id","principal_id","action"),
	CONSTRAINT "enterprise_grant_action" CHECK ("enterprise_resource_grants"."action"='read')
);
--> statement-breakpoint
CREATE TABLE "enterprise_resources" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"acl_epoch" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "enterprise_resources_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_resource_status" CHECK ("enterprise_resources"."status" in ('active','deleted')),
	CONSTRAINT "enterprise_resource_versions" CHECK ("enterprise_resources"."revision">0 and "enterprise_resources"."acl_epoch">0)
);
--> statement-breakpoint
CREATE TABLE "enterprise_security_events" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"operation_id" text NOT NULL,
	"actor" text NOT NULL,
	"kind" text NOT NULL,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_security_events_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "enterprise_memberships" ADD CONSTRAINT "enterprise_memberships_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_memberships" ADD CONSTRAINT "enterprise_memberships_principal_id_enterprise_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."enterprise_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_principals" ADD CONSTRAINT "enterprise_principals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_workspaces" ADD CONSTRAINT "enterprise_workspaces_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_resource_grants" ADD CONSTRAINT "enterprise_resource_grants_tenant_id_resource_id_enterprise_resources_tenant_id_id_fk" FOREIGN KEY ("tenant_id","resource_id") REFERENCES "public"."enterprise_resources"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_resource_grants" ADD CONSTRAINT "enterprise_resource_grants_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_resources" ADD CONSTRAINT "enterprise_resources_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_security_events" ADD CONSTRAINT "enterprise_security_events_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "enterprise_memberships_principal_tenant_idx" ON "enterprise_memberships" USING btree ("principal_id","tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_principal_user" ON "enterprise_principals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "enterprise_security_events_tenant_created_idx" ON "enterprise_security_events" USING btree ("tenant_id","created_at","id");