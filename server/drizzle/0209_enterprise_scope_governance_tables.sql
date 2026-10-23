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

CREATE TABLE "enterprise_purge_audit" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "manifest_id" text NOT NULL,
  "event" text NOT NULL,
  "actor_principal_id" text NOT NULL,
  "detail" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "id")
);


--> statement-breakpoint


CREATE TABLE "enterprise_purge_manifests" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "operation" text NOT NULL,
  "workspace_id" text,
  "principal_id" text NOT NULL,
  "item_refs" jsonb NOT NULL,
  "signature" text NOT NULL,
  "status" text NOT NULL DEFAULT 'sealed',
  "idempotency_key" text NOT NULL,
  "executed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "id")
);


--> statement-breakpoint


CREATE TABLE "enterprise_craft_schedule_scopes" (
  "kind" text NOT NULL,
  "object_id" text NOT NULL,
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "user_id" text NOT NULL,
  "parent_object_id" text,
  "credential_ref" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("kind", "object_id")
);


--> statement-breakpoint


CREATE TABLE "enterprise_craft_scopes" (
  "session_id" text NOT NULL PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "user_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);


--> statement-breakpoint


CREATE TABLE "enterprise_artifact_scopes" (
  "artifact_id" text NOT NULL PRIMARY KEY,
  "session_id" text NOT NULL,
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "user_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);


--> statement-breakpoint


CREATE TABLE "enterprise_workshop_scopes" (
  "session_id" text NOT NULL PRIMARY KEY,
  "channel_id" text NOT NULL,
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "user_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);


--> statement-breakpoint


CREATE TABLE "enterprise_workshop_sandbox_bindings" (
  "instance_id" text NOT NULL PRIMARY KEY,
  "session_id" text NOT NULL,
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "user_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'bound',
  "bound_at" timestamp with time zone NOT NULL DEFAULT now(),
  "recycled_at" timestamp with time zone,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);


--> statement-breakpoint


CREATE TABLE "enterprise_workshop_share_grants" (
  "id" text NOT NULL PRIMARY KEY,
  "session_id" text NOT NULL,
  "token_hash" text NOT NULL,
  "tenant_id" text NOT NULL,
  "owner_workspace_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "audience" text NOT NULL,
  "audience_workspace_id" text,
  "share_action" text NOT NULL,
  "expires_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_by" text,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);


--> statement-breakpoint


CREATE TABLE "enterprise_host_access_grants" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "display_name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "id")
);


--> statement-breakpoint


CREATE TABLE "enterprise_host_action_approvals" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "grant_id" text NOT NULL,
  "operation_kind" text NOT NULL,
  "params_digest" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "decided_by" text,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "id")
);


--> statement-breakpoint


CREATE TABLE "enterprise_audit_events" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "domain" text NOT NULL,
  "event_type" text NOT NULL,
  "actor_id" text NOT NULL,
  "target_id" text,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "id")
);


--> statement-breakpoint


CREATE TABLE "billing_company_manage_grants" (
  "tenant_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "granted_by" text NOT NULL,
  "actions" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "principal_id")
);


--> statement-breakpoint


CREATE TABLE "enterprise_learning_containers" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "namespace" text NOT NULL,
  "allocated_by_principal_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'allocated',
  "released_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "id")
);


--> statement-breakpoint


CREATE TABLE "enterprise_learning_records" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "container_id" text NOT NULL,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "payload" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "id")
);


--> statement-breakpoint


CREATE TABLE "enterprise_personal_memories" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "memory_key" text NOT NULL,
  "content" text NOT NULL,
  "source_kind" text NOT NULL DEFAULT 'manual',
  "source_ref" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "id")
);


--> statement-breakpoint


CREATE INDEX "enterprise_purge_audit_manifest_idx" ON "enterprise_purge_audit" ("tenant_id", "manifest_id");


--> statement-breakpoint


CREATE UNIQUE INDEX "enterprise_purge_manifest_idempotency_idx" ON "enterprise_purge_manifests" ("tenant_id", "idempotency_key");


