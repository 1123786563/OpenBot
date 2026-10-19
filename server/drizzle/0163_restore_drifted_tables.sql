-- #436: restore the migration chain — tables declared in schema but never generated.
--
-- A drizzle.config schema-list gap (17 files missing) plus migrations that were hand-written or
-- renumbered left 38 tables / 292 columns declared in server/src/db/schema but absent from
-- server/drizzle — every fresh deployment lacked them, and only the seed path crashed loudly
-- (#436's skills.icon 42703; 0162 restored that column). This migration creates the remaining
-- 37 tables and the one missing column, expand-only: no existing table or column is touched.
-- Policies/checks tied to these tables are operator territory (roles.sql / ops), not migration SQL.
ALTER TABLE "enterprise_resources" ADD COLUMN "visibility" text;
--> statement-breakpoint

CREATE TABLE "billing_vendor_interactions" (
  "id" text NOT NULL PRIMARY KEY,
  "direction" text NOT NULL,
  "tenant_id" text,
  "principal_id" text,
  "external_customer_id" text,
  "operation" text NOT NULL,
  "outcome" text NOT NULL,
  "denial_code" text,
  "detail" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX "billing_vendor_interactions_tenant_time_idx" ON "billing_vendor_interactions" ("tenant_id", "created_at");

--> statement-breakpoint

CREATE INDEX "billing_vendor_interactions_customer_time_idx" ON "billing_vendor_interactions" ("external_customer_id", "created_at");

--> statement-breakpoint

CREATE TABLE "enterprise_plugin_catalog" (
  "id" text NOT NULL PRIMARY KEY,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "vendor" text NOT NULL,
  "source" text NOT NULL,
  "metadata" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE TABLE "enterprise_plugin_connections" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "install_id" text NOT NULL,
  "bound_by" text NOT NULL,
  "vendor_ref" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "id")
);

--> statement-breakpoint

CREATE INDEX "enterprise_plugin_connection_install_idx" ON "enterprise_plugin_connections" ("tenant_id", "install_id");

--> statement-breakpoint

CREATE TABLE "enterprise_plugin_installs" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "catalog_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "installed_by" text NOT NULL,
  "config" jsonb NOT NULL,
  "envelope" text,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "id")
);

--> statement-breakpoint

CREATE INDEX "enterprise_plugin_install_tenant_created_idx" ON "enterprise_plugin_installs" ("tenant_id", "created_at", "id");

--> statement-breakpoint

CREATE INDEX "enterprise_plugin_install_catalog_idx" ON "enterprise_plugin_installs" ("catalog_id");

--> statement-breakpoint

CREATE TABLE "enterprise_oauth_states" (
  "id" text NOT NULL PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "purpose" text NOT NULL,
  "target" text NOT NULL,
  "verifier" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  "failed_reason" text
);

--> statement-breakpoint

CREATE INDEX "enterprise_oauth_state_tenant_created_idx" ON "enterprise_oauth_states" ("tenant_id", "created_at", "id");

--> statement-breakpoint

CREATE TABLE "enterprise_credential_lease_audit" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "lease_id" text NOT NULL,
  "credential_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "action" text NOT NULL,
  "detail" jsonb NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "id")
);

--> statement-breakpoint

CREATE INDEX "enterprise_credential_lease_audit_tenant_time_idx" ON "enterprise_credential_lease_audit" ("tenant_id", "occurred_at");

--> statement-breakpoint

CREATE TABLE "enterprise_credential_leases" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "credential_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "purpose" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  PRIMARY KEY ("tenant_id", "id")
);

--> statement-breakpoint

CREATE INDEX "enterprise_credential_lease_tenant_created_idx" ON "enterprise_credential_leases" ("tenant_id", "created_at", "id");

--> statement-breakpoint

CREATE INDEX "enterprise_credential_lease_credential_idx" ON "enterprise_credential_leases" ("tenant_id", "credential_id");

--> statement-breakpoint

CREATE TABLE "enterprise_identity_binding_intents" (
  "id" text NOT NULL PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "user_id" text NOT NULL,
  "kind" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone
);

--> statement-breakpoint

