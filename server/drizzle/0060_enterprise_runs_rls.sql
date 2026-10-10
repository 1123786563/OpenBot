-- Runs-ledger row-level security and capability-role grants, per plan 03 §4.1/§4.2.
--
-- This custom migration is the ONLY executable source of policies and table privileges for the
-- 22 runs/models tables (0056 discipline: no second policies.sql exists on purpose). Context
-- variables are set by the trusted application inside one transaction via set_config(..., true)
-- and vanish with it; a missing context yields NULL, and NULL policies deny.
--
-- Layout: (1) ENABLE/FORCE RLS on every table; (2) the Run↔reservation deferred composite
-- foreign keys; (3) the two plan-named partial unique indexes plus the default-route one;
-- (4) the budget non-negativity CHECK; (5) per-role policies and minimal GRANTs — the writer is
-- owner-pinned, the runtime writer is pinned to one bound run, the dispatcher sees ONLY the
-- redacted outbox, the offline operator is tenant-pinned, and maintenance is tenant-pinned with
-- a column-limited SELECT on enterprise_runs that never includes input_text.
--> statement-breakpoint
-- 1. Row level security on every new table.
ALTER TABLE enterprise_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_threads FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_run_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_run_releases FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_run_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_run_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_run_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_run_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_run_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_run_commands FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_run_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_run_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_run_steps FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_run_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_run_checkpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_run_events FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_run_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_run_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_run_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_run_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_capabilities FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_run_delegations ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_run_delegations FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_model_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_model_routes FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_model_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_model_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_budget_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_budget_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_budget_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_budget_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_budget_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_budget_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_model_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_model_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_usage_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_usage_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_model_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_model_calls FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- 2. The Run↔reservation creation cycle: run and reservation reference each other and commit in
-- ONE transaction; DEFERRABLE INITIALLY DEFERRED settles both directions at commit, so the
-- mutual reference is never dodged by nullability.
ALTER TABLE enterprise_runs ADD CONSTRAINT enterprise_run_reservation_fk
  FOREIGN KEY (tenant_id, budget_reservation_id)
  REFERENCES enterprise_budget_reservations (tenant_id, id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE enterprise_budget_reservations ADD CONSTRAINT enterprise_reservation_run_fk
  FOREIGN KEY (tenant_id, run_id)
  REFERENCES enterprise_runs (tenant_id, id)
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
-- 3. Partial unique indexes. A thread holds at most one non-terminal run; platform events
-- (NULL attempt) dedupe by source id, attempt-bound events by (attempt, source); one default
-- ACTIVE route version per (tenant, alias) — switching the default never rewrites history,
-- existing runs keep their pinned route_id.
CREATE UNIQUE INDEX enterprise_thread_single_active_run
  ON enterprise_runs (tenant_id, thread_id)
  WHERE status NOT IN ('succeeded','failed','cancelled','expired');
CREATE UNIQUE INDEX enterprise_platform_event_source
  ON enterprise_run_events (tenant_id, run_id, source_event_id) WHERE attempt_id IS NULL;
CREATE UNIQUE INDEX enterprise_route_alias_default
  ON enterprise_model_routes (tenant_id, alias)
  WHERE is_default_for_alias AND status = 'active';
--> statement-breakpoint
-- 4. Budget truth: counters never go negative and a reservation never allocates more than it
-- holds. Real overspend may push spent past the limit — admission refuses new calls, the
-- database does not discard the true cost.
ALTER TABLE enterprise_budget_reservations ADD CONSTRAINT budget_reservation_nonnegative
  CHECK (cap_micros >= 0 AND spent_micros >= 0 AND held_micros >= 0
    AND allocated_micros >= 0 AND overage_micros >= 0
    AND allocated_micros <= held_micros);
--> statement-breakpoint
-- 5a. ob_ent_run_writer: business create/command path. Owner-pinned on threads and runs; child
-- rows (commands, messages, outbox) and the budget cycle resolve the owner through the run.
-- Read-only tenancy catalog: members, workspaces, resources, releases, run grants. No events,
-- no checkpoints, no attempts, no capabilities, no model ledger.
CREATE POLICY thread_owner_write ON enterprise_threads FOR ALL TO ob_ent_run_writer
USING (enterprise_threads.tenant_id=nullif(current_setting('app.tenant_id',true),'')
 AND enterprise_threads.owner_principal_id=nullif(current_setting('app.principal_id',true),''))
WITH CHECK (enterprise_threads.tenant_id=nullif(current_setting('app.tenant_id',true),'')
 AND enterprise_threads.owner_principal_id=nullif(current_setting('app.principal_id',true),''));
CREATE POLICY run_owner_write ON enterprise_runs FOR ALL TO ob_ent_run_writer
USING (enterprise_runs.tenant_id=nullif(current_setting('app.tenant_id',true),'')
 AND enterprise_runs.owner_principal_id=nullif(current_setting('app.principal_id',true),''))
WITH CHECK (enterprise_runs.tenant_id=nullif(current_setting('app.tenant_id',true),'')
 AND enterprise_runs.owner_principal_id=nullif(current_setting('app.principal_id',true),''));
DO $rw_children$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['enterprise_run_commands','enterprise_run_messages',
    'enterprise_run_outbox'] LOOP
    EXECUTE format('CREATE POLICY run_owner_children ON %I FOR ALL TO ob_ent_run_writer USING
      (%I.tenant_id=nullif(current_setting(''app.tenant_id'',true),'''') AND EXISTS
      (SELECT 1 FROM enterprise_runs r WHERE r.tenant_id=%I.tenant_id AND r.id=%I.run_id
       AND r.owner_principal_id=nullif(current_setting(''app.principal_id'',true),'''')))
      WITH CHECK (%I.tenant_id=nullif(current_setting(''app.tenant_id'',true),'''') AND EXISTS
      (SELECT 1 FROM enterprise_runs r WHERE r.tenant_id=%I.tenant_id AND r.id=%I.run_id
       AND r.owner_principal_id=nullif(current_setting(''app.principal_id'',true),'''')))',
      t, t, t, t, t, t, t);
  END LOOP;
END
$rw_children$;
CREATE POLICY run_reservation_write ON enterprise_budget_reservations FOR ALL TO ob_ent_run_writer
USING (enterprise_budget_reservations.tenant_id=nullif(current_setting('app.tenant_id',true),'')
 AND EXISTS (SELECT 1 FROM enterprise_runs r WHERE r.tenant_id=enterprise_budget_reservations.tenant_id
  AND r.id=enterprise_budget_reservations.run_id
  AND r.owner_principal_id=nullif(current_setting('app.principal_id',true),'')))
WITH CHECK (enterprise_budget_reservations.tenant_id=nullif(current_setting('app.tenant_id',true),'')
 AND EXISTS (SELECT 1 FROM enterprise_runs r WHERE r.tenant_id=enterprise_budget_reservations.tenant_id
  AND r.id=enterprise_budget_reservations.run_id
  AND r.owner_principal_id=nullif(current_setting('app.principal_id',true),'')));
CREATE POLICY run_writer_bindings ON enterprise_budget_bindings FOR ALL TO ob_ent_run_writer
USING (enterprise_budget_bindings.tenant_id=nullif(current_setting('app.tenant_id',true),'')
 AND EXISTS (SELECT 1 FROM enterprise_budget_reservations v
  WHERE v.tenant_id=enterprise_budget_bindings.tenant_id
  AND v.id=enterprise_budget_bindings.reservation_id))
WITH CHECK (enterprise_budget_bindings.tenant_id=nullif(current_setting('app.tenant_id',true),'')
 AND EXISTS (SELECT 1 FROM enterprise_budget_reservations v
  WHERE v.tenant_id=enterprise_budget_bindings.tenant_id
  AND v.id=enterprise_budget_bindings.reservation_id));
DO $rw_read$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['enterprise_memberships','enterprise_workspaces',
    'enterprise_resources','enterprise_run_releases','enterprise_run_grants'] LOOP
    EXECUTE format('CREATE POLICY run_writer_catalog ON %I FOR SELECT TO ob_ent_run_writer USING
      (%I.tenant_id=nullif(current_setting(''app.tenant_id'',true),''''))', t, t);
  END LOOP;
END
$rw_read$;
CREATE POLICY run_writer_accounts ON enterprise_budget_accounts FOR SELECT TO ob_ent_run_writer
USING (enterprise_budget_accounts.tenant_id=nullif(current_setting('app.tenant_id',true),''));
GRANT SELECT,INSERT,UPDATE ON enterprise_threads, enterprise_runs TO ob_ent_run_writer;
GRANT SELECT,INSERT ON enterprise_run_commands, enterprise_run_messages,
 enterprise_run_outbox TO ob_ent_run_writer;
GRANT SELECT ON enterprise_memberships, enterprise_workspaces, enterprise_resources,
 enterprise_run_releases, enterprise_run_grants TO ob_ent_run_writer;
GRANT SELECT,INSERT ON enterprise_budget_reservations, enterprise_budget_bindings TO ob_ent_run_writer;
GRANT SELECT ON enterprise_budget_accounts TO ob_ent_run_writer;
--> statement-breakpoint
-- 5b. ob_ent_runtime_writer: internal callbacks, events and model metering. Every statement is
-- pinned to one bound run (tenant + run_id context); it can never accept a body-provided tenant,
-- and it never touches the dispatch outbox.
CREATE POLICY run_internal_scope ON enterprise_runs FOR ALL TO ob_ent_runtime_writer
USING (enterprise_runs.tenant_id=nullif(current_setting('app.tenant_id',true),'')
 AND enterprise_runs.id=nullif(current_setting('app.run_id',true),''))
WITH CHECK (enterprise_runs.tenant_id=nullif(current_setting('app.tenant_id',true),'')
 AND enterprise_runs.id=nullif(current_setting('app.run_id',true),''));
DO $rt_children$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['enterprise_run_attempts','enterprise_run_commands',
    'enterprise_run_messages','enterprise_run_steps','enterprise_run_checkpoints',
    'enterprise_run_events','enterprise_run_snapshots','enterprise_capabilities',
    'enterprise_model_calls','enterprise_model_attempts'] LOOP
    EXECUTE format('CREATE POLICY run_internal_children ON %I FOR ALL TO ob_ent_runtime_writer
      USING (%I.tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')
       AND %I.run_id=nullif(current_setting(''app.run_id'',true),''''))
      WITH CHECK (%I.tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')
       AND %I.run_id=nullif(current_setting(''app.run_id'',true),''''))', t, t, t, t, t);
  END LOOP;
END
$rt_children$;
CREATE POLICY run_internal_usage ON enterprise_usage_entries FOR ALL TO ob_ent_runtime_writer
USING (enterprise_usage_entries.tenant_id=nullif(current_setting('app.tenant_id',true),'')
 AND EXISTS (SELECT 1 FROM enterprise_model_attempts ma
  WHERE ma.tenant_id=enterprise_usage_entries.tenant_id
  AND ma.id=enterprise_usage_entries.model_attempt_id
  AND ma.run_id=nullif(current_setting('app.run_id',true),'')))
WITH CHECK (enterprise_usage_entries.tenant_id=nullif(current_setting('app.tenant_id',true),'')
 AND EXISTS (SELECT 1 FROM enterprise_model_attempts ma
  WHERE ma.tenant_id=enterprise_usage_entries.tenant_id
  AND ma.id=enterprise_usage_entries.model_attempt_id
  AND ma.run_id=nullif(current_setting('app.run_id',true),'')));
CREATE POLICY run_internal_reservations ON enterprise_budget_reservations
FOR ALL TO ob_ent_runtime_writer
USING (enterprise_budget_reservations.tenant_id=nullif(current_setting('app.tenant_id',true),'')
 AND enterprise_budget_reservations.run_id=nullif(current_setting('app.run_id',true),''))
WITH CHECK (enterprise_budget_reservations.tenant_id=nullif(current_setting('app.tenant_id',true),'')
 AND enterprise_budget_reservations.run_id=nullif(current_setting('app.run_id',true),''));
CREATE POLICY run_internal_accounts ON enterprise_budget_accounts FOR ALL TO ob_ent_runtime_writer
USING (enterprise_budget_accounts.tenant_id=nullif(current_setting('app.tenant_id',true),''))
WITH CHECK (enterprise_budget_accounts.tenant_id=nullif(current_setting('app.tenant_id',true),''));
CREATE POLICY runtime_routes_read ON enterprise_model_routes FOR SELECT TO ob_ent_runtime_writer
USING (enterprise_model_routes.tenant_id=nullif(current_setting('app.tenant_id',true),''));
CREATE POLICY runtime_model_grants_read ON enterprise_model_grants
FOR SELECT TO ob_ent_runtime_writer
USING (enterprise_model_grants.tenant_id=nullif(current_setting('app.tenant_id',true),''));
GRANT SELECT,INSERT,UPDATE ON enterprise_runs, enterprise_run_attempts, enterprise_run_commands,
 enterprise_run_messages, enterprise_run_steps, enterprise_run_checkpoints, enterprise_run_events,
 enterprise_run_snapshots, enterprise_capabilities, enterprise_model_calls,
 enterprise_model_attempts TO ob_ent_runtime_writer;
GRANT SELECT,INSERT ON enterprise_usage_entries TO ob_ent_runtime_writer;
GRANT SELECT,UPDATE ON enterprise_budget_reservations, enterprise_budget_accounts TO ob_ent_runtime_writer;
GRANT SELECT ON enterprise_model_routes, enterprise_model_grants TO ob_ent_runtime_writer;
--> statement-breakpoint
-- 5c. ob_ent_dispatcher: the redacted outbox ONLY. Polling the cross-tenant queue is an explicit,
-- bounded system grant; no resource rows, no run bodies, no messages, no events, no capability
-- hashes — not through RLS scope, not through table privileges.
CREATE POLICY dispatcher_outbox ON enterprise_run_outbox FOR ALL TO ob_ent_dispatcher
USING (true) WITH CHECK (true);
GRANT SELECT,UPDATE ON enterprise_run_outbox TO ob_ent_dispatcher;
--> statement-breakpoint
-- 5d. ob_ent_run_operator: offline approved provisioning. Releases, run grants, routes and
-- model grants, budget accounts, delegations — tenant-pinned on every statement. It can never
-- issue a model request: the model ledger has no grant for this role at all.
DO $op_scope$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['enterprise_run_releases','enterprise_run_grants',
    'enterprise_model_routes','enterprise_model_grants','enterprise_budget_accounts',
    'enterprise_run_delegations'] LOOP
    EXECUTE format('CREATE POLICY run_operator_scope ON %I FOR ALL TO ob_ent_run_operator USING
      (%I.tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')) WITH CHECK
      (%I.tenant_id=nullif(current_setting(''app.tenant_id'',true),''''))', t, t, t);
  END LOOP;
END
$op_scope$;
DO $op_read$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['enterprise_memberships','enterprise_workspaces',
    'enterprise_resources'] LOOP
    EXECUTE format('CREATE POLICY run_operator_catalog ON %I FOR SELECT TO ob_ent_run_operator
      USING (%I.tenant_id=nullif(current_setting(''app.tenant_id'',true),''''))', t, t);
  END LOOP;
END
$op_read$;
GRANT SELECT,INSERT,UPDATE ON enterprise_run_releases, enterprise_model_routes,
 enterprise_budget_accounts, enterprise_run_delegations TO ob_ent_run_operator;
GRANT SELECT,INSERT,DELETE ON enterprise_run_grants, enterprise_model_grants TO ob_ent_run_operator;
GRANT SELECT ON enterprise_memberships, enterprise_workspaces, enterprise_resources TO ob_ent_run_operator;
--> statement-breakpoint
-- 5e. ob_ent_run_maintenance: liveness convergence and settlement after authorship ends — fence
-- invalidation, lost marking, cancel confirmation, money reconciliation, audit. Tenant-pinned.
-- The SELECT on enterprise_runs is COLUMN-LIMITED and the list below deliberately omits
-- input_text: the maintenance role cannot read the input body BY CONSTRUCTION (a bare
-- SELECT * is refused with "permission denied for column input_text").
CREATE POLICY run_maintenance_scope ON enterprise_runs FOR ALL TO ob_ent_run_maintenance
USING (enterprise_runs.tenant_id=nullif(current_setting('app.tenant_id',true),''))
WITH CHECK (enterprise_runs.tenant_id=nullif(current_setting('app.tenant_id',true),''));
DO $mt_children$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['enterprise_run_attempts','enterprise_run_commands',
    'enterprise_budget_reservations','enterprise_budget_accounts','enterprise_model_attempts',
    'enterprise_usage_entries'] LOOP
    EXECUTE format('CREATE POLICY run_maintenance_scope ON %I FOR ALL TO ob_ent_run_maintenance
      USING (%I.tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')) WITH CHECK
      (%I.tenant_id=nullif(current_setting(''app.tenant_id'',true),''''))', t, t, t);
  END LOOP;
END
$mt_children$;
CREATE POLICY maintenance_audit ON enterprise_security_events FOR INSERT TO ob_ent_run_maintenance
WITH CHECK (enterprise_security_events.tenant_id=nullif(current_setting('app.tenant_id',true),''));
GRANT SELECT (tenant_id,id,owner_principal_id,actor_user_id,workspace_id,thread_id,release_id,initiator_kind,delegation_ref,request_key,request_digest,model_route_ref,model_grant_revision,release_digest,policy_revision,budget_reservation_id,status,revision,latest_seq,current_attempt_id,current_turn_id,current_fence,cancel_requested_at,wait_deadline,deadline_at,pending_approval_ref,checkpoint_id,reason_code,reconciliation_required,input_revision,event_low_watermark,created_at,updated_at), UPDATE (status,revision,latest_seq,current_attempt_id,current_turn_id,current_fence,cancel_requested_at,wait_deadline,deadline_at,pending_approval_ref,checkpoint_id,reason_code,reconciliation_required,event_low_watermark,updated_at) ON enterprise_runs TO ob_ent_run_maintenance;
GRANT SELECT,INSERT,UPDATE ON enterprise_run_attempts TO ob_ent_run_maintenance;
GRANT SELECT ON enterprise_run_commands TO ob_ent_run_maintenance;
GRANT SELECT,UPDATE ON enterprise_budget_reservations, enterprise_budget_accounts,
 enterprise_model_attempts TO ob_ent_run_maintenance;
GRANT SELECT,INSERT ON enterprise_usage_entries TO ob_ent_run_maintenance;
GRANT INSERT ON enterprise_security_events TO ob_ent_run_maintenance;
--> statement-breakpoint
-- 6. Defence in depth: no capability hashes, message bodies or event payloads for PUBLIC or the
-- dispatcher role even if a future grant is added carelessly. The legacy API roles hold nothing
-- on the ledger by omission — no GRANT names ob_ent_data, ob_ent_directory or ob_ent_operator
-- above, so their every statement on these tables is refused at the privilege layer.
REVOKE ALL ON enterprise_capabilities, enterprise_run_messages, enterprise_run_events,
 enterprise_run_checkpoints FROM PUBLIC, ob_ent_dispatcher;
