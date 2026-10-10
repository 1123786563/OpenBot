CREATE TABLE "enterprise_capabilities" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"token_hash" text NOT NULL,
	"service_id" text NOT NULL,
	"audience" text NOT NULL,
	"envelope_digest" text NOT NULL,
	"run_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"lease_id" text NOT NULL,
	"fencing_token" bigint NOT NULL,
	"logical_call_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_capabilities_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_capability_audience" CHECK ("enterprise_capabilities"."audience" in ('runtime','model','control')),
	CONSTRAINT "enterprise_capability_model_call" CHECK ("enterprise_capabilities"."audience" <> 'model' or "enterprise_capabilities"."logical_call_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "enterprise_run_attempts" (
	"tenant_id" text NOT NULL,
	"run_id" text NOT NULL,
	"id" text NOT NULL,
	"turn_id" text NOT NULL,
	"attempt_no" bigint NOT NULL,
	"lease_id" text NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"service_id" text NOT NULL,
	"fencing_token" bigint NOT NULL,
	"status" text NOT NULL,
	"context_digest" text NOT NULL,
	"started_at" timestamp with time zone,
	"exited_at" timestamp with time zone,
	"exit_receipt_ref" text,
	"sealed_at" timestamp with time zone,
	"effects_revision" bigint DEFAULT 0 NOT NULL,
	"model_calls_count" bigint DEFAULT 0 NOT NULL,
	"last_source_ordinal" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "enterprise_run_attempts_tenant_id_run_id_id_pk" PRIMARY KEY("tenant_id","run_id","id"),
	CONSTRAINT "enterprise_attempt_status" CHECK ("enterprise_run_attempts"."status" in ('allocated','active','exited','lost')),
	CONSTRAINT "enterprise_attempt_fence" CHECK ("enterprise_run_attempts"."fencing_token" > 0)
);
--> statement-breakpoint
CREATE TABLE "enterprise_run_commands" (
	"tenant_id" text NOT NULL,
	"run_id" text NOT NULL,
	"command_id" text NOT NULL,
	"payload_digest" text NOT NULL,
	"kind" text NOT NULL,
	"result_revision" bigint NOT NULL,
	"result_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_run_commands_tenant_id_run_id_command_id_pk" PRIMARY KEY("tenant_id","run_id","command_id"),
	CONSTRAINT "enterprise_command_kind" CHECK ("enterprise_run_commands"."kind" in ('cancel','input','resume'))
);
--> statement-breakpoint
CREATE TABLE "enterprise_run_delegations" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"principal_id" text NOT NULL,
	"release_id" text NOT NULL,
	"route_id" text NOT NULL,
	"max_run_micros" bigint NOT NULL,
	"max_runs" bigint NOT NULL,
	"used_runs" bigint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revision" bigint NOT NULL,
	CONSTRAINT "enterprise_run_delegations_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "enterprise_run_grants" (
	"tenant_id" text NOT NULL,
	"release_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"action" text NOT NULL,
	"revision" bigint NOT NULL,
	CONSTRAINT "enterprise_run_grants_tenant_id_release_id_principal_id_action_pk" PRIMARY KEY("tenant_id","release_id","principal_id","action"),
	CONSTRAINT "enterprise_run_grant_action" CHECK ("enterprise_run_grants"."action" in ('start','cancel_own','resume_own'))
);
--> statement-breakpoint
CREATE TABLE "enterprise_run_releases" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"resource_id" text NOT NULL,
	"version_digest" text NOT NULL,
	"runtime_compatibility" text NOT NULL,
	"expert_version" text NOT NULL,
	"model_route_ref" text,
	"input_limit_bytes" bigint NOT NULL,
	"max_model_calls" bigint NOT NULL,
	"max_run_micros" bigint NOT NULL,
	"currency" text NOT NULL,
	"tool_manifest_digest" text,
	"tool_count" bigint NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_run_releases_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_release_status" CHECK ("enterprise_run_releases"."status" in ('published','disabled'))
);
--> statement-breakpoint
CREATE TABLE "enterprise_run_steps" (
	"tenant_id" text NOT NULL,
	"run_id" text NOT NULL,
	"id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"step_no" bigint NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"next_call_ordinal" bigint NOT NULL,
	"result_ref" text,
	"revision" bigint NOT NULL,
	CONSTRAINT "enterprise_run_steps_tenant_id_run_id_id_pk" PRIMARY KEY("tenant_id","run_id","id"),
	CONSTRAINT "enterprise_step_kind" CHECK ("enterprise_run_steps"."kind" in ('model','tool','wait')),
	CONSTRAINT "enterprise_step_status" CHECK ("enterprise_run_steps"."status" in ('allocated','submitted','committed','unknown'))
);
--> statement-breakpoint
CREATE TABLE "enterprise_runs" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"owner_principal_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"release_id" text NOT NULL,
	"initiator_kind" text NOT NULL,
	"delegation_ref" text,
	"request_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"input_text" text NOT NULL,
	"model_route_ref" text NOT NULL,
	"model_grant_revision" bigint NOT NULL,
	"release_digest" text NOT NULL,
	"policy_revision" text NOT NULL,
	"budget_reservation_id" text NOT NULL,
	"status" text NOT NULL,
	"revision" bigint NOT NULL,
	"latest_seq" bigint NOT NULL,
	"current_attempt_id" text,
	"current_turn_id" text,
	"current_fence" bigint NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"wait_deadline" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"pending_approval_ref" text,
	"checkpoint_id" text,
	"reason_code" text,
	"reconciliation_required" boolean DEFAULT false NOT NULL,
	"input_revision" bigint DEFAULT 0 NOT NULL,
	"event_low_watermark" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_runs_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_run_status" CHECK ("enterprise_runs"."status" in ('queued','running','waiting_input','waiting_approval',
        'suspended','cancel_requested','succeeded','failed','cancelled','expired')),
	CONSTRAINT "enterprise_run_initiator" CHECK ("enterprise_runs"."initiator_kind" in ('user','schedule'))
);
--> statement-breakpoint
CREATE TABLE "enterprise_threads" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"owner_principal_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_threads_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_thread_status" CHECK ("enterprise_threads"."status" in ('active','archived'))
);
--> statement-breakpoint
CREATE TABLE "enterprise_run_checkpoints" (
	"tenant_id" text NOT NULL,
	"run_id" text NOT NULL,
	"id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"step_id" text NOT NULL,
	"content_digest" text NOT NULL,
	"runtime_compatibility" text NOT NULL,
	"expert_version" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_run_checkpoints_tenant_id_run_id_id_pk" PRIMARY KEY("tenant_id","run_id","id")
);
--> statement-breakpoint
CREATE TABLE "enterprise_run_events" (
	"tenant_id" text NOT NULL,
	"run_id" text NOT NULL,
	"event_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"attempt_id" text,
	"turn_id" text,
	"source_event_id" text NOT NULL,
	"source_digest" text NOT NULL,
	"event_type" text NOT NULL,
	"schema_version" text NOT NULL,
	"payload" jsonb NOT NULL,
	"public_payload" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "enterprise_run_events_tenant_id_run_id_seq_pk" PRIMARY KEY("tenant_id","run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "enterprise_run_messages" (
	"tenant_id" text NOT NULL,
	"run_id" text NOT NULL,
	"id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"role" text NOT NULL,
	"content_ref" text NOT NULL,
	"content_digest" text NOT NULL,
	"status" text NOT NULL,
	"operation_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_run_messages_tenant_id_run_id_id_pk" PRIMARY KEY("tenant_id","run_id","id"),
	CONSTRAINT "enterprise_message_role" CHECK ("enterprise_run_messages"."role" in ('user','assistant','tool')),
	CONSTRAINT "enterprise_message_status" CHECK ("enterprise_run_messages"."status" in ('partial','committed'))
);
--> statement-breakpoint
CREATE TABLE "enterprise_run_outbox" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload_digest" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claim_token" text,
	"claim_until" timestamp with time zone,
	"available_at" timestamp with time zone NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"receipt_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_run_outbox_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_outbox_status" CHECK ("enterprise_run_outbox"."status" in ('pending','claimed','delivered','unknown','rejected'))
);
--> statement-breakpoint
CREATE TABLE "enterprise_run_snapshots" (
	"tenant_id" text NOT NULL,
	"run_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"content_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_run_snapshots_tenant_id_run_id_seq_pk" PRIMARY KEY("tenant_id","run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "enterprise_budget_accounts" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_ref" text NOT NULL,
	"period_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"currency" text NOT NULL,
	"limit_micros" bigint NOT NULL,
	"spent_micros" bigint DEFAULT 0 NOT NULL,
	"held_micros" bigint DEFAULT 0 NOT NULL,
	"overage_micros" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revision" bigint NOT NULL,
	CONSTRAINT "enterprise_budget_accounts_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_account_scope" CHECK ("enterprise_budget_accounts"."scope_kind" in ('tenant','workspace','expert','principal')),
	CONSTRAINT "enterprise_account_status" CHECK ("enterprise_budget_accounts"."status" in ('active','frozen')),
	CONSTRAINT "enterprise_account_nonnegative" CHECK ("enterprise_budget_accounts"."spent_micros" >= 0 and "enterprise_budget_accounts"."held_micros" >= 0 and "enterprise_budget_accounts"."overage_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "enterprise_budget_bindings" (
	"tenant_id" text NOT NULL,
	"reservation_id" text NOT NULL,
	"account_id" text NOT NULL,
	CONSTRAINT "enterprise_budget_bindings_tenant_id_reservation_id_account_id_pk" PRIMARY KEY("tenant_id","reservation_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "enterprise_budget_reservations" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"run_id" text NOT NULL,
	"cap_micros" bigint NOT NULL,
	"spent_micros" bigint DEFAULT 0 NOT NULL,
	"held_micros" bigint DEFAULT 0 NOT NULL,
	"allocated_micros" bigint DEFAULT 0 NOT NULL,
	"overage_micros" bigint DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"period_id" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_budget_reservations_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_reservation_status" CHECK ("enterprise_budget_reservations"."status" in ('open','closed','reconciliation'))
);
--> statement-breakpoint
CREATE TABLE "enterprise_model_attempts" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"run_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"logical_call_id" text NOT NULL,
	"request_digest" text NOT NULL,
	"route_id" text NOT NULL,
	"price_revision" bigint NOT NULL,
	"reservation_id" text NOT NULL,
	"cap_micros" bigint NOT NULL,
	"status" text NOT NULL,
	"charged_micros" bigint,
	"usage_source" text,
	"response_digest" text,
	"response_ref" text,
	"provider_request_id" text,
	"usage_status" text DEFAULT 'pending' NOT NULL,
	"lease_id" text NOT NULL,
	"fencing_token" bigint NOT NULL,
	"receipt_revision" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	CONSTRAINT "enterprise_model_attempts_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_model_attempt_status" CHECK ("enterprise_model_attempts"."status" in ('reserved','submitted','succeeded','failed','unknown')),
	CONSTRAINT "enterprise_model_attempt_usage" CHECK ("enterprise_model_attempts"."usage_status" in ('pending','confirmed','unknown'))
);
--> statement-breakpoint
CREATE TABLE "enterprise_model_calls" (
	"tenant_id" text NOT NULL,
	"run_id" text NOT NULL,
	"logical_call_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"step_id" text NOT NULL,
	"call_ordinal" bigint NOT NULL,
	"route_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_model_calls_tenant_id_run_id_logical_call_id_pk" PRIMARY KEY("tenant_id","run_id","logical_call_id"),
	CONSTRAINT "enterprise_model_call_status" CHECK ("enterprise_model_calls"."status" in ('allocated','submitted','settled','unknown'))
);
--> statement-breakpoint
CREATE TABLE "enterprise_model_grants" (
	"tenant_id" text NOT NULL,
	"route_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "enterprise_model_grants_tenant_id_route_id_principal_id_pk" PRIMARY KEY("tenant_id","route_id","principal_id"),
	CONSTRAINT "enterprise_model_grant_status" CHECK ("enterprise_model_grants"."status" in ('active','revoked'))
);
--> statement-breakpoint
CREATE TABLE "enterprise_model_routes" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"alias" text NOT NULL,
	"revision" bigint NOT NULL,
	"resource_id" text NOT NULL,
	"target_ref" text NOT NULL,
	"price_revision" bigint NOT NULL,
	"currency" text NOT NULL,
	"input_unit_micros" bigint NOT NULL,
	"output_unit_micros" bigint NOT NULL,
	"per_request_micros" bigint NOT NULL,
	"max_input_tokens" bigint NOT NULL,
	"max_output_tokens" bigint NOT NULL,
	"max_request_bytes" bigint NOT NULL,
	"protocol_profile" text NOT NULL,
	"usage_profile" text NOT NULL,
	"is_default_for_alias" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_model_routes_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_route_status" CHECK ("enterprise_model_routes"."status" in ('active','disabled'))
);
--> statement-breakpoint
CREATE TABLE "enterprise_usage_entries" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"model_attempt_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"input_tokens" bigint,
	"output_tokens" bigint,
	"cost_micros" bigint NOT NULL,
	"kind" text NOT NULL,
	"evidence_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_usage_entries_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_usage_kind" CHECK ("enterprise_usage_entries"."kind" in ('charge','adjustment'))
);
--> statement-breakpoint
ALTER TABLE "enterprise_capabilities" ADD CONSTRAINT "enterprise_capabilities_tenant_id_run_id_enterprise_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."enterprise_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_capabilities" ADD CONSTRAINT "enterprise_capabilities_tenant_id_run_id_attempt_id_enterprise_run_attempts_tenant_id_run_id_id_fk" FOREIGN KEY ("tenant_id","run_id","attempt_id") REFERENCES "public"."enterprise_run_attempts"("tenant_id","run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_run_attempts" ADD CONSTRAINT "enterprise_run_attempts_tenant_id_run_id_enterprise_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."enterprise_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_run_commands" ADD CONSTRAINT "enterprise_run_commands_tenant_id_run_id_enterprise_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."enterprise_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_run_delegations" ADD CONSTRAINT "enterprise_run_delegations_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_run_delegations" ADD CONSTRAINT "enterprise_run_delegations_tenant_id_release_id_enterprise_run_releases_tenant_id_id_fk" FOREIGN KEY ("tenant_id","release_id") REFERENCES "public"."enterprise_run_releases"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_run_delegations" ADD CONSTRAINT "enterprise_run_delegations_tenant_id_route_id_enterprise_model_routes_tenant_id_id_fk" FOREIGN KEY ("tenant_id","route_id") REFERENCES "public"."enterprise_model_routes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_run_grants" ADD CONSTRAINT "enterprise_run_grants_tenant_id_release_id_enterprise_run_releases_tenant_id_id_fk" FOREIGN KEY ("tenant_id","release_id") REFERENCES "public"."enterprise_run_releases"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_run_grants" ADD CONSTRAINT "enterprise_run_grants_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_run_releases" ADD CONSTRAINT "enterprise_run_releases_tenant_id_resource_id_enterprise_resources_tenant_id_id_fk" FOREIGN KEY ("tenant_id","resource_id") REFERENCES "public"."enterprise_resources"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_run_steps" ADD CONSTRAINT "enterprise_run_steps_tenant_id_run_id_enterprise_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."enterprise_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_run_steps" ADD CONSTRAINT "enterprise_run_steps_tenant_id_run_id_attempt_id_enterprise_run_attempts_tenant_id_run_id_id_fk" FOREIGN KEY ("tenant_id","run_id","attempt_id") REFERENCES "public"."enterprise_run_attempts"("tenant_id","run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_runs" ADD CONSTRAINT "enterprise_runs_tenant_id_owner_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","owner_principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_runs" ADD CONSTRAINT "enterprise_runs_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_runs" ADD CONSTRAINT "enterprise_runs_tenant_id_thread_id_enterprise_threads_tenant_id_id_fk" FOREIGN KEY ("tenant_id","thread_id") REFERENCES "public"."enterprise_threads"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_runs" ADD CONSTRAINT "enterprise_runs_tenant_id_release_id_enterprise_run_releases_tenant_id_id_fk" FOREIGN KEY ("tenant_id","release_id") REFERENCES "public"."enterprise_run_releases"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_threads" ADD CONSTRAINT "enterprise_threads_tenant_id_owner_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","owner_principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_threads" ADD CONSTRAINT "enterprise_threads_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_run_checkpoints" ADD CONSTRAINT "enterprise_run_checkpoints_tenant_id_run_id_enterprise_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."enterprise_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_run_checkpoints" ADD CONSTRAINT "enterprise_run_checkpoints_tenant_id_run_id_attempt_id_enterprise_run_attempts_tenant_id_run_id_id_fk" FOREIGN KEY ("tenant_id","run_id","attempt_id") REFERENCES "public"."enterprise_run_attempts"("tenant_id","run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_run_events" ADD CONSTRAINT "enterprise_run_events_tenant_id_run_id_enterprise_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."enterprise_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_run_messages" ADD CONSTRAINT "enterprise_run_messages_tenant_id_run_id_enterprise_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."enterprise_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_run_messages" ADD CONSTRAINT "enterprise_run_messages_tenant_id_run_id_attempt_id_enterprise_run_attempts_tenant_id_run_id_id_fk" FOREIGN KEY ("tenant_id","run_id","attempt_id") REFERENCES "public"."enterprise_run_attempts"("tenant_id","run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_run_outbox" ADD CONSTRAINT "enterprise_run_outbox_tenant_id_run_id_enterprise_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."enterprise_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_run_snapshots" ADD CONSTRAINT "enterprise_run_snapshots_tenant_id_run_id_enterprise_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."enterprise_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_budget_bindings" ADD CONSTRAINT "enterprise_budget_bindings_tenant_id_reservation_id_enterprise_budget_reservations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","reservation_id") REFERENCES "public"."enterprise_budget_reservations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_budget_bindings" ADD CONSTRAINT "enterprise_budget_bindings_tenant_id_account_id_enterprise_budget_accounts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."enterprise_budget_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_model_attempts" ADD CONSTRAINT "enterprise_model_attempts_tenant_id_run_id_enterprise_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."enterprise_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_model_attempts" ADD CONSTRAINT "enterprise_model_attempts_tenant_id_run_id_attempt_id_enterprise_run_attempts_tenant_id_run_id_id_fk" FOREIGN KEY ("tenant_id","run_id","attempt_id") REFERENCES "public"."enterprise_run_attempts"("tenant_id","run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_model_attempts" ADD CONSTRAINT "enterprise_model_attempts_tenant_id_reservation_id_enterprise_budget_reservations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","reservation_id") REFERENCES "public"."enterprise_budget_reservations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_model_attempts" ADD CONSTRAINT "enterprise_model_attempts_tenant_id_route_id_enterprise_model_routes_tenant_id_id_fk" FOREIGN KEY ("tenant_id","route_id") REFERENCES "public"."enterprise_model_routes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_model_attempts" ADD CONSTRAINT "enterprise_model_attempts_tenant_id_run_id_logical_call_id_enterprise_model_calls_tenant_id_run_id_logical_call_id_fk" FOREIGN KEY ("tenant_id","run_id","logical_call_id") REFERENCES "public"."enterprise_model_calls"("tenant_id","run_id","logical_call_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_model_calls" ADD CONSTRAINT "enterprise_model_calls_tenant_id_run_id_enterprise_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."enterprise_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_model_calls" ADD CONSTRAINT "enterprise_model_calls_tenant_id_run_id_attempt_id_enterprise_run_attempts_tenant_id_run_id_id_fk" FOREIGN KEY ("tenant_id","run_id","attempt_id") REFERENCES "public"."enterprise_run_attempts"("tenant_id","run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_model_calls" ADD CONSTRAINT "enterprise_model_calls_tenant_id_run_id_step_id_enterprise_run_steps_tenant_id_run_id_id_fk" FOREIGN KEY ("tenant_id","run_id","step_id") REFERENCES "public"."enterprise_run_steps"("tenant_id","run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_model_calls" ADD CONSTRAINT "enterprise_model_calls_tenant_id_route_id_enterprise_model_routes_tenant_id_id_fk" FOREIGN KEY ("tenant_id","route_id") REFERENCES "public"."enterprise_model_routes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_model_grants" ADD CONSTRAINT "enterprise_model_grants_tenant_id_route_id_enterprise_model_routes_tenant_id_id_fk" FOREIGN KEY ("tenant_id","route_id") REFERENCES "public"."enterprise_model_routes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_model_grants" ADD CONSTRAINT "enterprise_model_grants_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_model_routes" ADD CONSTRAINT "enterprise_model_routes_tenant_id_resource_id_enterprise_resources_tenant_id_id_fk" FOREIGN KEY ("tenant_id","resource_id") REFERENCES "public"."enterprise_resources"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_usage_entries" ADD CONSTRAINT "enterprise_usage_entries_tenant_id_model_attempt_id_enterprise_model_attempts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","model_attempt_id") REFERENCES "public"."enterprise_model_attempts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_attempt_turn" ON "enterprise_run_attempts" USING btree ("tenant_id","run_id","turn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_step_no" ON "enterprise_run_steps" USING btree ("tenant_id","run_id","attempt_id","step_no");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_run_request_key" ON "enterprise_runs" USING btree ("tenant_id","owner_principal_id","request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_run_event_id" ON "enterprise_run_events" USING btree ("tenant_id","run_id","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_run_event_source" ON "enterprise_run_events" USING btree ("tenant_id","run_id","attempt_id","source_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_outbox_dedup" ON "enterprise_run_outbox" USING btree ("tenant_id","run_id","kind","payload_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_budget_account_period" ON "enterprise_budget_accounts" USING btree ("tenant_id","scope_kind","scope_ref","period_id","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_reservation_run" ON "enterprise_budget_reservations" USING btree ("tenant_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_model_attempt_call" ON "enterprise_model_attempts" USING btree ("tenant_id","run_id","logical_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_call_ordinal" ON "enterprise_model_calls" USING btree ("tenant_id","run_id","step_id","call_ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_route_revision" ON "enterprise_model_routes" USING btree ("tenant_id","alias","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_usage_revision" ON "enterprise_usage_entries" USING btree ("tenant_id","model_attempt_id","revision");