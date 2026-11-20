CREATE TABLE "slack_pilot_connections" (
	"workspace_id" text NOT NULL,
	"registration" text NOT NULL,
	"person_id" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_scope" text NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"credential" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revision" uuid NOT NULL,
	"verification_required_at" timestamp with time zone,
	CONSTRAINT "slack_pilot_stable_subject" UNIQUE("workspace_id","registration","person_id","subject_scope","user_id"),
	CONSTRAINT "slack_pilot_connection_owner" UNIQUE("workspace_id","registration","person_id","id")
);
--> statement-breakpoint
CREATE TABLE "slack_pilot_defaults" (
	"workspace_id" text NOT NULL,
	"registration" text NOT NULL,
	"person_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	CONSTRAINT "slack_pilot_defaults_workspace_id_registration_person_id_pk" PRIMARY KEY("workspace_id","registration","person_id")
);
--> statement-breakpoint
CREATE TABLE "slack_pilot_grants" (
	"workspace_id" text NOT NULL,
	"registration" text NOT NULL,
	"bot_id" text NOT NULL,
	"tool_ref" text NOT NULL,
	CONSTRAINT "slack_pilot_grants_workspace_id_registration_bot_id_tool_ref_pk" PRIMARY KEY("workspace_id","registration","bot_id","tool_ref")
);
--> statement-breakpoint
CREATE TABLE "slack_pilot_states" (
	"workspace_id" text NOT NULL,
	"registration" text NOT NULL,
	"person_id" text NOT NULL,
	"state_hash" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slack_pilot_connections" ADD CONSTRAINT "slack_pilot_connections_person_id_users_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_pilot_defaults" ADD CONSTRAINT "slack_pilot_defaults_person_id_users_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_pilot_defaults" ADD CONSTRAINT "slack_pilot_default_owner" FOREIGN KEY ("workspace_id","registration","person_id","connection_id") REFERENCES "public"."slack_pilot_connections"("workspace_id","registration","person_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_pilot_grants" ADD CONSTRAINT "slack_pilot_grants_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_pilot_states" ADD CONSTRAINT "slack_pilot_states_person_id_users_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;