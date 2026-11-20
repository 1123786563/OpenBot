CREATE TABLE "personal_workspace_suspensions" (
	"sequence" serial PRIMARY KEY NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"action" text NOT NULL,
	"operator" text NOT NULL,
	"reason" text NOT NULL,
	"display_reason" text,
	"effective_at" timestamp with time zone NOT NULL,
	CONSTRAINT "personal_workspace_suspensions_id_unique" UNIQUE("id")
);
--> statement-breakpoint
ALTER TABLE "personal_workspace_suspensions" ADD CONSTRAINT "personal_workspace_suspensions_workspace_id_personal_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."personal_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_workspace_suspensions_workspace_id_sequence_index" ON "personal_workspace_suspensions" USING btree ("workspace_id","sequence");