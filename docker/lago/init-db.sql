-- Lago's place on the PostgreSQL OpenBot already owns.
--
-- Runs once, on the first boot of a fresh data volume; on the volume this stack already has,
-- the same statements are applied by hand. Idempotent either way, so re-running it is safe.
--
-- A dedicated DATABASE, not a schema: Casdoor shares the `openbot` database through the
-- `casdoor` schema, and Lago would be the same arrangement if it could — but Lago v1.53
-- cannot live in a non-public schema, three ways:
--
--   1. db/structure.sql, the file a fresh install loads, is a pg_dump with every statement
--      schema-qualified to `public` (`CREATE VIEW public.billable_metrics_grouped_charges`,
--      `ALTER TABLE ONLY public.fees`, ...), so search_path never moves a fresh install.
--   2. db/migrate/20260109132143_partition_enriched_events.rb hardcodes the partition parent
--      as `public.enriched_events`, so pg_partman + another schema fails the migration.
--   3. Lago's SQL calls pg_partman through the fixed `partman.` schema prefix, so even the
--      extension's own location is not ours to choose.
--
-- It also needs the pg_partman binary in the postgres server itself (see
-- docker/pgvector-partman.Dockerfile), because that same structure.sql unconditionally DROPs
-- and re-CREATEs the extension during a fresh install.
--
-- A separate database gives Lago the `public` schema it hardcodes while keeping the isolation
-- a schema would have bought: billing data cannot see OpenBot's tables, and OpenBot's
-- migrations cannot see Lago's. What that isolation does NOT include is a privilege boundary
-- between the two: the role below is SUPERUSER, because Lago's structure.sql fresh-install
-- path DROPs and re-CREATEs the pg_partman extension (lines 1435-1464), which only a superuser
-- may do, and no pre-install survives that DROP. Upstream assumes the app's database user is
-- the cluster superuser — WeKnora's pinned stack runs exactly that way — so this stack matches
-- the assumption rather than patching vendor files. The whole postgres is loopback-only with
-- inline development credentials, same as the rest of docker-compose.yml; a deployment that
-- wants a real boundary gives Lago its own postgres instead of sharing this one.

-- The login Lago connects with. Local-development password, matching the DATABASE_URL in
-- docker-compose.yml; a deployment sets a real one in both places before anything else can
-- reach the database.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'lago') THEN
    CREATE ROLE lago LOGIN PASSWORD 'lago';
  END IF;
END
$$;

ALTER ROLE lago SUPERUSER;

SELECT 'CREATE DATABASE lago OWNER lago'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'lago')\gexec
