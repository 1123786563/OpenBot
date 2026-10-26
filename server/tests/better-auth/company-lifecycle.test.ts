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
import { createClosedCompanyAssurance } from "../../src/auth/company-assurance";
import { createDirectoryAuthority } from "../../src/auth/directory/authority";
import { createDirectoryExecutor } from "../../src/auth/directory/executor";
import { createDirectoryFinalizer } from "../../src/auth/directory/finalizer";
import {
  createCompanyDeletionRequestHandler,
  createCompanyProvisionHandler,
  createCompanyRestoreHandler,
  createCompanySuspendHandler,
  createPlatformCompanyLifecycleService,
  createProvisionTransactionBound,
  preAllocateProvisionTenantId,
  preAllocateProvisionWorkspaceId,
} from "../../src/auth/directory/lifecycle";
import { principalRegistry } from "../../src/auth/directory/principal-registry";
import type { PayerAccount } from "../../src/billing/payer";
import { ensureProvisionedCompanyPayerAccount } from "../../src/billing/payer-company";
import { createDatabase } from "../../src/db/client";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  createPlatformCompanyLifecycleRoutes,
  createPlatformCompanyRoutes,
} from "../../src/enterprise/tenancy/company-admin-routes";
import {
  type CompanyBillingInitializationPort,
  createPlatformCompanyProvisionService,
} from "../../src/enterprise/tenancy/provision";
import { createBaRevocationGuard } from "../../src/enterprise/tenancy/revocation";
import { createBaScopeResolver } from "../../src/enterprise/tenancy/store";

/*
 * T03.04 (#541, P06) — company suspend / restore / deletion request on the
 * real 0209–0214 stack of the isolated BA_TEST_* island (interfaces §2,
 * spec §4.3, plan Task 6). What this file pins, as database facts:
 *
 * - `suspended_company_directory_and_business_are_closed`: after the suspend
 *   command commits, the company layer every frozen face keys on is closed —
 *   scope selection (the directory entrance) refuses with 403/404 and the
 *   revocation checkpoint denies the pre-suspension scope.
 * - `company_restore_does_not_restore_old_capabilities`: a scope resolved
 *   before the suspension is denied after the restore too — the suspension
 *   advanced every member's company GENERATION and the restore advances the
 *   EPOCH without rewinding it (0215's change-key channel, spec §4.4), so
 *   only freshly resolved scopes (reading the live versions) work again and
 *   the live row, the clock and the fresh scope carry the SAME versions.
 * - suspend/restore are one atomic command per key: the status flip, the
 *   epoch advance and the finalized audit share one receipt, a replay of the
 *   same key advances nothing twice, and a different payload under the same
 *   key is the executor's 409.
 * - the state machine refuses its wrong ends by name (suspend needs an
 *   active company, restore a suspended one, deletion an opened one), a
 *   non-admin actor is refused before anything is written, and the
 *   legacy/paused authorities refuse the commands with 503 and write nothing.
 * - a deletion request registers and only registers: the asset/run/billing/
 *   retention facts are verified and recorded on the one idempotent request
 *   row, nothing is deleted, a second request under a new key is a named
 *   409, and the platform actor's reason is the organization marker the
 *   control plane can query.
 *
 * All five BA_TEST_* role URLs are required; a missing one is a blocked
 * suite, never a fallback. No DSN is ever printed.
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
  "0215_better_auth_company_lifecycle",
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

const PLATFORM_ADMIN = "t0304-platform-admin";
const PLAIN_USER = "t0304-plain-user";
const OWNER_USER = "t0304-owner";

/** Every provision key the suite creates companies under; cleanup is exact. */
const PROVISION_KEYS = [
  "t0304-key-lifecycle",
  "t0304-key-idempotent",
  "t0304-key-states",
  "t0304-key-matrix",
  "t0304-key-deletion",
  "t0304-key-deletion-unopened",
] as const;