CREATE TABLE "enterprise_scim_directory_bindings" (
  "id" text NOT NULL PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "connection_key" text NOT NULL,
  "credential_ref" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "last_deprovision_principal_id" text,
  "last_deprovision_epoch" integer,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "deactivated_at" timestamp with time zone
);

--> statement-breakpoint

CREATE UNIQUE INDEX "enterprise_scim_binding_connection_key" ON "enterprise_scim_directory_bindings" ("connection_key");

--> statement-breakpoint

CREATE TABLE "enterprise_sso_configs" (
  "tenant_id" text NOT NULL PRIMARY KEY,
  "document" jsonb NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE TABLE "job_config_snapshots" (
  "id" text NOT NULL PRIMARY KEY,
  "kind" text NOT NULL,
  "object_id" text NOT NULL,
  "purpose" text NOT NULL,
  "company_revision" integer NOT NULL,
  "override_revision" integer,
  "basis_digest" text NOT NULL,
  "captured_at" timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE UNIQUE INDEX "job_config_snapshots_creation_unique" ON "job_config_snapshots" ("kind", "object_id");

--> statement-breakpoint

CREATE INDEX "job_config_snapshots_history_idx" ON "job_config_snapshots" ("kind", "object_id", "captured_at");

--> statement-breakpoint

CREATE TABLE "job_leases" (
  "kind" text NOT NULL,
  "object_id" text NOT NULL,
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "claimed_by_kind" text,
  "claimed_by" text,
  "lease_until" timestamp with time zone,
  "attempts" integer NOT NULL DEFAULT 0,
  "finished_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("kind", "object_id")
);

--> statement-breakpoint

CREATE TABLE "job_ownership" (
  "kind" text NOT NULL,
  "object_id" text NOT NULL,
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("kind", "object_id")
);

--> statement-breakpoint

CREATE INDEX "job_ownership_scope_created_idx" ON "job_ownership" ("tenant_id", "workspace_id", "principal_id", "created_at");

--> statement-breakpoint

CREATE TABLE "enterprise_personal_bot_field_ownership" (
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "field_name" text NOT NULL,
  "managed_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "workspace_id", "principal_id", "field_name")
);

--> statement-breakpoint

CREATE TABLE "enterprise_personal_bots" (
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "display_name" text NOT NULL,
  "template_ref" text,
  "template_source_revision" integer,
  "document" jsonb NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "workspace_id", "principal_id")
);

--> statement-breakpoint

CREATE UNIQUE INDEX "enterprise_personal_bots_agent_id_global_uq" ON "enterprise_personal_bots" ("agent_id");

--> statement-breakpoint

CREATE TABLE "enterprise_shared_use_approvals" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "install_id" text NOT NULL,
  "request_id" text NOT NULL,
  "params_digest" text NOT NULL,
  "audience" text NOT NULL,
  "outside_input" boolean NOT NULL,
  "members" jsonb NOT NULL,
  "approved_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "id")
);

--> statement-breakpoint

CREATE INDEX "enterprise_shared_use_approval_object_idx" ON "enterprise_shared_use_approvals" ("tenant_id", "agent_id", "install_id", "workspace_id", "params_digest");

--> statement-breakpoint

CREATE TABLE "enterprise_shared_use_requests" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "install_id" text NOT NULL,
  "requested_by" text NOT NULL,
  "proposed_audience" text NOT NULL,
  "proposed_outside_input" boolean NOT NULL,
  "proposed_members" jsonb NOT NULL,
  "proposed_params_digest" text NOT NULL,
  "reason" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "decided_by" text,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "id")
);

--> statement-breakpoint

CREATE INDEX "enterprise_shared_use_request_tenant_created_idx" ON "enterprise_shared_use_requests" ("tenant_id", "created_at", "id");

--> statement-breakpoint

CREATE INDEX "enterprise_shared_use_request_object_idx" ON "enterprise_shared_use_requests" ("tenant_id", "agent_id", "install_id", "workspace_id");

--> statement-breakpoint