--> statement-breakpoint


CREATE INDEX "enterprise_purge_manifest_scope_idx" ON "enterprise_purge_manifests" ("tenant_id", "workspace_id", "operation");


--> statement-breakpoint


CREATE INDEX "enterprise_craft_schedule_scopes_scope_list_idx" ON "enterprise_craft_schedule_scopes" ("tenant_id", "workspace_id", "principal_id", "created_at", "object_id");


--> statement-breakpoint


CREATE INDEX "enterprise_craft_schedule_scopes_parent_idx" ON "enterprise_craft_schedule_scopes" ("tenant_id", "workspace_id", "parent_object_id");


--> statement-breakpoint


CREATE INDEX "enterprise_craft_scopes_scope_list_idx" ON "enterprise_craft_scopes" ("tenant_id", "workspace_id", "principal_id", "created_at", "session_id");


--> statement-breakpoint


CREATE INDEX "enterprise_artifact_scopes_scope_list_idx" ON "enterprise_artifact_scopes" ("tenant_id", "workspace_id", "principal_id", "created_at", "artifact_id");


--> statement-breakpoint


CREATE INDEX "enterprise_artifact_scopes_session_idx" ON "enterprise_artifact_scopes" ("session_id");


--> statement-breakpoint


CREATE INDEX "enterprise_workshop_scopes_scope_list_idx" ON "enterprise_workshop_scopes" ("tenant_id", "workspace_id", "principal_id", "created_at", "session_id");


--> statement-breakpoint


CREATE INDEX "enterprise_workshop_scopes_channel_idx" ON "enterprise_workshop_scopes" ("channel_id");


--> statement-breakpoint


CREATE INDEX "enterprise_workshop_sandbox_bindings_scope_idx" ON "enterprise_workshop_sandbox_bindings" ("tenant_id", "workspace_id", "principal_id");


--> statement-breakpoint


CREATE INDEX "enterprise_workshop_sandbox_bindings_session_idx" ON "enterprise_workshop_sandbox_bindings" ("session_id");


--> statement-breakpoint


CREATE UNIQUE INDEX "enterprise_workshop_share_grants_live_session_idx" ON "enterprise_workshop_share_grants" ("session_id") WHERE "enterprise_workshop_share_grants"."revoked_at" IS NULL;


--> statement-breakpoint


CREATE UNIQUE INDEX "enterprise_workshop_share_grants_token_idx" ON "enterprise_workshop_share_grants" ("token_hash");


--> statement-breakpoint


CREATE INDEX "enterprise_workshop_share_grants_session_idx" ON "enterprise_workshop_share_grants" ("session_id");


--> statement-breakpoint


CREATE INDEX "enterprise_host_access_grant_subject_idx" ON "enterprise_host_access_grants" ("tenant_id", "principal_id", "status");


--> statement-breakpoint


CREATE INDEX "enterprise_host_action_approval_object_idx" ON "enterprise_host_action_approvals" ("tenant_id", "workspace_id", "principal_id", "agent_id", "operation_kind", "params_digest");


--> statement-breakpoint


CREATE INDEX "enterprise_audit_event_tenant_domain_time" ON "enterprise_audit_events" ("tenant_id", "domain", "created_at");


--> statement-breakpoint


CREATE INDEX "enterprise_learning_container_scope_idx" ON "enterprise_learning_containers" ("tenant_id", "workspace_id", "status");


--> statement-breakpoint


CREATE INDEX "enterprise_learning_record_scope_idx" ON "enterprise_learning_records" ("tenant_id", "workspace_id", "kind");


--> statement-breakpoint


CREATE INDEX "enterprise_personal_memory_subject_idx" ON "enterprise_personal_memories" ("tenant_id", "workspace_id", "principal_id", "memory_key");


--> statement-breakpoint


ALTER TABLE "enterprise_purge_audit" ADD CONSTRAINT "enterprise_purge_audit_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id");


--> statement-breakpoint


