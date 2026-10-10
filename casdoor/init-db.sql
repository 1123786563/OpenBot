-- Casdoor's place on the PostgreSQL OpenBot already owns.
--
-- Runs once, on the first boot of a fresh data volume; on the volume this stack already has,
-- the same statements are applied by hand. Idempotent either way, so re-running it is safe.
--
-- A dedicated DATABASE, the same arrangement as Lago's and OpenConnector's (their init-db.sql
-- files carry the arguments): one login role and one database of its own, so Casdoor's tables,
-- users and application registrations cannot see OpenBot's and OpenBot's migrations cannot see
-- Casdoor's. What that isolation does not include is a privilege boundary: a role's CONNECT on
-- other databases in the cluster is granted to PUBLIC by default, the same trade Lago's role
-- makes.
--
-- Casdoor's tables land in the database's `public` schema — the upstream default arrangement,
-- and the one this Casdoor image restarts cleanly under: its schema sync checks index
-- existence against `public` and then creates unqualified indexes, which doubles every object
-- it owns into whichever schema the search_path names first and fails on the second boot with
-- `relation "IDX_..." already exists`. One database, one public schema, nothing to resolve.

-- The login Casdoor connects with. Local-development password, matching casdoor/app.conf;
-- a deployment sets a real one in both places before anything else can reach the database.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'casdoor') THEN
    CREATE ROLE casdoor LOGIN PASSWORD 'casdoor';
  END IF;
END
$$;

SELECT 'CREATE DATABASE casdoor OWNER casdoor'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'casdoor')\gexec
