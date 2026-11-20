CREATE TABLE "github_pilot_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"person_id" text NOT NULL,
	"registration" text NOT NULL,
	"github_user_id" text NOT NULL,
	"login" text NOT NULL,
	"credential" text NOT NULL,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "github_pilot_connections_workspace_id_person_id_registration_github_user_id_unique" UNIQUE("workspace_id","person_id","registration","github_user_id")
);
--> statement-breakpoint
CREATE TABLE "github_pilot_grants" (
	"workspace_id" text NOT NULL,
	"registration" text NOT NULL,
	"bot_id" text NOT NULL,
	"tool_ref" text NOT NULL,
	CONSTRAINT "github_pilot_grants_workspace_id_registration_bot_id_tool_ref_pk" PRIMARY KEY("workspace_id","registration","bot_id","tool_ref")
);
--> statement-breakpoint
CREATE TABLE "github_pilot_repositories" (
	"workspace_id" text NOT NULL,
	"registration" text NOT NULL,
	"repository_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"node_id" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "github_pilot_repositories_workspace_id_registration_repository_id_pk" PRIMARY KEY("workspace_id","registration","repository_id")
);
--> statement-breakpoint
CREATE TABLE "github_pilot_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"person_id" text NOT NULL,
	"registration" text NOT NULL,
	"verifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_pilot_connections" ADD CONSTRAINT "github_pilot_connections_person_id_users_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_pilot_grants" ADD CONSTRAINT "github_pilot_grants_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_pilot_states" ADD CONSTRAINT "github_pilot_states_person_id_users_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;