CREATE TABLE "billing_call_attributions" (
  "reservation_id" text NOT NULL PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "bot_ref" text NOT NULL,
  "call_key" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE UNIQUE INDEX "billing_call_attributions_tenant_call_key_unique" ON "billing_call_attributions" ("tenant_id", "call_key");

--> statement-breakpoint

CREATE INDEX "billing_call_attributions_tenant_idx" ON "billing_call_attributions" ("tenant_id");

--> statement-breakpoint

CREATE TABLE "openmuse_task_scopes" (
  "task_id" text NOT NULL PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "user_id" text NOT NULL,
  "bot_id" text NOT NULL,
  "attribution" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX "openmuse_task_scopes_scope_list_idx" ON "openmuse_task_scopes" ("tenant_id", "workspace_id", "principal_id", "created_at", "task_id");

--> statement-breakpoint

CREATE TABLE "billing_account_audit" (
  "id" text NOT NULL PRIMARY KEY,
  "action" text NOT NULL,
  "actor" text NOT NULL,
  "tenant_id" text,
  "external_customer_id" text,
  "account_id" text,
  "detail" jsonb,
  "occurred_at" timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX "billing_account_audit_tenant_time_idx" ON "billing_account_audit" ("tenant_id", "occurred_at");

--> statement-breakpoint

CREATE INDEX "billing_account_audit_customer_time_idx" ON "billing_account_audit" ("external_customer_id", "occurred_at");

--> statement-breakpoint

CREATE TABLE "billing_credit_accounts" (
  "id" text NOT NULL PRIMARY KEY,
  "external_customer_id" text NOT NULL,
  "account_type" text,
  "status" text NOT NULL,
  "tenant_id" text,
  "owner_user_id" text,
  "account_key" text,
  "quarantine_reason" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE UNIQUE INDEX "billing_credit_accounts_customer_unique" ON "billing_credit_accounts" ("external_customer_id");

--> statement-breakpoint

CREATE UNIQUE INDEX "billing_credit_accounts_key_unique" ON "billing_credit_accounts" ("account_key");

--> statement-breakpoint

CREATE TABLE "billing_customer_mappings" (
  "tenant_id" text NOT NULL PRIMARY KEY,
  "external_customer_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE UNIQUE INDEX "billing_customer_mappings_customer_unique" ON "billing_customer_mappings" ("external_customer_id");

--> statement-breakpoint

CREATE TABLE "enterprise_resource_shares" (
  "tenant_id" text NOT NULL,
  "resource_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "action" text NOT NULL DEFAULT 'read',
  "expires_at" timestamp with time zone NOT NULL,
  "granted_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "resource_id", "principal_id", "action")
);

--> statement-breakpoint

CREATE TABLE "billing_company_finance_grants" (
  "tenant_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "granted_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "principal_id")
);

--> statement-breakpoint

CREATE INDEX "billing_company_finance_grants_tenant_idx" ON "billing_company_finance_grants" ("tenant_id");

--> statement-breakpoint

CREATE TABLE "enterprise_governance_overrides" (
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "document" jsonb NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "workspace_id")
);

--> statement-breakpoint

CREATE TABLE "enterprise_governance_policies" (
  "tenant_id" text NOT NULL PRIMARY KEY,
  "document" jsonb NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE TABLE "enterprise_template_installs" (
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "template_ref" text NOT NULL,
  "source_revision" integer NOT NULL,
  "document" jsonb NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "workspace_id", "template_ref")
);

--> statement-breakpoint

CREATE TABLE "enterprise_credential_actions" (
  "tenant_id" text NOT NULL,
  "credential_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "action" text NOT NULL,
  "granted_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "credential_id", "principal_id", "action")
);

--> statement-breakpoint

CREATE TABLE "enterprise_credential_audit" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "credential_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "action" text NOT NULL DEFAULT 'plaintext.disclosed',
  "detail" jsonb NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "id")
);

--> statement-breakpoint

CREATE INDEX "enterprise_credential_audit_tenant_time_idx" ON "enterprise_credential_audit" ("tenant_id", "occurred_at");

--> statement-breakpoint

CREATE TABLE "enterprise_credentials" (
  "tenant_id" text NOT NULL,
  "id" text NOT NULL,
  "kind" text NOT NULL,
  "classification" text NOT NULL,
  "workspace_id" text,
  "owner_principal_id" text,
  "target" text NOT NULL,
  "display" jsonb NOT NULL,
  "envelope" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "id")
);

