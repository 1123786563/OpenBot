import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { createDirectoryAuthority } from "../../src/auth/directory/authority";
import { createDirectoryExecutor } from "../../src/auth/directory/executor";
import { createDirectoryFinalizer } from "../../src/auth/directory/finalizer";
import {
  createCompanyProvisionHandler,
  createProvisionTransactionBound,
  preAllocateProvisionTenantId,
  provisionBillingOutboxId,
} from "../../src/auth/directory/lifecycle";
import { principalRegistry } from "../../src/auth/directory/principal-registry";
import { ensureProvisionedCompanyPayerAccount } from "../../src/billing/payer-company";
import { createDatabase } from "../../src/db/client";
import { createPlatformCompanyRoutes } from "../../src/enterprise/tenancy/company-admin-routes";
import {
  createPlatformCompanyProvisionService,
  type CompanyBillingInitializationPort,
} from "../../src/enterprise/tenancy/provision";
import type { PayerAccount } from "../../src/billing/payer";

/*
 * T03.03 (#540, P06) — atomic company provisioning from the platform entry
 * with a fixed payer, driven against the real 0209–0214 stack on the
 * isolated BA_TEST_* island (interfaces §2/§3, plan Task 6 Steps 1–5).
 *
 * What this file pins, as database facts rather than code conventions:
 *
 * - `billing_initialization_failure_keeps_company_provisioning`: a fault at
 *   the external billing boundary leaves the committed local company in
 *   `provisioning` (the named assertion) with its idempotent outbox intent
 *   still pending — local provisioning is atomic, external initialization is
 *   not, and no half benefits open.
 * - `retry_provision_creates_exactly_one_company_owner_and_payer`: replaying
 *   the same idempotency key after the billing fault recovers into exactly
 *   one tenant, organization, default team, owner member and payer mapping,
 *   the original derived ids unchanged, and only then flips the company
 *   `active`.
 * - `platform_actor_and_owner_are_verified_not_assumed`: a non-admin session
 *   is 403 before anything is written; the command verifies the SPECIFIED
 *   owner (unknown → 404, nothing written) and never falls back to the first
 *   seeded user; the owner's member row names exactly the requested user.
 * - `slug_normalization_and_conflicts_follow_interfaces_s2`: the stored slug
 *   is the §2 normalization of the requested one; a second company under the
 *   same normalized slug is a determined 409 and leaves the first company
 *   untouched (no silent re-slug).
 * - `authority_matrix_gates_provision`: under `legacy` and `paused`
 *   directory authority the platform provision refuses 503 and writes
 *   nothing; only under `ba` does the command run.
 * - `same_key_with_different_payload_is_a_conflict`: the narrow company
 *   idempotency domain (tenant + key, payload hash) answers 409 and creates
 *   no second company.
 * - `mismatched_payer_account_refuses_activation`: an initializer that
 *   returns another subject's mapping can never activate the company.
 *
 * The suite applies the real 0209–0214 better-auth migrations (plus the
 * MT078 audit table the finalizer writes, only when the island lacks it) and
 * cleans up exactly what it created. All five BA_TEST_* role URLs are
 * required; a missing one is a blocked suite, never a fallback. No DSN is
 * ever printed.
 */

const DATABASE_VARIABLE = "BA_TEST_DATABASE_URL";
const BA_URL_VARIABLES = [
  DATABASE_VARIABLE,
  "BA_TEST_DIRECTORY_DATABASE_URL",
  "BA_TEST_DATA_DATABASE_URL",
  "BA_TEST_OPERATOR_DATABASE_URL",
  "BA_TEST_AUTH_WRITER_DATABASE_URL",
] as const;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const MIGRATION_TAGS = [
  "0209_better_auth_directory",
  "0210_better_auth_clocks",
  "0211_better_auth_command_authority",
  "0212_better_auth_authority_sources",
  "0213_better_auth_assurance",
  "0214_better_auth_schema_roles",
] as const;

