-- DBA-managed capability roles. This file contains no LOGIN identities or passwords.
DO $identity$
BEGIN
  IF session_user <> current_user OR NOT COALESCE(
    (SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false
  ) THEN
    RAISE EXCEPTION 'Enterprise role bootstrap requires a direct PostgreSQL superuser session (session_user must equal current_user)';
  END IF;
END
$identity$;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_ent_directory') THEN
    CREATE ROLE ob_ent_directory NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_ent_data') THEN
    CREATE ROLE ob_ent_data NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_ent_operator') THEN
    CREATE ROLE ob_ent_operator NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_ent_identity_operator') THEN
    CREATE ROLE ob_ent_identity_operator NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$roles$;

-- Existing roles are accepted only with the exact non-login, non-escalating attributes.
DO $validate$
DECLARE
  capability_name text;
  capability_oid oid;
  safe_attributes boolean;
  has_parent_role boolean;
  has_protected_ownership boolean;
  has_password boolean;
BEGIN
  FOREACH capability_name IN ARRAY ARRAY[
    'ob_ent_directory', 'ob_ent_data', 'ob_ent_operator', 'ob_ent_identity_operator'
  ] LOOP
    SELECT oid,
      NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls
        AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication
    INTO capability_oid, safe_attributes
    FROM pg_roles
    WHERE rolname = capability_name;

    IF capability_oid IS NULL OR NOT safe_attributes THEN
      RAISE EXCEPTION 'Capability role % has unsafe or missing attributes', capability_name;
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM pg_auth_members WHERE member = capability_oid
    ) INTO has_parent_role;
    IF has_parent_role THEN
      RAISE EXCEPTION 'Capability role % inherits another role', capability_name;
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname LIKE 'enterprise_%'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        AND relation.relowner = capability_oid
    ) OR EXISTS (
      SELECT 1 FROM pg_namespace namespace
      WHERE namespace.nspname = 'public'
        AND namespace.nspowner = capability_oid
    ) OR EXISTS (
      SELECT 1 FROM pg_database target_database
      WHERE target_database.datname = current_database()
        AND target_database.datdba = capability_oid
    ) INTO has_protected_ownership;
    IF has_protected_ownership THEN
      RAISE EXCEPTION 'Capability role % owns a protected enterprise relation, public schema, or current database', capability_name;
    END IF;

    SELECT rolpassword IS NOT NULL
      INTO has_password
      FROM pg_authid
      WHERE oid = capability_oid;
    IF has_password THEN
      RAISE EXCEPTION 'Capability role % must not have a password', capability_name;
    END IF;
  END LOOP;
END
$validate$;