ALTER TABLE "enterprise_purge_audit" ADD CONSTRAINT "enterprise_purge_audit_tenant_id_manifest_id_enterprise_purge_manifests_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "manifest_id") REFERENCES "enterprise_purge_manifests"("tenant_id", "id");


--> statement-breakpoint


ALTER TABLE "enterprise_purge_audit" ADD CONSTRAINT "enterprise_purge_audit_tenant_id_actor_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "actor_principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id");


--> statement-breakpoint


ALTER TABLE "enterprise_purge_manifests" ADD CONSTRAINT "enterprise_purge_manifests_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id");


--> statement-breakpoint


ALTER TABLE "enterprise_purge_manifests" ADD CONSTRAINT "enterprise_purge_manifests_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id");


--> statement-breakpoint


ALTER TABLE "enterprise_purge_manifests" ADD CONSTRAINT "enterprise_purge_manifests_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id");


--> statement-breakpoint


ALTER TABLE "enterprise_craft_schedule_scopes" ADD CONSTRAINT "enterprise_craft_schedule_scopes_workspace_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_craft_schedule_scopes" ADD CONSTRAINT "enterprise_craft_schedule_scopes_membership_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_craft_schedule_scopes" ADD CONSTRAINT "enterprise_craft_schedule_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_craft_scopes" ADD CONSTRAINT "enterprise_craft_scopes_session_fk" FOREIGN KEY ("session_id") REFERENCES "craft_sessions"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_craft_scopes" ADD CONSTRAINT "enterprise_craft_scopes_workspace_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_craft_scopes" ADD CONSTRAINT "enterprise_craft_scopes_membership_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_craft_scopes" ADD CONSTRAINT "enterprise_craft_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_artifact_scopes" ADD CONSTRAINT "enterprise_artifact_scopes_artifact_fk" FOREIGN KEY ("artifact_id") REFERENCES "workshop_artifacts"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_artifact_scopes" ADD CONSTRAINT "enterprise_artifact_scopes_workspace_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_artifact_scopes" ADD CONSTRAINT "enterprise_artifact_scopes_membership_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_artifact_scopes" ADD CONSTRAINT "enterprise_artifact_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_workshop_scopes" ADD CONSTRAINT "enterprise_workshop_scopes_session_fk" FOREIGN KEY ("session_id") REFERENCES "workshop_sessions"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_workshop_scopes" ADD CONSTRAINT "enterprise_workshop_scopes_workspace_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_workshop_scopes" ADD CONSTRAINT "enterprise_workshop_scopes_membership_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_workshop_scopes" ADD CONSTRAINT "enterprise_workshop_scopes_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_workshop_sandbox_bindings" ADD CONSTRAINT "enterprise_workshop_sandbox_bindings_instance_fk" FOREIGN KEY ("instance_id") REFERENCES "sandbox_instances"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_workshop_sandbox_bindings" ADD CONSTRAINT "enterprise_workshop_sandbox_bindings_session_fk" FOREIGN KEY ("session_id") REFERENCES "workshop_sessions"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_workshop_sandbox_bindings" ADD CONSTRAINT "enterprise_workshop_sandbox_bindings_workspace_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_workshop_sandbox_bindings" ADD CONSTRAINT "enterprise_workshop_sandbox_bindings_membership_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_workshop_sandbox_bindings" ADD CONSTRAINT "enterprise_workshop_sandbox_bindings_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_workshop_share_grants" ADD CONSTRAINT "enterprise_workshop_share_grants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_workshop_share_grants" ADD CONSTRAINT "enterprise_workshop_share_grants_session_fk" FOREIGN KEY ("session_id") REFERENCES "workshop_sessions"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_workshop_share_grants" ADD CONSTRAINT "enterprise_workshop_share_grants_owner_workspace_fk" FOREIGN KEY ("tenant_id", "owner_workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_workshop_share_grants" ADD CONSTRAINT "enterprise_workshop_share_grants_audience_workspace_fk" FOREIGN KEY ("tenant_id", "audience_workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_workshop_share_grants" ADD CONSTRAINT "enterprise_workshop_share_grants_membership_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_host_access_grants" ADD CONSTRAINT "enterprise_host_access_grants_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id");


--> statement-breakpoint


ALTER TABLE "enterprise_host_access_grants" ADD CONSTRAINT "enterprise_host_access_grants_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id");


