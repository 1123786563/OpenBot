CREATE TABLE "enterprise_runner_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"source_event_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"schema_version" integer NOT NULL,
	"event_type" text NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_runner_events_cursor_check" CHECK ("enterprise_runner_events"."seq" > 0 and "enterprise_runner_events"."generation" > 0 and "enterprise_runner_events"."schema_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "enterprise_runner_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enterprise_runner_events" ADD CONSTRAINT "enterprise_runner_events_runs_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."enterprise_runs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_runner_events" ADD CONSTRAINT "enterprise_runner_events_attempts_fk" FOREIGN KEY ("tenant_id","run_id","generation","attempt_id") REFERENCES "public"."enterprise_run_attempts"("tenant_id","run_id","generation","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_runner_events_thread_cursor" ON "enterprise_runner_events" USING btree ("tenant_id","thread_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_runner_events_source_identity" ON "enterprise_runner_events" USING btree ("tenant_id","run_id","attempt_id","generation","source_event_id");--> statement-breakpoint
CREATE POLICY "enterprise_runner_events_data_scope" ON "enterprise_runner_events" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING (enterprise_runner_events.tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (enterprise_runner_events.tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "enterprise_runner_events" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "enterprise_runner_events" TO ob_ent_data;
--> statement-breakpoint
ALTER TABLE "enterprise_runner_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enterprise_run_attempts" VALIDATE CONSTRAINT "enterprise_run_attempts_request_owner_check";
