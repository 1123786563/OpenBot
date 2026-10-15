CREATE TABLE "enterprise_model_budget_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"model_route_ref" text NOT NULL,
	"token_limit" integer NOT NULL,
	"confirmed_tokens" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_budget_reservation_tokens_check" CHECK ("enterprise_model_budget_reservations"."token_limit" > 0 and "enterprise_model_budget_reservations"."confirmed_tokens" >= 0),
	CONSTRAINT "enterprise_budget_reservation_status_check" CHECK ("enterprise_model_budget_reservations"."status" in ('reserved', 'confirmed', 'released'))
);
--> statement-breakpoint
ALTER TABLE "enterprise_model_budget_reservations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "enterprise_run_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"turn_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"fencing_token" integer NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "enterprise_run_attempts_generation_check" CHECK ("enterprise_run_attempts"."generation" > 0 and "enterprise_run_attempts"."fencing_token" > 0)
);
--> statement-breakpoint
ALTER TABLE "enterprise_run_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "enterprise_run_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"delivery_attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "enterprise_run_outbox_attempts_check" CHECK ("enterprise_run_outbox"."delivery_attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "enterprise_run_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "enterprise_runs" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"client_message_key" text NOT NULL,
	"model_route_ref" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt_generation" integer DEFAULT 1 NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "enterprise_runs_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_runs_generation_check" CHECK ("enterprise_runs"."attempt_generation" > 0),
	CONSTRAINT "enterprise_runs_status_check" CHECK ("enterprise_runs"."status" in ('queued', 'running', 'waiting_approval', 'suspended', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "enterprise_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enterprise_model_budget_reservations" ADD CONSTRAINT "enterprise_model_budget_reservations_tenant_id_run_id_enterprise_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."enterprise_runs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_model_budget_reservations" ADD CONSTRAINT "enterprise_model_budget_reservations_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_run_attempts" ADD CONSTRAINT "enterprise_run_attempts_tenant_id_run_id_enterprise_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."enterprise_runs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_run_outbox" ADD CONSTRAINT "enterprise_run_outbox_tenant_id_run_id_enterprise_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."enterprise_runs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_runs" ADD CONSTRAINT "enterprise_runs_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_runs" ADD CONSTRAINT "enterprise_runs_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_budget_reservation_idempotency" ON "enterprise_model_budget_reservations" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "enterprise_budget_reservation_scope_idx" ON "enterprise_model_budget_reservations" USING btree ("tenant_id","workspace_id","principal_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_run_attempts_generation" ON "enterprise_run_attempts" USING btree ("tenant_id","run_id","generation");--> statement-breakpoint
CREATE INDEX "enterprise_run_outbox_pending_idx" ON "enterprise_run_outbox" USING btree ("created_at") WHERE "enterprise_run_outbox"."delivered_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_runs_client_message_key" ON "enterprise_runs" USING btree ("tenant_id","thread_id","client_message_key");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_runs_one_active_thread" ON "enterprise_runs" USING btree ("tenant_id","thread_id") WHERE "enterprise_runs"."status" in ('queued', 'running', 'waiting_approval', 'suspended');--> statement-breakpoint
CREATE INDEX "enterprise_runs_owner_idx" ON "enterprise_runs" USING btree ("tenant_id","workspace_id","principal_id","created_at");--> statement-breakpoint
CREATE POLICY "enterprise_model_budget_reservations_data_scope" ON "enterprise_model_budget_reservations" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING (enterprise_model_budget_reservations.tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (enterprise_model_budget_reservations.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_run_attempts_data_scope" ON "enterprise_run_attempts" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING (enterprise_run_attempts.tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (enterprise_run_attempts.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_run_outbox_data_scope" ON "enterprise_run_outbox" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING (enterprise_run_outbox.tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (enterprise_run_outbox.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_runs_data_scope" ON "enterprise_runs" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING (enterprise_runs.tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (enterprise_runs.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "enterprise_runs", "enterprise_run_attempts", "enterprise_model_budget_reservations", "enterprise_run_outbox" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "enterprise_runs" TO ob_ent_data;--> statement-breakpoint
GRANT UPDATE ("status", "attempt_generation", "lease_expires_at", "error_code", "updated_at", "finished_at") ON TABLE "enterprise_runs" TO ob_ent_data;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "enterprise_run_attempts" TO ob_ent_data;--> statement-breakpoint
GRANT UPDATE ("status", "lease_expires_at", "finished_at") ON TABLE "enterprise_run_attempts" TO ob_ent_data;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "enterprise_model_budget_reservations" TO ob_ent_data;--> statement-breakpoint
GRANT UPDATE ("confirmed_tokens", "status", "updated_at") ON TABLE "enterprise_model_budget_reservations" TO ob_ent_data;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "enterprise_run_outbox" TO ob_ent_data;--> statement-breakpoint
GRANT UPDATE ("delivered_at", "delivery_attempts") ON TABLE "enterprise_run_outbox" TO ob_ent_data;--> statement-breakpoint
ALTER TABLE "enterprise_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enterprise_run_attempts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enterprise_model_budget_reservations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enterprise_run_outbox" FORCE ROW LEVEL SECURITY;
