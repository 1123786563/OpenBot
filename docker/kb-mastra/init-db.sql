-- kb-mastra's place on the PostgreSQL OpenBot already owns (openconnector/init-db.sql pattern).
--
-- Runs once, on the first boot of a fresh data volume; on the volume this stack already has,
-- the same statements are applied by hand. Idempotent either way, so re-running it is safe.
--
-- A dedicated DATABASE and login role of its own, like openconnector's and casdoor's: the
-- four metadata tables (knowledge_bases / knowledges / chunks / chunk_revisions) never share
-- a schema with OpenBot's tables. Vectors are NOT here — Qdrant is the only vector store
-- (qdrant service in docker/compose/kb.yml); this database holds metadata alone.
--
-- kb-mastra's own migration command (`cd server && bun run kb:db:migrate`) creates the tables
-- inside this database.

-- The login kb-mastra connects with. Local-development password matching the KB_DATABASE_URL
-- sample in .env.example; a deployment sets a real one in both places before anything else can
-- reach the database.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'kb_mastra') THEN
    CREATE ROLE kb_mastra LOGIN PASSWORD 'kb_mastra';
  END IF;
END
$$;

SELECT 'CREATE DATABASE kb_mastra OWNER kb_mastra'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'kb_mastra')\gexec