--> statement-breakpoint

CREATE INDEX "enterprise_credential_tenant_created_idx" ON "enterprise_credentials" ("tenant_id", "created_at", "id");

--> statement-breakpoint

CREATE TABLE "enterprise_runtime_config_overrides" (
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "document" jsonb NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "workspace_id")
);

--> statement-breakpoint

CREATE TABLE "enterprise_runtime_configs" (
  "tenant_id" text NOT NULL PRIMARY KEY,
  "document" jsonb NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE TABLE "enterprise_bot_ownership" (
  "tenant_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "owner_principal_id" text NOT NULL,
  "display_name" text NOT NULL,
  "default_config" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "revision" integer NOT NULL DEFAULT 1,
  "acl_epoch" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "agent_id")
);

--> statement-breakpoint

CREATE UNIQUE INDEX "enterprise_bot_ownership_agent_id_global_uq" ON "enterprise_bot_ownership" ("agent_id");

--> statement-breakpoint

CREATE TABLE "enterprise_bot_preferences" (
  "tenant_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "preferences" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "agent_id", "principal_id")
);

--> statement-breakpoint

ALTER TABLE "enterprise_plugin_connections" ADD CONSTRAINT "enterprise_plugin_connections_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_plugin_connections" ADD CONSTRAINT "enterprise_plugin_connections_tenant_id_install_id_enterprise_plugin_installs_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "install_id") REFERENCES "enterprise_plugin_installs"("tenant_id", "id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_plugin_connections" ADD CONSTRAINT "enterprise_plugin_connections_tenant_id_bound_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "bound_by") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_plugin_installs" ADD CONSTRAINT "enterprise_plugin_installs_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_plugin_installs" ADD CONSTRAINT "enterprise_plugin_installs_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_plugin_installs" ADD CONSTRAINT "enterprise_plugin_installs_tenant_id_installed_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "installed_by") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_plugin_installs" ADD CONSTRAINT "enterprise_plugin_installs_catalog_id_enterprise_plugin_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "enterprise_plugin_catalog"("id") ON DELETE NO ACTION;

--> statement-breakpoint

