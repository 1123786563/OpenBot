-- Casdoor's place in the database OpenBot already owns.
--
-- Runs once, on the first boot of a fresh data volume; on the volume this stack already has,
-- the same statements are applied by hand. Idempotent either way, so re-running it is safe.
--
-- Casdoor shares the `openbot` database with OpenBot but lives entirely in the `casdoor`
-- schema: beego's postgres adapter sets search_path from the application's `dbName` setting,
-- so every table Casdoor creates lands there. The dedicated role owns that schema and has no
-- privileges on OpenBot's tables (PostgreSQL grants none to a new role by default), and
-- `USAGE` on `public` is taken away below so the separation holds even against tables a
-- future migration might leave more open than today's are.

-- The login Casdoor connects with. Local-development password, matching casdoor/app.conf;
-- a deployment sets a real one in both places before anything else can reach the database.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'casdoor') THEN
    CREATE ROLE casdoor LOGIN PASSWORD 'casdoor';
  END IF;
END
$$;

-- Its schema, owned by its role, so Casdoor can create and alter its own tables and nothing
-- else in this database.
CREATE SCHEMA IF NOT EXISTS casdoor AUTHORIZATION casdoor;

-- Tables land in the schema even for connections that never set a search_path themselves.
ALTER ROLE casdoor IN DATABASE openbot SET search_path TO casdoor;

-- Nothing in OpenBot's own schema is Casdoor's to read or name.
REVOKE ALL ON SCHEMA public FROM casdoor;
