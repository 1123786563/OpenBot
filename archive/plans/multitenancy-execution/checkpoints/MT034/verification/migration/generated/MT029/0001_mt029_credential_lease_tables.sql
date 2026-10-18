-- multitenancy migrate-test
CREATE TABLE "enterprise_credential_leases" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"credential_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"purpose" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "enterprise_credential_leases_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_credential_lease_purpose" CHECK ("enterprise_credential_leases"."purpose" in ('bot-run','connector-call','site-access')),
	CONSTRAINT "enterprise_credential_lease_status" CHECK ("enterprise_credential_leases"."status" in ('active','revoked')),
	CONSTRAINT "enterprise_credential_lease_window" CHECK ("enterprise_credential_leases"."expires_at" > "enterprise_credential_leases"."created_at"),
	CONSTRAINT "enterprise_credential_lease_row_shape" CHECK (("enterprise_credential_leases"."status" = 'revoked') = ("enterprise_credential_leases"."revoked_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "enterprise_credential_leases" ADD CONSTRAINT "enterprise_credential_leases_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_credential_leases" ADD CONSTRAINT "enterprise_credential_leases_tenant_id_credential_id_enterprise_credentials_tenant_id_id_fk" FOREIGN KEY ("tenant_id","credential_id") REFERENCES "public"."enterprise_credentials"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_credential_leases" ADD CONSTRAINT "enterprise_credential_leases_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_credential_leases" ADD CONSTRAINT "enterprise_credential_leases_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "enterprise_credential_lease_tenant_created_idx" ON "enterprise_credential_leases" ("tenant_id","created_at","id");
--> statement-breakpoint
CREATE INDEX "enterprise_credential_lease_credential_idx" ON "enterprise_credential_leases" ("tenant_id","credential_id");
--> statement-breakpoint
CREATE TABLE "enterprise_credential_lease_audit" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"lease_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"action" text NOT NULL,
	"detail" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_credential_lease_audit_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_credential_lease_audit_action" CHECK ("enterprise_credential_lease_audit"."action" in ('issued','validated','revoked')),
	CONSTRAINT "enterprise_credential_lease_audit_detail_shape" CHECK (not "enterprise_credential_lease_audit"."detail" ?| array['envelope','plaintext','secret','value','password','token'])
);
--> statement-breakpoint
ALTER TABLE "enterprise_credential_lease_audit" ADD CONSTRAINT "enterprise_credential_lease_audit_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "enterprise_credential_lease_audit_tenant_time_idx" ON "enterprise_credential_lease_audit" ("tenant_id","occurred_at");