--> statement-breakpoint


ALTER TABLE "enterprise_host_access_grants" ADD CONSTRAINT "enterprise_host_access_grants_tenant_id_agent_id_enterprise_bot_ownership_tenant_id_agent_id_fk" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "enterprise_bot_ownership"("tenant_id", "agent_id");


--> statement-breakpoint


ALTER TABLE "enterprise_host_access_grants" ADD CONSTRAINT "enterprise_host_access_grants_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id");


--> statement-breakpoint


ALTER TABLE "enterprise_host_action_approvals" ADD CONSTRAINT "enterprise_host_action_approvals_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id");


--> statement-breakpoint


ALTER TABLE "enterprise_host_action_approvals" ADD CONSTRAINT "enterprise_host_action_approvals_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id");


--> statement-breakpoint


ALTER TABLE "enterprise_host_action_approvals" ADD CONSTRAINT "enterprise_host_action_approvals_tenant_id_agent_id_enterprise_bot_ownership_tenant_id_agent_id_fk" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "enterprise_bot_ownership"("tenant_id", "agent_id");


--> statement-breakpoint


ALTER TABLE "enterprise_host_action_approvals" ADD CONSTRAINT "enterprise_host_action_approvals_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id");


--> statement-breakpoint


ALTER TABLE "enterprise_host_action_approvals" ADD CONSTRAINT "enterprise_host_action_approvals_tenant_id_grant_id_enterprise_host_access_grants_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "grant_id") REFERENCES "enterprise_host_access_grants"("tenant_id", "id");


--> statement-breakpoint


ALTER TABLE "enterprise_audit_events" ADD CONSTRAINT "enterprise_audit_events_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "billing_company_manage_grants" ADD CONSTRAINT "billing_company_manage_grants_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "billing_company_manage_grants" ADD CONSTRAINT "billing_company_manage_grants_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "billing_company_manage_grants" ADD CONSTRAINT "billing_company_manage_grants_tenant_id_granted_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "granted_by") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_learning_containers" ADD CONSTRAINT "enterprise_learning_containers_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id");


--> statement-breakpoint


ALTER TABLE "enterprise_learning_containers" ADD CONSTRAINT "enterprise_learning_containers_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id");


--> statement-breakpoint


ALTER TABLE "enterprise_learning_containers" ADD CONSTRAINT "enterprise_learning_containers_tenant_id_allocated_by_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "allocated_by_principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id");


--> statement-breakpoint


ALTER TABLE "enterprise_learning_records" ADD CONSTRAINT "enterprise_learning_records_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id");


--> statement-breakpoint


ALTER TABLE "enterprise_learning_records" ADD CONSTRAINT "enterprise_learning_records_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id");


--> statement-breakpoint


ALTER TABLE "enterprise_learning_records" ADD CONSTRAINT "enterprise_learning_records_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id");


--> statement-breakpoint


ALTER TABLE "enterprise_learning_records" ADD CONSTRAINT "enterprise_learning_records_tenant_id_container_id_enterprise_learning_containers_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "container_id") REFERENCES "enterprise_learning_containers"("tenant_id", "id");


--> statement-breakpoint


ALTER TABLE "enterprise_personal_memories" ADD CONSTRAINT "enterprise_personal_memories_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id");


--> statement-breakpoint


ALTER TABLE "enterprise_personal_memories" ADD CONSTRAINT "enterprise_personal_memories_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id");


--> statement-breakpoint


ALTER TABLE "enterprise_personal_memories" ADD CONSTRAINT "enterprise_personal_memories_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id");

--> statement-breakpoint

--> statement-breakpoint
