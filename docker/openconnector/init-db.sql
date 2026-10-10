-- OpenConnector's place on the PostgreSQL OpenBot already owns.
--
-- Runs once, on the first boot of a fresh data volume; on the volume this stack already has,
-- the same statements are applied by hand. Idempotent either way, so re-running it is safe.
--
-- A dedicated DATABASE, the same arrangement as Lago's and Casdoor's (their init-db.sql files
-- carry the arguments): one login role and one database of its own, so the credentials people
-- type into the broker never sit in the same schema OpenBot's tables do. The broker's tables
-- land in the database's `public` schema — the connection's default search_path, so the URL
-- in docker-compose.yml needs no search_path option. Its own migration command
-- (`docker compose run --rm open-connector npm run runtime:migrate`) still has to run before
-- first start on a fresh database, as the compose file records.

-- The login OpenConnector connects with. Local-development password, matching the default
-- OOMOL_CONNECT_DATABASE_URL in docker-compose.yml; a deployment sets a real one in both
-- places before anything else can reach the database.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'openconnector') THEN
    CREATE ROLE openconnector LOGIN PASSWORD 'openconnector';
  END IF;
END
$$;

SELECT 'CREATE DATABASE openconnector OWNER openconnector'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'openconnector')\gexec
