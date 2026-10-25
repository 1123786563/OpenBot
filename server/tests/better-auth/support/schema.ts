/*
 * The fixed plugin schema the better-auth fixture owns (T01.02).
 *
 * Fixed, not per-run: the auth-writer capability role is the only writer that
 * creates or drops it, so the fixture contract can assert both the isolated
 * write path and a clean teardown against one well-known name. Nothing else in
 * the corpus may create relations here, and cleanup removes the schema as a
 * whole — no fixture-created object can survive it.
 */

export const BA_FIXTURE_SCHEMA = "ba_fixture_plugin";

export const BA_FIXTURE_NOTES_TABLE = "ba_fixture_notes";
export const BA_FIXTURE_MARKERS_TABLE = "ba_fixture_markers";

export const CREATE_BA_FIXTURE_SCHEMA_SQL = `CREATE SCHEMA IF NOT EXISTS "${BA_FIXTURE_SCHEMA}"`;

export const CREATE_BA_FIXTURE_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS "${BA_FIXTURE_SCHEMA}"."${BA_FIXTURE_NOTES_TABLE}" (
    id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    note text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS "${BA_FIXTURE_SCHEMA}"."${BA_FIXTURE_MARKERS_TABLE}" (
    id integer PRIMARY KEY,
    marker text NOT NULL UNIQUE
  )`,
];

export const DROP_BA_FIXTURE_SCHEMA_SQL = `DROP SCHEMA IF EXISTS "${BA_FIXTURE_SCHEMA}" CASCADE`;

/** Counts of every fixture-owned relation, as the snapshot fixture reports them. */
export const BA_FIXTURE_SNAPSHOT_SQL = `
  SELECT
    (SELECT count(*) FROM "${BA_FIXTURE_SCHEMA}"."${BA_FIXTURE_NOTES_TABLE}") AS notes,
    (SELECT count(*) FROM "${BA_FIXTURE_SCHEMA}"."${BA_FIXTURE_MARKERS_TABLE}") AS markers
`.trim();

/*
 * Namespaces and relations the fixture could have left behind, probed through
 * the setup connection so the check sees everything the restricted roles
 * created. Empty means the teardown was clean.
 */
export const LEAKED_BA_FIXTURE_RESOURCES_SQL = `
  SELECT nspname AS resource FROM pg_namespace WHERE nspname = '${BA_FIXTURE_SCHEMA}'
  UNION ALL
  SELECT n.nspname || '.' || c.relname AS resource
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = '${BA_FIXTURE_SCHEMA}'
   ORDER BY 1
`.trim();
