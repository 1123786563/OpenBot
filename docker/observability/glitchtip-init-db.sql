-- GlitchTip's place on its own PostgreSQL.
--
-- Runs once, on the first boot of a fresh data volume (the official postgres image entrypoint
-- applies it after the POSTGRES_* env has created the role and database below); on a volume that
-- already has them, re-running is safe — both statements guard on existence, in the same style as
-- docker/lago/init-db.sql.
--
-- A dedicated CONTAINER, not the shared `postgres` service: GlitchTip's Django migrations own the
-- whole `public` schema of the database they run against (Lago's hardcoding had a schema escape
-- hatch; GlitchTip's don't need one taken), and its upgrade path is recreate-from-scratch — a
-- data volume wiped without a second thought. Keeping that lifecycle off the volume OpenBot's
-- tables live on means a GlitchTip reset can never reach them, which matters more than one fewer
-- container. The container is loopback-only like everything else in docker/compose/observability.yml, and the
-- inline development credentials here match DATABASE_URL there; a deployment sets a real password
-- in both places before anything else can reach the database.

-- The login GlitchTip connects with. Local-development password, matching the DATABASE_URL in
-- docker/compose/observability.yml.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'glitchtip') THEN
    CREATE ROLE glitchtip LOGIN PASSWORD 'glitchtip';
  END IF;
END
$$;

SELECT 'CREATE DATABASE glitchtip OWNER glitchtip'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'glitchtip')\gexec
