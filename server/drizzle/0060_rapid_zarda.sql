CREATE TABLE "enterprise_model_invocation_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"model_route_ref" text NOT NULL,
	"model_request_id" text NOT NULL,
	"capability_digest" text NOT NULL,
	"capability_nonce" text NOT NULL,
	"maximum_tokens" integer NOT NULL,
	"used_tokens" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_model_invocation_tokens_check" CHECK ("enterprise_model_invocation_capabilities"."generation" > 0 and "enterprise_model_invocation_capabilities"."maximum_tokens" > 0 and "enterprise_model_invocation_capabilities"."used_tokens" >= 0 and "enterprise_model_invocation_capabilities"."used_tokens" <= "enterprise_model_invocation_capabilities"."maximum_tokens"),
	CONSTRAINT "enterprise_model_invocation_status_check" CHECK ("enterprise_model_invocation_capabilities"."status" in ('reserved', 'consumed', 'confirmed', 'unknown', 'released'))
);
--> statement-breakpoint
ALTER TABLE "enterprise_model_invocation_capabilities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enterprise_model_budget_reservations" ADD COLUMN "is_run_ceiling" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "enterprise_runs" ADD COLUMN "model_route_maximum_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_run_attempts_binding" ON "enterprise_run_attempts" USING btree ("tenant_id","run_id","generation","id");--> statement-breakpoint
ALTER TABLE "enterprise_model_invocation_capabilities" ADD CONSTRAINT "enterprise_model_invocation_capabilities_tenant_id_run_id_generation_attempt_id_enterprise_run_attempts_tenant_id_run_id_generation_id_fk" FOREIGN KEY ("tenant_id","run_id","generation","attempt_id") REFERENCES "public"."enterprise_run_attempts"("tenant_id","run_id","generation","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_model_invocation_capabilities" ADD CONSTRAINT "enterprise_model_invocation_capabilities_tenant_id_run_id_enterprise_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."enterprise_runs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_model_invocation_capabilities" ADD CONSTRAINT "enterprise_model_invocation_capabilities_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_model_invocation_request_id" ON "enterprise_model_invocation_capabilities" USING btree ("tenant_id","run_id","model_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_model_invocation_capability_digest" ON "enterprise_model_invocation_capabilities" USING btree ("tenant_id","capability_digest");--> statement-breakpoint
CREATE INDEX "enterprise_model_invocation_run_status_idx" ON "enterprise_model_invocation_capabilities" USING btree ("tenant_id","run_id","status");--> statement-breakpoint
CREATE POLICY "enterprise_model_invocation_capabilities_data_scope" ON "enterprise_model_invocation_capabilities" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING (enterprise_model_invocation_capabilities.tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (enterprise_model_invocation_capabilities.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "enterprise_model_invocation_capabilities" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "enterprise_model_invocation_capabilities" TO ob_ent_data;--> statement-breakpoint
GRANT UPDATE ("used_tokens", "status", "updated_at") ON TABLE "enterprise_model_invocation_capabilities" TO ob_ent_data;--> statement-breakpoint
ALTER TABLE "enterprise_model_invocation_capabilities" FORCE ROW LEVEL SECURITY;
