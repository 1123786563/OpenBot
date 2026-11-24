CREATE TABLE "personal_workspace_closures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"cutoff_deadline" timestamp with time zone NOT NULL,
	"computer_cutoff" text,
	"work_cutoff" text,
	CONSTRAINT "personal_workspace_closures_account_id_unique" UNIQUE("account_id"),
	CONSTRAINT "personal_workspace_closures_workspace_id_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
ALTER TABLE "personal_workspace_closures" ADD CONSTRAINT "personal_workspace_closures_account_id_personal_saas_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."personal_saas_accounts"("id") ON DELETE no action ON UPDATE no action;