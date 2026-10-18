-- multitenancy migrate-test
CREATE TABLE "enterprise_oauth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"purpose" text NOT NULL,
	"target" text NOT NULL,
	"verifier" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failed_reason" text,
	CONSTRAINT "enterprise_oauth_state_purpose" CHECK ("enterprise_oauth_states"."purpose" in ('connection','site-login')),
	CONSTRAINT "enterprise_oauth_state_target" CHECK (char_length("enterprise_oauth_states"."target") between 1 and 512),
	CONSTRAINT "enterprise_oauth_state_verifier" CHECK (char_length("enterprise_oauth_states"."verifier") >= 43),
	CONSTRAINT "enterprise_oauth_state_status" CHECK ("enterprise_oauth_states"."status" in ('pending','consumed','failed')),
	CONSTRAINT "enterprise_oauth_state_window" CHECK ("enterprise_oauth_states"."expires_at" > "enterprise_oauth_states"."created_at"),
	CONSTRAINT "enterprise_oauth_state_failed_reason" CHECK (("enterprise_oauth_states"."failed_reason" is null) = ("enterprise_oauth_states"."failed_at" is null) and ("enterprise_oauth_states"."failed_reason" is null or "enterprise_oauth_states"."failed_reason" in ('vendor-refused','record-failed','abandoned'))),
	CONSTRAINT "enterprise_oauth_state_row_shape" CHECK (("enterprise_oauth_states"."status" = 'pending') = ("enterprise_oauth_states"."consumed_at" is null and "enterprise_oauth_states"."failed_at" is null) and ("enterprise_oauth_states"."status" = 'consumed') = ("enterprise_oauth_states"."consumed_at" is not null and "enterprise_oauth_states"."failed_at" is null) and ("enterprise_oauth_states"."status" = 'failed') = ("enterprise_oauth_states"."failed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "enterprise_oauth_states" ADD CONSTRAINT "enterprise_oauth_states_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_oauth_states" ADD CONSTRAINT "enterprise_oauth_states_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_oauth_states" ADD CONSTRAINT "enterprise_oauth_states_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "enterprise_oauth_state_tenant_created_idx" ON "enterprise_oauth_states" ("tenant_id","created_at","id");
