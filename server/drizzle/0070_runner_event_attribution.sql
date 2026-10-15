ALTER TABLE "enterprise_runner_events" DROP CONSTRAINT "enterprise_runner_events_runs_fk";
--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_runs_event_owner_binding" ON "enterprise_runs" USING btree ("tenant_id","id","workspace_id","principal_id","thread_id");--> statement-breakpoint
ALTER TABLE "enterprise_runner_events" ADD CONSTRAINT "enterprise_runner_events_conversations_fk" FOREIGN KEY ("tenant_id","thread_id") REFERENCES "public"."enterprise_conversations"("tenant_id","thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_runner_events" ADD CONSTRAINT "enterprise_runner_events_runs_owner_fk" FOREIGN KEY ("tenant_id","run_id","workspace_id","principal_id","thread_id") REFERENCES "public"."enterprise_runs"("tenant_id","id","workspace_id","principal_id","thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
