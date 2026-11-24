CREATE TABLE "slack_shared_bot_access" (
	"installation_id" uuid NOT NULL,
	"bot_id" text NOT NULL,
	"granted" boolean DEFAULT false NOT NULL,
	"approval" jsonb,
	CONSTRAINT "slack_shared_bot_access_installation_id_bot_id_pk" PRIMARY KEY("installation_id","bot_id")
);
--> statement-breakpoint
CREATE TABLE "slack_shared_installations" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"team_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"bot_user_id" text NOT NULL,
	"channel_ids" text[] NOT NULL,
	CONSTRAINT "slack_shared_installations_id_unique" UNIQUE("id")
);
--> statement-breakpoint
ALTER TABLE "slack_shared_bot_access" ADD CONSTRAINT "slack_shared_bot_access_installation_id_slack_shared_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."slack_shared_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_shared_bot_access" ADD CONSTRAINT "slack_shared_bot_access_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;