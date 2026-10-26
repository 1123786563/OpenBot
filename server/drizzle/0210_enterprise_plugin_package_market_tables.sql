-- issue-358 closeout (F1): restore the migration chain — tables declared in schema after 0163
-- by the wave merges (fd62295a14, a789f6a438, 0453ed6b9c, f45a87104f) but never generated:
-- 32 tables / 294 columns absent from every fresh deployment (db-drift-check FAIL, 294 problems).
--
-- #652 (2026-10-26): the four tables whose drizzle config declares a NAMED primary key
-- (enterprise_package_grant_pk / enterprise_package_link_pk / enterprise_package_expert_pk /
-- enterprise_run_package_pin_pk in server/src/db/schema/enterprise-plugin-packages.ts) originally
-- shipped with anonymous PRIMARY KEY clauses, landing as <table>_pkey and forking the constraint
-- names from the mirror with no anchor for name-based ALTER/DROP. Rewritten in place within the
-- no-external-deployments window (entered main 2026-10-25).
--
-- OCRfix-1 (OCR-5/OCR-6, 2026-10-26): that window is closed — origin/main already carried this
-- revision — so the in-place rewrite alone would be a silent fork. Every table below now names its
-- primary key after the authoritative DDL (scripts/multitenancy/migrate-test.ts PKG02/PKG03/PKG04,
-- the same names the drizzle mirror generates):
--   enterprise_package_plans_tenant_id_id_pk / enterprise_package_revisions_tenant_id_install_id_revision_pk
--   enterprise_package_installs_tenant_id_id_pk / enterprise_package_changes_tenant_id_change_id_pk
--   enterprise_package_grant_pk / enterprise_package_expert_pk / enterprise_package_link_pk
--   enterprise_run_package_pin_pk
-- Fresh databases get these names from here. A database that applied the earlier revision keeps
-- <table>_pkey — the journal watermark skips this file and never checks a hash — and is repaired by
-- the conditional renames in 0216_enterprise_package_primary_key_names.sql. Do not rely on this
-- file alone to converge an existing database.
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

CREATE TABLE "enterprise_package_plans" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "actor_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "operation" text NOT NULL,
  "package_key" text NOT NULL,
  "version" text NOT NULL,
  "artifact_digest" text NOT NULL,
  "expected_revision" integer,
  "canonical_input" jsonb NOT NULL,
  "input_digest" text NOT NULL,
  "preview" jsonb NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "result" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "enterprise_package_plans_tenant_id_id_pk" PRIMARY KEY ("tenant_id", "id")
);


--> statement-breakpoint


CREATE TABLE "enterprise_package_revisions" (
  "tenant_id" text NOT NULL,
  "install_id" text NOT NULL,
  "revision" integer NOT NULL,
  "release_version" text NOT NULL,
  "artifact_digest" text NOT NULL,
  "config" jsonb NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "enterprise_package_revisions_tenant_id_install_id_revision_pk" PRIMARY KEY ("tenant_id", "install_id", "revision")
);


--> statement-breakpoint


CREATE TABLE "enterprise_package_installs" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "package_key" text NOT NULL,
  "current_version" text NOT NULL,
  "status" text NOT NULL DEFAULT 'enabled',
  "generation" integer NOT NULL DEFAULT 1,
  "revision" integer NOT NULL DEFAULT 1,
  "installed_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "enterprise_package_installs_tenant_id_id_pk" PRIMARY KEY ("tenant_id", "id")
);


--> statement-breakpoint


CREATE TABLE "enterprise_package_grants" (
  "tenant_id" text NOT NULL,
  "install_id" text NOT NULL,
  "generation" integer NOT NULL,
  "bot_id" text NOT NULL,
  "resource_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "resource_kind" text NOT NULL DEFAULT 'skill',
  "tool_ref" text NOT NULL DEFAULT '',
  "granted_by" text NOT NULL,
  "granted_at" timestamp with time zone NOT NULL DEFAULT now(),
  "revoked_at" timestamp with time zone,
  CONSTRAINT "enterprise_package_grant_pk" PRIMARY KEY ("tenant_id", "install_id", "generation", "bot_id", "resource_id", "tool_ref")
);


