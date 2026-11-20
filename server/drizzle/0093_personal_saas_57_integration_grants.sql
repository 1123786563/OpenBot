CREATE TABLE "personal_workspace_integration_grants" (
	"credential_hash" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"action" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "personal_workspace_integration_action_check" CHECK ("personal_workspace_integration_grants"."action" = 'assistant.read')
);
--> statement-breakpoint
ALTER TABLE "personal_workspace_integration_grants" ADD CONSTRAINT "personal_workspace_integration_grants_workspace_id_personal_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."personal_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_workspace_integration_grants" ADD CONSTRAINT "personal_workspace_integration_grants_agent_id_personal_workspace_default_bots_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."personal_workspace_default_bots"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_workspace_integration_grants_agent_id_index" ON "personal_workspace_integration_grants" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "personal_workspace_integration_grants_workspace_id_index" ON "personal_workspace_integration_grants" USING btree ("workspace_id");