-- multitenancy migrate-test
CREATE TABLE "enterprise_shared_use_requests" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"install_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"proposed_audience" text NOT NULL,
	"proposed_outside_input" boolean NOT NULL,
	"proposed_members" jsonb NOT NULL,
	"proposed_params_digest" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_shared_use_requests_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_shared_use_request_audience" CHECK ("enterprise_shared_use_requests"."proposed_audience" in ('owner','people','team')),
	CONSTRAINT "enterprise_shared_use_request_reason" CHECK ("enterprise_shared_use_requests"."reason" in ('publish','trigger','grant','refused_call')),
	CONSTRAINT "enterprise_shared_use_request_status" CHECK ("enterprise_shared_use_requests"."status" in ('pending','approved','declined','withdrawn','superseded')),
	CONSTRAINT "enterprise_shared_use_request_digest_shape" CHECK ("enterprise_shared_use_requests"."proposed_params_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "enterprise_shared_use_request_members_shape" CHECK (jsonb_typeof("enterprise_shared_use_requests"."proposed_members") = 'array'),
	CONSTRAINT "enterprise_shared_use_request_decision_shape" CHECK (("enterprise_shared_use_requests"."status" in ('approved','declined')) = ("enterprise_shared_use_requests"."decided_by" is not null and "enterprise_shared_use_requests"."decided_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "enterprise_shared_use_requests" ADD CONSTRAINT "enterprise_shared_use_requests_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_shared_use_requests" ADD CONSTRAINT "enterprise_shared_use_requests_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_shared_use_requests" ADD CONSTRAINT "enterprise_shared_use_requests_tenant_id_agent_id_enterprise_bot_ownership_tenant_id_agent_id_fk" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "public"."enterprise_bot_ownership"("tenant_id","agent_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_shared_use_requests" ADD CONSTRAINT "enterprise_shared_use_requests_tenant_id_install_id_enterprise_plugin_installs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","install_id") REFERENCES "public"."enterprise_plugin_installs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_shared_use_requests" ADD CONSTRAINT "enterprise_shared_use_requests_tenant_id_requested_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_shared_use_requests" ADD CONSTRAINT "enterprise_shared_use_requests_tenant_id_decided_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","decided_by") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "enterprise_shared_use_request_tenant_created_idx" ON "enterprise_shared_use_requests" ("tenant_id","created_at","id");
--> statement-breakpoint
CREATE INDEX "enterprise_shared_use_request_object_idx" ON "enterprise_shared_use_requests" ("tenant_id","agent_id","install_id","workspace_id");
--> statement-breakpoint
CREATE TABLE "enterprise_shared_use_approvals" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"install_id" text NOT NULL,
	"request_id" text NOT NULL,
	"params_digest" text NOT NULL,
	"audience" text NOT NULL,
	"outside_input" boolean NOT NULL,
	"members" jsonb NOT NULL,
	"approved_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_shared_use_approvals_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_shared_use_approval_audience" CHECK ("enterprise_shared_use_approvals"."audience" in ('owner','people','team')),
	CONSTRAINT "enterprise_shared_use_approval_digest_shape" CHECK ("enterprise_shared_use_approvals"."params_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "enterprise_shared_use_approval_members_shape" CHECK (jsonb_typeof("enterprise_shared_use_approvals"."members") = 'array')
);
--> statement-breakpoint
ALTER TABLE "enterprise_shared_use_approvals" ADD CONSTRAINT "enterprise_shared_use_approvals_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_shared_use_approvals" ADD CONSTRAINT "enterprise_shared_use_approvals_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_shared_use_approvals" ADD CONSTRAINT "enterprise_shared_use_approvals_tenant_id_agent_id_enterprise_bot_ownership_tenant_id_agent_id_fk" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "public"."enterprise_bot_ownership"("tenant_id","agent_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_shared_use_approvals" ADD CONSTRAINT "enterprise_shared_use_approvals_tenant_id_install_id_enterprise_plugin_installs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","install_id") REFERENCES "public"."enterprise_plugin_installs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_shared_use_approvals" ADD CONSTRAINT "enterprise_shared_use_approvals_tenant_id_request_id_enterprise_shared_use_requests_tenant_id_id_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."enterprise_shared_use_requests"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_shared_use_approvals" ADD CONSTRAINT "enterprise_shared_use_approvals_tenant_id_approved_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","approved_by") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "enterprise_shared_use_approval_object_idx" ON "enterprise_shared_use_approvals" ("tenant_id","agent_id","install_id","workspace_id","params_digest");
