-- Enterprise tenancy row-level security, per plan 02 §5 T1-B steps 4-6.
--
-- This custom migration is the ONLY executable source of RLS policies and table privileges for the
-- enterprise tables (there is deliberately no separate policies.sql; see server/ops/enterprise/
-- roles.sql for the DBA-side NOLOGIN role definitions and the comparison/verification contract).
--
-- Context variables are set by the trusted application inside one transaction via
-- set_config(..., true) and vanish with it; a missing context yields NULL, and NULL policies
-- deny. The directory domain resolves without circularity: principal filters on the current user,
-- membership subqueries the principal, tenant subqueries the membership (each subquery is itself
-- subject to the same RLS under the calling role).
--> statement-breakpoint
-- Step 4: directory domain. The directory connection answers "who is this person in enterprises";
-- the data connection re-checks its own principal, tenant and membership while reading business
-- rows. Unqualified columns are qualified by table name so an inner same-named column can never
-- make a policy vacuously true.
ALTER TABLE enterprise_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_principals FORCE ROW LEVEL SECURITY;
CREATE POLICY directory_self ON enterprise_principals FOR SELECT TO ob_ent_directory
USING (user_id = nullif(current_setting('app.user_id',true),''));
CREATE POLICY data_self ON enterprise_principals FOR SELECT TO ob_ent_data
USING (enterprise_principals.id = nullif(current_setting('app.principal_id',true),'')
 AND enterprise_principals.user_id = nullif(current_setting('app.user_id',true),''));

ALTER TABLE enterprise_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY directory_memberships ON enterprise_memberships FOR SELECT TO ob_ent_directory
USING (EXISTS (SELECT 1 FROM enterprise_principals p WHERE p.id=enterprise_memberships.principal_id));
CREATE POLICY data_membership ON enterprise_memberships FOR SELECT TO ob_ent_data
USING (enterprise_memberships.tenant_id=nullif(current_setting('app.tenant_id',true),'')
 AND enterprise_memberships.principal_id=nullif(current_setting('app.principal_id',true),''));

ALTER TABLE enterprise_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY directory_tenants ON enterprise_tenants FOR SELECT TO ob_ent_directory
USING (EXISTS (SELECT 1 FROM enterprise_memberships m WHERE m.tenant_id=enterprise_tenants.id));
CREATE POLICY data_tenant ON enterprise_tenants FOR SELECT TO ob_ent_data
USING (enterprise_tenants.id=nullif(current_setting('app.tenant_id',true),''));
GRANT SELECT ON enterprise_principals,enterprise_memberships,enterprise_tenants TO ob_ent_directory,ob_ent_data;
--> statement-breakpoint
-- Step 5: business domain. Table names come from the fixed list below, never from a request. The
-- tenant_data policy also covers enterprise_security_events on purpose, but the SELECT grant on it
-- is deliberately withheld from ob_ent_data: keeping a policy is not keeping table access.
DO $policy$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['enterprise_workspaces',
    'enterprise_resources','enterprise_resource_grants','enterprise_security_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_data ON %I FOR SELECT TO ob_ent_data USING
      (%I.tenant_id=nullif(current_setting(''app.tenant_id'',true),''''))',t,t);
  END LOOP;
END $policy$;
CREATE POLICY self_grants ON enterprise_resource_grants AS RESTRICTIVE
FOR SELECT TO ob_ent_data
USING (enterprise_resource_grants.principal_id=nullif(current_setting('app.principal_id',true),''));
GRANT SELECT ON enterprise_workspaces,enterprise_resources,
 enterprise_resource_grants TO ob_ent_data;
--> statement-breakpoint
-- Step 6: offline operators. The tenant operator is an explicitly privileged offline connection,
-- never a general-purpose management API: it may select a tenant, but every write is pinned by
-- WITH CHECK to that same tenant. It has no INSERT/UPDATE on the global principal table — global
-- identity work belongs to ob_ent_identity_operator alone (TEN-21), with its own global audit
-- domain that no API role can read.
CREATE POLICY operator_tenants ON enterprise_tenants TO ob_ent_operator
USING (enterprise_tenants.id=nullif(current_setting('app.tenant_id',true),''))
WITH CHECK (enterprise_tenants.id=nullif(current_setting('app.tenant_id',true),''));
DO $operator$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['enterprise_memberships','enterprise_workspaces',
    'enterprise_resources','enterprise_resource_grants','enterprise_security_events'] LOOP
    EXECUTE format('CREATE POLICY operator_scope ON %I TO ob_ent_operator USING
      (%I.tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')) WITH CHECK
      (%I.tenant_id=nullif(current_setting(''app.tenant_id'',true),''''))',t,t,t);
  END LOOP;
END $operator$;
GRANT SELECT,INSERT,UPDATE ON enterprise_tenants,enterprise_memberships,
 enterprise_workspaces,enterprise_resources TO ob_ent_operator;
GRANT SELECT,INSERT,DELETE ON enterprise_resource_grants TO ob_ent_operator;
GRANT SELECT,INSERT ON enterprise_security_events TO ob_ent_operator;
CREATE POLICY operator_principal_lookup ON enterprise_principals FOR SELECT TO ob_ent_operator
USING (enterprise_principals.id=nullif(current_setting('app.operator_principal_id',true),''));
GRANT SELECT (id,user_id,status) ON enterprise_principals TO ob_ent_operator;
CREATE POLICY identity_principal_read ON enterprise_principals FOR SELECT TO ob_ent_identity_operator USING (true);
CREATE POLICY identity_principal_create ON enterprise_principals FOR INSERT TO ob_ent_identity_operator WITH CHECK (true);
CREATE POLICY identity_principal_status ON enterprise_principals FOR UPDATE TO ob_ent_identity_operator USING (true) WITH CHECK (true);
GRANT SELECT,INSERT ON enterprise_principals TO ob_ent_identity_operator;
GRANT UPDATE (status) ON enterprise_principals TO ob_ent_identity_operator;
ALTER TABLE enterprise_identity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_identity_events FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_audit ON enterprise_identity_events TO ob_ent_identity_operator
USING (true) WITH CHECK (true);
GRANT SELECT,INSERT ON enterprise_identity_events TO ob_ent_identity_operator;
REVOKE ALL ON enterprise_identity_events FROM PUBLIC,ob_ent_directory,ob_ent_data,ob_ent_operator;
