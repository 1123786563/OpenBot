CREATE TYPE "public"."agent_type" AS ENUM('built_in', 'remote_ag_ui', 'remote_mastra');--> statement-breakpoint
CREATE TYPE "public"."credential_kind" AS ENUM('model', 'connector', 'agent', 'mcp', 'mcp_oauth_client', 'mcp_user_token', 'bot_service', 'gateway_admin', 'credit_service');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('admin', 'user');--> statement-breakpoint
CREATE TYPE "public"."agent_visibility" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TYPE "public"."routine_run_status" AS ENUM('succeeded', 'failed', 'skipped', 'waiting');--> statement-breakpoint
CREATE TYPE "public"."responsibility_run_status" AS ENUM('queued', 'running', 'waiting', 'succeeded', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."responsibility_status" AS ENUM('active', 'paused', 'completed');--> statement-breakpoint
CREATE TABLE "openmuse_account_deletions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"disabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"phase" text DEFAULT 'fenced' NOT NULL,
	"restore_until" timestamp with time zone,
	"resources" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openmuse_deletion_resources" (
	"manifest_id" text NOT NULL,
	"kind" text NOT NULL,
	"id" text NOT NULL,
	"external_key" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openmuse_deletion_resources_manifest_id_kind_id_external_key_pk" PRIMARY KEY("manifest_id","kind","id","external_key")
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"issuer" text,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" "agent_type" NOT NULL,
	"configuration" jsonb NOT NULL,
	"package_id" uuid,
	"override" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attached_at" timestamp with time zone,
	"upload_group" text
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" text,
	"initiator_kind" text DEFAULT 'person' NOT NULL,
	"initiator_id" text,
	"event_type" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_agents" (
	"channel_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_agents_channel_id_agent_id_pk" PRIMARY KEY("channel_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "channel_memberships" (
	"channel_id" text NOT NULL,
	"user_id" text NOT NULL,
	"pinned_at" timestamp with time zone,
	"last_read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_memberships_channel_id_user_id_pk" PRIMARY KEY("channel_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"suggested_prompts" text[] DEFAULT '{}' NOT NULL,
	"allowed_groups" text[] DEFAULT '{}' NOT NULL,
	"package_id" uuid,
	"override" jsonb,
	"summary" text,
	"summary_at" timestamp with time zone,
	"last_message" text,
	"last_message_source_id" text,
	"last_message_at" timestamp with time zone,
	"last_message_agent_id" text,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "credential_kind" NOT NULL,
	"provider" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"key_id" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"source_path" text NOT NULL,
	"checksum" text NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployment_packages_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
CREATE TABLE "intelligence_channel_mappings" (
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intelligence_channel_mappings_user_id_channel_id_pk" PRIMARY KEY("user_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "revoked_access" (
	"email" text PRIMARY KEY NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "sso_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"oidc_config" text,
	"saml_config" text,
	"user_id" text,
	"provider_id" text NOT NULL,
	"organization_id" text,
	"domain" text NOT NULL,
	CONSTRAINT "sso_providers_provider_id_unique" UNIQUE("provider_id")
);
--> statement-breakpoint
CREATE TABLE "user_instructions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"instructions" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" text NOT NULL,
	"role" "role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_roles_user_id_role_pk" PRIMARY KEY("user_id","role")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"image" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"groups" text[] DEFAULT '{}' NOT NULL,
	"onboarding_step" integer DEFAULT 0 NOT NULL,
	"onboarding_completed_at" timestamp with time zone,
	"last_signed_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "action_policy" (
	"id" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"deny" text[] NOT NULL,
	"allow" text[] NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "computer_page_frame" (
	"computer_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"frame" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "computer_page_frame_computer_id_tool_call_id_pk" PRIMARY KEY("computer_id","tool_call_id")
);
--> statement-breakpoint
CREATE TABLE "computer_snapshot" (
	"computer_id" text PRIMARY KEY NOT NULL,
	"snapshot_id" integer NOT NULL,
	"url" text NOT NULL,
	"elements" jsonb NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"session" text
);
--> statement-breakpoint
CREATE TABLE "agent_preferences" (
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"hidden_at" timestamp with time zone,
	"pinned_at" timestamp with time zone,
	CONSTRAINT "agent_preferences_user_id_agent_id_pk" PRIMARY KEY("user_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "agent_profiles" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text,
	"title" text NOT NULL,
	"role_description" text NOT NULL,
	"avatar_seed" text NOT NULL,
	"visibility" "agent_visibility" NOT NULL,
	"callback_token_hash" text,
	"callback_token_issued_at" timestamp with time zone,
	"template_key" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routine_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"routine_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "routine_run_status",
	"waiting" jsonb,
	"error" text,
	"source" text DEFAULT 'schedule' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routine_sweeps" (
	"id" text PRIMARY KEY NOT NULL,
	"swept_at" timestamp with time zone DEFAULT now() NOT NULL,
	"owner" text
);
--> statement-breakpoint
CREATE TABLE "routines" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"instruction" text NOT NULL,
	"cron" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "component_exclusions" (
	"component_name" text NOT NULL,
	"agent_id" text NOT NULL,
	"withheld_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "component_exclusions_component_name_agent_id_pk" PRIMARY KEY("component_name","agent_id")
);
--> statement-breakpoint
CREATE TABLE "component_functions" (
	"component_name" text NOT NULL,
	"function_name" text NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "component_functions_component_name_function_name_pk" PRIMARY KEY("component_name","function_name")
);
--> statement-breakpoint
CREATE TABLE "components" (
	"name" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"draft_description" text NOT NULL,
	"published_description" text,
	"published" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brokered_connections" (
	"provider" text NOT NULL,
	"app" text NOT NULL,
	"holder" text NOT NULL,
	"user_id" text,
	"vendor_user_id" text NOT NULL,
	"connected_by" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"probe_action" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brokered_connections_holder_check" CHECK (("brokered_connections"."holder" = 'person' AND "brokered_connections"."user_id" IS NOT NULL) OR ("brokered_connections"."holder" = 'deployment' AND "brokered_connections"."user_id" IS NULL)),
	CONSTRAINT "brokered_connections_provider_check" CHECK ("brokered_connections"."provider" IN ('composio', 'open-connector'))
);
--> statement-breakpoint
CREATE TABLE "composio_connections" (
	"toolkit" text NOT NULL,
	"user_id" text NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"probe_action" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "composio_connections_toolkit_user_id_pk" PRIMARY KEY("toolkit","user_id")
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"logo" text,
	"vendor" text NOT NULL,
	"url" text NOT NULL,
	"provenance" text DEFAULT 'first-party' NOT NULL,
	"credential_id" uuid,
	"auth_scheme" text,
	"account_mode" text,
	"shared_vendor_user_id" text,
	"tools_refreshed_at" timestamp with time zone,
	"last_error" text,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_account_mode_check" CHECK ("mcp_servers"."account_mode" IS NULL OR "mcp_servers"."account_mode" IN ('personal', 'shared'))
);
--> statement-breakpoint
CREATE TABLE "mcp_tools" (
	"server_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"input_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effect" text,
	"destructive" boolean DEFAULT false NOT NULL,
	"version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_tools_server_id_name_pk" PRIMARY KEY("server_id","name")
);
--> statement-breakpoint
CREATE TABLE "mcp_user_credentials" (
	"server_id" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_user_credentials_server_id_user_id_pk" PRIMARY KEY("server_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "plugin_grants" (
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"agent_id" text NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_grants_kind_ref_agent_id_pk" PRIMARY KEY("kind","ref","agent_id")
);
--> statement-breakpoint
CREATE TABLE "sandboxed_components" (
	"name" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"draft_description" text DEFAULT '' NOT NULL,
	"draft_html" text DEFAULT '' NOT NULL,
	"draft_css" text DEFAULT '' NOT NULL,
	"draft_js_functions" text DEFAULT '' NOT NULL,
	"draft_argument_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"published_description" text,
	"published_html" text,
	"published_css" text,
	"published_js_functions" text,
	"published_argument_schema" jsonb,
	"sample_arguments" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"authored_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_tools" (
	"skill_id" text NOT NULL,
	"ref" text NOT NULL,
	"declared_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_tools_skill_id_ref_pk" PRIMARY KEY("skill_id","ref")
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"instructions" text NOT NULL,
	"origin" text DEFAULT 'yours' NOT NULL,
	"icon" text,
	"category" text,
	"installed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_by" text,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"finished_at" timestamp with time zone,
	"last_error" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_items_kind_key_pk" PRIMARY KEY("kind","key")
);
--> statement-breakpoint
CREATE TABLE "voice_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"user_id" text NOT NULL,
	"anchor_message_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"duration_seconds" integer NOT NULL,
	"transcript" jsonb NOT NULL,
	"summary" text,
	"summary_status" text DEFAULT 'failed' NOT NULL,
	CONSTRAINT "voice_sessions_duration_check" CHECK ("voice_sessions"."duration_seconds" >= 0),
	CONSTRAINT "voice_sessions_summary_check" CHECK (("voice_sessions"."summary_status" = 'ready' AND "voice_sessions"."summary" IS NOT NULL) OR ("voice_sessions"."summary_status" = 'failed' AND "voice_sessions"."summary" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "learning_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"settings" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_thread_bindings" (
	"user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"container_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_thread_bindings_user_id_thread_id_pk" PRIMARY KEY("user_id","thread_id")
);
--> statement-breakpoint
CREATE TABLE "responsibilities" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"title" text NOT NULL,
	"instruction" text NOT NULL,
	"success_criteria" text NOT NULL,
	"status" "responsibility_status" DEFAULT 'active' NOT NULL,
	"progress" text DEFAULT '' NOT NULL,
	"last_result" text,
	"subscriptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "responsibility_events" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "responsibility_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"responsibility_id" text NOT NULL,
	"event_id" text NOT NULL,
	"status" "responsibility_run_status" DEFAULT 'queued' NOT NULL,
	"reply_text" text,
	"error" text,
	"waiting" jsonb,
	"continuation" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "responsibility_source_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"source" text NOT NULL,
	"repository" text NOT NULL,
	"credential_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "responsibility_triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"responsibility_id" text NOT NULL,
	"kind" text NOT NULL,
	"config" jsonb NOT NULL,
	"credential_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_preferences" (
	"owner_user_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"auto_review" boolean DEFAULT false NOT NULL,
	"host_commands" text DEFAULT 'ask' NOT NULL,
	CONSTRAINT "approval_preferences_host_commands_check" CHECK ("approval_preferences"."host_commands" IN ('ask', 'allow', 'never'))
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"run_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"action_digest" text NOT NULL,
	"action" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decision" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "approval_status_check" CHECK ("approval_requests"."status" IN ('pending', 'approved', 'denied', 'consumed', 'completed')),
	CONSTRAINT "approval_decision_check" CHECK ("approval_requests"."decision" IN ('allow_once', 'allow_always', 'deny', 'handled'))
);
--> statement-breakpoint
CREATE TABLE "approval_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"tool_ref" text NOT NULL,
	"effect" text NOT NULL,
	"scope" text NOT NULL,
	"behaviour" text DEFAULT 'allow' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_rules_behaviour_check" CHECK ("approval_rules"."behaviour" IN ('allow', 'pre_approved', 'ask', 'hand_off'))
);
--> statement-breakpoint
CREATE TABLE "approval_team_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"tool_ref" text NOT NULL,
	"effect" text NOT NULL,
	"scope" text NOT NULL,
	"behaviour" text NOT NULL,
	"created_by" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_team_rules_behaviour_check" CHECK ("approval_team_rules"."behaviour" IN ('allow', 'pre_approved', 'ask', 'hand_off'))
);
--> statement-breakpoint
CREATE TABLE "approval_team_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"enforce_auto_review" boolean DEFAULT false NOT NULL,
	"custom_rules_enabled" boolean DEFAULT true NOT NULL,
	"host_commands_cap" text DEFAULT 'allow' NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_team_settings_host_commands_cap_check" CHECK ("approval_team_settings"."host_commands_cap" IN ('ask', 'allow', 'never'))
);
--> statement-breakpoint
CREATE TABLE "memory_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"tool_ref" text NOT NULL,
	"title" text NOT NULL,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sync_status" text DEFAULT 'idle' NOT NULL,
	"sync_error" text,
	"last_sync_at" timestamp with time zone,
	"next_sync_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_memories" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"source_id" text,
	"external_id" text,
	"import_digest" text,
	"content" text NOT NULL,
	"provenance" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"review_state" text DEFAULT 'unreviewed' NOT NULL,
	"deleted_at" timestamp with time zone,
	"formed_by" text DEFAULT 'person' NOT NULL,
	"formed_by_agent_id" text,
	"source_app" text,
	"source_ref" text,
	"source_link" text,
	"observed_at" timestamp with time zone,
	"intelligence_memory_id" text,
	"intelligence_digest" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openmuse_file_owner_disables" (
	"owner_user_id" text PRIMARY KEY NOT NULL,
	"disabled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openmuse_file_versions" (
	"version_id" text PRIMARY KEY NOT NULL,
	"file_id" text NOT NULL,
	"byte_path" text NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parent_version_id" text
);
--> statement-breakpoint
CREATE TABLE "openmuse_files" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "openmuse_goals" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" text DEFAULT 'Personal' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"milestones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "openmuse_google_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"account_email" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"granted_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"alias" text NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "openmuse_ideas" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"title" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT '' NOT NULL,
	"input" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"task_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "openmuse_memories" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"text" text NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "openmuse_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"task_id" text NOT NULL,
	"event_kind" text NOT NULL,
	"attempt_key" text NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "openmuse_oauth_pending" (
	"state" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"return_uri" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"nonce" text,
	"outcome" text,
	"connection_id" text
);
--> statement-breakpoint
CREATE TABLE "openmuse_reviewed_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"canonical_payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"account_email" text NOT NULL,
	"connection_generation" integer NOT NULL,
	"target_id" text,
	"target_version" text,
	"attachment_version_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'awaiting_review' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"provider_ref" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "openmuse_reviewed_attempts" (
	"attempt_id" text PRIMARY KEY NOT NULL,
	"action_id" text NOT NULL,
	"fingerprint" text,
	"outcome" text,
	"provider_ref" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"reconciliation" jsonb
);
--> statement-breakpoint
CREATE TABLE "openmuse_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"kind" text NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"cancellation_requested" boolean DEFAULT false NOT NULL,
	"pause_requested" boolean DEFAULT false NOT NULL,
	"last_retry_key" text,
	"wait" jsonb,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"artifact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"monitor_condition" jsonb,
	"next_check_at" timestamp with time zone,
	"last_observation_hash" text,
	"last_observation_at" timestamp with time zone,
	"monitor_failure_streak" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "default_opt_outs" (
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"feature" text NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "default_opt_outs_owner_user_id_agent_id_feature_scope_pk" PRIMARY KEY("owner_user_id","agent_id","feature","scope"),
	CONSTRAINT "default_opt_outs_feature_check" CHECK ("default_opt_outs"."feature" IN ('memory_source', 'proactive_research'))
);
--> statement-breakpoint
CREATE TABLE "proactive_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"focus" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"interval_minutes" integer DEFAULT 240 NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_status" text DEFAULT 'idle' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proactive_settings_interval_check" CHECK ("proactive_settings"."interval_minutes" >= 60 AND "proactive_settings"."interval_minutes" <= 1440),
	CONSTRAINT "proactive_settings_status_check" CHECK ("proactive_settings"."last_status" IN ('idle', 'running', 'succeeded', 'error'))
);
--> statement-breakpoint
CREATE TABLE "proactive_suggestions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"setting_id" text NOT NULL,
	"run_id" text NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"source_app" text,
	"source_ref" text,
	"source_link" text,
	"status" text DEFAULT 'open' NOT NULL,
	"delivered_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proactive_suggestions_status_check" CHECK ("proactive_suggestions"."status" IN ('open', 'dismissed', 'started'))
);
--> statement-breakpoint
CREATE TABLE "demonstrations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'recording' NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft" jsonb,
	"skill_slug" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "delivery_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"transport" text NOT NULL,
	"identity" text NOT NULL,
	"realm" text NOT NULL,
	"address" text NOT NULL,
	"mention_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"opted_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"transport" text NOT NULL,
	"address" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_inbox" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"binding_id" text,
	"source" text NOT NULL,
	"realm" text NOT NULL,
	"external_id" text NOT NULL,
	"text" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"binding_id" text,
	"device_id" text,
	"transport" text NOT NULL,
	"text" text NOT NULL,
	"kind" text NOT NULL,
	"request_id" text,
	"state" text DEFAULT 'queued' NOT NULL,
	"provider_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_outbox_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "push_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"token" text NOT NULL,
	"project_id" text NOT NULL,
	"platform" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_devices_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "enterprise_memberships" (
	"tenant_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"epoch" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_memberships_tenant_id_principal_id_pk" PRIMARY KEY("tenant_id","principal_id"),
	CONSTRAINT "enterprise_member_role" CHECK ("enterprise_memberships"."role" in ('tenant_admin','member','auditor')),
	CONSTRAINT "enterprise_member_status" CHECK ("enterprise_memberships"."status" in ('active','suspended')),
	CONSTRAINT "enterprise_member_epoch" CHECK ("enterprise_memberships"."epoch" > 0)
);
--> statement-breakpoint
ALTER TABLE "enterprise_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "enterprise_principals" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_principal_status" CHECK ("enterprise_principals"."status" in ('active','suspended'))
);
--> statement-breakpoint
ALTER TABLE "enterprise_principals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "enterprise_resource_grants" (
	"tenant_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"action" text DEFAULT 'read' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_resource_grants_tenant_id_resource_id_principal_id_action_pk" PRIMARY KEY("tenant_id","resource_id","principal_id","action"),
	CONSTRAINT "enterprise_grant_action" CHECK ("enterprise_resource_grants"."action" = 'read')
);
--> statement-breakpoint
ALTER TABLE "enterprise_resource_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "enterprise_resources" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"acl_epoch" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_resources_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_resource_status" CHECK ("enterprise_resources"."status" in ('active','deleted')),
	CONSTRAINT "enterprise_resource_versions" CHECK ("enterprise_resources"."revision" > 0 and "enterprise_resources"."acl_epoch" > 0)
);
--> statement-breakpoint
ALTER TABLE "enterprise_resources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "enterprise_security_events" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"operation_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"event_type" text NOT NULL,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_security_events_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "enterprise_security_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "enterprise_tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"policy_revision" text DEFAULT 'tenancy-v1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_tenant_status" CHECK ("enterprise_tenants"."status" in ('active','suspended'))
);
--> statement-breakpoint
ALTER TABLE "enterprise_tenants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "enterprise_workspaces" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_workspaces_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "enterprise_workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "enterprise_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"title" text,
	"storage_backend" text DEFAULT 'platform' NOT NULL,
	"backend_version" integer DEFAULT 1 NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_conversations_backend_check" CHECK ("enterprise_conversations"."storage_backend" in ('platform', 'intelligence', 'mastra')),
	CONSTRAINT "enterprise_conversations_backend_version_check" CHECK ("enterprise_conversations"."backend_version" > 0),
	CONSTRAINT "enterprise_conversations_seq_check" CHECK ("enterprise_conversations"."last_seq" >= 0)
);
--> statement-breakpoint
ALTER TABLE "enterprise_conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "enterprise_message_parts" (
	"tenant_id" text NOT NULL,
	"message_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" text NOT NULL,
	"attachment_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "enterprise_message_parts_tenant_id_message_id_ordinal_pk" PRIMARY KEY("tenant_id","message_id","ordinal"),
	CONSTRAINT "enterprise_message_parts_ordinal_check" CHECK ("enterprise_message_parts"."ordinal" >= 0),
	CONSTRAINT "enterprise_message_parts_kind_check" CHECK ("enterprise_message_parts"."kind" in ('text', 'attachment'))
);
--> statement-breakpoint
ALTER TABLE "enterprise_message_parts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "enterprise_messages" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"seq" integer NOT NULL,
	"client_message_key" text NOT NULL,
	"digest" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"content" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_messages_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_messages_seq_check" CHECK ("enterprise_messages"."seq" > 0),
	CONSTRAINT "enterprise_messages_role_check" CHECK ("enterprise_messages"."role" in ('user', 'assistant', 'tool'))
);
--> statement-breakpoint
ALTER TABLE "enterprise_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "enterprise_expert_versions" (
	"tenant_id" text NOT NULL,
	"expert_version_ref" text NOT NULL,
	"schema_version" integer NOT NULL,
	"agent_id" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_expert_versions_tenant_id_expert_version_ref_pk" PRIMARY KEY("tenant_id","expert_version_ref"),
	CONSTRAINT "enterprise_expert_versions_schema_version_check" CHECK ("enterprise_expert_versions"."schema_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "enterprise_expert_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "enterprise_model_routes" (
	"tenant_id" text NOT NULL,
	"route_ref" text NOT NULL,
	"schema_version" integer NOT NULL,
	"agent_id" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_model_routes_tenant_id_route_ref_pk" PRIMARY KEY("tenant_id","route_ref"),
	CONSTRAINT "enterprise_model_routes_schema_version_check" CHECK ("enterprise_model_routes"."schema_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "enterprise_model_routes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "enterprise_model_budget_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"model_route_ref" text NOT NULL,
	"token_limit" integer NOT NULL,
	"is_run_ceiling" boolean DEFAULT false NOT NULL,
	"confirmed_tokens" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_budget_reservation_tokens_check" CHECK ("enterprise_model_budget_reservations"."token_limit" > 0 and "enterprise_model_budget_reservations"."confirmed_tokens" >= 0 and "enterprise_model_budget_reservations"."confirmed_tokens" <= "enterprise_model_budget_reservations"."token_limit"),
	CONSTRAINT "enterprise_budget_reservation_status_check" CHECK ("enterprise_model_budget_reservations"."status" in ('reserved', 'confirmed', 'released'))
);
--> statement-breakpoint
ALTER TABLE "enterprise_model_budget_reservations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
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
CREATE TABLE "enterprise_run_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"turn_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"fencing_token" integer NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"request_owner_token" uuid,
	"request_owner_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "enterprise_run_attempts_generation_check" CHECK ("enterprise_run_attempts"."generation" > 0 and "enterprise_run_attempts"."fencing_token" > 0),
	CONSTRAINT "enterprise_run_attempts_request_owner_check" CHECK (("enterprise_run_attempts"."request_owner_token" is null and "enterprise_run_attempts"."request_owner_expires_at" is null) or ("enterprise_run_attempts"."request_owner_token" is not null and "enterprise_run_attempts"."request_owner_expires_at" is not null))
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
	"claim_id" uuid,
	"claim_owner_id" text,
	"claim_expires_at" timestamp with time zone,
	CONSTRAINT "enterprise_run_outbox_attempts_check" CHECK ("enterprise_run_outbox"."delivery_attempts" >= 0),
	CONSTRAINT "enterprise_run_outbox_claim_check" CHECK (("enterprise_run_outbox"."claim_id" is null and "enterprise_run_outbox"."claim_owner_id" is null and "enterprise_run_outbox"."claim_expires_at" is null) or ("enterprise_run_outbox"."claim_id" is not null and "enterprise_run_outbox"."claim_owner_id" is not null and "enterprise_run_outbox"."claim_expires_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "enterprise_run_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
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
CREATE TABLE "enterprise_runs" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"client_message_key" text NOT NULL,
	"expert_version_ref" text NOT NULL,
	"model_route_ref" text NOT NULL,
	"model_route_maximum_tokens" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt_generation" integer DEFAULT 1 NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "enterprise_runs_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_runs_generation_check" CHECK ("enterprise_runs"."attempt_generation" > 0),
	CONSTRAINT "enterprise_runs_model_route_maximum_tokens_check" CHECK ("enterprise_runs"."model_route_maximum_tokens" > 0),
	CONSTRAINT "enterprise_runs_status_check" CHECK ("enterprise_runs"."status" in ('queued', 'running', 'waiting_approval', 'suspended', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "enterprise_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mastra_tenant_storage_registry" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"storage_key" text NOT NULL,
	"schema_name" text NOT NULL,
	"role_version" integer NOT NULL,
	"status" text NOT NULL,
	"claim_token" uuid,
	"credential_ref" text,
	"runtime_role" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	CONSTRAINT "mastra_tenant_storage_role_version" CHECK ("mastra_tenant_storage_registry"."role_version" > 0),
	CONSTRAINT "mastra_tenant_storage_status" CHECK ("mastra_tenant_storage_registry"."status" in ('provisioning','ready')),
	CONSTRAINT "mastra_tenant_storage_state" CHECK (("mastra_tenant_storage_registry"."status" = 'provisioning' and "mastra_tenant_storage_registry"."claim_token" is not null and "mastra_tenant_storage_registry"."credential_ref" is null and "mastra_tenant_storage_registry"."runtime_role" is null and "mastra_tenant_storage_registry"."ready_at" is null) or ("mastra_tenant_storage_registry"."status" = 'ready' and "mastra_tenant_storage_registry"."claim_token" is null and "mastra_tenant_storage_registry"."credential_ref" is not null and "mastra_tenant_storage_registry"."runtime_role" is not null and "mastra_tenant_storage_registry"."ready_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "mastra_message_intent_attachments" (
	"tenant_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"client_message_key" text NOT NULL,
	"attachment_id" uuid NOT NULL,
	CONSTRAINT "mastra_msg_intent_attachments_pk" PRIMARY KEY("tenant_id","thread_id","client_message_key","attachment_id")
);
--> statement-breakpoint
ALTER TABLE "mastra_message_intent_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mastra_message_intents" (
	"tenant_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"client_message_key" text NOT NULL,
	"message_id" text NOT NULL,
	"digest" text NOT NULL,
	"reserved_seq" integer NOT NULL,
	"actor_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"backend_version" integer NOT NULL,
	"attachment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mastra_message_intents_pk" PRIMARY KEY("tenant_id","thread_id","client_message_key"),
	CONSTRAINT "mastra_message_intents_seq_check" CHECK ("mastra_message_intents"."reserved_seq" > 0),
	CONSTRAINT "mastra_message_intents_backend_version_check" CHECK ("mastra_message_intents"."backend_version" > 0),
	CONSTRAINT "mastra_message_intents_attachment_ids_array_check" CHECK (jsonb_typeof("mastra_message_intents"."attachment_ids") = 'array'),
	CONSTRAINT "mastra_message_intents_state_check" CHECK ("mastra_message_intents"."state" in ('pending', 'finalized'))
);
--> statement-breakpoint
ALTER TABLE "mastra_message_intents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "group_bot_threads" (
	"owner_user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_bot_threads_owner_user_id_channel_id_agent_id_pk" PRIMARY KEY("owner_user_id","channel_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "group_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text,
	"thread_id" text,
	"text" text NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_messages_status_check" CHECK ("group_messages"."status" IN ('queued', 'running', 'waiting', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "action_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"surface" text NOT NULL,
	"bot_id" text,
	"actor_user_id" text,
	"tool_name" text NOT NULL,
	"command" text NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_records_surface_check" CHECK ("action_records"."surface" IN ('cloud', 'local'))
);
--> statement-breakpoint
CREATE TABLE "capability_settings" (
	"scope_kind" text NOT NULL,
	"scope_id" text DEFAULT '' NOT NULL,
	"capability" text NOT NULL,
	"allowed" boolean NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capability_settings_scope_kind_scope_id_capability_pk" PRIMARY KEY("scope_kind","scope_id","capability"),
	CONSTRAINT "capability_settings_scope_kind_check" CHECK ("capability_settings"."scope_kind" IN ('organization', 'role', 'group'))
);
--> statement-breakpoint
CREATE TABLE "enterprise_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"agent_id" text NOT NULL,
	"thread_id" text,
	"run_id" text,
	"model" text NOT NULL,
	"source" text NOT NULL,
	"allowed" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_usage_source_check" CHECK ("model_usage"."source" IN ('configured', 'observed', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "network_policies" (
	"scope_kind" text NOT NULL,
	"scope_id" text DEFAULT '' NOT NULL,
	"mode" text NOT NULL,
	"rules" jsonb DEFAULT '{"entries":[]}'::jsonb NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "network_policies_scope_kind_scope_id_pk" PRIMARY KEY("scope_kind","scope_id"),
	CONSTRAINT "network_policies_scope_kind_check" CHECK ("network_policies"."scope_kind" IN ('organization', 'group')),
	CONSTRAINT "network_policies_mode_check" CHECK ("network_policies"."mode" IN ('allow_all', 'defaults_plus_allowlist', 'allowlist_only'))
);
--> statement-breakpoint
CREATE TABLE "scim_connection_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"connection_key" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"decommissioned_at" timestamp with time zone,
	"decommission_status" text DEFAULT 'active' NOT NULL,
	"decommission_cursor_user_id" text,
	"decommission_reconciled_user_count" integer DEFAULT 0 NOT NULL,
	"decommission_batch_count" integer DEFAULT 0 NOT NULL,
	"decommission_revision" integer DEFAULT 0 NOT NULL,
	"decommission_completed_at" timestamp with time zone,
	"decommission_lease_id" text,
	"decommission_lease_expires_at" timestamp with time zone,
	CONSTRAINT "scim_connection_bindings_connection_key_unique" UNIQUE("connection_key")
);
--> statement-breakpoint
CREATE TABLE "scim_group_members" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"group_id" text NOT NULL,
	"scim_user_id" text NOT NULL,
	"membership_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_group_members_membership_key_unique" UNIQUE("membership_key")
);
--> statement-breakpoint
CREATE TABLE "scim_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"display_name" text NOT NULL,
	"display_name_key" text NOT NULL,
	"external_id" text,
	"external_id_key" text,
	"order_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_groups_display_name_key_unique" UNIQUE("display_name_key"),
	CONSTRAINT "scim_groups_external_id_key_unique" UNIQUE("external_id_key"),
	CONSTRAINT "scim_groups_order_key_unique" UNIQUE("order_key")
);
--> statement-breakpoint
CREATE TABLE "scim_identity_tombstones" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"external_id" text NOT NULL,
	"external_id_key" text NOT NULL,
	"user_id" text NOT NULL,
	"profile" text NOT NULL,
	"deleted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_identity_tombstones_external_id_key_unique" UNIQUE("external_id_key")
);
--> statement-breakpoint
CREATE TABLE "scim_projection_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"scim_user_id" text NOT NULL,
	"user_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"source_value" text,
	"role" text NOT NULL,
	"grant_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_projection_grants_grant_key_unique" UNIQUE("grant_key")
);
--> statement-breakpoint
CREATE TABLE "scim_subjects" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"profile_source_id" text,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_subjects_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "scim_users" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connection_user_key" text NOT NULL,
	"user_name" text NOT NULL,
	"user_name_key" text NOT NULL,
	"primary_email" text NOT NULL,
	"work_email_value_index" text NOT NULL,
	"email_value_index" text NOT NULL,
	"display_name" text NOT NULL,
	"formatted_name" text NOT NULL,
	"given_name" text,
	"family_name" text,
	"serialized_emails" text NOT NULL,
	"serialized_attributes" text,
	"external_id" text,
	"external_id_key" text,
	"active" boolean NOT NULL,
	"order_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_users_connection_user_key_unique" UNIQUE("connection_user_key"),
	CONSTRAINT "scim_users_user_name_key_unique" UNIQUE("user_name_key"),
	CONSTRAINT "scim_users_external_id_key_unique" UNIQUE("external_id_key"),
	CONSTRAINT "scim_users_order_key_unique" UNIQUE("order_key")
);
--> statement-breakpoint
CREATE TABLE "bot_lifecycle" (
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"paused_at" timestamp with time zone,
	"notify" text DEFAULT 'all' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_lifecycle_owner_user_id_agent_id_pk" PRIMARY KEY("owner_user_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "update_routing_preferences" (
	"owner_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"transports" text[] DEFAULT '{}' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "update_routing_preferences_owner_user_id_kind_pk" PRIMARY KEY("owner_user_id","kind")
);
--> statement-breakpoint
CREATE TABLE "saved_logins" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"origin" text NOT NULL,
	"username" text NOT NULL,
	"encrypted_password" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sign_in_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"origin" text NOT NULL,
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"method" text,
	"outcome" text,
	"thread_id" text,
	"tool_call_id" text,
	"control_request_id" text,
	"continuation" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"filling_until" timestamp with time zone,
	CONSTRAINT "sign_in_requests_status_check" CHECK ("sign_in_requests"."status" IN ('pending', 'filling', 'taken_over', 'signed_in', 'failed', 'cancelled', 'expired')),
	CONSTRAINT "sign_in_requests_method_check" CHECK ("sign_in_requests"."method" IS NULL OR "sign_in_requests"."method" IN ('typed', 'saved', 'takeover'))
);
--> statement-breakpoint
CREATE TABLE "team_bot_assignments" (
	"agent_id" text NOT NULL,
	"group_name" text NOT NULL,
	"assigned_by" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_bot_assignments_agent_id_group_name_pk" PRIMARY KEY("agent_id","group_name")
);
--> statement-breakpoint
CREATE TABLE "team_bot_audience" (
	"agent_id" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_bot_audience_agent_id_kind_value_pk" PRIMARY KEY("agent_id","kind","value"),
	CONSTRAINT "team_bot_audience_kind_check" CHECK ("team_bot_audience"."kind" IN ('user', 'group'))
);
--> statement-breakpoint
CREATE TABLE "team_bot_consent_defaults" (
	"user_id" text NOT NULL,
	"server_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_bot_consent_defaults_user_id_server_id_pk" PRIMARY KEY("user_id","server_id")
);
--> statement-breakpoint
CREATE TABLE "team_bot_consents" (
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"server_id" text NOT NULL,
	"decision" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_bot_consents_user_id_agent_id_server_id_pk" PRIMARY KEY("user_id","agent_id","server_id"),
	CONSTRAINT "team_bot_consents_decision_check" CHECK ("team_bot_consents"."decision" IN ('always', 'once'))
);
--> statement-breakpoint
CREATE TABLE "team_bot_publications" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"published_by" text NOT NULL,
	"audience" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_bot_publications_audience_check" CHECK ("team_bot_publications"."audience" IN ('team', 'people'))
);
--> statement-breakpoint
CREATE TABLE "shared_use_approval_members" (
	"agent_id" text NOT NULL,
	"server_id" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "shared_use_approval_members_agent_id_server_id_kind_value_pk" PRIMARY KEY("agent_id","server_id","kind","value"),
	CONSTRAINT "shared_use_approval_members_kind_check" CHECK ("shared_use_approval_members"."kind" IN ('user', 'group'))
);
--> statement-breakpoint
CREATE TABLE "shared_use_approvals" (
	"agent_id" text NOT NULL,
	"server_id" text NOT NULL,
	"audience" text NOT NULL,
	"outside_input" boolean NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_use_approvals_agent_id_server_id_pk" PRIMARY KEY("agent_id","server_id"),
	CONSTRAINT "shared_use_approvals_audience_check" CHECK ("shared_use_approvals"."audience" IN ('owner', 'people', 'team'))
);
--> statement-breakpoint
CREATE TABLE "shared_use_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"server_id" text NOT NULL,
	"proposed_audience" text NOT NULL,
	"proposed_outside_input" boolean NOT NULL,
	"proposed_members" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"requested_by" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_use_requests_audience_check" CHECK ("shared_use_requests"."proposed_audience" IN ('owner', 'people', 'team')),
	CONSTRAINT "shared_use_requests_reason_check" CHECK ("shared_use_requests"."reason" IN ('publish', 'trigger', 'grant', 'refused_call')),
	CONSTRAINT "shared_use_requests_status_check" CHECK ("shared_use_requests"."status" IN ('pending', 'approved', 'declined', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE "billing_customers" (
	"external_id" text PRIMARY KEY NOT NULL,
	"name" text,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"external_customer_id" text NOT NULL,
	"external_subscription_id" text PRIMARY KEY NOT NULL,
	"plan_code" text NOT NULL,
	"status" text NOT NULL,
	"owner_payer_kind" text,
	"owner_payer_id" text,
	"allowance_period_start" timestamp with time zone,
	"allowance_period_end" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_subscriptions_status_check" CHECK ("billing_subscriptions"."status" IN ('active', 'incomplete', 'canceled', 'terminated')),
	CONSTRAINT "billing_subscriptions_owner_pair_check" CHECK (("billing_subscriptions"."owner_payer_kind" IS NULL) = ("billing_subscriptions"."owner_payer_id" IS NULL)),
	CONSTRAINT "billing_subscriptions_owner_kind_check" CHECK ("billing_subscriptions"."owner_payer_kind" IS NULL OR "billing_subscriptions"."owner_payer_kind" IN ('personal', 'company', 'legacy_deployment', 'unknown_owner')),
	CONSTRAINT "billing_subscriptions_allowance_pair_check" CHECK (("billing_subscriptions"."allowance_period_start" IS NULL) = ("billing_subscriptions"."allowance_period_end" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "billing_webhook_events" (
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"lago_unique_key" text,
	"webhook_type" text NOT NULL,
	"object_id" text,
	"body_hash" text,
	"processed" boolean DEFAULT true NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payer_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payer_id" text NOT NULL,
	"external_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payer_accounts_kind_check" CHECK ("payer_accounts"."kind" IN ('personal', 'company', 'legacy_deployment', 'unknown_owner'))
);
--> statement-breakpoint
CREATE TABLE "bot_services" (
	"bot_id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"kind" text NOT NULL,
	"capabilities" text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_services_kind_check" CHECK ("bot_services"."kind" IN ('builtin', 'external')),
	CONSTRAINT "bot_services_status_check" CHECK ("bot_services"."status" IN ('active', 'disabled')),
	CONSTRAINT "bot_services_capabilities_check" CHECK ("bot_services"."capabilities" <@ ARRAY['chat','image','audio','embedding','realtime','async']::text[])
);
--> statement-breakpoint
CREATE TABLE "bot_binding_offers" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"external_identity_hint" text NOT NULL,
	"single_use" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "bot_binding_offers_status_check" CHECK ("bot_binding_offers"."status" IN ('pending', 'redeemed', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "access_grants" (
	"grant_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"external_identity" text NOT NULL,
	"scope" text NOT NULL,
	"source" text DEFAULT 'binding-code' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "access_grants_scope_check" CHECK ("access_grants"."scope" IN ('model-access')),
	CONSTRAINT "access_grants_source_check" CHECK ("access_grants"."source" IN ('binding-code', 'workbench-implicit')),
	CONSTRAINT "access_grants_status_check" CHECK ("access_grants"."status" IN ('active', 'revoked')),
	CONSTRAINT "access_grants_revoked_at_check" CHECK (("access_grants"."status" = 'active' AND "access_grants"."revoked_at" IS NULL) OR ("access_grants"."status" = 'revoked' AND "access_grants"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "gateway_catalog_fetches" (
	"fetch_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"raw_item_count" integer,
	"config_version" integer,
	"failure_reason_code" text,
	"fetched_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_catalog_fetches_status_allowed" CHECK ("gateway_catalog_fetches"."status" IN ('ok', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "gateway_catalog_sync_state" (
	"id" text PRIMARY KEY NOT NULL,
	"last_successful_sync_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_failure_reason_code" text,
	"last_failure_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_attempt_status" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_catalog_sync_state_failures_nonnegative" CHECK ("gateway_catalog_sync_state"."consecutive_failures" >= 0),
	CONSTRAINT "gateway_catalog_sync_state_attempt_status_allowed" CHECK ("gateway_catalog_sync_state"."last_attempt_status" IS NULL OR "gateway_catalog_sync_state"."last_attempt_status" IN ('ok', 'failed')),
	CONSTRAINT "gateway_catalog_sync_state_failure_details_consistent" CHECK (("gateway_catalog_sync_state"."last_attempt_status" = 'failed') = ("gateway_catalog_sync_state"."last_failure_reason_code" IS NOT NULL) AND ("gateway_catalog_sync_state"."last_attempt_status" = 'failed') = ("gateway_catalog_sync_state"."last_failure_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "gateway_customers" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payer_id" text NOT NULL,
	"gateway_customer_id" text,
	"gateway_customer_name" text NOT NULL,
	"external_reference" text GENERATED ALWAYS AS (gateway_customer_name) STORED NOT NULL,
	"provision_state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_customers_kind_check" CHECK ("gateway_customers"."kind" IN ('personal')),
	CONSTRAINT "gateway_customers_provision_state_check" CHECK ("gateway_customers"."provision_state" IN ('pending', 'confirmed', 'recoverable', 'active'))
);
--> statement-breakpoint
CREATE TABLE "gateway_model_catalog_refs" (
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"capability" text NOT NULL,
	"capability_source" text NOT NULL,
	"unknown_reason" text,
	"raw_entry" jsonb NOT NULL,
	"config_version" integer NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gateway_model_catalog_refs_capability_allowed" CHECK ("gateway_model_catalog_refs"."capability" IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'realtime', 'video', 'unknown')),
	CONSTRAINT "gateway_model_catalog_refs_source_allowed" CHECK ("gateway_model_catalog_refs"."capability_source" IN ('supported_methods', 'none'))
);
--> statement-breakpoint
CREATE TABLE "gateway_model_open_scopes" (
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"capability" text NOT NULL,
	"state" text NOT NULL,
	"reason" text NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_model_open_scopes_identity_pk" PRIMARY KEY("provider","model","capability"),
	CONSTRAINT "gateway_model_open_scopes_state_allowed" CHECK ("gateway_model_open_scopes"."state" IN ('open', 'closed')),
	CONSTRAINT "gateway_model_open_scopes_capability_allowed" CHECK ("gateway_model_open_scopes"."capability" IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'realtime', 'video', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "gateway_model_preferences" (
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"bot_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"capability" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_model_preferences_identity_pk" PRIMARY KEY("user_id","scope","bot_id","conversation_id"),
	CONSTRAINT "gateway_model_preferences_scope_allowed" CHECK ("gateway_model_preferences"."scope" IN ('global', 'bot', 'conversation')),
	CONSTRAINT "gateway_model_preferences_capability_allowed" CHECK ("gateway_model_preferences"."capability" IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'realtime', 'video', 'unknown')),
	CONSTRAINT "gateway_model_preferences_scope_identity_consistent" CHECK (("gateway_model_preferences"."scope" = 'global' AND "gateway_model_preferences"."bot_id" = '' AND "gateway_model_preferences"."conversation_id" = '') OR ("gateway_model_preferences"."scope" = 'bot' AND "gateway_model_preferences"."bot_id" <> '' AND "gateway_model_preferences"."conversation_id" = '') OR ("gateway_model_preferences"."scope" = 'conversation' AND "gateway_model_preferences"."bot_id" <> '' AND "gateway_model_preferences"."conversation_id" <> ''))
);
--> statement-breakpoint
CREATE TABLE "gateway_price_snapshots" (
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"capability" text NOT NULL,
	"snapshot_version" integer NOT NULL,
	"dims" jsonb NOT NULL,
	"price_status" text NOT NULL,
	"price_status_reason" text,
	"price_status_missing_dims" jsonb,
	"source" text NOT NULL,
	"config_version" integer NOT NULL,
	"rate_version" integer,
	"fetched_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_price_snapshots_identity_version_pk" PRIMARY KEY("provider","model","capability","snapshot_version"),
	CONSTRAINT "gateway_price_snapshots_capability_allowed" CHECK ("gateway_price_snapshots"."capability" IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'realtime', 'video', 'unknown')),
	CONSTRAINT "gateway_price_snapshots_version_positive" CHECK ("gateway_price_snapshots"."snapshot_version" >= 1),
	CONSTRAINT "gateway_price_snapshots_rate_version_nonnegative" CHECK ("gateway_price_snapshots"."rate_version" IS NULL OR "gateway_price_snapshots"."rate_version" >= 0),
	CONSTRAINT "gateway_price_snapshots_dims_valid" CHECK (valid_gateway_price_dims("gateway_price_snapshots"."dims")),
	CONSTRAINT "gateway_price_snapshots_status_allowed" CHECK ("gateway_price_snapshots"."price_status" IN ('known', 'free', 'unknown')),
	CONSTRAINT "gateway_price_snapshots_status_reason_allowed" CHECK ("gateway_price_snapshots"."price_status_reason" IS NULL OR "gateway_price_snapshots"."price_status_reason" IN ('price_status_dims_missing', 'price_status_dims_unreadable')),
	CONSTRAINT "gateway_price_snapshots_status_details_consistent" CHECK (("gateway_price_snapshots"."price_status" = 'unknown') = ("gateway_price_snapshots"."price_status_reason" IS NOT NULL) AND ("gateway_price_snapshots"."price_status" = 'unknown') = ("gateway_price_snapshots"."price_status_missing_dims" IS NOT NULL)),
	CONSTRAINT "gateway_price_snapshots_status_missing_dims_valid" CHECK ("gateway_price_snapshots"."price_status_missing_dims" IS NULL OR valid_gateway_price_missing_dims("gateway_price_snapshots"."price_status_missing_dims")),
	CONSTRAINT "gateway_price_snapshots_status_matches_dims" CHECK ("gateway_price_snapshots"."price_status" = classify_gateway_price_status("gateway_price_snapshots"."dims"))
);
--> statement-breakpoint
CREATE TABLE "gateway_rate_versions" (
	"rate_version" integer PRIMARY KEY NOT NULL,
	"numerator" text NOT NULL,
	"denominator" text NOT NULL,
	"effective_at" timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gateway_virtual_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"gateway_customer_id" text NOT NULL,
	"gateway_virtual_key_id" text NOT NULL,
	"value_hash" text NOT NULL,
	"credential_version" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_virtual_keys_status_check" CHECK ("gateway_virtual_keys"."status" IN ('active', 'expired', 'revoked')),
	CONSTRAINT "gateway_virtual_keys_version_check" CHECK ("gateway_virtual_keys"."credential_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "code_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"task" text NOT NULL,
	"model" text,
	"status" text DEFAULT 'running' NOT NULL,
	"session_id" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"artifact_paths" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "credit_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"external_customer_id" text NOT NULL,
	"source" text NOT NULL,
	"reason" text,
	"total" integer NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_grants_source_check" CHECK ("credit_grants"."source" IN ('plan', 'promo', 'signin')),
	CONSTRAINT "credit_grants_status_check" CHECK ("credit_grants"."status" IN ('active', 'exhausted', 'expired')),
	CONSTRAINT "credit_grants_total_check" CHECK ("credit_grants"."total" >= 0),
	CONSTRAINT "credit_grants_used_check" CHECK ("credit_grants"."used" >= 0 AND "credit_grants"."used" <= "credit_grants"."total")
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"external_customer_id" text NOT NULL,
	"grant_id" text,
	"title" text NOT NULL,
	"request_id" text,
	"idempotency_key" text NOT NULL,
	"credits" integer NOT NULL,
	"applied" integer DEFAULT 0 NOT NULL,
	"model" text,
	"client" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_ledger_credits_check" CHECK ("credit_ledger"."credits" >= 0),
	CONSTRAINT "credit_ledger_applied_check" CHECK ("credit_ledger"."applied" >= 0 AND "credit_ledger"."applied" <= "credit_ledger"."credits")
);
--> statement-breakpoint
CREATE TABLE "credit_charge_remainders" (
	"external_customer_id" text PRIMARY KEY NOT NULL,
	"numerator" text NOT NULL,
	"denominator" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_charge_remainders_shape_check" CHECK ("credit_charge_remainders"."numerator" ~ '^[0-9]+$' AND "credit_charge_remainders"."denominator" ~ '^[1-9][0-9]*$')
);
--> statement-breakpoint
CREATE TABLE "credit_reservation_allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"reservation_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"amount" integer NOT NULL,
	"consumed" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "credit_reservation_allocations_amount_check" CHECK ("credit_reservation_allocations"."amount" > 0),
	CONSTRAINT "credit_reservation_allocations_consumed_check" CHECK ("credit_reservation_allocations"."consumed" >= 0 AND "credit_reservation_allocations"."consumed" <= "credit_reservation_allocations"."amount")
);
--> statement-breakpoint
CREATE TABLE "credit_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"external_customer_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"maximum" integer NOT NULL,
	"provider" text,
	"model" text,
	"capability" text,
	"snapshot_version" integer,
	"rate_version" integer,
	"status" text DEFAULT 'reserved' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"actual_numerator" text,
	"actual_denominator" text,
	"charged" integer,
	"remainder_numerator" text,
	"remainder_denominator" text,
	"applied" integer,
	"released" integer,
	"release_reason" text,
	"ledger_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"terminal_at" timestamp with time zone,
	"unknown_at" timestamp with time zone,
	"unknown_reason" text,
	CONSTRAINT "credit_reservations_status_check" CHECK ("credit_reservations"."status" IN ('reserved', 'unknown', 'settled', 'released')),
	CONSTRAINT "credit_reservations_maximum_check" CHECK ("credit_reservations"."maximum" > 0),
	CONSTRAINT "credit_reservations_lock_completeness_check" CHECK (("credit_reservations"."provider" IS NULL) = ("credit_reservations"."model" IS NULL) AND ("credit_reservations"."provider" IS NULL) = ("credit_reservations"."capability" IS NULL) AND ("credit_reservations"."provider" IS NULL) = ("credit_reservations"."snapshot_version" IS NULL) AND ("credit_reservations"."provider" IS NULL) = ("credit_reservations"."rate_version" IS NULL) AND ("credit_reservations"."provider" IS NULL OR ("credit_reservations"."provider" <> '' AND "credit_reservations"."model" <> '' AND "credit_reservations"."capability" IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'realtime', 'video', 'unknown') AND "credit_reservations"."snapshot_version" >= 1 AND "credit_reservations"."rate_version" >= 0))),
	CONSTRAINT "credit_reservations_terminal_check" CHECK (("credit_reservations"."status" IN ('reserved', 'unknown') AND "credit_reservations"."terminal_at" IS NULL) OR ("credit_reservations"."status" IN ('settled', 'released') AND "credit_reservations"."terminal_at" IS NOT NULL)),
	CONSTRAINT "credit_reservations_settled_check" CHECK ("credit_reservations"."status" <> 'settled' OR ("credit_reservations"."actual_numerator" ~ '^[0-9]+$' AND "credit_reservations"."actual_denominator" ~ '^[0-9]+$' AND "credit_reservations"."actual_denominator" !~ '^0+$' AND "credit_reservations"."charged" >= 0 AND "credit_reservations"."applied" >= 0 AND "credit_reservations"."applied" <= "credit_reservations"."maximum" AND "credit_reservations"."released" = "credit_reservations"."maximum" - "credit_reservations"."applied"))
);
--> statement-breakpoint
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
	"preapproved" jsonb,
	"status" text DEFAULT 'enabled' NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "payment_events" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"kind" text NOT NULL,
	"code" text NOT NULL,
	"state" text,
	"channel_transaction_id" text,
	"amount_cents" integer,
	"detail" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_events_kind_check" CHECK ("payment_events"."kind" IN ('fact', 'anomaly'))
);
--> statement-breakpoint
CREATE TABLE "payment_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"deployment_scope" text DEFAULT 'default' NOT NULL,
	"plan_code" text NOT NULL,
	"provider" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'CNY' NOT NULL,
	"status" text NOT NULL,
	"activation_state" text DEFAULT 'pending' NOT NULL,
	"channel_transaction_id" text,
	"checkout_payload" text,
	"expires_at" timestamp with time zone NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"created_by" text,
	"owner_payer_kind" text,
	"owner_payer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "payment_orders_status_check" CHECK ("payment_orders"."status" IN ('pending', 'paid', 'blocked', 'canceled', 'expired')),
	CONSTRAINT "payment_orders_activation_state_check" CHECK ("payment_orders"."activation_state" IN ('pending', 'applied', 'failed')),
	CONSTRAINT "payment_orders_provider_check" CHECK ("payment_orders"."provider" IN ('alipay', 'wechat')),
	CONSTRAINT "payment_orders_amount_check" CHECK ("payment_orders"."amount_cents" > 0),
	CONSTRAINT "payment_orders_currency_check" CHECK ("payment_orders"."currency" = 'CNY'),
	CONSTRAINT "payment_orders_owner_pair_check" CHECK (("payment_orders"."owner_payer_kind" IS NULL) = ("payment_orders"."owner_payer_id" IS NULL)),
	CONSTRAINT "payment_orders_owner_kind_check" CHECK ("payment_orders"."owner_payer_kind" IS NULL OR "payment_orders"."owner_payer_kind" IN ('personal', 'company', 'legacy_deployment', 'unknown_owner'))
);
--> statement-breakpoint
CREATE TABLE "usage_outbox" (
	"event_id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"external_customer_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"model" text NOT NULL,
	"client" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"reservation_id" text,
	"actual_cost_numerator" text,
	"actual_cost_denominator" text,
	"run_id" text,
	"bot_id" text,
	"owner_user_id" text,
	"session_id" text,
	"status" text,
	"lago_status" text DEFAULT 'pending' NOT NULL,
	"credits_status" text DEFAULT 'pending' NOT NULL,
	"lago_last_error_code" text,
	"credits_last_error_code" text,
	"lago_attempts" integer DEFAULT 0 NOT NULL,
	"credits_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_outbox_source_check" CHECK ("usage_outbox"."source" IN ('llm', 'code_run')),
	CONSTRAINT "usage_outbox_input_tokens_check" CHECK ("usage_outbox"."input_tokens" >= 0),
	CONSTRAINT "usage_outbox_output_tokens_check" CHECK ("usage_outbox"."output_tokens" >= 0),
	CONSTRAINT "usage_outbox_credit_identity_check" CHECK ((
        "usage_outbox"."reservation_id" IS NULL
        AND "usage_outbox"."actual_cost_numerator" IS NULL
        AND "usage_outbox"."actual_cost_denominator" IS NULL
      ) OR (
        "usage_outbox"."reservation_id" IS NOT NULL
        AND "usage_outbox"."actual_cost_numerator" ~ '^[0-9]+$'
        AND "usage_outbox"."actual_cost_denominator" ~ '^[1-9][0-9]*$'
      )),
	CONSTRAINT "usage_outbox_lago_status_check" CHECK ("usage_outbox"."lago_status" IN ('pending', 'delivered', 'blocked')),
	CONSTRAINT "usage_outbox_credits_status_check" CHECK ("usage_outbox"."credits_status" IN ('pending', 'delivered', 'blocked')),
	CONSTRAINT "usage_outbox_lago_attempts_check" CHECK ("usage_outbox"."lago_attempts" >= 0),
	CONSTRAINT "usage_outbox_credits_attempts_check" CHECK ("usage_outbox"."credits_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "expert_installs" (
	"id" text PRIMARY KEY NOT NULL,
	"expert_slug" text NOT NULL,
	"agent_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_link_challenges" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_links" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"realm" text NOT NULL,
	"subject" text NOT NULL,
	"user_id" text NOT NULL,
	"handle" text,
	"verified_by" text NOT NULL,
	"credential_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_links_verified_by_check" CHECK ("identity_links"."verified_by" IN ('challenge', 'oauth')),
	CONSTRAINT "identity_links_status_check" CHECK ("identity_links"."status" IN ('active', 'needs_reconnect'))
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_package_id_deployment_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."deployment_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_agents" ADD CONSTRAINT "channel_agents_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_agents" ADD CONSTRAINT "channel_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_memberships" ADD CONSTRAINT "channel_memberships_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_memberships" ADD CONSTRAINT "channel_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_package_id_deployment_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."deployment_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_last_message_agent_id_agents_id_fk" FOREIGN KEY ("last_message_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligence_channel_mappings" ADD CONSTRAINT "intelligence_channel_mappings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligence_channel_mappings" ADD CONSTRAINT "intelligence_channel_mappings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_instructions" ADD CONSTRAINT "user_instructions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_preferences" ADD CONSTRAINT "agent_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_preferences" ADD CONSTRAINT "agent_preferences_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "craft_messages" ADD CONSTRAINT "craft_messages_session_id_craft_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."craft_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "craft_scheduled_task_runs" ADD CONSTRAINT "craft_scheduled_task_runs_task_id_craft_scheduled_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."craft_scheduled_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "craft_scheduled_task_runs" ADD CONSTRAINT "craft_scheduled_task_runs_session_id_craft_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."craft_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "craft_scheduled_tasks" ADD CONSTRAINT "craft_scheduled_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "craft_sessions" ADD CONSTRAINT "craft_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "craft_snapshots" ADD CONSTRAINT "craft_snapshots_session_id_craft_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."craft_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_exclusions" ADD CONSTRAINT "component_exclusions_component_name_components_name_fk" FOREIGN KEY ("component_name") REFERENCES "public"."components"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_exclusions" ADD CONSTRAINT "component_exclusions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_functions" ADD CONSTRAINT "component_functions_component_name_components_name_fk" FOREIGN KEY ("component_name") REFERENCES "public"."components"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tools" ADD CONSTRAINT "mcp_tools_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_user_credentials" ADD CONSTRAINT "mcp_user_credentials_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_user_credentials" ADD CONSTRAINT "mcp_user_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_user_credentials" ADD CONSTRAINT "mcp_user_credentials_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_grants" ADD CONSTRAINT "plugin_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_tools" ADD CONSTRAINT "skill_tools_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD CONSTRAINT "voice_sessions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD CONSTRAINT "voice_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_events" ADD CONSTRAINT "responsibility_events_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_runs" ADD CONSTRAINT "responsibility_runs_responsibility_id_responsibilities_id_fk" FOREIGN KEY ("responsibility_id") REFERENCES "public"."responsibilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_runs" ADD CONSTRAINT "responsibility_runs_event_id_responsibility_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."responsibility_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_source_bindings" ADD CONSTRAINT "responsibility_source_bindings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_source_bindings" ADD CONSTRAINT "responsibility_source_bindings_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_triggers" ADD CONSTRAINT "responsibility_triggers_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_triggers" ADD CONSTRAINT "responsibility_triggers_responsibility_id_responsibilities_id_fk" FOREIGN KEY ("responsibility_id") REFERENCES "public"."responsibilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_triggers" ADD CONSTRAINT "responsibility_triggers_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_preferences" ADD CONSTRAINT "approval_preferences_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_team_rules" ADD CONSTRAINT "approval_team_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_team_settings" ADD CONSTRAINT "approval_team_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_memories" ADD CONSTRAINT "personal_memories_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_memories" ADD CONSTRAINT "personal_memories_source_id_memory_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."memory_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_memories" ADD CONSTRAINT "personal_memories_formed_by_agent_id_agents_id_fk" FOREIGN KEY ("formed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openmuse_file_owner_disables" ADD CONSTRAINT "openmuse_file_owner_disables_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openmuse_file_versions" ADD CONSTRAINT "openmuse_file_versions_file_id_openmuse_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."openmuse_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openmuse_files" ADD CONSTRAINT "openmuse_files_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openmuse_goals" ADD CONSTRAINT "openmuse_goals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openmuse_google_connections" ADD CONSTRAINT "openmuse_google_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openmuse_oauth_pending" ADD CONSTRAINT "openmuse_oauth_pending_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openmuse_reviewed_attempts" ADD CONSTRAINT "openmuse_reviewed_attempts_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."openmuse_reviewed_actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openmuse_tasks" ADD CONSTRAINT "openmuse_tasks_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "default_opt_outs" ADD CONSTRAINT "default_opt_outs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "default_opt_outs" ADD CONSTRAINT "default_opt_outs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_settings" ADD CONSTRAINT "proactive_settings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_settings" ADD CONSTRAINT "proactive_settings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_suggestions" ADD CONSTRAINT "proactive_suggestions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_suggestions" ADD CONSTRAINT "proactive_suggestions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_suggestions" ADD CONSTRAINT "proactive_suggestions_setting_id_proactive_settings_id_fk" FOREIGN KEY ("setting_id") REFERENCES "public"."proactive_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demonstrations" ADD CONSTRAINT "demonstrations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demonstrations" ADD CONSTRAINT "demonstrations_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_bindings" ADD CONSTRAINT "delivery_bindings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_bindings" ADD CONSTRAINT "delivery_bindings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_bindings" ADD CONSTRAINT "delivery_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_challenges" ADD CONSTRAINT "delivery_challenges_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_challenges" ADD CONSTRAINT "delivery_challenges_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_challenges" ADD CONSTRAINT "delivery_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_inbox" ADD CONSTRAINT "delivery_inbox_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_inbox" ADD CONSTRAINT "delivery_inbox_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_inbox" ADD CONSTRAINT "delivery_inbox_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_outbox" ADD CONSTRAINT "delivery_outbox_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_outbox" ADD CONSTRAINT "delivery_outbox_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_outbox" ADD CONSTRAINT "delivery_outbox_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_memberships" ADD CONSTRAINT "enterprise_memberships_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_memberships" ADD CONSTRAINT "enterprise_memberships_principal_id_enterprise_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."enterprise_principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_principals" ADD CONSTRAINT "enterprise_principals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_resource_grants" ADD CONSTRAINT "enterprise_resource_grants_tenant_id_resource_id_enterprise_resources_tenant_id_id_fk" FOREIGN KEY ("tenant_id","resource_id") REFERENCES "public"."enterprise_resources"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_resource_grants" ADD CONSTRAINT "enterprise_resource_grants_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_resources" ADD CONSTRAINT "enterprise_resources_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_security_events" ADD CONSTRAINT "enterprise_security_events_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_workspaces" ADD CONSTRAINT "enterprise_workspaces_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_conversations" ADD CONSTRAINT "enterprise_conversations_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_conversations" ADD CONSTRAINT "enterprise_conversations_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_conversations" ADD CONSTRAINT "enterprise_conversations_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_message_parts" ADD CONSTRAINT "enterprise_message_parts_tenant_id_message_id_enterprise_messages_tenant_id_id_fk" FOREIGN KEY ("tenant_id","message_id") REFERENCES "public"."enterprise_messages"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_messages" ADD CONSTRAINT "enterprise_messages_tenant_id_thread_id_enterprise_conversations_tenant_id_thread_id_fk" FOREIGN KEY ("tenant_id","thread_id") REFERENCES "public"."enterprise_conversations"("tenant_id","thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_expert_versions" ADD CONSTRAINT "enterprise_expert_versions_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_model_routes" ADD CONSTRAINT "enterprise_model_routes_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_model_budget_reservations" ADD CONSTRAINT "enterprise_model_budget_reservations_tenant_id_run_id_enterprise_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."enterprise_runs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_model_budget_reservations" ADD CONSTRAINT "enterprise_model_budget_reservations_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_model_invocation_capabilities" ADD CONSTRAINT "enterprise_model_invocation_capabilities_tenant_id_run_id_generation_attempt_id_enterprise_run_attempts_tenant_id_run_id_generation_id_fk" FOREIGN KEY ("tenant_id","run_id","generation","attempt_id") REFERENCES "public"."enterprise_run_attempts"("tenant_id","run_id","generation","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_model_invocation_capabilities" ADD CONSTRAINT "enterprise_model_invocation_capabilities_tenant_id_run_id_enterprise_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."enterprise_runs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_model_invocation_capabilities" ADD CONSTRAINT "enterprise_model_invocation_capabilities_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_run_attempts" ADD CONSTRAINT "enterprise_run_attempts_tenant_id_run_id_enterprise_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."enterprise_runs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_run_outbox" ADD CONSTRAINT "enterprise_run_outbox_tenant_id_run_id_enterprise_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."enterprise_runs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_runner_events" ADD CONSTRAINT "enterprise_runner_events_conversations_fk" FOREIGN KEY ("tenant_id","thread_id") REFERENCES "public"."enterprise_conversations"("tenant_id","thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_runner_events" ADD CONSTRAINT "enterprise_runner_events_runs_owner_fk" FOREIGN KEY ("tenant_id","run_id","workspace_id","principal_id","thread_id") REFERENCES "public"."enterprise_runs"("tenant_id","id","workspace_id","principal_id","thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_runner_events" ADD CONSTRAINT "enterprise_runner_events_attempts_fk" FOREIGN KEY ("tenant_id","run_id","generation","attempt_id") REFERENCES "public"."enterprise_run_attempts"("tenant_id","run_id","generation","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_runs" ADD CONSTRAINT "enterprise_runs_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_runs" ADD CONSTRAINT "enterprise_runs_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastra_message_intent_attachments" ADD CONSTRAINT "mastra_msg_intent_attachments_intent_fk" FOREIGN KEY ("tenant_id","thread_id","client_message_key") REFERENCES "public"."mastra_message_intents"("tenant_id","thread_id","client_message_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastra_message_intent_attachments" ADD CONSTRAINT "mastra_msg_intent_attachments_file_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastra_message_intents" ADD CONSTRAINT "mastra_message_intents_conversation_fk" FOREIGN KEY ("tenant_id","thread_id") REFERENCES "public"."enterprise_conversations"("tenant_id","thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastra_message_intents" ADD CONSTRAINT "mastra_message_intents_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastra_message_intents" ADD CONSTRAINT "mastra_message_intents_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_bot_threads" ADD CONSTRAINT "group_bot_threads_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_bot_threads" ADD CONSTRAINT "group_bot_threads_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_messages" ADD CONSTRAINT "group_messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_messages" ADD CONSTRAINT "group_messages_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_group_id_scim_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."scim_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_scim_user_id_scim_users_id_fk" FOREIGN KEY ("scim_user_id") REFERENCES "public"."scim_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_identity_tombstones" ADD CONSTRAINT "scim_identity_tombstones_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_projection_grants" ADD CONSTRAINT "scim_projection_grants_scim_user_id_scim_users_id_fk" FOREIGN KEY ("scim_user_id") REFERENCES "public"."scim_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_projection_grants" ADD CONSTRAINT "scim_projection_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_subjects" ADD CONSTRAINT "scim_subjects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_users" ADD CONSTRAINT "scim_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_lifecycle" ADD CONSTRAINT "bot_lifecycle_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_lifecycle" ADD CONSTRAINT "bot_lifecycle_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_routing_preferences" ADD CONSTRAINT "update_routing_preferences_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_logins" ADD CONSTRAINT "saved_logins_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_in_requests" ADD CONSTRAINT "sign_in_requests_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_bot_assignments" ADD CONSTRAINT "team_bot_assignments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_bot_assignments" ADD CONSTRAINT "team_bot_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_bot_audience" ADD CONSTRAINT "team_bot_audience_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_bot_consent_defaults" ADD CONSTRAINT "team_bot_consent_defaults_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_bot_consents" ADD CONSTRAINT "team_bot_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_bot_consents" ADD CONSTRAINT "team_bot_consents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_bot_publications" ADD CONSTRAINT "team_bot_publications_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_bot_publications" ADD CONSTRAINT "team_bot_publications_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_use_approval_members" ADD CONSTRAINT "shared_use_approval_members_approval_fk" FOREIGN KEY ("agent_id","server_id") REFERENCES "public"."shared_use_approvals"("agent_id","server_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_use_approvals" ADD CONSTRAINT "shared_use_approvals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_use_approvals" ADD CONSTRAINT "shared_use_approvals_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_use_requests" ADD CONSTRAINT "shared_use_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_use_requests" ADD CONSTRAINT "shared_use_requests_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_external_customer_id_billing_customers_external_id_fk" FOREIGN KEY ("external_customer_id") REFERENCES "public"."billing_customers"("external_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_accounts" ADD CONSTRAINT "payer_accounts_external_customer_id_fk" FOREIGN KEY ("external_customer_id") REFERENCES "public"."billing_customers"("external_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_binding_offers" ADD CONSTRAINT "bot_binding_offers_bot_id_bot_services_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bot_services"("bot_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_bot_id_bot_services_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bot_services"("bot_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_virtual_keys" ADD CONSTRAINT "gateway_virtual_keys_grant_id_access_grants_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."access_grants"("grant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_external_customer_id_billing_customers_external_id_fk" FOREIGN KEY ("external_customer_id") REFERENCES "public"."billing_customers"("external_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_external_customer_id_billing_customers_external_id_fk" FOREIGN KEY ("external_customer_id") REFERENCES "public"."billing_customers"("external_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_grant_id_credit_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."credit_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_charge_remainders" ADD CONSTRAINT "credit_charge_remainders_external_customer_id_billing_customers_external_id_fk" FOREIGN KEY ("external_customer_id") REFERENCES "public"."billing_customers"("external_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reservation_allocations" ADD CONSTRAINT "credit_reservation_allocations_reservation_id_credit_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."credit_reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reservation_allocations" ADD CONSTRAINT "credit_reservation_allocations_grant_id_credit_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."credit_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_external_customer_id_billing_customers_external_id_fk" FOREIGN KEY ("external_customer_id") REFERENCES "public"."billing_customers"("external_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_ledger_id_credit_ledger_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."credit_ledger"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_instances" ADD CONSTRAINT "sandbox_instances_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_instances" ADD CONSTRAINT "sandbox_instances_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_instances" ADD CONSTRAINT "sandbox_instances_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_artifacts" ADD CONSTRAINT "workshop_artifacts_session_id_workshop_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workshop_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_schedule_runs" ADD CONSTRAINT "workshop_schedule_runs_schedule_id_workshop_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."workshop_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_schedule_runs" ADD CONSTRAINT "workshop_schedule_runs_turn_id_workshop_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."workshop_turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_schedules" ADD CONSTRAINT "workshop_schedules_session_id_workshop_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workshop_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_schedules" ADD CONSTRAINT "workshop_schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_sessions" ADD CONSTRAINT "workshop_sessions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_sessions" ADD CONSTRAINT "workshop_sessions_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_sessions" ADD CONSTRAINT "workshop_sessions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_sessions" ADD CONSTRAINT "workshop_sessions_share_created_by_users_id_fk" FOREIGN KEY ("share_created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_turn_events" ADD CONSTRAINT "workshop_turn_events_turn_id_workshop_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."workshop_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_turns" ADD CONSTRAINT "workshop_turns_session_id_workshop_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workshop_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_turns" ADD CONSTRAINT "workshop_turns_code_run_id_code_runs_id_fk" FOREIGN KEY ("code_run_id") REFERENCES "public"."code_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_order_id_payment_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."payment_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_installs" ADD CONSTRAINT "expert_installs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_installs" ADD CONSTRAINT "expert_installs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_links" ADD CONSTRAINT "identity_links_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_account_idx" ON "accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "attachments_channel_idx" ON "attachments" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "attachments_uploaded_by_idx" ON "attachments" USING btree ("uploaded_by");--> statement-breakpoint
CREATE INDEX "attachments_upload_group_idx" ON "attachments" USING btree ("channel_id","uploaded_by","upload_group") WHERE "attachments"."attached_at" is null;--> statement-breakpoint
CREATE INDEX "attachments_staged_idx" ON "attachments" USING btree ("created_at") WHERE "attachments"."attached_at" is null;--> statement-breakpoint
CREATE INDEX "audit_events_created_at_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_events_type_time_idx" ON "audit_events" USING btree ("event_type","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_actor_time_idx" ON "audit_events" USING btree ("actor_user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_target_time_idx" ON "audit_events" USING btree ("target_type","target_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_initiator_time_idx" ON "audit_events" USING btree ("initiator_kind","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "channels_recent_activity_idx" ON "channels" USING btree (COALESCE("last_message_at", "created_at") DESC);--> statement-breakpoint
CREATE INDEX "channels_awaiting_summary_idx" ON "channels" USING btree ("id") WHERE "channels"."summary" is null and "channels"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_active_key_idx" ON "credentials" USING btree ("kind","provider","key_id") WHERE "credentials"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "intelligence_channel_mappings_thread_idx" ON "intelligence_channel_mappings" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "computer_page_frame_captured_idx" ON "computer_page_frame" USING btree ("captured_at");--> statement-breakpoint
CREATE INDEX "agent_profiles_visibility_deleted_idx" ON "agent_profiles" USING btree ("visibility","deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_profiles_owner_template_live_uq" ON "agent_profiles" USING btree ("owner_user_id","template_key") WHERE "agent_profiles"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "routine_runs_by_routine_idx" ON "routine_runs" USING btree ("routine_id","started_at");--> statement-breakpoint
CREATE INDEX "routines_due_idx" ON "routines" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "routines_by_owner_idx" ON "routines" USING btree ("owner_user_id","enabled");--> statement-breakpoint
CREATE INDEX "craft_messages_session_turn_idx" ON "craft_messages" USING btree ("session_id","turn_index","created_at");--> statement-breakpoint
CREATE INDEX "craft_scheduled_task_runs_task_started_idx" ON "craft_scheduled_task_runs" USING btree ("task_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "craft_scheduled_task_runs_status_idx" ON "craft_scheduled_task_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "craft_scheduled_task_runs_session_idx" ON "craft_scheduled_task_runs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "craft_scheduled_tasks_dispatch_idx" ON "craft_scheduled_tasks" USING btree ("status","deleted","next_run_at");--> statement-breakpoint
CREATE INDEX "craft_scheduled_tasks_user_created_idx" ON "craft_scheduled_tasks" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "craft_sessions_user_origin_created_idx" ON "craft_sessions" USING btree ("user_id","origin","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "craft_sessions_status_idx" ON "craft_sessions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "craft_sessions_user_port_idx" ON "craft_sessions" USING btree ("user_id","nextjs_port") WHERE "craft_sessions"."nextjs_port" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "craft_snapshots_session_created_idx" ON "craft_snapshots" USING btree ("session_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "brokered_connections_person_idx" ON "brokered_connections" USING btree ("provider","app","user_id") WHERE "brokered_connections"."holder" = 'person';--> statement-breakpoint
CREATE UNIQUE INDEX "brokered_connections_deployment_idx" ON "brokered_connections" USING btree ("provider","app") WHERE "brokered_connections"."holder" = 'deployment';--> statement-breakpoint
CREATE INDEX "brokered_connections_user_idx" ON "brokered_connections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "composio_connections_user_idx" ON "composio_connections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mcp_user_credentials_user_idx" ON "mcp_user_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "plugin_grants_agent_idx" ON "plugin_grants" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "skill_tools_ref_idx" ON "skill_tools" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_slug_key" ON "skills" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "skills_owner_idx" ON "skills" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "work_items_claimable_idx" ON "work_items" USING btree ("kind","run_at");--> statement-breakpoint
CREATE INDEX "voice_sessions_channel_started_idx" ON "voice_sessions" USING btree ("channel_id","started_at","id");--> statement-breakpoint
CREATE INDEX "responsibilities_owner_status_idx" ON "responsibilities" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "responsibility_events_source_id_idx" ON "responsibility_events" USING btree ("owner_user_id","source","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "responsibility_runs_event_idx" ON "responsibility_runs" USING btree ("responsibility_id","event_id");--> statement-breakpoint
CREATE INDEX "responsibility_runs_status_idx" ON "responsibility_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "responsibility_source_bindings_owner_idx" ON "responsibility_source_bindings" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "responsibility_triggers_owner_idx" ON "responsibility_triggers" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "responsibility_triggers_responsibility_idx" ON "responsibility_triggers" USING btree ("responsibility_id");--> statement-breakpoint
CREATE INDEX "responsibility_triggers_kind_idx" ON "responsibility_triggers" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_action_idx" ON "approval_requests" USING btree ("owner_user_id","run_id","tool_call_id");--> statement-breakpoint
CREATE INDEX "approval_requests_inbox_idx" ON "approval_requests" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "approval_rules_owner_idx" ON "approval_rules" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "memory_sources_owner_idx" ON "memory_sources" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "memory_sources_due_idx" ON "memory_sources" USING btree ("enabled","next_sync_at");--> statement-breakpoint
CREATE INDEX "personal_memories_owner_idx" ON "personal_memories" USING btree ("owner_user_id","enabled");--> statement-breakpoint
CREATE INDEX "personal_memories_intelligence_idx" ON "personal_memories" USING btree ("owner_user_id","intelligence_memory_id");--> statement-breakpoint
CREATE INDEX "personal_memories_formed_idx" ON "personal_memories" USING btree ("owner_user_id","formed_by_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_memories_import_idx" ON "personal_memories" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_memories_formed_digest_idx" ON "personal_memories" USING btree ("owner_user_id","import_digest") WHERE "personal_memories"."formed_by" = 'bot';--> statement-breakpoint
CREATE INDEX "openmuse_file_versions_file_idx" ON "openmuse_file_versions" USING btree ("file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "openmuse_file_versions_parent_uq" ON "openmuse_file_versions" USING btree ("file_id","parent_version_id") WHERE "openmuse_file_versions"."parent_version_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "openmuse_files_owner_list_idx" ON "openmuse_files" USING btree ("owner_user_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "openmuse_files_owner_idem_uq" ON "openmuse_files" USING btree ("owner_user_id","idempotency_key") WHERE "openmuse_files"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "openmuse_goals_owner_created_idx" ON "openmuse_goals" USING btree ("owner_user_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "openmuse_google_connections_owner_provider_uq" ON "openmuse_google_connections" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX "openmuse_ideas_owner_created_idx" ON "openmuse_ideas" USING btree ("owner_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "openmuse_memories_owner_created_idx" ON "openmuse_memories" USING btree ("owner_user_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "openmuse_notifications_owner_event_uq" ON "openmuse_notifications" USING btree ("user_id","task_id","event_kind","attempt_key");--> statement-breakpoint
CREATE INDEX "openmuse_notifications_owner_created_idx" ON "openmuse_notifications" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "openmuse_oauth_pending_open_idx" ON "openmuse_oauth_pending" USING btree ("expires_at") WHERE "openmuse_oauth_pending"."consumed_at" IS NULL AND "openmuse_oauth_pending"."outcome" IS NULL;--> statement-breakpoint
CREATE INDEX "openmuse_reviewed_actions_owner_created_idx" ON "openmuse_reviewed_actions" USING btree ("owner_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "openmuse_reviewed_actions_outcome_unknown_idx" ON "openmuse_reviewed_actions" USING btree ("created_at") WHERE "openmuse_reviewed_actions"."status" = 'outcome_unknown';--> statement-breakpoint
CREATE UNIQUE INDEX "openmuse_reviewed_actions_active_send_uq" ON "openmuse_reviewed_actions" USING btree ("owner_user_id","kind","payload_hash",coalesce("target_id", '')) WHERE "openmuse_reviewed_actions"."status" IN ('awaiting_review', 'executing', 'outcome_unknown');--> statement-breakpoint
CREATE INDEX "openmuse_reviewed_attempts_action_idx" ON "openmuse_reviewed_attempts" USING btree ("action_id");--> statement-breakpoint
CREATE UNIQUE INDEX "openmuse_tasks_owner_key_uq" ON "openmuse_tasks" USING btree ("owner_user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "openmuse_tasks_owner_created_idx" ON "openmuse_tasks" USING btree ("owner_user_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "proactive_settings_owner_agent_idx" ON "proactive_settings" USING btree ("owner_user_id","agent_id");--> statement-breakpoint
CREATE INDEX "proactive_settings_due_idx" ON "proactive_settings" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "proactive_suggestions_owner_idx" ON "proactive_suggestions" USING btree ("owner_user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "proactive_suggestions_run_idx" ON "proactive_suggestions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "demonstrations_owner_idx" ON "demonstrations" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "demonstrations_active_bot_idx" ON "demonstrations" USING btree ("bot_id") WHERE "demonstrations"."status" = 'recording';--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_binding_identity_idx" ON "delivery_bindings" USING btree ("transport","realm","identity");--> statement-breakpoint
CREATE INDEX "delivery_bindings_owner_idx" ON "delivery_bindings" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_inbox_dedupe_idx" ON "delivery_inbox" USING btree ("source","realm","external_id");--> statement-breakpoint
CREATE INDEX "delivery_inbox_owner_idx" ON "delivery_inbox" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "delivery_outbox_owner_idx" ON "delivery_outbox" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "delivery_outbox_provider_idx" ON "delivery_outbox" USING btree ("transport","provider_id");--> statement-breakpoint
CREATE INDEX "push_devices_owner_idx" ON "push_devices" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_memberships_principal_tenant" ON "enterprise_memberships" USING btree ("principal_id","tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_principal_user" ON "enterprise_principals" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_conversations_tenant_thread" ON "enterprise_conversations" USING btree ("tenant_id","thread_id");--> statement-breakpoint
CREATE INDEX "enterprise_conversations_owner_idx" ON "enterprise_conversations" USING btree ("tenant_id","workspace_id","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_messages_thread_seq" ON "enterprise_messages" USING btree ("tenant_id","thread_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_messages_client_key" ON "enterprise_messages" USING btree ("tenant_id","thread_id","client_message_key");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_budget_reservation_idempotency" ON "enterprise_model_budget_reservations" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "enterprise_budget_reservation_scope_idx" ON "enterprise_model_budget_reservations" USING btree ("tenant_id","workspace_id","principal_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_model_invocation_request_id" ON "enterprise_model_invocation_capabilities" USING btree ("tenant_id","run_id","model_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_model_invocation_capability_digest" ON "enterprise_model_invocation_capabilities" USING btree ("tenant_id","capability_digest");--> statement-breakpoint
CREATE INDEX "enterprise_model_invocation_run_status_idx" ON "enterprise_model_invocation_capabilities" USING btree ("tenant_id","run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_run_attempts_generation" ON "enterprise_run_attempts" USING btree ("tenant_id","run_id","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_run_attempts_binding" ON "enterprise_run_attempts" USING btree ("tenant_id","run_id","generation","id");--> statement-breakpoint
CREATE INDEX "enterprise_run_outbox_pending_idx" ON "enterprise_run_outbox" USING btree ("created_at") WHERE "enterprise_run_outbox"."delivered_at" is null;--> statement-breakpoint
CREATE INDEX "enterprise_run_outbox_claim_idx" ON "enterprise_run_outbox" USING btree ("claim_expires_at","created_at") WHERE "enterprise_run_outbox"."delivered_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_runner_events_thread_cursor" ON "enterprise_runner_events" USING btree ("tenant_id","thread_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_runner_events_source_identity" ON "enterprise_runner_events" USING btree ("tenant_id","run_id","attempt_id","generation","source_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_runs_event_owner_binding" ON "enterprise_runs" USING btree ("tenant_id","id","workspace_id","principal_id","thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_runs_client_message_key" ON "enterprise_runs" USING btree ("tenant_id","thread_id","client_message_key");--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_runs_one_active_thread" ON "enterprise_runs" USING btree ("tenant_id","thread_id") WHERE "enterprise_runs"."status" in ('queued', 'running', 'waiting_approval', 'suspended');--> statement-breakpoint
CREATE INDEX "enterprise_runs_owner_idx" ON "enterprise_runs" USING btree ("tenant_id","workspace_id","principal_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mastra_tenant_storage_key_unique" ON "mastra_tenant_storage_registry" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "mastra_tenant_storage_schema_unique" ON "mastra_tenant_storage_registry" USING btree ("schema_name");--> statement-breakpoint
CREATE UNIQUE INDEX "mastra_message_intents_message_id" ON "mastra_message_intents" USING btree ("tenant_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mastra_message_intents_thread_seq" ON "mastra_message_intents" USING btree ("tenant_id","thread_id","reserved_seq");--> statement-breakpoint
CREATE INDEX "mastra_message_intents_pending_idx" ON "mastra_message_intents" USING btree ("tenant_id","state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "group_bot_threads_thread_idx" ON "group_bot_threads" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "group_messages_channel_idx" ON "group_messages" USING btree ("channel_id","created_at","id");--> statement-breakpoint
CREATE INDEX "action_records_created_idx" ON "action_records" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "action_records_bot_idx" ON "action_records" USING btree ("bot_id","created_at");--> statement-breakpoint
CREATE INDEX "model_usage_created_idx" ON "model_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "model_usage_model_idx" ON "model_usage" USING btree ("model","created_at");--> statement-breakpoint
CREATE INDEX "scim_connection_bindings_connection_idx" ON "scim_connection_bindings" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_group_members_connection_idx" ON "scim_group_members" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_group_members_group_idx" ON "scim_group_members" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "scim_group_members_scim_user_idx" ON "scim_group_members" USING btree ("scim_user_id");--> statement-breakpoint
CREATE INDEX "scim_groups_connection_idx" ON "scim_groups" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_groups_domain_idx" ON "scim_groups" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scim_identity_tombstones_connection_idx" ON "scim_identity_tombstones" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_identity_tombstones_domain_idx" ON "scim_identity_tombstones" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scim_identity_tombstones_user_idx" ON "scim_identity_tombstones" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scim_projection_grants_connection_idx" ON "scim_projection_grants" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_projection_grants_domain_idx" ON "scim_projection_grants" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scim_projection_grants_scim_user_idx" ON "scim_projection_grants" USING btree ("scim_user_id");--> statement-breakpoint
CREATE INDEX "scim_projection_grants_user_idx" ON "scim_projection_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scim_subjects_profile_source_idx" ON "scim_subjects" USING btree ("profile_source_id");--> statement-breakpoint
CREATE INDEX "scim_users_connection_idx" ON "scim_users" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_users_domain_idx" ON "scim_users" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scim_users_user_idx" ON "scim_users" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_logins_owner_origin_username_idx" ON "saved_logins" USING btree ("owner_user_id","origin","username");--> statement-breakpoint
CREATE INDEX "saved_logins_owner_idx" ON "saved_logins" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "sign_in_requests_owner_idx" ON "sign_in_requests" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "shared_use_requests_pending_idx" ON "shared_use_requests" USING btree ("agent_id","server_id") WHERE "shared_use_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "shared_use_requests_status_idx" ON "shared_use_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "billing_subscriptions_customer_idx" ON "billing_subscriptions" USING btree ("external_customer_id");--> statement-breakpoint
CREATE INDEX "billing_subscriptions_owner_idx" ON "billing_subscriptions" USING btree ("owner_payer_id","owner_payer_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_webhook_events_provider_event_idx" ON "billing_webhook_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "billing_webhook_events_unique_key_idx" ON "billing_webhook_events" USING btree ("lago_unique_key");--> statement-breakpoint
CREATE INDEX "billing_webhook_events_body_hash_idx" ON "billing_webhook_events" USING btree ("body_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "payer_accounts_subject_unique_idx" ON "payer_accounts" USING btree ("kind","payer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payer_accounts_external_customer_unique_idx" ON "payer_accounts" USING btree ("external_customer_id");--> statement-breakpoint
CREATE INDEX "bot_binding_offers_bot_idx" ON "bot_binding_offers" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "bot_binding_offers_expiry_idx" ON "bot_binding_offers" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "access_grants_one_active_per_identity" ON "access_grants" USING btree ("user_id","bot_id","external_identity") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "access_grants_user_idx" ON "access_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "access_grants_bot_idx" ON "access_grants" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "gateway_catalog_fetches_fetched_at_idx" ON "gateway_catalog_fetches" USING btree ("fetched_at" DESC NULLS LAST,"fetch_id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_customers_subject_unique_idx" ON "gateway_customers" USING btree ("kind","payer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_customers_remote_id_unique_idx" ON "gateway_customers" USING btree ("gateway_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_customers_remote_name_unique_idx" ON "gateway_customers" USING btree ("gateway_customer_name");--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_customers_external_reference_unique_idx" ON "gateway_customers" USING btree ("external_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_model_catalog_refs_identity_uq" ON "gateway_model_catalog_refs" USING btree ("provider","model","capability");--> statement-breakpoint
CREATE INDEX "gateway_rate_versions_effective_at_idx" ON "gateway_rate_versions" USING btree ("effective_at" DESC NULLS LAST,"rate_version" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_virtual_keys_grant_version_unique_idx" ON "gateway_virtual_keys" USING btree ("grant_id","credential_version");--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_virtual_keys_remote_id_unique_idx" ON "gateway_virtual_keys" USING btree ("gateway_virtual_key_id");--> statement-breakpoint
CREATE INDEX "gateway_virtual_keys_bot_idx" ON "gateway_virtual_keys" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "gateway_virtual_keys_customer_idx" ON "gateway_virtual_keys" USING btree ("gateway_customer_id");--> statement-breakpoint
CREATE INDEX "code_runs_bot_idx" ON "code_runs" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "credit_grants_customer_idx" ON "credit_grants" USING btree ("external_customer_id");--> statement-breakpoint
CREATE INDEX "credit_grants_customer_expires_idx" ON "credit_grants" USING btree ("external_customer_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_grants_idempotency_key_unique_idx" ON "credit_grants" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "credit_ledger_customer_created_idx" ON "credit_ledger" USING btree ("external_customer_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_ledger_grant_idx" ON "credit_ledger" USING btree ("grant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_idempotency_key_unique_idx" ON "credit_ledger" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_reservation_allocations_reservation_grant_idx" ON "credit_reservation_allocations" USING btree ("reservation_id","grant_id");--> statement-breakpoint
CREATE INDEX "credit_reservation_allocations_grant_idx" ON "credit_reservation_allocations" USING btree ("grant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_reservations_idempotency_key_unique_idx" ON "credit_reservations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "credit_reservations_customer_status_idx" ON "credit_reservations" USING btree ("external_customer_id","status");--> statement-breakpoint
CREATE INDEX "credit_reservations_status_expires_idx" ON "credit_reservations" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "sandbox_instances_bot_status_idx" ON "sandbox_instances" USING btree ("bot_id","status") WHERE "sandbox_instances"."status" IN ('provisioning', 'ready', 'sleeping');--> statement-breakpoint
CREATE INDEX "sandbox_instances_tenant_idx" ON "sandbox_instances" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "workshop_artifacts_session_idx" ON "workshop_artifacts" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workshop_schedule_runs_once_idx" ON "workshop_schedule_runs" USING btree ("schedule_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "workshop_schedule_runs_schedule_idx" ON "workshop_schedule_runs" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "workshop_schedules_session_idx" ON "workshop_schedules" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "workshop_schedules_due_idx" ON "workshop_schedules" USING btree ("next_run_at") WHERE "workshop_schedules"."status" = 'enabled' AND "workshop_schedules"."next_run_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workshop_sessions_channel_idx" ON "workshop_sessions" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workshop_sessions_share_token_idx" ON "workshop_sessions" USING btree ("share_token_hash") WHERE "workshop_sessions"."share_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "workshop_sessions_owner_idx" ON "workshop_sessions" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workshop_turn_events_turn_seq_idx" ON "workshop_turn_events" USING btree ("turn_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "workshop_turns_session_turn_idx" ON "workshop_turns" USING btree ("session_id","turn_index");--> statement-breakpoint
CREATE INDEX "workshop_turns_stale_idx" ON "workshop_turns" USING btree ("status","runner_heartbeat_at");--> statement-breakpoint
CREATE INDEX "workshop_turns_code_run_idx" ON "workshop_turns" USING btree ("code_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_paid_fact_unique_idx" ON "payment_events" USING btree ("channel_transaction_id") WHERE "payment_events"."kind" = 'fact' AND "payment_events"."state" = 'paid';--> statement-breakpoint
CREATE INDEX "payment_events_order_idx" ON "payment_events" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_anomaly_unique_idx" ON "payment_events" USING btree ("order_id","code") WHERE "payment_events"."kind" = 'anomaly' AND "payment_events"."code" <> 'amount_unreadable';--> statement-breakpoint
CREATE INDEX "payment_orders_plan_provider_status_idx" ON "payment_orders" USING btree ("plan_code","provider","status");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_orders_pending_scope_unique_idx" ON "payment_orders" USING btree ("deployment_scope") WHERE "payment_orders"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "payment_orders_status_expires_idx" ON "payment_orders" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "payment_orders_owner_idx" ON "payment_orders" USING btree ("owner_payer_id","owner_payer_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_outbox_transaction_id_unique_idx" ON "usage_outbox" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "usage_outbox_lago_pending_updated_idx" ON "usage_outbox" USING btree ("lago_status","updated_at");--> statement-breakpoint
CREATE INDEX "usage_outbox_credits_pending_updated_idx" ON "usage_outbox" USING btree ("credits_status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "expert_installs_owner_slug_key" ON "expert_installs" USING btree ("owner_user_id","expert_slug");--> statement-breakpoint
CREATE INDEX "expert_installs_agent_idx" ON "expert_installs" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "identity_link_challenges_expiry_idx" ON "identity_link_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_link_challenges_user_provider_idx" ON "identity_link_challenges" USING btree ("user_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_links_identity_idx" ON "identity_links" USING btree ("provider","realm","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_links_user_realm_idx" ON "identity_links" USING btree ("user_id","provider","realm");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_links_credential_idx" ON "identity_links" USING btree ("credential_id") WHERE "identity_links"."credential_id" IS NOT NULL;--> statement-breakpoint
CREATE POLICY "enterprise_membership_self_read" ON "enterprise_memberships" AS PERMISSIVE FOR SELECT TO "ob_ent_directory" USING (exists (select 1 from enterprise_principals p where p.id = enterprise_memberships.principal_id and p.user_id = nullif(current_setting('app.user_id', true), '')));--> statement-breakpoint
CREATE POLICY "enterprise_membership_data_read" ON "enterprise_memberships" AS PERMISSIVE FOR SELECT TO "ob_ent_data" USING (enterprise_memberships.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_memberships.principal_id = nullif(current_setting('app.principal_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_membership_operator_read" ON "enterprise_memberships" AS PERMISSIVE FOR SELECT TO "ob_ent_operator" USING (enterprise_memberships.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_membership_operator_insert" ON "enterprise_memberships" AS PERMISSIVE FOR INSERT TO "ob_ent_operator" WITH CHECK (enterprise_memberships.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_membership_operator_update" ON "enterprise_memberships" AS PERMISSIVE FOR UPDATE TO "ob_ent_operator" USING (enterprise_memberships.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_memberships.principal_id = nullif(current_setting('app.operator_principal_id', true), '')) WITH CHECK (enterprise_memberships.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_memberships.principal_id = nullif(current_setting('app.operator_principal_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_principal_self_read" ON "enterprise_principals" AS PERMISSIVE FOR SELECT TO "ob_ent_directory" USING (enterprise_principals.user_id = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_principal_data_read" ON "enterprise_principals" AS PERMISSIVE FOR SELECT TO "ob_ent_data" USING (enterprise_principals.id = nullif(current_setting('app.principal_id', true), '') and enterprise_principals.user_id = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_principal_operator_read" ON "enterprise_principals" AS PERMISSIVE FOR SELECT TO "ob_ent_operator" USING (enterprise_principals.id = nullif(current_setting('app.operator_principal_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_grant_data_tenant_read" ON "enterprise_resource_grants" AS PERMISSIVE FOR SELECT TO "ob_ent_data" USING (enterprise_resource_grants.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_grant_self_read" ON "enterprise_resource_grants" AS RESTRICTIVE FOR SELECT TO "ob_ent_data" USING (enterprise_resource_grants.principal_id = nullif(current_setting('app.principal_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_grant_operator_read" ON "enterprise_resource_grants" AS PERMISSIVE FOR SELECT TO "ob_ent_operator" USING (enterprise_resource_grants.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_grant_operator_insert" ON "enterprise_resource_grants" AS PERMISSIVE FOR INSERT TO "ob_ent_operator" WITH CHECK (enterprise_resource_grants.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_grant_operator_delete" ON "enterprise_resource_grants" AS PERMISSIVE FOR DELETE TO "ob_ent_operator" USING (enterprise_resource_grants.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_resource_grants.resource_id = nullif(current_setting('app.resource_id', true), '') and enterprise_resource_grants.principal_id = nullif(current_setting('app.operator_principal_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_resource_tenant_scope" ON "enterprise_resources" AS PERMISSIVE FOR SELECT TO "ob_ent_data" USING (enterprise_resources.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_resource_operator_read" ON "enterprise_resources" AS PERMISSIVE FOR SELECT TO "ob_ent_operator" USING (enterprise_resources.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_resource_operator_insert" ON "enterprise_resources" AS PERMISSIVE FOR INSERT TO "ob_ent_operator" WITH CHECK (enterprise_resources.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_resource_operator_update" ON "enterprise_resources" AS PERMISSIVE FOR UPDATE TO "ob_ent_operator" USING (enterprise_resources.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_resources.id = nullif(current_setting('app.resource_id', true), '')) WITH CHECK (enterprise_resources.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_resources.id = nullif(current_setting('app.resource_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_security_event_tenant_scope" ON "enterprise_security_events" AS PERMISSIVE FOR SELECT TO "ob_ent_operator" USING (enterprise_security_events.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_security_events.id = nullif(current_setting('app.operation_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_security_event_operator_insert" ON "enterprise_security_events" AS PERMISSIVE FOR INSERT TO "ob_ent_operator" WITH CHECK (enterprise_security_events.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_security_events.id = nullif(current_setting('app.operation_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_tenant_member_read" ON "enterprise_tenants" AS PERMISSIVE FOR SELECT TO "ob_ent_directory" USING (exists (select 1 from enterprise_memberships m join enterprise_principals p on p.id = m.principal_id where m.tenant_id = enterprise_tenants.id and p.user_id = nullif(current_setting('app.user_id', true), '')));--> statement-breakpoint
CREATE POLICY "enterprise_tenant_data_read" ON "enterprise_tenants" AS PERMISSIVE FOR SELECT TO "ob_ent_data" USING (enterprise_tenants.id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_tenant_operator_read" ON "enterprise_tenants" AS PERMISSIVE FOR SELECT TO "ob_ent_operator" USING (enterprise_tenants.id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_tenant_context_write" ON "enterprise_tenants" AS PERMISSIVE FOR INSERT TO "ob_ent_operator" WITH CHECK (enterprise_tenants.id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_workspace_tenant_scope" ON "enterprise_workspaces" AS PERMISSIVE FOR SELECT TO "ob_ent_data" USING (enterprise_workspaces.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_workspace_operator_read" ON "enterprise_workspaces" AS PERMISSIVE FOR SELECT TO "ob_ent_operator" USING (enterprise_workspaces.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_workspace_operator_insert" ON "enterprise_workspaces" AS PERMISSIVE FOR INSERT TO "ob_ent_operator" WITH CHECK (enterprise_workspaces.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_conversations_data_scope" ON "enterprise_conversations" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING (enterprise_conversations.tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (enterprise_conversations.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_message_parts_data_scope" ON "enterprise_message_parts" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING (enterprise_message_parts.tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (enterprise_message_parts.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_messages_data_scope" ON "enterprise_messages" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING (enterprise_messages.tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (enterprise_messages.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_expert_versions_data_scope" ON "enterprise_expert_versions" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING (enterprise_expert_versions.tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (enterprise_expert_versions.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_model_routes_data_scope" ON "enterprise_model_routes" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING (enterprise_model_routes.tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (enterprise_model_routes.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_model_budget_reservations_data_scope" ON "enterprise_model_budget_reservations" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING (enterprise_model_budget_reservations.tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (enterprise_model_budget_reservations.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_model_invocation_capabilities_data_scope" ON "enterprise_model_invocation_capabilities" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING (enterprise_model_invocation_capabilities.tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (enterprise_model_invocation_capabilities.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_run_attempts_data_scope" ON "enterprise_run_attempts" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING (enterprise_run_attempts.tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (enterprise_run_attempts.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_run_outbox_data_scope" ON "enterprise_run_outbox" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING (enterprise_run_outbox.tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (enterprise_run_outbox.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_runner_events_data_scope" ON "enterprise_runner_events" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING (enterprise_runner_events.tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (enterprise_runner_events.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_runs_data_scope" ON "enterprise_runs" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING (enterprise_runs.tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (enterprise_runs.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "mastra_message_intent_attachments_data_scope" ON "mastra_message_intent_attachments" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING (mastra_message_intent_attachments.tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (mastra_message_intent_attachments.tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "mastra_message_intents_data_scope" ON "mastra_message_intents" AS PERMISSIVE FOR ALL TO "ob_ent_data" USING (mastra_message_intents.tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (mastra_message_intents.tenant_id = nullif(current_setting('app.tenant_id', true), ''));