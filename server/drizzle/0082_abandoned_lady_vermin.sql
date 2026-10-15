CREATE TABLE "craft_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"turn_index" integer NOT NULL,
	"type" text NOT NULL,
	"message_metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "craft_messages_type_check" CHECK ("craft_messages"."type" IN ('system', 'user', 'assistant', 'tool_call_response', 'user_reminder'))
);
--> statement-breakpoint
CREATE TABLE "craft_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text,
	"status" text DEFAULT 'initializing' NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"nextjs_port" integer,
	"sharing_scope" text DEFAULT 'private' NOT NULL,
	"origin" text DEFAULT 'INTERACTIVE' NOT NULL,
	"opencode_session_id" text,
	"agent_provider" text,
	"agent_model" text,
	"skills_hash" text,
	"mcp_config_hash" text,
	CONSTRAINT "craft_sessions_status_check" CHECK ("craft_sessions"."status" IN ('initializing', 'active', 'idle', 'failed')),
	CONSTRAINT "craft_sessions_origin_check" CHECK ("craft_sessions"."origin" IN ('INTERACTIVE', 'SCHEDULED', 'SLACK')),
	CONSTRAINT "craft_sessions_sharing_scope_check" CHECK ("craft_sessions"."sharing_scope" IN ('private', 'public_org'))
);
--> statement-breakpoint
CREATE TABLE "craft_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"storage_path" text NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "craft_messages" ADD CONSTRAINT "craft_messages_session_id_craft_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."craft_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "craft_sessions" ADD CONSTRAINT "craft_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "craft_snapshots" ADD CONSTRAINT "craft_snapshots_session_id_craft_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."craft_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "craft_messages_session_turn_idx" ON "craft_messages" USING btree ("session_id","turn_index","created_at");--> statement-breakpoint
CREATE INDEX "craft_sessions_user_origin_created_idx" ON "craft_sessions" USING btree ("user_id","origin","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "craft_sessions_status_idx" ON "craft_sessions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "craft_sessions_user_port_idx" ON "craft_sessions" USING btree ("user_id","nextjs_port") WHERE "craft_sessions"."nextjs_port" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "craft_snapshots_session_created_idx" ON "craft_snapshots" USING btree ("session_id","created_at" DESC NULLS LAST);