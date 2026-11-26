CREATE TABLE "personal_workspace_agent_sandboxes" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"generation" uuid NOT NULL,
	"epoch" integer NOT NULL,
	"started_at" bigint NOT NULL,
	"issued_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"phase" text NOT NULL,
	"cutoff" text
);
--> statement-breakpoint
ALTER TABLE "personal_workspace_agent_sandboxes" ADD CONSTRAINT "personal_workspace_agent_sandboxes_workspace_id_personal_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."personal_workspaces"("id") ON DELETE cascade ON UPDATE no action;