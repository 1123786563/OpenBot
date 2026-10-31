-- issue-358 closeout (F1): restore the migration chain — tables declared in schema after 0163
-- by the wave merges (fd62295a14, a789f6a438, 0453ed6b9c, f45a87104f) but never generated:
-- 32 tables / 294 columns absent from every fresh deployment (db-drift-check FAIL, 294 problems).
--
-- Expand-only, mirroring the 0163/#436 discipline: only CREATE TABLE / CREATE INDEX /
-- ADD CONSTRAINT FK. No existing table or column is touched. Column names, types, nullability
-- and defaults, plus index and FK definitions, are transcribed from the drizzle table configs of
-- server/src/db/schema (the same serializer drizzle-kit generate uses), grouped by domain:
--   0209: enterprise scope/governance surfaces (craft/artifact/workshop scopes, share grants,
--         host access, audit, purge/restore, learning, personal memory, billing manage grants)
--   0210: enterprise plugin-package market (plans, revisions, installs, grants, experts,
--         resource links, changes, run pins)
--   0211: openmuse tenant-scoped scope rows and voice/mobile usage scopes
--
-- NOT carried here, same operator-territory rule as 0163: the pgPolicy objects, RLS markers and
-- CHECK constraints these schema files also declare. 0163 restored 38 tables the same way and
-- shipped; policies/checks stay an ops concern (roles.sql / ops) until a dedicated RLS pass.
--
-- Why hand-written SQL instead of `drizzle-kit generate`: the latest snapshot (0160) predates the
-- hand-written 0161-0208 migrations, so generate diffs against a stale snapshot and produces a
-- destructive full-chain diff that dies in zod validation — the documented #436 state. Snapshots
-- therefore stay un-maintained for hand-written migrations (0161-0208 precedent);
-- `drizzle-kit check` continues to validate the journal and snapshot chain.