const DELETION_REQUEST_OUTBOX_KIND = "company.deletion.request";

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
        `${variable} is required: the company-lifecycle suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
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

/** Returns the island to the pre-suite shape (the T03.03 recipe, t0304 rows). */
async function cleanupFixture(
  sql: postgres.Sql,
  options: { ownsAuditTable: boolean },
): Promise<void> {
  const tenantIds = PROVISION_KEYS.map((key) =>
    preAllocateProvisionTenantId(key),
  );
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
  await sql`DELETE FROM enterprise_principals WHERE user_id LIKE 't0304-%'`;
  await sql`DELETE FROM enterprise_workspaces WHERE tenant_id IN (${sql.unsafe(
    tenantIds.map((id) => `'${id}'`).join(","),
  )})`;
  await sql`DELETE FROM enterprise_tenants WHERE id IN (${sql.unsafe(
    tenantIds.map((id) => `'${id}'`).join(","),
  )})`;
  await sql`DELETE FROM users WHERE id LIKE 't0304-%'`;
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

interface Harness {
  app: Hono;
  faces: Hono;
  sql: postgres.Sql;
  faults: { billing?: Error; account?: PayerAccount };
  tenantIdOf(key: string): string;
  workspaceIdOf(key: string): string;
  postCompany(input: {
    actor: string;
    key: string;
    name?: string;
    ownerUserId?: string;
    slug?: string;
  }): Promise<Response>;
  postLifecycle(input: {
    actor: string;
    companyId: string;
    action: "suspend" | "restore" | "deletion-request";
    reason?: string;
    key?: string;
  }): Promise<Response>;
  resolveScope(key: string): Promise<PlatformScope>;
  setScopeUnderTest(scope: PlatformScope | null): void;
}

async function buildHarness(sql: postgres.Sql): Promise<Harness> {
  const setupUrl = process.env[DATABASE_VARIABLE]!.trim();
  const db = createDatabase(setupUrl, { max: 4 });
  const dataDb = createDatabase(process.env.BA_TEST_DATA_DATABASE_URL!.trim(), {
    max: 2,
  });

  const faults: { billing?: Error; account?: PayerAccount } = {};
  const billing: CompanyBillingInitializationPort = {
    async initialize(tenantId: string): Promise<PayerAccount> {
      if (faults.billing) throw faults.billing;
      if (faults.account) return faults.account;
      return ensureProvisionedCompanyPayerAccount(db, { tenantId });
    },
  };

  const directory = createDirectoryExecutor({
    database: db,
    bound: createProvisionTransactionBound(),
    authority: createDirectoryAuthority(),
    registry: principalRegistry,
    finalizer: createDirectoryFinalizer(),
    handlers: {
      "company.provision": createCompanyProvisionHandler(),
      "company.suspend": createCompanySuspendHandler(),
      "company.restore": createCompanyRestoreHandler(),
      "company.deletion.request": createCompanyDeletionRequestHandler(),
    },
  });
  const provisioner = createPlatformCompanyProvisionService({
    database: db,
    directory,
    billing,
  });
  const lifecycle = createPlatformCompanyLifecycleService({
    database: db,
    directory,
  });

  const authenticate = async (request: Request) => {
    const actor = request.headers.get("x-test-actor");
    return actor ? { actorId: actor, entrypoint: "web" } : null;
  };

  const app = new Hono();
  app.route(
    "/api/enterprise/companies",
    createPlatformCompanyRoutes({ authenticate, provisioner }),
  );
  app.route(
    "/api/enterprise/companies",
    createPlatformCompanyLifecycleRoutes({ authenticate, lifecycle }),
  );

  const authority = createDirectoryAuthority();
  const assurance = createClosedCompanyAssurance({
    policy: { requiresProof: async () => false },
  });
  const resolver = createBaScopeResolver(db, {
    authenticate,
    selectTenant: (request) => request.headers.get("x-openbot-tenant"),
    selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
    data: dataDb,
    authority,
    assurance,
  });
  const guard = createBaRevocationGuard(db, { authority, assurance });

  /*
   * The two closure faces the ticket names, mounted as HTTP so the assertion
   * is the status a client sees: the directory entrance (scope selection —
   * the face every directory read and the company plane sit behind) and the
   * business checkpoint (the revocation guard's judgment of the scope under
   * test). The scope crosses as the server-issued trusted object it is —
   * held in a variable, never rebuilt from a body.
   */
  let scopeUnderTest: PlatformScope | null = null;
  const faces = new Hono();
  faces.get("/t/directory", async (context) => {
    const url = new URL(context.req.raw.url);
    const tenantId = url.searchParams.get("tenant");
    const workspaceId = url.searchParams.get("workspace");
    if (!tenantId || !workspaceId) {
      return context.json({ error: { code: "INVALID_REQUEST" } }, 400);
    }
    try {
      await resolver.resolve(
        new Request("https://openbot.test/api/enterprise/scope", {
          headers: {
            "x-test-actor": OWNER_USER,
            "x-openbot-tenant": tenantId,
            "x-openbot-workspace": workspaceId,
          },
        }),
      );
      return context.json({ ok: true }, 200);
    } catch {
      // The selection face's refusals are all closure-shaped (TENANT_FORBIDDEN
      // and friends): 403 for a closed company, 404 never claims a directory.
      return context.json({ error: { code: "closed" } }, 403);
    }
  });
  faces.post("/t/business", async (context) => {
    if (!scopeUnderTest) {
      return context.json({ error: { code: "INVALID_REQUEST" } }, 400);
    }
    try {
      await guard.assert(scopeUnderTest, "list");
      return context.json({ ok: true }, 200);
    } catch {
      return context.json({ error: { code: "closed" } }, 403);
    }
  });

  return {
    app,
    faces,
    sql,
    faults,
    tenantIdOf: (key) => preAllocateProvisionTenantId(key),
    workspaceIdOf: (key) =>
      preAllocateProvisionWorkspaceId(preAllocateProvisionTenantId(key)),
    postCompany: ({ actor, key, name, ownerUserId, slug }) =>
      app.request("/api/enterprise/companies", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-actor": actor,
          "idempotency-key": key,
        },
        body: JSON.stringify({
          name: name ?? "T03.04 生命周期公司",
          slug: slug ?? `t0304-${key}`,
          ownerUserId: ownerUserId ?? OWNER_USER,
          defaultTeamName: "默认团队",
        }),
      }),
    postLifecycle: ({ actor, companyId, action, reason, key }) =>
      app.request(`/api/enterprise/companies/${companyId}/${action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-actor": actor,
          "idempotency-key": key ?? `t0304-auto-${action}-${companyId}`,
        },
        body: JSON.stringify({ reason: reason ?? "t0304 受控操作" }),
      }),
    resolveScope: async (key) => {
      const tenantId = preAllocateProvisionTenantId(key);
      return resolver.resolve(
        new Request("https://openbot.test/api/enterprise/scope", {
          headers: {
            "x-test-actor": OWNER_USER,
            "x-openbot-tenant": tenantId,
            "x-openbot-workspace": preAllocateProvisionWorkspaceId(tenantId),
          },
        }),
      );
    },
    setScopeUnderTest: (scope) => {
      scopeUnderTest = scope;
    },
  };
}