/** Everything the migrations above create (the T02.15 closed inventory). */
const SUITE_TABLES = [
  "auth_command_outbox",
  "auth_command_change_keys",
  "auth_command_receipts",
  "auth_authority_states",
  "auth_team_management_grants",
  "auth_provisioning_rules",
  "auth_organizations",
  "auth_teams",
  "auth_team_bindings",
  "auth_members",
  "auth_team_members",
  "auth_invitations",
  "auth_eligibility_clocks",
  "auth_company_auth_challenges",
  "auth_company_session_assurances",
] as const;

/*
 * The audit table the finalizer writes (MT078's enterprise_audit_events).
 * The BA island's one-shot enterprise baseline predates MT078, so this suite
 * applies MT078's own statements for that table — copied from
 * server/scripts/multitenancy/migrate-test.ts (the migration's single source
 * of truth, `AUDIT_DOMAIN_TASK`) rather than re-invented — and removes them
 * again only when it created them.
 */
const AUDIT_TABLE = "enterprise_audit_events";
const AUDIT_TABLE_STATEMENTS = [
  `CREATE TABLE "enterprise_audit_events" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"domain" text NOT NULL,
	"event_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"target_id" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_audit_events_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_audit_event_domain" CHECK ("enterprise_audit_events"."domain" in ('business','identity','platform')),
	CONSTRAINT "enterprise_audit_events_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action
)`,
  `CREATE INDEX "enterprise_audit_event_tenant_domain_time" ON "enterprise_audit_events" ("tenant_id","domain","created_at")`,
  `ALTER TABLE "enterprise_audit_events" ENABLE ROW LEVEL SECURITY`,
  `CREATE POLICY "enterprise_audit_event_operator_read" ON "enterprise_audit_events"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_audit_events"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))`,
  `CREATE POLICY "enterprise_audit_event_operator_insert" ON "enterprise_audit_events"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_audit_events"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_audit_events"."id" = nullif(current_setting('app.operation_id', true), ''))`,
  `GRANT SELECT, INSERT ON TABLE "enterprise_audit_events" TO ob_ent_operator`,
  `ALTER TABLE "enterprise_audit_events" FORCE ROW LEVEL SECURITY`,
] as const;

/*
 * The fixture's stable business identities. The owner is deliberately NOT
 * the first seeded user: `platform_actor_and_owner_are_verified_not_assumed`
 * pins that the command takes the SPECIFIED owner, never a first user.
 */
const PLATFORM_ADMIN = "t0303-platform-admin";
const PLAIN_USER = "t0303-plain-user";
const OWNER_USER = "t0303-owner";

/** Every idempotency key the suite provisions under, so cleanup is exact. */
const IDEMPOTENCY_KEYS = [
  "t0303-key-billing-failure",
  "t0303-key-retry",
  "t0303-key-owner-pins",
  "t0303-key-slug",
  "t0303-key-slug-conflict",
  "t0303-key-matrix-ba",
  "t0303-key-conflict",
  "t0303-key-payer-mismatch",
] as const;

function shapeOf(variable: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${variable} must be a loopback PostgreSQL URL.`);
  }
  let database = "";
  try {
    database = decodeURIComponent(
      url.pathname.replace(/^\//, "").replace(/\/+$/, ""),
    );
  } catch {
    throw new Error(`${variable} carries invalid percent-encoding.`);
  }
  if (
    !/^postgres(?:ql)?:$/.test(url.protocol) ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    !/^openbot_enterprise_/.test(database)
  ) {
    throw new Error(
      `${variable} must name a loopback openbot_enterprise_* database.`,
    );
  }
  const host =
    url.hostname === "localhost" || url.hostname === "[::1]"
      ? "127.0.0.1"
      : url.hostname;
  return `${host}:${url.port || "5432"}/${database}`;
}

/** All five URLs, shaped and naming one database; missing means blocked. */
function readBaUrls(): string {
  let reference: string | undefined;
  for (const variable of BA_URL_VARIABLES) {
    const raw = process.env[variable]?.trim();
    if (!raw) {
      throw new Error(
        `${variable} is required: the company-provision suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
      );
    }
    const shape = shapeOf(variable, raw);
    reference ??= shape;
    if (shape !== reference) {
      throw new Error(
        `${variable} must name the same PostgreSQL instance and database as ${DATABASE_VARIABLE}.`,
      );
    }
  }
  return process.env[DATABASE_VARIABLE]!.trim();
}