ALTER TABLE "enterprise_oauth_states" ADD CONSTRAINT "enterprise_oauth_states_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_oauth_states" ADD CONSTRAINT "enterprise_oauth_states_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_oauth_states" ADD CONSTRAINT "enterprise_oauth_states_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_credential_lease_audit" ADD CONSTRAINT "enterprise_credential_lease_audit_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_credential_leases" ADD CONSTRAINT "enterprise_credential_leases_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_credential_leases" ADD CONSTRAINT "enterprise_credential_leases_tenant_id_credential_id_enterprise_credentials_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "credential_id") REFERENCES "enterprise_credentials"("tenant_id", "id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_credential_leases" ADD CONSTRAINT "enterprise_credential_leases_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_credential_leases" ADD CONSTRAINT "enterprise_credential_leases_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_identity_binding_intents" ADD CONSTRAINT "enterprise_identity_binding_intents_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_identity_binding_intents" ADD CONSTRAINT "enterprise_identity_binding_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_scim_directory_bindings" ADD CONSTRAINT "enterprise_scim_directory_bindings_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_sso_configs" ADD CONSTRAINT "enterprise_sso_configs_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "job_config_snapshots" ADD CONSTRAINT "job_config_snapshots_kind_object_id_job_ownership_kind_object_id_fk" FOREIGN KEY ("kind", "object_id") REFERENCES "job_ownership"("kind", "object_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "job_leases" ADD CONSTRAINT "job_leases_kind_object_id_job_ownership_kind_object_id_fk" FOREIGN KEY ("kind", "object_id") REFERENCES "job_ownership"("kind", "object_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "job_leases" ADD CONSTRAINT "job_leases_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "job_ownership" ADD CONSTRAINT "job_ownership_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "job_ownership" ADD CONSTRAINT "job_ownership_principal_id_enterprise_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "enterprise_principals"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "job_ownership" ADD CONSTRAINT "job_ownership_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "job_ownership" ADD CONSTRAINT "job_ownership_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_personal_bot_field_ownership" ADD CONSTRAINT "enterprise_personal_bot_field_ownership_tenant_id_workspace_id_principal_id_enterprise_personal_bots_tenant_id_workspace_id_principal_id_fk" FOREIGN KEY ("tenant_id", "workspace_id", "principal_id") REFERENCES "enterprise_personal_bots"("tenant_id", "workspace_id", "principal_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_personal_bot_field_ownership" ADD CONSTRAINT "enterprise_personal_bot_field_ownership_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_personal_bots" ADD CONSTRAINT "enterprise_personal_bots_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_personal_bots" ADD CONSTRAINT "enterprise_personal_bots_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_shared_use_approvals" ADD CONSTRAINT "enterprise_shared_use_approvals_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_shared_use_approvals" ADD CONSTRAINT "enterprise_shared_use_approvals_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_shared_use_approvals" ADD CONSTRAINT "enterprise_shared_use_approvals_tenant_id_agent_id_enterprise_bot_ownership_tenant_id_agent_id_fk" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "enterprise_bot_ownership"("tenant_id", "agent_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_shared_use_approvals" ADD CONSTRAINT "enterprise_shared_use_approvals_tenant_id_install_id_enterprise_plugin_installs_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "install_id") REFERENCES "enterprise_plugin_installs"("tenant_id", "id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_shared_use_approvals" ADD CONSTRAINT "enterprise_shared_use_approvals_tenant_id_request_id_enterprise_shared_use_requests_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "request_id") REFERENCES "enterprise_shared_use_requests"("tenant_id", "id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_shared_use_approvals" ADD CONSTRAINT "enterprise_shared_use_approvals_tenant_id_approved_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "approved_by") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_shared_use_requests" ADD CONSTRAINT "enterprise_shared_use_requests_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_shared_use_requests" ADD CONSTRAINT "enterprise_shared_use_requests_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_shared_use_requests" ADD CONSTRAINT "enterprise_shared_use_requests_tenant_id_agent_id_enterprise_bot_ownership_tenant_id_agent_id_fk" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "enterprise_bot_ownership"("tenant_id", "agent_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_shared_use_requests" ADD CONSTRAINT "enterprise_shared_use_requests_tenant_id_install_id_enterprise_plugin_installs_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "install_id") REFERENCES "enterprise_plugin_installs"("tenant_id", "id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_shared_use_requests" ADD CONSTRAINT "enterprise_shared_use_requests_tenant_id_requested_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "requested_by") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_shared_use_requests" ADD CONSTRAINT "enterprise_shared_use_requests_tenant_id_decided_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "decided_by") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "billing_call_attributions" ADD CONSTRAINT "billing_call_attributions_reservation_id_credit_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "credit_reservations"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "billing_call_attributions" ADD CONSTRAINT "billing_call_attributions_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "billing_call_attributions" ADD CONSTRAINT "billing_call_attributions_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "billing_call_attributions" ADD CONSTRAINT "billing_call_attributions_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "openmuse_task_scopes" ADD CONSTRAINT "openmuse_task_scopes_task_id_openmuse_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "openmuse_tasks"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "openmuse_task_scopes" ADD CONSTRAINT "openmuse_task_scopes_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "openmuse_task_scopes" ADD CONSTRAINT "openmuse_task_scopes_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "openmuse_task_scopes" ADD CONSTRAINT "openmuse_task_scopes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "billing_account_audit" ADD CONSTRAINT "billing_account_audit_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "billing_credit_accounts" ADD CONSTRAINT "billing_credit_accounts_external_customer_id_billing_customers_external_id_fk" FOREIGN KEY ("external_customer_id") REFERENCES "billing_customers"("external_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "billing_credit_accounts" ADD CONSTRAINT "billing_credit_accounts_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "billing_credit_accounts" ADD CONSTRAINT "billing_credit_accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "billing_customer_mappings" ADD CONSTRAINT "billing_customer_mappings_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "billing_customer_mappings" ADD CONSTRAINT "billing_customer_mappings_external_customer_id_billing_customers_external_id_fk" FOREIGN KEY ("external_customer_id") REFERENCES "billing_customers"("external_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_resource_shares" ADD CONSTRAINT "enterprise_resource_shares_tenant_id_resource_id_enterprise_resources_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "resource_id") REFERENCES "enterprise_resources"("tenant_id", "id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_resource_shares" ADD CONSTRAINT "enterprise_resource_shares_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_resource_shares" ADD CONSTRAINT "enterprise_resource_shares_tenant_id_granted_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "granted_by") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "billing_company_finance_grants" ADD CONSTRAINT "billing_company_finance_grants_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "billing_company_finance_grants" ADD CONSTRAINT "billing_company_finance_grants_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "billing_company_finance_grants" ADD CONSTRAINT "billing_company_finance_grants_tenant_id_granted_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "granted_by") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_governance_overrides" ADD CONSTRAINT "enterprise_governance_overrides_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_governance_policies" ADD CONSTRAINT "enterprise_governance_policies_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_template_installs" ADD CONSTRAINT "enterprise_template_installs_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_credential_actions" ADD CONSTRAINT "enterprise_credential_actions_tenant_id_credential_id_enterprise_credentials_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "credential_id") REFERENCES "enterprise_credentials"("tenant_id", "id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_credential_actions" ADD CONSTRAINT "enterprise_credential_actions_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_credential_actions" ADD CONSTRAINT "enterprise_credential_actions_tenant_id_granted_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "granted_by") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_credential_audit" ADD CONSTRAINT "enterprise_credential_audit_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_credentials" ADD CONSTRAINT "enterprise_credentials_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_credentials" ADD CONSTRAINT "enterprise_credentials_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_credentials" ADD CONSTRAINT "enterprise_credentials_tenant_id_owner_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "owner_principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_runtime_config_overrides" ADD CONSTRAINT "enterprise_runtime_config_overrides_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_runtime_configs" ADD CONSTRAINT "enterprise_runtime_configs_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_bot_ownership" ADD CONSTRAINT "enterprise_bot_ownership_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_bot_ownership" ADD CONSTRAINT "enterprise_bot_ownership_tenant_id_owner_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "owner_principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_bot_preferences" ADD CONSTRAINT "enterprise_bot_preferences_tenant_id_agent_id_enterprise_bot_ownership_tenant_id_agent_id_fk" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "enterprise_bot_ownership"("tenant_id", "agent_id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_bot_preferences" ADD CONSTRAINT "enterprise_bot_preferences_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;
--> statement-breakpoint

CREATE TABLE "enterprise_deployment_anchors" (
  "tenant_id" text NOT NULL PRIMARY KEY,
  "deployment_tenant_id" text NOT NULL,
  "billing_external_customer_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE UNIQUE INDEX "enterprise_deployment_anchor_identity" ON "enterprise_deployment_anchors" ("deployment_tenant_id");

--> statement-breakpoint

CREATE UNIQUE INDEX "enterprise_deployment_anchor_billing_customer" ON "enterprise_deployment_anchors" ("billing_external_customer_id");

--> statement-breakpoint

CREATE TABLE "enterprise_workspace_memberships" (
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "epoch" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "workspace_id", "principal_id")
);

--> statement-breakpoint

CREATE UNIQUE INDEX "enterprise_workspace_membership_principal_tenant" ON "enterprise_workspace_memberships" ("principal_id", "tenant_id", "workspace_id");

--> statement-breakpoint

CREATE TABLE "gateway_configs" (
  "id" text NOT NULL PRIMARY KEY,
  "base_url" text NOT NULL,
  "request_timeout_ms" integer NOT NULL DEFAULT 10000,
  "config_version" integer NOT NULL,
  "updated_by" text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint

ALTER TABLE "enterprise_deployment_anchors" ADD CONSTRAINT "enterprise_deployment_anchors_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_workspace_memberships" ADD CONSTRAINT "enterprise_workspace_memberships_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "enterprise_workspaces"("tenant_id", "id") ON DELETE CASCADE;

--> statement-breakpoint

ALTER TABLE "enterprise_workspace_memberships" ADD CONSTRAINT "enterprise_workspace_memberships_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id", "principal_id") REFERENCES "enterprise_memberships"("tenant_id", "principal_id") ON DELETE CASCADE;
--> statement-breakpoint

