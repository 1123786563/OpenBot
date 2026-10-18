-- multitenancy migrate-test
CREATE TABLE "enterprise_credentials" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"classification" text NOT NULL,
	"workspace_id" text,
	"owner_principal_id" text,
	"target" text NOT NULL,
	"display" jsonb NOT NULL,
	"envelope" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_credentials_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_credential_kind" CHECK ("enterprise_credentials"."kind" in ('connection','site-login')),
	CONSTRAINT "enterprise_credential_classification" CHECK ("enterprise_credentials"."classification" in ('personal','team','company')),
	CONSTRAINT "enterprise_credential_status" CHECK ("enterprise_credentials"."status" in ('active','revoked')),
	CONSTRAINT "enterprise_credential_row_shape" CHECK (("enterprise_credentials"."classification" = 'team') = ("enterprise_credentials"."workspace_id" is not null) and ("enterprise_credentials"."classification" = 'personal') = ("enterprise_credentials"."owner_principal_id" is not null)),
	CONSTRAINT "enterprise_credential_display_shape" CHECK ("enterprise_credentials"."display" ? 'label' and not "enterprise_credentials"."display" ?| array['envelope','plaintext','secret','value','password','token'])
);
--> statement-breakpoint
ALTER TABLE "enterprise_credentials" ADD CONSTRAINT "enterprise_credentials_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_credentials" ADD CONSTRAINT "enterprise_credentials_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_credentials" ADD CONSTRAINT "enterprise_credentials_tenant_id_owner_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","owner_principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "enterprise_credential_tenant_created_idx" ON "enterprise_credentials" ("tenant_id","created_at","id");
--> statement-breakpoint
CREATE TABLE "enterprise_credential_actions" (
	"tenant_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"action" text NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_credential_actions_tenant_id_credential_id_principal_id_action_pk" PRIMARY KEY("tenant_id","credential_id","principal_id","action"),
	CONSTRAINT "enterprise_credential_action_kind" CHECK ("enterprise_credential_actions"."action" in ('use','disclose'))
);
--> statement-breakpoint
ALTER TABLE "enterprise_credential_actions" ADD CONSTRAINT "enterprise_credential_actions_tenant_id_credential_id_enterprise_credentials_tenant_id_id_fk" FOREIGN KEY ("tenant_id","credential_id") REFERENCES "public"."enterprise_credentials"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_credential_actions" ADD CONSTRAINT "enterprise_credential_actions_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_credential_actions" ADD CONSTRAINT "enterprise_credential_actions_tenant_id_granted_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","granted_by") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "enterprise_credential_audit" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"credential_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"action" text DEFAULT 'plaintext.disclosed' NOT NULL,
	"detail" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_credential_audit_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_credential_audit_action" CHECK ("enterprise_credential_audit"."action" = 'plaintext.disclosed'),
	CONSTRAINT "enterprise_credential_audit_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "enterprise_credential_audit_tenant_time_idx" ON "enterprise_credential_audit" ("tenant_id","occurred_at");
