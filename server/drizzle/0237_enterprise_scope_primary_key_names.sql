-- #675/#677 follow-through (2026-10-31): converge the remaining primary-key names on databases
-- that applied an earlier migration chain.
--
-- WHY THIS EXISTS. `src/db/schema` names every composite primary key, but several historical
-- migrations created the same tables with an anonymous `PRIMARY KEY (...)` clause, so PostgreSQL
-- generated the default `<table>_pkey`. `db-drift-check` now compares constraint names (#675) and
-- found 35 such tables. Renaming in a NEW migration — the 0216 shape — converges both kinds of
-- database: one built by this chain today, and one that applied the earlier file. Rewriting the
-- historical files would leave those two shapes apart forever.
--
-- Each row is (table, legacy name, the name src/db/schema declares). The legacy name is spelled
-- out rather than assumed to be `<table>_pkey`: three tables already carry a named key, and two of
-- those names are TRUNCATED by PostgreSQL's 63-byte identifier cap. `left(..., 63)` below is that
-- same cap, so a declared name longer than it is judged by what PG would actually store — and a
-- table whose key is none of the three shapes fails loudly instead of being silently skipped
-- (the deployment migrator discards NOTICEs, so an exception is the only message an operator sees).

DO $$
DECLARE
  target record;
  declared_name text;
  target_exists boolean;
  legacy_exists boolean;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
    ('billing_company_finance_grants', 'billing_company_finance_grants_pkey', 'billing_company_finance_grants_tenant_id_principal_id_pk'),
    ('billing_company_manage_grants', 'billing_company_manage_grants_pkey', 'billing_company_manage_grants_tenant_id_principal_id_pk'),
    ('billing_subscriptions', 'billing_subscriptions_pkey', 'billing_subscriptions_external_customer_id_external_subscription_id_pk'),
    ('enterprise_audit_events', 'enterprise_audit_events_pkey', 'enterprise_audit_events_tenant_id_id_pk'),
    ('enterprise_bot_ownership', 'enterprise_bot_ownership_pkey', 'enterprise_bot_ownership_tenant_id_agent_id_pk'),
    ('enterprise_bot_preferences', 'enterprise_bot_preferences_pkey', 'enterprise_bot_preferences_tenant_id_agent_id_principal_id_pk'),
    ('enterprise_craft_schedule_scopes', 'enterprise_craft_schedule_scopes_pkey', 'enterprise_craft_schedule_scopes_kind_object_id_pk'),
    ('enterprise_credential_actions', 'enterprise_credential_actions_pkey', 'enterprise_credential_actions_tenant_id_credential_id_principal_id_action_pk'),
    ('enterprise_credential_audit', 'enterprise_credential_audit_pkey', 'enterprise_credential_audit_tenant_id_id_pk'),
    ('enterprise_credential_lease_audit', 'enterprise_credential_lease_audit_pkey', 'enterprise_credential_lease_audit_tenant_id_id_pk'),
    ('enterprise_credential_leases', 'enterprise_credential_leases_pkey', 'enterprise_credential_leases_tenant_id_id_pk'),
    ('enterprise_credentials', 'enterprise_credentials_pkey', 'enterprise_credentials_tenant_id_id_pk'),
    ('enterprise_governance_overrides', 'enterprise_governance_overrides_pkey', 'enterprise_governance_overrides_tenant_id_workspace_id_pk'),
    ('enterprise_host_access_grants', 'enterprise_host_access_grants_pkey', 'enterprise_host_access_grants_tenant_id_id_pk'),
    ('enterprise_host_action_approvals', 'enterprise_host_action_approvals_pkey', 'enterprise_host_action_approvals_tenant_id_id_pk'),
    ('enterprise_learning_containers', 'enterprise_learning_containers_pkey', 'enterprise_learning_containers_tenant_id_id_pk'),
    ('enterprise_learning_records', 'enterprise_learning_records_pkey', 'enterprise_learning_records_tenant_id_id_pk'),
    ('enterprise_package_dispatches', 'enterprise_package_dispatch_pk', 'enterprise_package_dispatches_tenant_id_operation_id_pk'),
    ('enterprise_personal_bot_field_ownership', 'enterprise_personal_bot_field_ownership_pkey', 'enterprise_personal_bot_field_ownership_pk'),
    ('enterprise_personal_bots', 'enterprise_personal_bots_pkey', 'enterprise_personal_bots_tenant_id_workspace_id_principal_id_pk'),
    ('enterprise_personal_memories', 'enterprise_personal_memories_pkey', 'enterprise_personal_memories_tenant_id_id_pk'),
    ('enterprise_plugin_connections', 'enterprise_plugin_connections_pkey', 'enterprise_plugin_connections_tenant_id_id_pk'),
    ('enterprise_plugin_installs', 'enterprise_plugin_installs_pkey', 'enterprise_plugin_installs_tenant_id_id_pk'),
    ('enterprise_purge_audit', 'enterprise_purge_audit_pkey', 'enterprise_purge_audit_tenant_id_id_pk'),
    ('enterprise_purge_manifests', 'enterprise_purge_manifests_pkey', 'enterprise_purge_manifests_tenant_id_id_pk'),
    ('enterprise_resource_grants', 'enterprise_resource_grants_tenant_id_resource_id_principal_id_a', 'enterprise_resource_grants_tenant_id_resource_id_principal_id_action_pk'),
    ('enterprise_resource_shares', 'enterprise_resource_shares_pkey', 'enterprise_resource_shares_tenant_id_resource_id_principal_id_action_pk'),
    ('enterprise_runtime_config_overrides', 'enterprise_runtime_config_overrides_pkey', 'enterprise_runtime_config_overrides_tenant_id_workspace_id_pk'),
    ('enterprise_shared_use_approvals', 'enterprise_shared_use_approvals_pkey', 'enterprise_shared_use_approvals_tenant_id_id_pk'),
    ('enterprise_shared_use_requests', 'enterprise_shared_use_requests_pkey', 'enterprise_shared_use_requests_tenant_id_id_pk'),
    ('enterprise_template_installs', 'enterprise_template_installs_pkey', 'enterprise_template_installs_tenant_id_workspace_id_template_ref_pk'),
    ('enterprise_workspace_memberships', 'enterprise_workspace_memberships_pkey', 'enterprise_workspace_memberships_tenant_id_workspace_id_principal_id_pk'),
    ('hindsight_memory_grants', 'hindsight_memory_grants_tenant_id_principal_id_kind_target_id_p', 'hindsight_memory_grants_tenant_id_principal_id_kind_target_id_pk'),
    ('job_leases', 'job_leases_pkey', 'job_leases_kind_object_id_pk'),
    ('job_ownership', 'job_ownership_pkey', 'job_ownership_kind_object_id_pk')
    ) AS t(table_name, legacy_name, target_name)
  LOOP
    declared_name := left(target.target_name, 63);

    -- Already converged: the shape a fresh chain produces after this file has run once.
    SELECT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass(format('public.%I', target.table_name))
        AND contype = 'p'
        AND conname = declared_name
    ) INTO target_exists;
    IF target_exists THEN
      CONTINUE;
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass(format('public.%I', target.table_name))
        AND contype = 'p'
        AND conname = target.legacy_name
    ) INTO legacy_exists;

    IF legacy_exists THEN
      EXECUTE format(
        'ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',
        target.table_name, target.legacy_name, declared_name
      );
      RAISE NOTICE 'pk-names: renamed %.% to %',
        target.table_name, target.legacy_name, declared_name;
    ELSE
      RAISE EXCEPTION 'pk-names: % has no primary key named % or %; settle the live constraint name by hand, then re-run migrations',
        target.table_name, target.legacy_name, declared_name;
    END IF;
  END LOOP;
END $$;