--> statement-breakpoint


CREATE TABLE "enterprise_package_experts" (
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "install_id" text NOT NULL,
  "revision" integer NOT NULL,
  "resource_id" text NOT NULL,
  "expert_template_ref" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "enterprise_package_expert_pk" PRIMARY KEY ("tenant_id", "agent_id")
);


--> statement-breakpoint


CREATE TABLE "enterprise_package_resource_links" (
  "tenant_id" text NOT NULL,
  "install_id" text NOT NULL,
  "revision" integer NOT NULL,
  "resource_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "kind" text NOT NULL,
  "existing_skill_id" text,
  "connector_install_id" text,
  "expert_template_ref" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "enterprise_package_link_pk" PRIMARY KEY ("tenant_id", "install_id", "revision", "resource_id")
);


--> statement-breakpoint


CREATE TABLE "enterprise_package_changes" (
  "tenant_id" text NOT NULL,
  "change_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "install_id" text NOT NULL,
  "revision" integer NOT NULL,
  "actor_id" text NOT NULL,
  "action" text NOT NULL,
  "diff" jsonb NOT NULL,
  "idempotency_key" text NOT NULL DEFAULT '',
  "request_digest" text NOT NULL,
  "result_json" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "enterprise_package_changes_tenant_id_change_id_pk" PRIMARY KEY ("tenant_id", "change_id")
);


--> statement-breakpoint


CREATE TABLE "enterprise_run_package_pins" (
  "tenant_id" text NOT NULL,
  "run_id" uuid NOT NULL,
  "attempt_generation" integer NOT NULL,
  "install_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "revision" integer NOT NULL,
  "release_digest" text NOT NULL,
  "grant_revision" integer NOT NULL,
  "allowed_resource_ids" jsonb NOT NULL,
  "pinned_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "enterprise_run_package_pin_pk" PRIMARY KEY ("tenant_id", "run_id", "attempt_generation", "install_id")
);


--> statement-breakpoint


CREATE INDEX "enterprise_package_plan_expiry_idx" ON "enterprise_package_plans" ("tenant_id", "expires_at");


--> statement-breakpoint


CREATE UNIQUE INDEX "enterprise_package_install_scope_key_uq" ON "enterprise_package_installs" ("tenant_id", "workspace_id", "package_key");


--> statement-breakpoint


CREATE UNIQUE INDEX "enterprise_package_install_scope_id_uq" ON "enterprise_package_installs" ("tenant_id", "workspace_id", "id");


--> statement-breakpoint


-- Authority PKG02 (`scripts/multitenancy/migrate-test.ts`): the (tenant, workspace, id) unique
-- index on the MT031 plugin-install table that `enterprise_package_link_connector_fk` below
-- targets. 0163 restored the table without this index, so the declared FK was unenforceable
-- (postgres 42830). CREATE INDEX on an existing table is within the expand-only allowlist.
CREATE UNIQUE INDEX "enterprise_plugin_install_scope_id_uq" ON "enterprise_plugin_installs" ("tenant_id", "workspace_id", "id");


--> statement-breakpoint


CREATE UNIQUE INDEX "enterprise_package_grant_active_uq" ON "enterprise_package_grants" ("tenant_id", "install_id", "bot_id", "resource_id", "tool_ref") WHERE "enterprise_package_grants"."revoked_at" is null;


--> statement-breakpoint


CREATE UNIQUE INDEX "enterprise_package_change_idempotency_uq" ON "enterprise_package_changes" ("tenant_id", "workspace_id", "actor_id", "idempotency_key") WHERE "enterprise_package_changes"."idempotency_key" <> '';


--> statement-breakpoint


CREATE INDEX "enterprise_package_change_install_idx" ON "enterprise_package_changes" ("tenant_id", "install_id", "revision");


--> statement-breakpoint


