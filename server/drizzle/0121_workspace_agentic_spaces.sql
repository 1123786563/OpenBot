CREATE TABLE "personal_workspace_agentic_spaces" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"agentic_space_id" text NOT NULL,
	"file_system_id" text NOT NULL,
	"access_point_id" text NOT NULL,
	"access_point_domain" text NOT NULL,
	"role_arn" text NOT NULL,
	"storage_egress_ips" text[] NOT NULL,
	"vpc_id" text NOT NULL,
	"vswitch_id" text NOT NULL,
	"security_group_id" text NOT NULL,
	CONSTRAINT "personal_workspace_agentic_spaces_agentic_space_id_unique" UNIQUE("agentic_space_id"),
	CONSTRAINT "personal_workspace_agentic_spaces_access_point_id_unique" UNIQUE("access_point_id"),
	CONSTRAINT "personal_workspace_agentic_spaces_role_arn_unique" UNIQUE("role_arn")
);
--> statement-breakpoint
ALTER TABLE "personal_workspace_agent_sandboxes" ADD COLUMN "flash_agentic_space_id" text;--> statement-breakpoint
ALTER TABLE "personal_workspace_agentic_spaces" ADD CONSTRAINT "personal_workspace_agentic_spaces_workspace_id_personal_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."personal_workspaces"("id") ON DELETE cascade ON UPDATE no action;