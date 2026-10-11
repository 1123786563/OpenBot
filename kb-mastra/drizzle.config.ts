import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.KB_DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "KB_DATABASE_URL must be configured before running a database migration command",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/db/schema.ts"],
  out: "./drizzle",
  dbCredentials: {
    url: databaseUrl,
  },
});