ALTER TABLE "enterprise_package_plans" ADD CONSTRAINT "enterprise_package_plans_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_package_plans" ADD CONSTRAINT "enterprise_package_plans_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_package_plans" ADD CONSTRAINT "enterprise_package_plans_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_package_revisions" ADD CONSTRAINT "enterprise_package_revisions_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_package_revisions" ADD CONSTRAINT "enterprise_package_revisions_tenant_id_install_id_enterprise_package_installs_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "install_id") REFERENCES "enterprise_package_installs"("tenant_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_package_revisions" ADD CONSTRAINT "enterprise_package_revisions_tenant_id_created_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "created_by") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_package_installs" ADD CONSTRAINT "enterprise_package_installs_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_package_installs" ADD CONSTRAINT "enterprise_package_installs_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_package_installs" ADD CONSTRAINT "enterprise_package_installs_tenant_id_installed_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "installed_by") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_package_grants" ADD CONSTRAINT "enterprise_package_grant_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_package_grants" ADD CONSTRAINT "enterprise_package_grant_workspace_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_package_grants" ADD CONSTRAINT "enterprise_package_grant_install_fk" FOREIGN KEY ("tenant_id", "workspace_id", "install_id") REFERENCES "enterprise_package_installs"("tenant_id", "workspace_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_package_grants" ADD CONSTRAINT "enterprise_package_grant_bot_fk" FOREIGN KEY ("tenant_id", "bot_id") REFERENCES "enterprise_bot_ownership"("tenant_id", "agent_id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_package_grants" ADD CONSTRAINT "enterprise_package_grant_granted_by_fk" FOREIGN KEY ("tenant_id", "granted_by") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_package_experts" ADD CONSTRAINT "enterprise_package_expert_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_package_experts" ADD CONSTRAINT "enterprise_package_expert_workspace_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_package_experts" ADD CONSTRAINT "enterprise_package_expert_install_fk" FOREIGN KEY ("tenant_id", "workspace_id", "install_id") REFERENCES "enterprise_package_installs"("tenant_id", "workspace_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_package_experts" ADD CONSTRAINT "enterprise_package_expert_bot_fk" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "enterprise_bot_ownership"("tenant_id", "agent_id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_package_experts" ADD CONSTRAINT "enterprise_package_expert_created_by_fk" FOREIGN KEY ("tenant_id", "created_by") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_package_resource_links" ADD CONSTRAINT "enterprise_package_link_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_package_resource_links" ADD CONSTRAINT "enterprise_package_link_workspace_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_package_resource_links" ADD CONSTRAINT "enterprise_package_link_revision_fk" FOREIGN KEY ("tenant_id", "install_id", "revision") REFERENCES "enterprise_package_revisions"("tenant_id", "install_id", "revision") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_package_resource_links" ADD CONSTRAINT "enterprise_package_link_connector_fk" FOREIGN KEY ("tenant_id", "workspace_id", "connector_install_id") REFERENCES "enterprise_plugin_installs"("tenant_id", "workspace_id", "id") ON DELETE RESTRICT;


--> statement-breakpoint


ALTER TABLE "enterprise_package_changes" ADD CONSTRAINT "enterprise_package_changes_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_package_changes" ADD CONSTRAINT "enterprise_package_changes_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_package_changes" ADD CONSTRAINT "enterprise_package_changes_tenant_id_install_id_revision_enterprise_package_revisions_tenant_id_install_id_revision_fk" FOREIGN KEY ("tenant_id", "install_id", "revision") REFERENCES "enterprise_package_revisions"("tenant_id", "install_id", "revision") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_run_package_pins" ADD CONSTRAINT "enterprise_run_package_pin_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_run_package_pins" ADD CONSTRAINT "enterprise_run_package_pin_workspace_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_run_package_pins" ADD CONSTRAINT "enterprise_run_package_pin_run_fk" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "enterprise_runs"("tenant_id", "id") ON DELETE CASCADE;


--> statement-breakpoint


ALTER TABLE "enterprise_run_package_pins" ADD CONSTRAINT "enterprise_run_package_pin_install_fk" FOREIGN KEY ("tenant_id", "workspace_id", "install_id") REFERENCES "enterprise_package_installs"("tenant_id", "workspace_id", "id") ON DELETE CASCADE;

--> statement-breakpoint
