CREATE TABLE "skill_market_runs" (
	"actor_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"run_id" text NOT NULL,
	"registry" text NOT NULL,
	"registry_skill_id" integer NOT NULL,
	"version_id" integer NOT NULL,
	"pause_reason" text,
	"computer_tool_calls" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "skill_market_runs_actor_id_bot_id_thread_id_run_id_pk" PRIMARY KEY("actor_id","bot_id","thread_id","run_id")
);
--> statement-breakpoint
ALTER TABLE "skill_market_runs" ADD CONSTRAINT "skill_market_runs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_market_runs" ADD CONSTRAINT "skill_market_runs_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_market_runs_version_idx" ON "skill_market_runs" USING btree ("registry","registry_skill_id","version_id");