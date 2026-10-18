-- multitenancy migrate-test
CREATE TABLE "openmuse_task_scopes" (
	"task_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"attribution" text DEFAULT 'created' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openmuse_task_scopes_attribution" CHECK ("openmuse_task_scopes"."attribution" in ('created','backfill'))
);
--> statement-breakpoint
CREATE INDEX "openmuse_task_scopes_scope_list_idx" ON "openmuse_task_scopes" USING btree ("tenant_id","workspace_id","principal_id","created_at","task_id");
--> statement-breakpoint
ALTER TABLE "openmuse_task_scopes" ADD CONSTRAINT "openmuse_task_scopes_task_fk" FOREIGN KEY ("task_id") REFERENCES "public"."openmuse_tasks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "openmuse_task_scopes" ADD CONSTRAINT "openmuse_task_scopes_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "openmuse_task_scopes" ADD CONSTRAINT "openmuse_task_scopes_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "openmuse_task_scopes" ADD CONSTRAINT "openmuse_task_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
