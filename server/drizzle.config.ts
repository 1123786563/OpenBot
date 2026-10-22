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
    /*
     * The plugin-package tables' DDL authority is the PKG02/PKG03/PKG04 task
     * track in scripts/multitenancy/migrate-test.ts; the file below is the
     * typed/query-visible projection of that DDL. It stays listed here on
     * purpose (OCR round 1, F1, pinned by tests/schema-drizzle-parity.test.ts):
     * a file missing from this list is invisible to `generate`, and the next
     * generated migration would treat these tables as absent and could emit
     * destructive DDL. Listed = controlled generate source under that parity
     * guard, not a second way to create the tables.
     */
    "./src/db/schema/enterprise-plugin-packages.ts",
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
    "./src/db/schema/bot-services.ts",
    "./src/db/schema/bot-binding.ts",
    "./src/db/schema/access-grants.ts",
    "./src/db/schema/gateway.ts",
    "./src/db/schema/code-runs.ts",
    "./src/db/schema/credits.ts",
    "./src/db/schema/credit-reservations.ts",
    "./src/db/schema/sandbox-instances.ts",
    "./src/db/schema/workshop.ts",
    "./src/db/schema/payment.ts",
    "./src/db/schema/usage-outbox.ts",
    "./src/db/schema/ai-observability-bindings.ts",
    "./src/db/schema/ai-observability-datasets.ts",
    "./src/db/schema/ai-observability-experiments.ts",
    "./src/db/schema/ai-observability-executions.ts",
    "./src/db/schema/ai-observability-execution-case-outcomes.ts",
    "./src/db/schema/ai-observability-exports.ts",
    "./src/db/schema/ai-observability-id-links.ts",
    "./src/db/schema/ai-observability-retention.ts",
    "./src/db/schema/enterprise-tenancy.ts",
    "./src/db/schema/enterprise-conversations.ts",
    "./src/db/schema/enterprise-runs.ts",
    "./src/db/schema/marketplace.ts",
    "./src/db/schema/identity.ts",
    "./src/db/schema/vendor-billing.ts",
    "./src/db/schema/enterprise-plugins.ts",
    "./src/db/schema/enterprise-oauth-state.ts",
    "./src/db/schema/enterprise-credential-lease.ts",
    "./src/db/schema/enterprise-sso-scim.ts",
    "./src/db/schema/job-ownership.ts",
    "./src/db/schema/enterprise-personal-bot.ts",
    "./src/db/schema/enterprise-shared-approvals.ts",
    "./src/db/schema/call-attributions.ts",
    "./src/db/schema/openmuse-task-tenancy.ts",
    "./src/db/schema/payer-accounts.ts",
    "./src/db/schema/personal-shares.ts",
    "./src/db/schema/company-finance.ts",
    "./src/db/schema/enterprise-governance-policy.ts",
    "./src/db/schema/enterprise-credentials.ts",
    "./src/db/schema/enterprise-runtime-config.ts",
    "./src/db/schema/enterprise-bot-ownership.ts",
  ],
  out: "./drizzle",
  dbCredentials: {
    url: databaseUrl,
  },
});
