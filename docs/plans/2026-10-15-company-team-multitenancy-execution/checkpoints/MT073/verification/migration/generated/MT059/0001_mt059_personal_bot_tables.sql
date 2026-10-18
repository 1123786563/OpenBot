-- multitenancy migrate-test
CREATE TABLE "enterprise_personal_bots" (
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"display_name" text NOT NULL,
	"template_ref" text,
	"template_source_revision" integer,
	"document" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_personal_bots_tenant_id_workspace_id_principal_id_pk" PRIMARY KEY("tenant_id","workspace_id","principal_id"),
	CONSTRAINT "enterprise_personal_bots_revision" CHECK ("enterprise_personal_bots"."revision" > 0),
	CONSTRAINT "enterprise_personal_bots_template_pairing" CHECK (("enterprise_personal_bots"."template_ref" IS NULL) = ("enterprise_personal_bots"."template_source_revision" IS NULL)),
	CONSTRAINT "enterprise_personal_bots_template_source_revision" CHECK ("enterprise_personal_bots"."template_source_revision" IS NULL OR "enterprise_personal_bots"."template_source_revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_personal_bots_agent_id_global_uq" ON "enterprise_personal_bots" USING btree ("agent_id");
--> statement-breakpoint
ALTER TABLE "enterprise_personal_bots" ADD CONSTRAINT "enterprise_personal_bots_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_personal_bots" ADD CONSTRAINT "enterprise_personal_bots_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "enterprise_personal_bot_field_ownership" (
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"field_name" text NOT NULL,
	"managed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_personal_bot_field_ownership_tenant_id_workspace_id_principal_id_field_name_pk" PRIMARY KEY("tenant_id","workspace_id","principal_id","field_name")
);
--> statement-breakpoint
ALTER TABLE "enterprise_personal_bot_field_ownership" ADD CONSTRAINT "enterprise_personal_bot_field_ownership_personal_bot_fk" FOREIGN KEY ("tenant_id","workspace_id","principal_id") REFERENCES "public"."enterprise_personal_bots"("tenant_id","workspace_id","principal_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_personal_bot_field_ownership" ADD CONSTRAINT "enterprise_personal_bot_field_ownership_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_personal_bot_field_ownership" ADD CONSTRAINT "enterprise_personal_bot_field_ownership_managed_by" CHECK ("enterprise_personal_bot_field_ownership"."managed_by" in ('template','user'));
