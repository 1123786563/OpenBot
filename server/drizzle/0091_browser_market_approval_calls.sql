CREATE TABLE "browser_market_approval_calls" (
	"owner_user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"run_id" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "browser_market_approval_calls_owner_user_id_bot_id_thread_id_tool_call_id_pk" PRIMARY KEY("owner_user_id","bot_id","thread_id","tool_call_id")
);
--> statement-breakpoint
ALTER TABLE "browser_market_approval_calls" ADD CONSTRAINT "browser_market_approval_calls_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_market_approval_calls" ADD CONSTRAINT "browser_market_approval_calls_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;