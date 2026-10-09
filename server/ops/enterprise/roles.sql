-- Enterprise capability roles, per plan 02 §5 T1-B "角色合同".
--
-- Executed by the DBA on a dedicated instance BEFORE the migrations run. These are passwordless
-- NOLOGIN group roles: no secret ever appears in this file. Human/ service LOGIN users are created
-- separately through the environment-approved account system, and each LOGIN user is a member of
-- EXACTLY ONE capability role — an API login must never be the migration owner, an operator, or a
-- role administrator.
--
-- Idempotency contract: when a role already exists, COMPARE ITS ATTRIBUTES against this file
-- (rolsuper/rolcreaterole/rolcreatedb/rolcanlogin/rolbypassrls/rolinherit must all be false/false/
-- false/false/false/true) and treat any difference as a failure to investigate — do not drop and
-- recreate it, and do not swallow the exception:
--
--   SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolbypassrls, rolinherit
--   FROM pg_roles
--   WHERE rolname IN ('ob_ent_directory','ob_ent_data','ob_ent_operator',
--                     'ob_ent_identity_operator','ob_ent_identity');
--
-- Privileges granted here are only schema access. TABLE privileges (GRANT SELECT/INSERT/UPDATE per
-- role contract) live exclusively in the RLS custom migration — server/drizzle/00XX_*_enterprise_
-- tenancy_rls.sql — which is the single executable source of policy and grants. This file never
-- duplicates them; a second policies.sql does not exist on purpose.
--
-- After applying the migrations, verify PUBLIC holds no bypass on any enterprise table:
--
--   SELECT grantee, table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE table_schema = 'public' AND table_name LIKE 'enterprise_%' AND grantee = 'PUBLIC';
--   -- must return zero rows

CREATE ROLE ob_ent_directory NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE ob_ent_data NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE ob_ent_operator NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE ob_ent_identity_operator NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
-- Identity database role for the standalone Better Auth connection. Its per-table grants over the
-- existing identity tables (users/sessions/accounts/verifications/user_roles/…) are enumerated by
-- T3-B from the auth factory's actual access and granted there; it receives NOTHING on the
-- enterprise business tables.
CREATE ROLE ob_ent_identity NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

GRANT USAGE ON SCHEMA public TO ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator, ob_ent_identity;

-- Post-migration spot checks the DBA runs on the migrated database (informational; the same checks
-- are asserted against a live restricted login by server/tests/enterprise/tenancy/rls.test.ts):
--   * every enterprise_* table: relrowsecurity = t AND relforcerowsecurity = t
--   * no LOGIN user is a member of the table owner or of another capability role
--   * ob_ent_operator is NOT a member of ob_ent_identity_operator and vice versa (TEN-21)