async function tenantRow(
  sql: postgres.Sql,
  tenantId: string,
): Promise<{ status: string } | null> {
  const rows =
    await sql`SELECT status FROM enterprise_tenants WHERE id = ${tenantId}`;
  return rows[0] ?? null;
}

async function ownerMembership(
  sql: postgres.Sql,
  tenantId: string,
): Promise<{ status: string; epoch: number } | null> {
  const rows = await sql`
    SELECT m.status, m.epoch::int AS epoch FROM enterprise_memberships m
     WHERE m.tenant_id = ${tenantId}
       AND m.principal_id IN (
         SELECT p.id FROM enterprise_principals p WHERE p.user_id = ${OWNER_USER}
       )`;
  return rows[0] ?? null;
}

/** The owner's company eligibility clock (the three-way gate's third fact). */
async function ownerCompanyClock(
  sql: postgres.Sql,
  tenantId: string,
): Promise<{ epoch: number; generation: number; tombstone: boolean } | null> {
  const rows = await sql`
    SELECT epoch::int AS epoch, generation::int AS generation, tombstone
      FROM auth_eligibility_clocks
     WHERE tenant_id = ${tenantId} AND kind = 'company' AND scope_id = ${tenantId}
       AND principal_id IN (
         SELECT p.id FROM enterprise_principals p WHERE p.user_id = ${OWNER_USER}
       )`;
  return rows[0] ?? null;
}

