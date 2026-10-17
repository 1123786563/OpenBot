import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL or DATABASE_URL must be configured before running a database migration command",
  );
}

export default defineConfig({
  dialect: "postgresql",
  /**
   * Every schema file, listed explicitly.
   *
   * Files missing from this list are invisible to `generate`; existing tables still work, but the
   * next generated migration treats them as absent. Add the file here in the same change that adds
   * the schema file.
   */
  schema: [
    /*
     * The deletion subsystem's two tables (openmuse_account_deletions,
     * openmuse_deletion_resources) live in db/schema like everything else.
     * They used to be declared beside their business code in
     * openmuse-deletion/store.ts, which dragged drizzle-kit's bundled import
     * graph through that module's value-level cycle (store → manifest →
     * google-oauth — a pino logger constructed at load — and retention →
     * restore → store): load-time side effects inside migration tooling that
     * only "happened to work". Round 6 (M7) moved the pgTable definitions
     * here; store.ts imports them back and re-exports, so callers are
     * unchanged. Keep new deletion tables in db/schema, not beside the code.
     */
    "./src/db/schema/openmuse-deletion.ts",
    "./src/db/schema/core.ts",
    "./src/db/schema/computer.ts",
    "./src/db/schema/coworker.ts",
    "./src/db/schema/craft.ts",
    "./src/db/schema/components.ts",
    "./src/db/schema/plugins.ts",
    "./src/db/schema/work.ts",
    "./src/db/schema/voice.ts",
    "./src/db/schema/learning.ts",
    "./src/db/schema/responsibilities.ts",
    "./src/db/schema/approvals.ts",
    "./src/db/schema/memory.ts",
    "./src/db/schema/openmuse.ts",
    "./src/db/schema/defaults.ts",
    "./src/db/schema/proactive.ts",
    "./src/db/schema/demonstrations.ts",
    "./src/db/schema/delivery.ts",
    "./src/db/schema/gateway.ts",
    "./src/db/schema/enterprise-tenancy.ts",
    "./src/db/schema/enterprise-conversations.ts",
    "./src/db/schema/enterprise-expert-versions.ts",
    "./src/db/schema/enterprise-model-routes.ts",
    "./src/db/schema/enterprise-runs.ts",
    "./src/db/schema/mastra-tenant-storage.ts",
    "./src/db/schema/mastra-message-intents.ts",
    "./src/db/schema/group.ts",
    "./src/db/schema/admin.ts",
    "./src/db/schema/scim.ts",
    "./src/db/schema/lifecycle.ts",
    "./src/db/schema/passwords.ts",
    "./src/db/schema/team-bots.ts",
    "./src/db/schema/shared-use.ts",
    "./src/db/schema/billing.ts",
    "./src/db/schema/bots.ts",
    "./src/db/schema/code-runs.ts",
    "./src/db/schema/credits.ts",
    "./src/db/schema/credit-reservations.ts",
    "./src/db/schema/sandbox-instances.ts",
    "./src/db/schema/workshop.ts",
    "./src/db/schema/payment.ts",
    "./src/db/schema/payer.ts",
    "./src/db/schema/usage-outbox.ts",
    "./src/db/schema/enterprise-tenancy.ts",
    "./src/db/schema/enterprise-authz.ts",
    "./src/db/schema/enterprise-conversations.ts",
    "./src/db/schema/enterprise-runs.ts",
    "./src/db/schema/enterprise-run-events.ts",
    "./src/db/schema/enterprise-models.ts",
    "./src/db/schema/marketplace.ts",
    "./src/db/schema/identity.ts",
  ],
  out: "./drizzle",
  dbCredentials: {
    url: databaseUrl,
  },
});
