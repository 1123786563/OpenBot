-- OCRfix-1 (OCR-5 / OCR-6, 2026-10-26): converge the plugin-package primary-key names on
-- databases that applied an earlier 0210.
--
-- WHY THIS EXISTS. 0210 created the eight enterprise plugin-package tables with PRIMARY KEY
-- clauses that named no constraint, so PostgreSQL generated the default `<table>_pkey` for all
-- eight. #652 then rewrote 0210 in place to name four of them
-- (enterprise_package_grant_pk / _expert_pk / _link_pk, enterprise_run_package_pin_pk) and
-- OCRfix-1 named the remaining four after the authoritative DDL in
-- scripts/multitenancy/migrate-test.ts (PKG02/PKG03/PKG04) and the drizzle mirror in
-- src/db/schema/enterprise-plugin-packages.ts:
--
--   enterprise_package_plans_tenant_id_id_pk
--   enterprise_package_revisions_tenant_id_install_id_revision_pk
--   enterprise_package_installs_tenant_id_id_pk
--   enterprise_package_changes_tenant_id_change_id_pk
--
-- But that window had already closed: origin/main carried the older revision, so any database
-- that migrated from it holds `<table>_pkey` for all eight tables. Drizzle's journal is a
-- watermark — a migration whose `when` is not newer than the last recorded one is skipped
-- without comparing file contents — so rewriting 0210 in place cannot repair those databases,
-- and nothing in the chain compared constraint names, so the fork stayed invisible. This
-- migration is the repair half: it renames whatever the default produced onto the names the
-- mirror and the authority declare.
--
-- IDEMPOTENT BY CONSTRUCTION. For each table it looks up the live primary key in
-- pg_constraint and acts only on the exact legacy name `<table>_pkey`; a database that already
-- carries the target name (every fresh chain, and any database this migration already ran on)
-- matches nothing and the block does nothing. A table that does not exist at all is skipped
-- rather than raising, so a partially built database is not wedged here. Renaming a primary
-- key constraint also renames its backing index, and foreign keys point at the index rather
-- than at the constraint name, so no dependent object needs touching.
--
-- After this runs, `select conname from pg_constraint where contype = 'p' and conrelid in
-- (those eight tables)` returns the eight target names on a repaired database and on a fresh
-- one alike — the agreement tests/schema-drizzle-parity pins across the authority, the
-- migration, this guard and the mirror.

DO $$
DECLARE
  target record;
  legacy_name text;
  target_exists boolean;
  legacy_exists boolean;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('enterprise_package_plans', 'enterprise_package_plans_tenant_id_id_pk'),
      ('enterprise_package_revisions', 'enterprise_package_revisions_tenant_id_install_id_revision_pk'),
      ('enterprise_package_installs', 'enterprise_package_installs_tenant_id_id_pk'),
      ('enterprise_package_grants', 'enterprise_package_grant_pk'),
      ('enterprise_package_experts', 'enterprise_package_expert_pk'),
      ('enterprise_package_resource_links', 'enterprise_package_link_pk'),
      ('enterprise_package_changes', 'enterprise_package_changes_tenant_id_change_id_pk'),
      ('enterprise_run_package_pins', 'enterprise_run_package_pin_pk')
    ) AS names(table_name, target_name)
  LOOP
    -- A table this database never got is not this migration's business.
    IF to_regclass(format('public.%I', target.table_name)) IS NULL THEN
      CONTINUE;
    END IF;

    legacy_name := target.table_name || '_pkey';

    SELECT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass(format('public.%I', target.table_name))
        AND contype = 'p'
        AND conname = target.target_name
    ) INTO target_exists;

    -- Already converged: the fresh-chain shape, and the shape after a first run of this file.
    IF target_exists THEN
      CONTINUE;
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass(format('public.%I', target.table_name))
        AND contype = 'p'
        AND conname = legacy_name
    ) INTO legacy_exists;

    IF legacy_exists THEN
      EXECUTE format(
        'ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',
        target.table_name, legacy_name, target.target_name
      );
      RAISE NOTICE 'ocrfix-1: renamed %.% to %',
        target.table_name, legacy_name, target.target_name;
    ELSE
      -- Neither name is the primary key. Not a shape this migration authored, so say so instead
      -- of guessing: an operator reading the log can then look at the table directly.
      RAISE NOTICE 'ocrfix-1: % has no primary key named % or %; left untouched',
        target.table_name, legacy_name, target.target_name;
    END IF;
  END LOOP;
END
$$;