function loadMigrationSql(tag: string): string {
  const path = join(import.meta.dirname, `../../drizzle/${tag}.sql`);
  if (!existsSync(path)) {
    throw new Error(
      `${tag}.sql does not exist: the BA directory model this suite pins is the integrated T02 target behavior, not an environment problem.`,
    );
  }
  return readFileSync(path, "utf8");
}

async function setAuthority(
  sql: postgres.Sql,
  row: { phase: string; directoryAuthority: string },
): Promise<void> {
  await sql`
    UPDATE auth_authority_states
       SET phase = ${row.phase},
           directory_authority = ${row.directoryAuthority},
           authority_version = 1
     WHERE id = 1`;
}

async function dropAuditTable(sql: postgres.Sql): Promise<void> {
  await sql`DROP POLICY IF EXISTS "enterprise_audit_event_operator_insert" ON "enterprise_audit_events"`;
  await sql`DROP POLICY IF EXISTS "enterprise_audit_event_operator_read" ON "enterprise_audit_events"`;
  await sql`DROP TABLE IF EXISTS "enterprise_audit_events"`;
}

/**
 * Returns the island to the pre-suite shape: this suite's rows gone, the BA
 * tables gone, the tenant status domain back to active/suspended.
 * Idempotent; also recovers a crashed earlier run.
 */
async function cleanupFixture(
  sql: postgres.Sql,
  options: { ownsAuditTable: boolean },
): Promise<void> {
  const tenantIds = IDEMPOTENCY_KEYS.map((key) =>
    preAllocateProvisionTenantId(key),
  );
  // The BA tables go FIRST: their workspace FK cascades into
  // auth_team_bindings, and that cascade would fire the DML guard while the
  // tables still exist.
  await sql.unsafe(
    `DROP TABLE IF EXISTS ${SUITE_TABLES.map((name) => `"${name}"`).join(", ")} CASCADE`,
  );
  await sql`DELETE FROM payer_accounts WHERE external_customer_id IN (${sql.unsafe(
    tenantIds.map((id) => `'openbot-company-${id}'`).join(","),
  )})`;
  await sql`DELETE FROM billing_customers WHERE external_id IN (${sql.unsafe(
    tenantIds.map((id) => `'openbot-company-${id}'`).join(","),
  )})`;
  const auditTableExists =
    await sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = ${AUDIT_TABLE}`;
  if (auditTableExists[0].n > 0) {
    await sql`DELETE FROM enterprise_audit_events WHERE tenant_id IN (${sql.unsafe(
      tenantIds.map((id) => `'${id}'`).join(","),
    )})`;
  }
  await sql`DELETE FROM enterprise_workspace_memberships WHERE tenant_id IN (${sql.unsafe(
    tenantIds.map((id) => `'${id}'`).join(","),
  )})`;
  await sql`DELETE FROM enterprise_memberships WHERE tenant_id IN (${sql.unsafe(
    tenantIds.map((id) => `'${id}'`).join(","),
  )})`;
  await sql`DELETE FROM enterprise_principals WHERE user_id LIKE 't0303-%'`;
  await sql`DELETE FROM enterprise_workspaces WHERE tenant_id IN (${sql.unsafe(
    tenantIds.map((id) => `'${id}'`).join(","),
  )})`;
  await sql`DELETE FROM enterprise_tenants WHERE id IN (${sql.unsafe(
    tenantIds.map((id) => `'${id}'`).join(","),
  )})`;
  await sql`DELETE FROM users WHERE id LIKE 't0303-%'`;
  if (options.ownsAuditTable) await dropAuditTable(sql);
  await sql.unsafe(
    `ALTER TABLE "enterprise_principals" DROP COLUMN IF EXISTS "identity_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_tenants" DROP CONSTRAINT IF EXISTS "enterprise_tenant_status"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_tenants" ADD CONSTRAINT "enterprise_tenant_status" CHECK ("status" in ('active','suspended'))`,
  );
  // The 0212 authority-source columns on shared tables (the T02.04 recipe):
  // the island can carry them as restored-dump residue, and 0212 re-adds them
  // after this normalization.
  await sql.unsafe(
    `ALTER TABLE "enterprise_credentials" DROP COLUMN IF EXISTS "owner_identity_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_credentials" DROP COLUMN IF EXISTS "owner_company_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_credential_actions" DROP COLUMN IF EXISTS "identity_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_credential_actions" DROP COLUMN IF EXISTS "company_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_credential_actions" DROP COLUMN IF EXISTS "source_team_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "billing_company_finance_grants" DROP COLUMN IF EXISTS "identity_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "billing_company_finance_grants" DROP COLUMN IF EXISTS "company_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "access_grants" DROP COLUMN IF EXISTS "principal_id"`,
  );
  await sql.unsafe(
    `ALTER TABLE "access_grants" DROP COLUMN IF EXISTS "identity_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "gateway_virtual_keys" DROP COLUMN IF EXISTS "source_identity_generation"`,
  );
}

