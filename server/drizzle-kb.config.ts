import { defineConfig } from "drizzle-kit";

/**
 * The knowledge-base domain's own migrations, separate from the server's on purpose.
 *
 * The kb domain (migrated from the standalone kb-mastra package) lives in its OWN postgres
 * database (`kb_mastra`, own login role — docker/kb-mastra/init-db.sql), not the `openbot`
 * database the server's drizzle.config.ts migrates. Two databases cannot share one journal,
 * so they get two configs and two folders:
 *
 *   drizzle/      → the `openbot` database (DATABASE_URL)
 *   drizzle-kb/   → the `kb_mastra` database (KB_DATABASE_URL)
 *
 * `db:generate`/`db:migrate` own the former; `kb:db:generate`/`kb:db:migrate` own the latter.
 * The runtime migrator with the advisory lock (src/kb/db/migrate.ts) reads this folder too,
 * so a database migrated by either path is migrated.
 */
const databaseUrl = process.env.KB_DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "KB_DATABASE_URL must be configured before running a knowledge-base migration command",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/kb/db/schema.ts"],
  out: "./drizzle-kb",
  dbCredentials: {
    url: databaseUrl,
  },
});
