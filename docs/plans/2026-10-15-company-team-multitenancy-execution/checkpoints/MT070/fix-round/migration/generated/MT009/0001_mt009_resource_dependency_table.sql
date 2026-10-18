-- multitenancy migrate-test
CREATE TABLE "enterprise_resource_dependencies" (
	"tenant_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"dependency_kind" text NOT NULL,
	"dependency_ref" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_resource_dependencies_tenant_id_resource_id_dependency_kind_dependency_ref_pk" PRIMARY KEY("tenant_id","resource_id","dependency_kind","dependency_ref"),
	CONSTRAINT "enterprise_resource_dependency_kind" CHECK ("enterprise_resource_dependencies"."dependency_kind" in ('model','credential','knowledge')),
	CONSTRAINT "enterprise_resource_dependency_status" CHECK ("enterprise_resource_dependencies"."status" in ('active','invalid')),
	CONSTRAINT "enterprise_resource_dependency_ref_present" CHECK ("enterprise_resource_dependencies"."dependency_ref" <> '')
);
--> statement-breakpoint
ALTER TABLE "enterprise_resource_dependencies" ADD CONSTRAINT "enterprise_resource_dependencies_tenant_id_resource_id_enterprise_resources_tenant_id_id_fk" FOREIGN KEY ("tenant_id","resource_id") REFERENCES "public"."enterprise_resources"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