/*
 * The assembled platform surface under test: the real executor stack over
 * the island's owner connection (the frozen DirectoryTx shape; the
 * writer-role exclusivity proof is T02.06's, not this suite's subject), the
 * real payer initialization over the same island, and a fault-injectable
 * billing boundary.
 */
interface Harness {
  app: Hono;
  sql: postgres.Sql;
  faults: { billing?: Error; account?: PayerAccount };
  tenantIdOf(key: string): string;
  postCompany(input: {
    actor: string;
    key: string;
    name?: string;
    slug?: string;
    ownerUserId?: string;
    defaultTeamName?: string;
  }): Promise<Response>;
}

async function buildHarness(sql: postgres.Sql): Promise<Harness> {
  const setupUrl = process.env[DATABASE_VARIABLE]!.trim();
  const db = createDatabase(setupUrl, { max: 4 });

  const faults: { billing?: Error; account?: PayerAccount } = {};
  const billing: CompanyBillingInitializationPort = {
    async initialize(tenantId: string): Promise<PayerAccount> {
      if (faults.billing) throw faults.billing;
      if (faults.account) return faults.account;
      return ensureProvisionedCompanyPayerAccount(db, { tenantId });
    },
  };

  const service = createPlatformCompanyProvisionService({
    database: db,
    directory: createDirectoryExecutor({
      database: db,
      bound: createProvisionTransactionBound(),
      authority: createDirectoryAuthority(),
      registry: principalRegistry,
      finalizer: createDirectoryFinalizer(),
      handlers: { "company.provision": createCompanyProvisionHandler() },
    }),
    billing,
  });

  const app = new Hono();
  app.route(
    "/api/enterprise/companies",
    createPlatformCompanyRoutes({
      authenticate: async (request) => {
        const actor = request.headers.get("x-test-actor");
        return actor ? { actorId: actor, entrypoint: "web" } : null;
      },
      provisioner: service,
    }),
  );

  return {
    app,
    sql,
    faults,
    tenantIdOf: (key) => preAllocateProvisionTenantId(key),
    postCompany: ({
      actor,
      key,
      name = "T03.03 团队公司",
      slug = `t0303-${key}`,
      ownerUserId = OWNER_USER,
      defaultTeamName = "默认团队",
    }) =>
      app.request("/api/enterprise/companies", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-actor": actor,
          "idempotency-key": key,
        },
        body: JSON.stringify({
          name,
          slug,
          ownerUserId,
          defaultTeamName,
        }),
      }),
  };
}

