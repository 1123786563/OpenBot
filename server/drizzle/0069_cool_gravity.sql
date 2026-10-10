CREATE TABLE "workshop_schedule_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"schedule_id" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"turn_id" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"note" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workshop_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"created_by" text NOT NULL,
	"prompt" text NOT NULL,
	"rrule" text NOT NULL,
	"timezone" text,
	"status" text DEFAULT 'enabled' NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workshop_schedule_runs" ADD CONSTRAINT "workshop_schedule_runs_schedule_id_workshop_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."workshop_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_schedule_runs" ADD CONSTRAINT "workshop_schedule_runs_turn_id_workshop_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."workshop_turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_schedules" ADD CONSTRAINT "workshop_schedules_session_id_workshop_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workshop_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_schedules" ADD CONSTRAINT "workshop_schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workshop_schedule_runs_once_idx" ON "workshop_schedule_runs" USING btree ("schedule_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "workshop_schedule_runs_schedule_idx" ON "workshop_schedule_runs" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "workshop_schedules_session_idx" ON "workshop_schedules" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "workshop_schedules_due_idx" ON "workshop_schedules" USING btree ("next_run_at") WHERE "workshop_schedules"."status" = 'enabled' AND "workshop_schedules"."next_run_at" IS NOT NULL;--> statement-breakpoint
-- RLS for the two schedule tables, the 0067 way (B16): owner-pinned through the session,
-- because a schedule is its session's child exactly as a turn is — whoever may act on the
-- workshop may schedule it, and nobody else may even see that a schedule exists.
ALTER TABLE workshop_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE workshop_schedules FORCE ROW LEVEL SECURITY;
ALTER TABLE workshop_schedule_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workshop_schedule_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY schedule_session_owner ON workshop_schedules FOR ALL TO ob_workshop_writer
USING (EXISTS (
  SELECT 1 FROM workshop_sessions s
  WHERE s.id = workshop_schedules.session_id
    AND s.owner_user_id = nullif(current_setting('app.user_id', true), '')))
WITH CHECK (EXISTS (
  SELECT 1 FROM workshop_sessions s
  WHERE s.id = workshop_schedules.session_id
    AND s.owner_user_id = nullif(current_setting('app.user_id', true), '')));
--> statement-breakpoint
-- Runs resolve through TWO parents (schedule, then session), the turn-events shape.
CREATE POLICY schedule_run_owner ON workshop_schedule_runs FOR ALL TO ob_workshop_writer
USING (EXISTS (
  SELECT 1 FROM workshop_schedules sch
  JOIN workshop_sessions s ON s.id = sch.session_id
  WHERE sch.id = workshop_schedule_runs.schedule_id
    AND s.owner_user_id = nullif(current_setting('app.user_id', true), '')))
WITH CHECK (EXISTS (
  SELECT 1 FROM workshop_schedules sch
  JOIN workshop_sessions s ON s.id = sch.session_id
  WHERE sch.id = workshop_schedule_runs.schedule_id
    AND s.owner_user_id = nullif(current_setting('app.user_id', true), '')));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON workshop_schedules TO ob_workshop_writer;
GRANT SELECT, INSERT, UPDATE ON workshop_schedule_runs TO ob_workshop_writer;