async function organizationMetadata(
  sql: postgres.Sql,
  tenantId: string,
): Promise<string | null> {
  const rows =
    await sql`SELECT metadata FROM auth_organizations WHERE id = ${tenantId}`;
  return rows[0]?.metadata ?? null;
}

async function finalizedAuditCount(
  sql: postgres.Sql,
  tenantId: string,
  commandId: string,
): Promise<number> {
  const rows = await sql`
    SELECT count(*)::int AS n FROM enterprise_audit_events
     WHERE tenant_id = ${tenantId}
       AND event_type = 'directory.command.finalized'
       AND payload->>'commandId' = ${commandId}`;
  return rows[0].n;
}

describe("T03.04 company lifecycle (suspend, restore, deletion request)", () => {
  let harness: Harness;
  /** The server-issued trusted scope resolved BEFORE the suspension. */
  let preSuspensionScope: PlatformScope;

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
        (${PLAIN_USER}, 't0304-plain@example.test'),
        (${PLATFORM_ADMIN}, 't0304-admin@example.test'),
        (${OWNER_USER}, 't0304-owner@example.test')`;
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

  test("suspended_company_directory_and_business_are_closed", async () => {
    const created = await harness.postCompany({
      actor: PLATFORM_ADMIN,
      key: "t0304-key-lifecycle",
    });
    expect(created.status).toBe(201);
    const tenantId = harness.tenantIdOf("t0304-key-lifecycle");
    const workspaceId = harness.workspaceIdOf("t0304-key-lifecycle");

    // The pre-suspension scope is a REAL server-issued trusted object: the
    // checkpoint's trust boundary must never be the thing that denies it.
    preSuspensionScope = await harness.resolveScope("t0304-key-lifecycle");
    expect(preSuspensionScope.memberEpoch).toBe(1);
    harness.setScopeUnderTest(preSuspensionScope);
    const openBusiness = await harness.faces.request("/t/business", {
      method: "POST",
    });
    expect(openBusiness.status).toBe(200);
    harness.setScopeUnderTest(null);

    const suspended = await harness.postLifecycle({
      actor: PLATFORM_ADMIN,
      companyId: tenantId,
      action: "suspend",
      reason: "t0304 合规暂停",
      key: "t0304-key-lifecycle-suspend",
    });
    expect(suspended.status).toBe(200);
    expect((await tenantRow(harness.sql, tenantId))?.status).toBe("suspended");

    // The directory entrance refuses selection for the suspended company.
    const directory = await harness.faces.request(
      `/t/directory?tenant=${tenantId}&workspace=${workspaceId}`,
    );
    expect([403, 404]).toContain(directory.status);

    // The business checkpoint denies the pre-suspension scope.
    harness.setScopeUnderTest(preSuspensionScope);
    const business = await harness.faces.request("/t/business", {
      method: "POST",
    });
    expect([403, 404]).toContain(business.status);
    harness.setScopeUnderTest(null);
  });

  test("company_restore_does_not_restore_old_capabilities", async () => {
    const tenantId = harness.tenantIdOf("t0304-key-lifecycle");

    const restore = await harness.postLifecycle({
      actor: PLATFORM_ADMIN,
      companyId: tenantId,
      action: "restore",
      reason: "t0304 受控恢复",
      key: "t0304-key-lifecycle-restore",
    });
    expect(restore.status).toBe(200);
    expect((await tenantRow(harness.sql, tenantId))?.status).toBe("active");

    // The scope resolved before the suspension carries the versions as they
    // were then (epoch 1, generation 1): the suspension advanced every
    // member's company GENERATION (1 → 2) and the restore advanced the EPOCH
    // (1 → 2) without rewinding the generation — the old version pair never
    // matches again; the restore is a new admission, not a resurrection.
    harness.setScopeUnderTest(preSuspensionScope);
    const oldBusiness = await harness.faces.request("/t/business", {
      method: "POST",
    });
    const oldScopeAllowed = oldBusiness.status === 200;
    expect(oldScopeAllowed).toBe(false);
    harness.setScopeUnderTest(null);

    // Three-way consistency (ruling 2026-10-26, item 3): the live row, the
    // durable clock and a freshly minted scope must carry the SAME versions,
    // and the fresh scope must work — the controlled restore.
    const membership = await ownerMembership(harness.sql, tenantId);
    expect(membership?.status).toBe("active");
    expect(membership?.epoch).toBe(2);
    const clock = await ownerCompanyClock(harness.sql, tenantId);
    expect(clock?.epoch).toBe(2);
    expect(clock?.generation).toBe(2);
    expect(clock?.tombstone).toBe(false);
    const freshScope = await harness.resolveScope("t0304-key-lifecycle");
    expect(freshScope.memberEpoch).toBe(2);
    expect(freshScope.companyGeneration).toBe(2);
    harness.setScopeUnderTest(freshScope);
    const freshBusiness = await harness.faces.request("/t/business", {
      method: "POST",
    });
    expect(freshBusiness.status).toBe(200);
    harness.setScopeUnderTest(null);

    // The channel never regresses: a second full cycle only advances (the
    // same change-key lattice member commands ride, 0215's rule table).
    const resuspend = await harness.postLifecycle({
      actor: PLATFORM_ADMIN,
      companyId: tenantId,
      action: "suspend",
      key: "t0304-key-lifecycle-suspend-2",
    });
    expect(resuspend.status).toBe(200);
    const rerestore = await harness.postLifecycle({
      actor: PLATFORM_ADMIN,
      companyId: tenantId,
      action: "restore",
      key: "t0304-key-lifecycle-restore-2",
    });
    expect(rerestore.status).toBe(200);
    const cycled = await ownerCompanyClock(harness.sql, tenantId);
    const cycledRow = await ownerMembership(harness.sql, tenantId);
    expect(cycled?.epoch).toBe(3);
    expect(cycled?.generation).toBe(3);
    expect(cycledRow?.epoch).toBe(3);
  });

  test("suspend_replay_advances_nothing_twice", async () => {
    const created = await harness.postCompany({
      actor: PLATFORM_ADMIN,
      key: "t0304-key-idempotent",
    });
    expect(created.status).toBe(201);
    const tenantId = harness.tenantIdOf("t0304-key-idempotent");

    const first = await harness.postLifecycle({
      actor: PLATFORM_ADMIN,
      companyId: tenantId,
      action: "suspend",
      reason: "t0304 暂停",
      key: "t0304-key-idempotent-suspend",
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      company: { commandId: string; replayed: boolean };
    };
    expect(firstBody.company.replayed).toBe(false);
    expect((await ownerMembership(harness.sql, tenantId))?.epoch).toBe(1);
    expect((await ownerCompanyClock(harness.sql, tenantId))?.generation).toBe(
      2,
    );
    expect(
      await finalizedAuditCount(
        harness.sql,
        tenantId,
        firstBody.company.commandId,
      ),
    ).toBe(1);

    const replay = await harness.postLifecycle({
      actor: PLATFORM_ADMIN,
      companyId: tenantId,
      action: "suspend",
      reason: "t0304 暂停",
      key: "t0304-key-idempotent-suspend",
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as {
      company: { commandId: string; replayed: boolean };
    };
    expect(replayBody.company.replayed).toBe(true);
    expect(replayBody.company.commandId).toBe(firstBody.company.commandId);
    expect((await ownerMembership(harness.sql, tenantId))?.epoch).toBe(1);
    expect((await ownerCompanyClock(harness.sql, tenantId))?.generation).toBe(
      2,
    );
    expect(
      await finalizedAuditCount(
        harness.sql,
        tenantId,
        firstBody.company.commandId,
      ),
    ).toBe(1);

    const conflict = await harness.postLifecycle({
      actor: PLATFORM_ADMIN,
      companyId: tenantId,
      action: "suspend",
      reason: "t0304 另一个理由",
      key: "t0304-key-idempotent-suspend",
    });
    expect(conflict.status).toBe(409);
  });

  test("suspend_and_restore_refuse_their_wrong_ends_by_name", async () => {
    harness.faults.billing = new Error("injected billing outage");
    const provisioning = await harness.postCompany({
      actor: PLATFORM_ADMIN,
      key: "t0304-key-states",
    });
    delete harness.faults.billing;
    expect(provisioning.status).toBe(201);
    expect((await provisioning.json()).company.status).toBe("provisioning");
    const tenantId = harness.tenantIdOf("t0304-key-states");

    const unopened = await harness.postLifecycle({
      actor: PLATFORM_ADMIN,
      companyId: tenantId,
      action: "suspend",
      key: "t0304-key-states-s1",
    });
    expect(unopened.status).toBe(409);
    expect((await unopened.json()).error.code).toBe(
      "COMPANY_SUSPEND_REQUIRES_ACTIVE",
    );
    expect((await tenantRow(harness.sql, tenantId))?.status).toBe(
      "provisioning",
    );

    // Finish the activation the T03.03 way: the same provision key replays
    // with billing healthy and flips the company active.
    const activated = await harness.postCompany({
      actor: PLATFORM_ADMIN,
      key: "t0304-key-states",
    });
    expect(activated.status).toBe(200);
    expect((await tenantRow(harness.sql, tenantId))?.status).toBe("active");

    const restoreActive = await harness.postLifecycle({
      actor: PLATFORM_ADMIN,
      companyId: tenantId,
      action: "restore",
      key: "t0304-key-states-r0",
    });
    expect(restoreActive.status).toBe(409);
    expect((await restoreActive.json()).error.code).toBe(
      "COMPANY_RESTORE_REQUIRES_SUSPENDED",
    );

    const suspended = await harness.postLifecycle({
      actor: PLATFORM_ADMIN,
      companyId: tenantId,
      action: "suspend",
      key: "t0304-key-states-s1",
    });
    expect(suspended.status).toBe(200);
    const resuspended = await harness.postLifecycle({
      actor: PLATFORM_ADMIN,
      companyId: tenantId,
      action: "suspend",
      key: "t0304-key-states-s2",
    });
    expect(resuspended.status).toBe(409);
    expect((await resuspended.json()).error.code).toBe(
      "COMPANY_SUSPEND_REQUIRES_ACTIVE",
    );
    expect((await ownerCompanyClock(harness.sql, tenantId))?.generation).toBe(
      2,
    );
    expect((await ownerMembership(harness.sql, tenantId))?.epoch).toBe(1);

    const restored = await harness.postLifecycle({
      actor: PLATFORM_ADMIN,
      companyId: tenantId,
      action: "restore",
      key: "t0304-key-states-r1",
    });
    expect(restored.status).toBe(200);
    const rerestored = await harness.postLifecycle({
      actor: PLATFORM_ADMIN,
      companyId: tenantId,
      action: "restore",
      key: "t0304-key-states-r2",
    });
    expect(rerestored.status).toBe(409);
    expect((await rerestored.json()).error.code).toBe(
      "COMPANY_RESTORE_REQUIRES_SUSPENDED",
    );
    expect((await ownerCompanyClock(harness.sql, tenantId))?.epoch).toBe(2);
    expect((await ownerCompanyClock(harness.sql, tenantId))?.generation).toBe(
      2,
    );
    expect((await ownerMembership(harness.sql, tenantId))?.epoch).toBe(2);
  });

  test("lifecycle_commands_need_a_current_platform_admin", async () => {
    const tenantId = harness.tenantIdOf("t0304-key-lifecycle");
    const before = await ownerMembership(harness.sql, tenantId);
    const forbidden = await harness.postLifecycle({
      actor: PLAIN_USER,
      companyId: tenantId,
      action: "suspend",
      key: "t0304-key-admin-gate",
    });
    expect(forbidden.status).toBe(403);
    expect((await ownerMembership(harness.sql, tenantId))?.epoch).toBe(
      before?.epoch,
    );
    expect((await tenantRow(harness.sql, tenantId))?.status).toBe("active");

    const missing = await harness.postLifecycle({
      actor: PLATFORM_ADMIN,
      companyId: "c0304-no-such-company",
      action: "suspend",
      key: "t0304-key-admin-gate",
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe(
      "COMPANY_LIFECYCLE_TENANT_MISSING",
    );
  });

  test("authority_matrix_gates_lifecycle_commands", async () => {
    const created = await harness.postCompany({
      actor: PLATFORM_ADMIN,
      key: "t0304-key-matrix",
    });
    expect(created.status).toBe(201);
    const tenantId = harness.tenantIdOf("t0304-key-matrix");

    await setAuthority(harness.sql, {
      phase: "M1",
      directoryAuthority: "legacy",
    });
    const legacy = await harness.postLifecycle({
      actor: PLATFORM_ADMIN,
      companyId: tenantId,
      action: "suspend",
      key: "t0304-key-matrix-s1",
    });
    expect(legacy.status).toBe(503);
    expect((await tenantRow(harness.sql, tenantId))?.status).toBe("active");
    expect((await ownerMembership(harness.sql, tenantId))?.epoch).toBe(1);

    await setAuthority(harness.sql, {
      phase: "M2",
      directoryAuthority: "paused",
    });
    const paused = await harness.postLifecycle({
      actor: PLATFORM_ADMIN,
      companyId: tenantId,
      action: "suspend",
      key: "t0304-key-matrix-s1",
    });
    expect(paused.status).toBe(503);
    expect((await tenantRow(harness.sql, tenantId))?.status).toBe("active");

    await setAuthority(harness.sql, { phase: "M4", directoryAuthority: "ba" });
    const ba = await harness.postLifecycle({
      actor: PLATFORM_ADMIN,
      companyId: tenantId,
      action: "suspend",
      key: "t0304-key-matrix-s1",
    });
    expect(ba.status).toBe(200);
    expect((await tenantRow(harness.sql, tenantId))?.status).toBe("suspended");
  });

  test("deletion_request_registers_and_only_registers", async () => {
    const created = await harness.postCompany({
      actor: PLATFORM_ADMIN,
      key: "t0304-key-deletion",
    });
    expect(created.status).toBe(201);
    const tenantId = harness.tenantIdOf("t0304-key-deletion");

    const membersBefore =
      await harness.sql`SELECT count(*)::int AS n FROM auth_members WHERE organization_id = ${tenantId}`;
    const teamsBefore =
      await harness.sql`SELECT count(*)::int AS n FROM auth_teams WHERE organization_id = ${tenantId}`;

    const request = await harness.postLifecycle({
      actor: PLATFORM_ADMIN,
      companyId: tenantId,
      action: "deletion-request",
      reason: "t0304 客户要求删除",
      key: "t0304-key-deletion-request",
    });
    expect(request.status).toBe(201);
    const body = (await request.json()) as {
      deletionRequest: {
        requestId: string;
        commandId: string;
        replayed: boolean;
        verification: Record<string, number | null>;
      };
    };
    expect(body.deletionRequest.replayed).toBe(false);
    expect(body.deletionRequest.requestId).toBe(
      `${DELETION_REQUEST_OUTBOX_KIND}:${tenantId}`,
    );

    // The one idempotent request row, pending, with the verified facts.
    const intent = await harness.sql`
      SELECT status, payload FROM auth_command_outbox
       WHERE id = ${`${DELETION_REQUEST_OUTBOX_KIND}:${tenantId}`}`;
    expect(intent).toHaveLength(1);
    expect(intent[0].status).toBe("pending");
    const intentPayload = JSON.parse(String(intent[0].payload)) as {
      reason: string;
      verification: Record<string, number | null>;
    };
    expect(intentPayload.reason).toBe("t0304 客户要求删除");
    expect(intentPayload.verification.assets).toBe(0);
    expect(intentPayload.verification.runs).toBe(0);
    expect(intentPayload.verification.billing).toBe(1);
    expect(Number(intentPayload.verification.auditEvents)).toBeGreaterThan(0);

    // Nothing was deleted and the company keeps its state.
    expect((await tenantRow(harness.sql, tenantId))?.status).toBe("active");
    const membersAfter =
      await harness.sql`SELECT count(*)::int AS n FROM auth_members WHERE organization_id = ${tenantId}`;
    const teamsAfter =
      await harness.sql`SELECT count(*)::int AS n FROM auth_teams WHERE organization_id = ${tenantId}`;
    expect(membersAfter[0].n).toBe(membersBefore[0].n);
    expect(teamsAfter[0].n).toBe(teamsBefore[0].n);

    const replay = await harness.postLifecycle({
      actor: PLATFORM_ADMIN,
      companyId: tenantId,
      action: "deletion-request",
      reason: "t0304 客户要求删除",
      key: "t0304-key-deletion-request",
    });
    expect(replay.status).toBe(200);
    expect((await replay.json()).deletionRequest.replayed).toBe(true);

    const second = await harness.postLifecycle({
      actor: PLATFORM_ADMIN,
      companyId: tenantId,
      action: "deletion-request",
      reason: "t0304 再次申请",
      key: "t0304-key-deletion-request-2",
    });
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe(
      "COMPANY_DELETION_REQUEST_EXISTS",
    );
  });

  test("deletion_request_refuses_an_unopened_company", async () => {
    harness.faults.billing = new Error("injected billing outage");
    const provisioning = await harness.postCompany({
      actor: PLATFORM_ADMIN,
      key: "t0304-key-deletion-unopened",
    });
    delete harness.faults.billing;
    expect(provisioning.status).toBe(201);
    const tenantId = harness.tenantIdOf("t0304-key-deletion-unopened");

    const refused = await harness.postLifecycle({
      actor: PLATFORM_ADMIN,
      companyId: tenantId,
      action: "deletion-request",
      key: "t0304-key-deletion-unopened-request",
    });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe(
      "COMPANY_DELETION_REQUIRES_OPEN_COMPANY",
    );
    const intent = await harness.sql`
      SELECT count(*)::int AS n FROM auth_command_outbox
       WHERE id = ${`${DELETION_REQUEST_OUTBOX_KIND}:${tenantId}`}`;
    expect(intent[0].n).toBe(0);
  });

  test("suspension_reason_is_recorded_and_cleared_with_the_marker", async () => {
    const tenantId = harness.tenantIdOf("t0304-key-matrix");
    expect((await tenantRow(harness.sql, tenantId))?.status).toBe("suspended");
    const raw = await organizationMetadata(harness.sql, tenantId);
    expect(raw).not.toBeNull();
    const marker = JSON.parse(raw as string) as {
      suspended: boolean;
      suspensionReason: string;
      suspendedByCommand: string;
    };
    expect(marker.suspended).toBe(true);
    expect(marker.suspensionReason).toBe("t0304 受控操作");

    const restored = await harness.postLifecycle({
      actor: PLATFORM_ADMIN,
      companyId: tenantId,
      action: "restore",
      reason: "t0304 恢复完毕",
      key: "t0304-key-matrix-restore",
    });
    expect(restored.status).toBe(200);
    const clearedRaw = await organizationMetadata(harness.sql, tenantId);
    const cleared =
      clearedRaw === null
        ? {}
        : (JSON.parse(clearedRaw) as Record<string, unknown>);
    expect(cleared.suspended).toBeUndefined();
    expect(cleared.suspensionReason).toBeUndefined();
    expect((await tenantRow(harness.sql, tenantId))?.status).toBe("active");
  });
});