async function tenantRow(sql: postgres.Sql, tenantId: string) {
  const rows =
    await sql`SELECT id, name, status FROM enterprise_tenants WHERE id = ${tenantId}`;
  return rows[0] ?? null;
}

async function countRows(
  sql: postgres.Sql,
  table: string,
  where: string,
): Promise<number> {
  const rows = await sql.unsafe(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
  );
  return rows[0].n;
}

describe("T03.03 company provision (platform entry, fixed payer)", () => {
  let harness: Harness;

  beforeAll(async () => {
    readBaUrls();
    const setupUrl = process.env[DATABASE_VARIABLE]!.trim();
    const sql = postgres(setupUrl, { max: 2, onnotice: () => {} });
    const ownsAudit =
      await sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = ${AUDIT_TABLE}`.then(
        (r) => r[0].n === 0,
      );
    await cleanupFixture(sql, { ownsAuditTable: ownsAudit });
    for (const tag of MIGRATION_TAGS) {
      await sql.unsafe(loadMigrationSql(tag));
    }
    if (ownsAudit) {
      for (const statement of AUDIT_TABLE_STATEMENTS) {
        await sql.unsafe(statement);
      }
    }
    await sql`
      INSERT INTO users (id, email) VALUES
        (${PLAIN_USER}, 't0303-plain@example.test'),
        (${PLATFORM_ADMIN}, 't0303-admin@example.test'),
        (${OWNER_USER}, 't0303-owner@example.test')`;
    await sql`
      INSERT INTO user_roles (user_id, role) VALUES (${PLATFORM_ADMIN}, 'admin')`;
    await setAuthority(sql, { phase: "M4", directoryAuthority: "ba" });
    harness = await buildHarness(sql);
    harness.sql = sql;
  });

  afterAll(async () => {
    if (!harness?.sql) return;
    const stillOwns =
      await harness.sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = ${AUDIT_TABLE}`.then(
        (rows) => rows[0].n > 0,
      );
    await cleanupFixture(harness.sql, { ownsAuditTable: stillOwns });
    await harness.sql.end();
  });

  test("billing_initialization_failure_keeps_company_provisioning", async () => {
    const tenantId = harness.tenantIdOf("t0303-key-billing-failure");
    harness.faults.billing = new Error("injected billing outage");
    const response = await harness.postCompany({
      actor: PLATFORM_ADMIN,
      key: "t0303-key-billing-failure",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { company: { status: string } };
    expect(body.company.status).toBe("provisioning");
    const company = await tenantRow(harness.sql, tenantId);
    expect(company?.status).toBe("provisioning");
    const intent = await harness.sql`
      SELECT status FROM auth_command_outbox WHERE id = ${provisionBillingOutboxId(tenantId)}`;
    expect(intent).toHaveLength(1);
    expect(intent[0].status).toBe("pending");
    delete harness.faults.billing;
  });

  test("retry_provision_creates_exactly_one_company_owner_and_payer", async () => {
    const key = "t0303-key-retry";
    const tenantId = harness.tenantIdOf(key);
    harness.faults.billing = new Error("injected billing outage");
    const first = await harness.postCompany({ actor: PLATFORM_ADMIN, key });
    expect(first.status).toBe(201);
    expect((await first.json()).company.status).toBe("provisioning");
    delete harness.faults.billing;
    const second = await harness.postCompany({ actor: PLATFORM_ADMIN, key });
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      company: { status: string; replayed: boolean; tenantId: string };
    };
    expect(body.company.replayed).toBe(true);
    expect(body.company.status).toBe("active");
    expect(body.company.tenantId).toBe(tenantId);
    expect(
      await countRows(harness.sql, "enterprise_tenants", `id = '${tenantId}'`),
    ).toBe(1);
    expect(
      await countRows(harness.sql, "auth_organizations", `id = '${tenantId}'`),
    ).toBe(1);
    expect(
      await countRows(
        harness.sql,
        "auth_teams",
        `organization_id = '${tenantId}'`,
      ),
    ).toBe(1);
    expect(
      await countRows(
        harness.sql,
        "auth_members",
        `organization_id = '${tenantId}' AND user_id = '${OWNER_USER}' AND role = 'owner'`,
      ),
    ).toBe(1);
    expect(
      await countRows(
        harness.sql,
        "auth_team_members",
        `team_id IN (SELECT id FROM auth_teams WHERE organization_id = '${tenantId}')`,
      ),
    ).toBe(1);
    expect(
      await countRows(
        harness.sql,
        "payer_accounts",
        `kind = 'company' AND payer_id = '${tenantId}'`,
      ),
    ).toBe(1);
    expect(
      await countRows(
        harness.sql,
        "billing_customers",
        `external_id = 'openbot-company-${tenantId}'`,
      ),
    ).toBe(1);
    const company = await tenantRow(harness.sql, tenantId);
    expect(company?.status).toBe("active");
    const intent = await harness.sql`
      SELECT status FROM auth_command_outbox WHERE id = ${provisionBillingOutboxId(tenantId)}`;
    expect(intent[0].status).toBe("delivered");
    const membership = await harness.sql`
      SELECT role, status FROM enterprise_memberships WHERE tenant_id = ${tenantId} AND principal_id IN (SELECT id FROM enterprise_principals WHERE user_id = ${OWNER_USER})`;
    expect(membership[0].role).toBe("tenant_admin");
    expect(membership[0].status).toBe("active");
    const workspaceMembership = await harness.sql`
      SELECT status, epoch FROM enterprise_workspace_memberships WHERE tenant_id = ${tenantId}`;
    expect(workspaceMembership).toHaveLength(1);
    expect(workspaceMembership[0].status).toBe("active");
    expect(workspaceMembership[0].epoch).toBe(1);
    const clocks = await harness.sql`
      SELECT kind, epoch, generation FROM auth_eligibility_clocks WHERE tenant_id = ${tenantId}`;
    expect(clocks).toHaveLength(2);
    // The replay's activation is a no-op echo: exactly one activation fact.
    const activationAudits = await harness.sql`
      SELECT count(*)::int AS n FROM enterprise_audit_events WHERE tenant_id = ${tenantId} AND event_type = 'company.provision.activated'`;
    expect(activationAudits[0].n).toBe(1);
  });

  test("platform_actor_and_owner_are_verified_not_assumed", async () => {
    const forbidden = await harness.postCompany({
      actor: PLAIN_USER,
      key: "t0303-key-owner-pins",
    });
    expect(forbidden.status).toBe(403);
    expect(
      await countRows(
        harness.sql,
        "enterprise_tenants",
        `id = '${harness.tenantIdOf("t0303-key-owner-pins")}'`,
      ),
    ).toBe(0);
    const unknownOwner = await harness.postCompany({
      actor: PLATFORM_ADMIN,
      key: "t0303-key-owner-pins",
      ownerUserId: "t0303-no-such-owner",
    });
    expect(unknownOwner.status).toBe(404);
    expect(
      await countRows(
        harness.sql,
        "enterprise_tenants",
        `id = '${harness.tenantIdOf("t0303-key-owner-pins")}'`,
      ),
    ).toBe(0);
    harness.faults.billing = new Error("injected billing outage");
    const created = await harness.postCompany({
      actor: PLATFORM_ADMIN,
      key: "t0303-key-owner-pins",
      ownerUserId: OWNER_USER,
    });
    delete harness.faults.billing;
    expect(created.status).toBe(201);
    const ownerMember = await harness.sql`
      SELECT user_id FROM auth_members WHERE organization_id = ${harness.tenantIdOf("t0303-key-owner-pins")}`;
    expect(ownerMember).toHaveLength(1);
    expect(ownerMember[0].user_id).toBe(OWNER_USER);
  });

  test("slug_normalization_and_conflicts_follow_interfaces_s2", async () => {
    harness.faults.billing = new Error("injected billing outage");
    const created = await harness.postCompany({
      actor: PLATFORM_ADMIN,
      key: "t0303-key-slug",
      name: " Acme Corp & Co!! ",
      slug: "  Acme Corp & Co!!  ",
    });
    delete harness.faults.billing;
    expect(created.status).toBe(201);
    const tenantId = harness.tenantIdOf("t0303-key-slug");
    const organization = await harness.sql`
      SELECT slug FROM auth_organizations WHERE id = ${tenantId}`;
    expect(organization[0].slug).toBe("acme-corp-co");
    const conflict = await harness.postCompany({
      actor: PLATFORM_ADMIN,
      key: "t0303-key-slug-conflict",
      name: "Another Acme",
      slug: "acme-corp-co",
    });
    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as { error: { code: string } };
    expect(body.error.code).toBe("COMPANY_PROVISION_SLUG_TAKEN");
    expect(
      await countRows(
        harness.sql,
        "enterprise_tenants",
        `id = '${harness.tenantIdOf("t0303-key-slug-conflict")}'`,
      ),
    ).toBe(0);
    expect(
      await countRows(
        harness.sql,
        "auth_organizations",
        "slug = 'acme-corp-co'",
      ),
    ).toBe(1);
  });

  test("authority_matrix_gates_provision", async () => {
    await setAuthority(harness.sql, {
      phase: "M1",
      directoryAuthority: "legacy",
    });
    const legacy = await harness.postCompany({
      actor: PLATFORM_ADMIN,
      key: "t0303-key-matrix-ba",
    });
    expect(legacy.status).toBe(503);
    await setAuthority(harness.sql, {
      phase: "M2",
      directoryAuthority: "paused",
    });
    const paused = await harness.postCompany({
      actor: PLATFORM_ADMIN,
      key: "t0303-key-matrix-ba",
    });
    expect(paused.status).toBe(503);
    await setAuthority(harness.sql, { phase: "M4", directoryAuthority: "ba" });
    harness.faults.billing = new Error("injected billing outage");
    const ba = await harness.postCompany({
      actor: PLATFORM_ADMIN,
      key: "t0303-key-matrix-ba",
    });
    delete harness.faults.billing;
    expect(ba.status).toBe(201);
    expect(
      await countRows(
        harness.sql,
        "enterprise_tenants",
        `id = '${harness.tenantIdOf("t0303-key-matrix-ba")}'`,
      ),
    ).toBe(1);
  });

  test("same_key_with_different_payload_is_a_conflict", async () => {
    const key = "t0303-key-conflict";
    harness.faults.billing = new Error("injected billing outage");
    const first = await harness.postCompany({ actor: PLATFORM_ADMIN, key });
    const second = await harness.postCompany({
      actor: PLATFORM_ADMIN,
      key,
      name: "Different payload entirely",
    });
    delete harness.faults.billing;
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe("DIRECTORY_IDEMPOTENCY_CONFLICT");
    expect(
      await countRows(
        harness.sql,
        "auth_organizations",
        `id = '${harness.tenantIdOf(key)}'`,
      ),
    ).toBe(1);
  });

  test("mismatched_payer_account_refuses_activation", async () => {
    const key = "t0303-key-payer-mismatch";
    harness.faults.account = {
      id: "t0303-foreign-account",
      kind: "personal",
      payerId: OWNER_USER,
      externalCustomerId: `openbot-personal-${OWNER_USER}`,
      createdAt: new Date().toISOString(),
    };
    const response = await harness.postCompany({ actor: PLATFORM_ADMIN, key });
    delete harness.faults.account;
    expect(response.status).toBe(409);
    const company = await tenantRow(harness.sql, harness.tenantIdOf(key));
    expect(company?.status).toBe("provisioning");
  });
});
