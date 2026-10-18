-- multitenancy migrate-test
CREATE TABLE "job_ownership" (
	"kind" text NOT NULL,
	"object_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_ownership_kind" CHECK ("job_ownership"."kind" in ('task','run','trigger')),
	CONSTRAINT "job_ownership_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "job_ownership_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "job_ownership_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "job_ownership_principal_id_enterprise_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."enterprise_principals"("id") ON DELETE cascade ON UPDATE no action,
	PRIMARY KEY ("kind","object_id")
);
--> statement-breakpoint
CREATE INDEX "job_ownership_scope_created_idx" ON "job_ownership" ("tenant_id","workspace_id","principal_id","created_at");
--> statement-breakpoint
CREATE TABLE "job_config_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"object_id" text NOT NULL,
	"purpose" text NOT NULL,
	"company_revision" integer NOT NULL,
	"override_revision" integer,
	"basis_digest" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_config_snapshots_purpose" CHECK ("job_config_snapshots"."purpose" in ('creation','execution')),
	CONSTRAINT "job_config_snapshots_company_revision" CHECK ("job_config_snapshots"."company_revision" > 0),
	CONSTRAINT "job_config_snapshots_override_revision" CHECK ("job_config_snapshots"."override_revision" is null or "job_config_snapshots"."override_revision" > 0),
	CONSTRAINT "job_config_snapshots_kind_object_id_job_ownership_kind_object_id_fk" FOREIGN KEY ("kind","object_id") REFERENCES "public"."job_ownership"("kind","object_id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "job_config_snapshots_creation_unique" ON "job_config_snapshots" ("kind","object_id") WHERE "job_config_snapshots"."purpose" = 'creation';
--> statement-breakpoint
CREATE INDEX "job_config_snapshots_history_idx" ON "job_config_snapshots" ("kind","object_id","captured_at");
--> statement-breakpoint
CREATE TABLE "job_leases" (
	"kind" text NOT NULL,
	"object_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"claimed_by_kind" text,
	"claimed_by" text,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"finished_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_leases_claimed_by_kind" CHECK ("job_leases"."claimed_by_kind" is null or "job_leases"."claimed_by_kind" in ('worker','principal')),
	CONSTRAINT "job_leases_claimed_row_shape" CHECK (("job_leases"."claimed_by_kind" is null and "job_leases"."claimed_by" is null and "job_leases"."lease_until" is null) or ("job_leases"."claimed_by_kind" is not null and "job_leases"."claimed_by" is not null and "job_leases"."lease_until" is not null)),
	CONSTRAINT "job_leases_attempts_non_negative" CHECK ("job_leases"."attempts" >= 0),
	CONSTRAINT "job_leases_kind_object_id_job_ownership_kind_object_id_fk" FOREIGN KEY ("kind","object_id") REFERENCES "public"."job_ownership"("kind","object_id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "job_leases_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action,
	PRIMARY KEY ("kind","object_id")
);
