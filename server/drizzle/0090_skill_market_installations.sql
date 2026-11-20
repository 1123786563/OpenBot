CREATE TABLE "skill_market_installations" (
	"command" text NOT NULL,
	"agent_id" text NOT NULL,
	"version" text NOT NULL,
	"version_id" integer NOT NULL,
	"registry_skill_id" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"instructions" text NOT NULL,
	"installed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_market_installations_agent_id_command_pk" PRIMARY KEY("agent_id","command")
);
--> statement-breakpoint
CREATE TABLE "skill_market_sources" (
	"command" text PRIMARY KEY NOT NULL,
	"registry" text NOT NULL,
	"namespace" text NOT NULL,
	"slug" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_market_installations" ADD CONSTRAINT "skill_market_installations_command_skill_market_sources_command_fk" FOREIGN KEY ("command") REFERENCES "public"."skill_market_sources"("command") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_market_installations" ADD CONSTRAINT "skill_market_installations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_market_sources" ADD CONSTRAINT "skill_market_sources_command_skills_slug_fk" FOREIGN KEY ("command") REFERENCES "public"."skills"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_market_source_key" ON "skill_market_sources" USING btree ("registry","namespace","slug");