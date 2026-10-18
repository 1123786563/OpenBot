-- multitenancy migrate-test
CREATE TABLE "enterprise_sso_configs" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"document" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_sso_config_revision" CHECK ("enterprise_sso_configs"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "enterprise_sso_configs" ADD CONSTRAINT "enterprise_sso_configs_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "enterprise_scim_directory_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"connection_key" text NOT NULL,
	"credential_ref" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_deprovision_principal_id" text,
	"last_deprovision_epoch" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivated_at" timestamp with time zone,
	CONSTRAINT "enterprise_scim_binding_status" CHECK ("enterprise_scim_directory_bindings"."status" in ('active','deactivated')),
	CONSTRAINT "enterprise_scim_binding_deprovision_fact" CHECK (("last_deprovision_principal_id" is null) = ("last_deprovision_epoch" is null))
);
--> statement-breakpoint
ALTER TABLE "enterprise_scim_directory_bindings" ADD CONSTRAINT "enterprise_scim_binding_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_scim_binding_connection_key" ON "enterprise_scim_directory_bindings" ("connection_key");
--> statement-breakpoint
CREATE TABLE "enterprise_identity_binding_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "enterprise_identity_binding_kind" CHECK ("enterprise_identity_binding_intents"."kind" in ('sso','scim')),
	CONSTRAINT "enterprise_identity_binding_window" CHECK ("enterprise_identity_binding_intents"."expires_at" > "enterprise_identity_binding_intents"."created_at")
);
--> statement-breakpoint
ALTER TABLE "enterprise_identity_binding_intents" ADD CONSTRAINT "enterprise_identity_binding_intents_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_identity_binding_intents" ADD CONSTRAINT "enterprise_identity_binding_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