CREATE TABLE "openmuse_delivery_binding_scopes" (
  "binding_id" text NOT NULL PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "user_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);


--> statement-breakpoint


CREATE TABLE "openmuse_notification_scopes" (
  "notification_id" text NOT NULL PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "user_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);


--> statement-breakpoint


CREATE TABLE "openmuse_file_scopes" (
  "file_id" text NOT NULL PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "user_id" text NOT NULL,
  "attribution" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);


--> statement-breakpoint


CREATE TABLE "openmuse_document_actions" (
  "file_id" text NOT NULL,
  "action_kind" text NOT NULL,
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "user_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "openmuse_document_actions_pk" PRIMARY KEY ("file_id", "action_kind")
);


--> statement-breakpoint


CREATE TABLE "openmuse_reviewed_action_scopes" (
  "action_id" text NOT NULL PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "user_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);


--> statement-breakpoint


CREATE TABLE "openmuse_personal_scopes" (
  "object_type" text NOT NULL,
  "object_id" text NOT NULL,
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "user_id" text NOT NULL,
  "attribution" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "openmuse_personal_scopes_pk" PRIMARY KEY ("object_type", "object_id")
);


--> statement-breakpoint


CREATE TABLE "voice_session_scopes" (
  "session_id" text NOT NULL PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "user_id" text NOT NULL,
  "usage_seconds" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);


--> statement-breakpoint


CREATE TABLE "dictation_usage_scopes" (
  "id" text NOT NULL PRIMARY KEY,
  "usage_key" text NOT NULL,
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "user_id" text NOT NULL,
  "audio_seconds" integer NOT NULL,
  "output_tokens" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);


--> statement-breakpoint


CREATE TABLE "push_device_scopes" (
  "device_id" text NOT NULL PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "user_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);


--> statement-breakpoint


CREATE INDEX "openmuse_delivery_binding_scopes_scope_list_idx" ON "openmuse_delivery_binding_scopes" ("tenant_id", "workspace_id", "principal_id", "created_at", "binding_id");


--> statement-breakpoint


CREATE INDEX "openmuse_notification_scopes_scope_list_idx" ON "openmuse_notification_scopes" ("tenant_id", "workspace_id", "principal_id", "created_at", "notification_id");


--> statement-breakpoint


CREATE INDEX "openmuse_file_scopes_scope_list_idx" ON "openmuse_file_scopes" ("tenant_id", "workspace_id", "principal_id", "created_at", "file_id");


--> statement-breakpoint


CREATE INDEX "openmuse_document_actions_scope_list_idx" ON "openmuse_document_actions" ("tenant_id", "workspace_id", "principal_id", "created_at", "file_id");


--> statement-breakpoint


CREATE INDEX "openmuse_reviewed_action_scopes_scope_list_idx" ON "openmuse_reviewed_action_scopes" ("tenant_id", "workspace_id", "principal_id", "created_at", "action_id");


--> statement-breakpoint


CREATE INDEX "openmuse_personal_scopes_scope_list_idx" ON "openmuse_personal_scopes" ("tenant_id", "workspace_id", "principal_id", "object_type", "created_at", "object_id");


--> statement-breakpoint


CREATE INDEX "voice_session_scopes_scope_list_idx" ON "voice_session_scopes" ("tenant_id", "workspace_id", "principal_id", "created_at", "session_id");


--> statement-breakpoint


CREATE UNIQUE INDEX "dictation_usage_scopes_usage_key_uq" ON "dictation_usage_scopes" ("usage_key");


--> statement-breakpoint


CREATE INDEX "dictation_usage_scopes_scope_list_idx" ON "dictation_usage_scopes" ("tenant_id", "workspace_id", "principal_id", "created_at", "id");


--> statement-breakpoint


CREATE INDEX "push_device_scopes_scope_list_idx" ON "push_device_scopes" ("tenant_id", "workspace_id", "principal_id", "created_at", "device_id");


--> statement-breakpoint


ALTER TABLE "openmuse_delivery_binding_scopes" ADD CONSTRAINT "openmuse_delivery_binding_scopes_binding_fk" FOREIGN KEY ("binding_id") REFERENCES "delivery_bindings"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "openmuse_delivery_binding_scopes" ADD CONSTRAINT "openmuse_delivery_binding_scopes_workspace_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "openmuse_delivery_binding_scopes" ADD CONSTRAINT "openmuse_delivery_binding_scopes_membership_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "openmuse_delivery_binding_scopes" ADD CONSTRAINT "openmuse_delivery_binding_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "openmuse_notification_scopes" ADD CONSTRAINT "openmuse_notification_scopes_notification_fk" FOREIGN KEY ("notification_id") REFERENCES "openmuse_notifications"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "openmuse_notification_scopes" ADD CONSTRAINT "openmuse_notification_scopes_workspace_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "openmuse_notification_scopes" ADD CONSTRAINT "openmuse_notification_scopes_membership_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "openmuse_notification_scopes" ADD CONSTRAINT "openmuse_notification_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "openmuse_file_scopes" ADD CONSTRAINT "openmuse_file_scopes_file_fk" FOREIGN KEY ("file_id") REFERENCES "openmuse_files"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "openmuse_file_scopes" ADD CONSTRAINT "openmuse_file_scopes_workspace_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "openmuse_file_scopes" ADD CONSTRAINT "openmuse_file_scopes_membership_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "openmuse_file_scopes" ADD CONSTRAINT "openmuse_file_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "openmuse_document_actions" ADD CONSTRAINT "openmuse_document_actions_file_fk" FOREIGN KEY ("file_id") REFERENCES "openmuse_files"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "openmuse_document_actions" ADD CONSTRAINT "openmuse_document_actions_workspace_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "openmuse_document_actions" ADD CONSTRAINT "openmuse_document_actions_membership_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "openmuse_document_actions" ADD CONSTRAINT "openmuse_document_actions_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "openmuse_reviewed_action_scopes" ADD CONSTRAINT "openmuse_reviewed_action_scopes_action_fk" FOREIGN KEY ("action_id") REFERENCES "openmuse_reviewed_actions"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "openmuse_reviewed_action_scopes" ADD CONSTRAINT "openmuse_reviewed_action_scopes_workspace_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "openmuse_reviewed_action_scopes" ADD CONSTRAINT "openmuse_reviewed_action_scopes_membership_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "openmuse_reviewed_action_scopes" ADD CONSTRAINT "openmuse_reviewed_action_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "openmuse_personal_scopes" ADD CONSTRAINT "openmuse_personal_scopes_workspace_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "openmuse_personal_scopes" ADD CONSTRAINT "openmuse_personal_scopes_membership_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "openmuse_personal_scopes" ADD CONSTRAINT "openmuse_personal_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "voice_session_scopes" ADD CONSTRAINT "voice_session_scopes_session_fk" FOREIGN KEY ("session_id") REFERENCES "voice_sessions"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "voice_session_scopes" ADD CONSTRAINT "voice_session_scopes_workspace_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "voice_session_scopes" ADD CONSTRAINT "voice_session_scopes_membership_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "voice_session_scopes" ADD CONSTRAINT "voice_session_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "dictation_usage_scopes" ADD CONSTRAINT "dictation_usage_scopes_workspace_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "dictation_usage_scopes" ADD CONSTRAINT "dictation_usage_scopes_membership_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "dictation_usage_scopes" ADD CONSTRAINT "dictation_usage_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "push_device_scopes" ADD CONSTRAINT "push_device_scopes_device_fk" FOREIGN KEY ("device_id") REFERENCES "push_devices"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "push_device_scopes" ADD CONSTRAINT "push_device_scopes_workspace_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "push_device_scopes" ADD CONSTRAINT "push_device_scopes_membership_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "push_device_scopes" ADD CONSTRAINT "push_device_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

--> statement-breakpoint
