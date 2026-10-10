CREATE TABLE "sandbox_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"attempt_number" integer DEFAULT 0 NOT NULL,
	"address" text,
	"ports" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provisioned_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"terminated_at" timestamp with time zone,
	"owner_user_id" text NOT NULL,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_instances_status_check" CHECK ("sandbox_instances"."status" IN ('provisioning', 'ready', 'sleeping', 'terminated', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "workshop_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"preview_url" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workshop_artifacts_type_check" CHECK ("workshop_artifacts"."type" IN ('csv', 'chart', 'report', 'webapp', 'file', 'dataset')),
	CONSTRAINT "workshop_artifacts_visibility_check" CHECK ("workshop_artifacts"."visibility" IN ('private', 'public'))
);
--> statement-breakpoint
CREATE TABLE "workshop_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"opencode_session_id" text,
	"webapp_port" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"share_token_hash" text,
	"share_scope" text DEFAULT 'preview' NOT NULL,
	"share_expires_at" timestamp with time zone,
	"share_revoked_at" timestamp with time zone,
	"share_created_by" text,
	"share_created_at" timestamp with time zone,
	CONSTRAINT "workshop_sessions_status_check" CHECK ("workshop_sessions"."status" IN ('active', 'archived')),
	CONSTRAINT "workshop_sessions_visibility_check" CHECK ("workshop_sessions"."visibility" IN ('private', 'unlisted', 'public')),
	CONSTRAINT "workshop_sessions_share_scope_check" CHECK ("workshop_sessions"."share_scope" IN ('preview', 'preview_download'))
);
--> statement-breakpoint
CREATE TABLE "workshop_turn_events" (
	"id" text PRIMARY KEY NOT NULL,
	"turn_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workshop_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"prompt" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"turn_index" integer NOT NULL,
	"code_run_id" text,
	"runner_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"initiator" text DEFAULT 'person' NOT NULL,
	CONSTRAINT "workshop_turns_status_check" CHECK ("workshop_turns"."status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "workshop_turns_initiator_check" CHECK ("workshop_turns"."initiator" IN ('person', 'headless', 'schedule'))
);
--> statement-breakpoint
ALTER TABLE "sandbox_instances" ADD CONSTRAINT "sandbox_instances_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_instances" ADD CONSTRAINT "sandbox_instances_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_instances" ADD CONSTRAINT "sandbox_instances_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_artifacts" ADD CONSTRAINT "workshop_artifacts_session_id_workshop_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workshop_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_sessions" ADD CONSTRAINT "workshop_sessions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_sessions" ADD CONSTRAINT "workshop_sessions_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_sessions" ADD CONSTRAINT "workshop_sessions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_sessions" ADD CONSTRAINT "workshop_sessions_share_created_by_users_id_fk" FOREIGN KEY ("share_created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_turn_events" ADD CONSTRAINT "workshop_turn_events_turn_id_workshop_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."workshop_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_turns" ADD CONSTRAINT "workshop_turns_session_id_workshop_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workshop_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_turns" ADD CONSTRAINT "workshop_turns_code_run_id_code_runs_id_fk" FOREIGN KEY ("code_run_id") REFERENCES "public"."code_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandbox_instances_bot_status_idx" ON "sandbox_instances" USING btree ("bot_id","status") WHERE "sandbox_instances"."status" IN ('provisioning', 'ready', 'sleeping');--> statement-breakpoint
CREATE INDEX "sandbox_instances_tenant_idx" ON "sandbox_instances" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "workshop_artifacts_session_idx" ON "workshop_artifacts" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workshop_sessions_channel_idx" ON "workshop_sessions" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workshop_sessions_share_token_idx" ON "workshop_sessions" USING btree ("share_token_hash") WHERE "workshop_sessions"."share_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "workshop_sessions_owner_idx" ON "workshop_sessions" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workshop_turn_events_turn_seq_idx" ON "workshop_turn_events" USING btree ("turn_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "workshop_turns_session_turn_idx" ON "workshop_turns" USING btree ("session_id","turn_index");--> statement-breakpoint
CREATE INDEX "workshop_turns_stale_idx" ON "workshop_turns" USING btree ("status","runner_heartbeat_at");--> statement-breakpoint
CREATE INDEX "workshop_turns_code_run_idx" ON "workshop_turns" USING btree ("code_run_id");