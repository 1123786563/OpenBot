CREATE TABLE "personal_saas_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"email" text NOT NULL,
	CONSTRAINT "personal_saas_accounts_issuer_subject_unique" UNIQUE("issuer","subject")
);
--> statement-breakpoint
CREATE TABLE "personal_saas_assistants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text DEFAULT 'Personal Assistant' NOT NULL,
	CONSTRAINT "personal_saas_assistants_workspace_id_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
CREATE TABLE "personal_saas_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"casdoor_access_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	CONSTRAINT "personal_workspaces_owner_id_unique" UNIQUE("owner_id")
);
--> statement-breakpoint
ALTER TABLE "personal_saas_assistants" ADD CONSTRAINT "personal_saas_assistants_workspace_id_personal_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."personal_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_saas_sessions" ADD CONSTRAINT "personal_saas_sessions_account_id_personal_saas_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."personal_saas_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_workspaces" ADD CONSTRAINT "personal_workspaces_owner_id_personal_saas_accounts_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."personal_saas_accounts"("id") ON DELETE no action ON UPDATE no action;