CREATE TABLE "craft_scheduled_task_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"session_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger_source" text NOT NULL,
	"skip_reason" text,
	"error_class" text,
	"error_detail" text,
	"summary" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "craft_scheduled_task_runs_status_check" CHECK ("craft_scheduled_task_runs"."status" IN ('queued', 'running', 'succeeded', 'failed', 'skipped', 'awaiting_approval')),
	CONSTRAINT "craft_scheduled_task_runs_trigger_check" CHECK ("craft_scheduled_task_runs"."trigger_source" IN ('scheduled', 'manual_run_now'))
);
--> statement-breakpoint
CREATE TABLE "craft_scheduled_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"cron_expression" text NOT NULL,
	"editor_mode" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"next_run_at" timestamp with time zone,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "craft_scheduled_tasks_status_check" CHECK ("craft_scheduled_tasks"."status" IN ('active', 'paused')),
	CONSTRAINT "craft_scheduled_tasks_editor_mode_check" CHECK ("craft_scheduled_tasks"."editor_mode" IN ('interval', 'daily_weekly', 'advanced'))
);
--> statement-breakpoint
ALTER TABLE "craft_scheduled_task_runs" ADD CONSTRAINT "craft_scheduled_task_runs_task_id_craft_scheduled_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."craft_scheduled_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "craft_scheduled_task_runs" ADD CONSTRAINT "craft_scheduled_task_runs_session_id_craft_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."craft_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "craft_scheduled_tasks" ADD CONSTRAINT "craft_scheduled_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "craft_scheduled_task_runs_task_started_idx" ON "craft_scheduled_task_runs" USING btree ("task_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "craft_scheduled_task_runs_status_idx" ON "craft_scheduled_task_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "craft_scheduled_task_runs_session_idx" ON "craft_scheduled_task_runs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "craft_scheduled_tasks_dispatch_idx" ON "craft_scheduled_tasks" USING btree ("status","deleted","next_run_at");--> statement-breakpoint
CREATE INDEX "craft_scheduled_tasks_user_created_idx" ON "craft_scheduled_tasks" USING btree ("user_id","created_at" DESC NULLS LAST);