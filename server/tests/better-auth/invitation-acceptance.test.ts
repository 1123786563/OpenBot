import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
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
import { createDirectoryIngress } from "../../src/auth/directory/ingress";
import {
  createCompanyProvisionHandler,
  createCompanySuspendHandler,
  preAllocateProvisionTenantId,
  preAllocateProvisionWorkspaceId,
} from "../../src/auth/directory/lifecycle";
import {
  createFixedVersionInvitationCommands,
  createInvitationMembershipHandlers,
} from "../../src/auth/directory/membership";
import { principalRegistry } from "../../src/auth/directory/principal-registry";
import {
  createDirectoryReadGate,
  createPlatformReadGate,
} from "../../src/auth/directory/read-gate";
import {
  createInvitationReadRoutes,
  createOwnInvitationReader,
} from "../../src/auth/directory/read-routes";
import { createTransactionBoundBa } from "../../src/auth/directory/transaction-adapter";
import type { PayerAccount } from "../../src/billing/payer";
import { ensureProvisionedCompanyPayerAccount } from "../../src/billing/payer-company";
import { createDatabase } from "../../src/db/client";
import {
  authInvitations,
  authMembers,
  authOrganizations,
  authTeamBindings,
  authTeamMembers,
  authTeams,
} from "../../src/db/schema/auth-directory";
import {
  accounts,
  sessions,
  users,
  verifications,
} from "../../src/db/schema/core";
import { createPlatformCompanyProvisionService } from "../../src/enterprise/tenancy/provision";

/*
 * T04.02 (#546, P08) — invitation accept / reject through the Directory, on
 * the real 0209–0216 stack of the isolated BA_TEST_* island (interfaces §2
 * payload table, §3.2 D-class rows, design §8.2).
 *
 * What this file pins, as database facts:
 *
 * - `new_user_without_principal_accepts_invitation_atomically`: a brand-new
 *   verified user with NO principal row accepts through the real
 *   /api/auth/organization/accept-invitation endpoint and, in ONE command,
 *   gets exactly one principal, one company membership, the invited team
 *   membership, an `accepted` invitation, the projected business membership,
 *   the company+team clocks and one audit fact. Accepting demands no prior
 *   company qualification and no company SSO proof.
 * - `existing_member_role_is_not_overwritten`: an invitation that predates a
 *   live membership never rewrites that member's company role; the acceptance
 *   settles the record and leaves the role byte-identical.
 * - `invitation_failure_leaves_no_partial_membership`: a fault injected after
 *   the membership writes rolls back every half — no member, no principal, no
 *   clock, no team membership, no receipt, the invitation still pending — and
 *   the injected error survives instead of a compensation's 25P02.
 *
 * Also pinned: the invitation's own rules (matching verified mailbox,
 * unexpired, still-pending, live company, teams still in the company, seats
 * checked inside the tenant lock), concurrent acceptance settling once, and
 * reject granting nothing at all.
 *
 * Fixture writes that touch the guarded directory tables run under
 * `session_replication_role = replica` (the schema-migration suites' recipe):
 * the T02.06 DML guard admits writes only inside a command transaction, and a
 * fixture that forges a pre-existing row is deliberately outside one. The
 * commands under test never use that path.
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
  "0216_better_auth_invitation_resend",
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

const BA_SECRET =
  "t0402-invitation-acceptance-fixed-test-secret-not-a-credential";
const DEFAULT_PASSWORD = "correct-horse-battery-staple";
const PLATFORM_ADMIN_ID = "t0402-platform-admin";
const EMAIL_DOMAIN = "@t0402.example.test";

const PROVISION_KEYS = [
  "t0402-key-company",
  "t0402-key-second",
  "t0402-key-suspended",
  "t0402-key-seats",
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
function readBaUrls(): void {
  let reference: string | undefined;
  for (const variable of BA_URL_VARIABLES) {
    const raw = process.env[variable]?.trim();
    if (!raw) {
      throw new Error(
        `${variable} is required: the invitation-acceptance suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
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

/**
 * A fixture write against a guarded directory table. The T02.06 DML guard
 * admits such writes only inside a command transaction (a receipt behind the
 * marker); a fixture that forges a pre-existing row is deliberately outside
 * one, so it runs with replica trigger dispatch — the schema-migration
 * suites' own recipe. The commands under test never take this path.
 */
async function unguarded<T>(
  sql: postgres.Sql,
  run: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL session_replication_role = 'replica'");
    return run(tx);
  });
}

async function dropAuditTable(sql: postgres.Sql): Promise<void> {
  await sql`DROP POLICY IF EXISTS "enterprise_audit_event_operator_insert" ON "enterprise_audit_events"`;
  await sql`DROP POLICY IF EXISTS "enterprise_audit_event_operator_read" ON "enterprise_audit_events"`;
  await sql`DROP TABLE IF EXISTS "enterprise_audit_events"`;
}

/** Returns the island to the pre-suite shape (the T04.01 recipe, t0402 rows). */
async function cleanupFixture(
  sql: postgres.Sql,
  options: { ownsAuditTable: boolean },
): Promise<void> {
  await sql.unsafe(
    `DROP TABLE IF EXISTS ${SUITE_TABLES.map((name) => `"${name}"`).join(", ")} CASCADE`,
  );
  const tenantIds = PROVISION_KEYS.map((key) =>
    preAllocateProvisionTenantId(key),
  );
  const quoted = sql.unsafe(tenantIds.map((id) => `'${id}'`).join(","));
  await sql`DELETE FROM payer_accounts WHERE external_customer_id IN (${sql.unsafe(
    tenantIds.map((id) => `'openbot-company-${id}'`).join(","),
  )})`;
  await sql`DELETE FROM billing_customers WHERE external_id IN (${sql.unsafe(
    tenantIds.map((id) => `'openbot-company-${id}'`).join(","),
  )})`;
  const auditTableExists =
    await sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = ${AUDIT_TABLE}`;
  if (auditTableExists[0].n > 0) {
    await sql`DELETE FROM enterprise_audit_events WHERE tenant_id IN (${quoted})`;
  }
  await sql`DELETE FROM enterprise_workspace_memberships WHERE tenant_id IN (${quoted})`;
  await sql`DELETE FROM enterprise_memberships WHERE tenant_id IN (${quoted})`;
  await sql`DELETE FROM enterprise_principals WHERE user_id IN (
    SELECT id FROM users WHERE email LIKE ${`t0402-%${EMAIL_DOMAIN}`}
       OR id = ${PLATFORM_ADMIN_ID})`;
  await sql`DELETE FROM enterprise_workspaces WHERE tenant_id IN (${quoted})`;
  await sql`DELETE FROM enterprise_tenants WHERE id IN (${quoted})`;
  await sql`DELETE FROM user_roles WHERE user_id = ${PLATFORM_ADMIN_ID}`;
  await sql`DELETE FROM users WHERE email LIKE ${`t0402-%${EMAIL_DOMAIN}`} OR id = ${PLATFORM_ADMIN_ID}`;
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

interface HarnessUser {
  userId: string;
  email: string;
  cookie: string;
  sessionToken: string;
}

interface InvitationRow {
  id: string;
  organization_id: string;
  email: string;
  role: string | null;
  status: string;
  team_id: string | null;
  expires_at: string;
}

interface Harness {
  app: Hono;
  sql: postgres.Sql;
  tenantA: string;
  workspaceA: string;
  teamA: string;
  tenantB: string;
  directory: ReturnType<typeof createDirectoryExecutor>;
  owner: HarnessUser;
  ownerB: HarnessUser;
  outsider: HarnessUser;
  unverified: HarnessUser;
  /** A new, verified, principal-less user — one per test, so no row collides. */
  freshInvitee(label: string): Promise<HarnessUser>;
  signUpRaw(label: string, verified: boolean): Promise<HarnessUser>;
  invite(input: {
    actor: HarnessUser;
    tenantId: string;
    email: string;
    role?: string;
    workspaceIds?: string[];
    key: string;
  }): Promise<Response>;
  accept(input: {
    actor: HarnessUser;
    invitationId: string;
    key: string;
  }): Promise<Response>;
  reject(input: {
    actor: HarnessUser;
    invitationId: string;
    key: string;
  }): Promise<Response>;
  readInvitation(id: string): Promise<InvitationRow | undefined>;
  memberRows(tenantId: string, userId: string): Promise<{ role: string }[]>;
  principalRows(userId: string): Promise<{ id: string; status: string }[]>;
  clockRows(
    tenantId: string,
    principalId: string,
    kind: "company" | "team",
  ): Promise<{ epoch: number; generation: number; tombstone: boolean }[]>;
  teamMemberRows(teamId: string, userId: string): Promise<unknown[]>;
  businessMembership(
    tenantId: string,
    principalId: string,
  ): Promise<{ role: string; status: string; epoch: number }[]>;
  auditCountByOperation(tenantId: string, operation: string): Promise<number>;
  /** A directory whose invitation handlers enforce `limit` seats. */
  directoryWithSeatLimit(
    limit: number,
  ): ReturnType<typeof createDirectoryExecutor>;
  teamOf(tenantId: string): Promise<string>;
  workspaceOf(tenantId: string): string;
  provision(key: string, ownerUserId: string): Promise<string>;
}

async function buildHarness(sql: postgres.Sql): Promise<Harness> {
  const setupUrl = process.env[DATABASE_VARIABLE]!.trim();
  const db = createDatabase(setupUrl, { max: 6 });

  const baSchema = {
    user: users,
    session: sessions,
    account: accounts,
    verification: verifications,
    organization: authOrganizations,
    member: authMembers,
    invitation: authInvitations,
    team: authTeams,
    teamMember: authTeamMembers,
    teamBinding: authTeamBindings,
  };
  let resolvedOptions: unknown;
  const auth = betterAuth({
    secret: BA_SECRET,
    baseURL: "http://127.0.0.1:0",
    trustedOrigins: ["http://127.0.0.1:0"],
    emailAndPassword: { enabled: true },
    plugins: [organization({ teams: { enabled: true } })],
    database: (options: unknown) => {
      resolvedOptions = options;
      return drizzleAdapter(db as never, {
        provider: "pg",
        schema: baSchema as never,
        transaction: true,
      })(options as never);
    },
  });
  const authContext = await auth.$context;

  const signUp = async (email: string, name: string): Promise<HarnessUser> => {
    const response = await (
      auth.api as unknown as Record<
        string,
        (input: unknown) => Promise<Response>
      >
    ).signUpEmail({
      body: { email, password: DEFAULT_PASSWORD, name },
      asResponse: true,
    });
    if (response.status !== 200) {
      throw new Error(`signUpEmail for ${email} failed: ${response.status}`);
    }
    const setCookie = response.headers.get("set-cookie");
    if (!setCookie) throw new Error("signUpEmail returned no session cookie");
    const body = (await response.json()) as {
      token: string;
      user: { id: string };
    };
    return {
      userId: body.user.id,
      email: email.toLowerCase(),
      cookie: setCookie.split(";")[0],
      sessionToken: body.token,
    };
  };

  const setVerified = async (
    email: string,
    verified: boolean,
  ): Promise<void> => {
    await sql`UPDATE users SET email_verified = ${verified} WHERE email = ${email}`;
  };

  const bound = createTransactionBoundBa({
    createTxAdapter: (tx) =>
      drizzleAdapter(tx as never, {
        provider: "pg",
        schema: baSchema as never,
        transaction: false,
      })(resolvedOptions as never),
  });
  const authority = createDirectoryAuthority();
  const finalizer = createDirectoryFinalizer();
  const ba = createFixedVersionInvitationCommands(authContext, {
    teams: { enabled: true },
  });
  const handlerSet = (seatLimit?: number) => ({
    "company.provision": createCompanyProvisionHandler(),
    "company.suspend": createCompanySuspendHandler(),
    ...createInvitationMembershipHandlers(
      seatLimit === undefined ? { ba } : { ba, seatLimit },
    ),
  });
  const directory = createDirectoryExecutor({
    database: db,
    bound,
    authority,
    registry: principalRegistry,
    finalizer,
    handlers: handlerSet(),
  });

  const billing = {
    async initialize(tenantId: string): Promise<PayerAccount> {
      return ensureProvisionedCompanyPayerAccount(db, { tenantId });
    },
  };
  const provisioner = createPlatformCompanyProvisionService({
    database: db,
    directory,
    billing,
  });

  const ingress = createDirectoryIngress({
    database: db,
    auth: auth as never,
    readGate: createDirectoryReadGate({
      authority,
      assurance: createClosedCompanyAssurance({
        policy: { requiresProof: async () => false },
      }),
    }),
    platformReadGate: createPlatformReadGate(),
    directory,
  });

  const app = new Hono();
  app.on(
    ["POST", "GET", "PUT", "PATCH", "DELETE"],
    "/api/auth/*",
    async (context) => {
      const answer = await ingress.handle(context.req.raw);
      if (answer) return answer;
      return context.notFound();
    },
  );
  app.route(
    "/api/enterprise/invitations",
    createInvitationReadRoutes({
      authenticate: async (request) => {
        const session = await auth.api
          .getSession({
            headers: request.headers,
            query: { disableCookieCache: true },
          })
          .catch(() => null);
        return session?.user.id
          ? { actorId: session.user.id, entrypoint: "web" }
          : null;
      },
      reader: createOwnInvitationReader(db),
    }),
  );

  const [owner, ownerB, outsider, unverified] = await Promise.all([
    signUp(`t0402-owner${EMAIL_DOMAIN}`, "T04.02 Owner"),
    signUp(`t0402-owner-b${EMAIL_DOMAIN}`, "T04.02 Owner B"),
    signUp(`t0402-outsider${EMAIL_DOMAIN}`, "T04.02 Outsider"),
    signUp(`t0402-unverified${EMAIL_DOMAIN}`, "T04.02 Unverified"),
  ]);
  // Verification MAIL delivery is T04.04's wiring; the harness pins the fact
  // directly, exactly as the T04.01 suite does. `unverified` stays false.
  for (const user of [owner, ownerB, outsider]) {
    await setVerified(user.email, true);
  }

  const provision = async (key: string, ownerUserId: string) => {
    const tenantId = preAllocateProvisionTenantId(key);
    await provisioner.provision({
      actorUserId: PLATFORM_ADMIN_ID,
      idempotencyKey: key,
      name: `T04.02 公司 ${key}`,
      slug: `t0402-${key}`,
      ownerUserId,
      defaultTeamName: "默认团队",
    });
    return tenantId;
  };
  const tenantA = await provision("t0402-key-company", owner.userId);
  const tenantB = await provision("t0402-key-second", ownerB.userId);

  const teamOf = async (tenantId: string): Promise<string> => {
    const rows =
      await sql`SELECT team_id FROM auth_team_bindings WHERE tenant_id = ${tenantId} LIMIT 1`;
    const teamId = rows[0]?.team_id;
    if (typeof teamId !== "string") {
      throw new Error(`company ${tenantId} has no team binding`);
    }
    return teamId;
  };

  const respond = (
    operation: "accept" | "reject",
    input: { actor: HarnessUser; invitationId: string; key: string },
  ): Promise<Response> =>
    app.request(`/api/auth/organization/${operation}-invitation`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: input.actor.cookie,
        "idempotency-key": input.key,
      },
      body: JSON.stringify({ invitationId: input.invitationId }),
    });

  return {
    app,
    sql,
    tenantA,
    workspaceA: preAllocateProvisionWorkspaceId(tenantA),
    teamA: await teamOf(tenantA),
    tenantB,
    directory,
    owner,
    ownerB,
    outsider,
    unverified,
    signUpRaw: async (label, verified) => {
      const user = await signUp(`t0402-${label}${EMAIL_DOMAIN}`, label);
      if (verified) await setVerified(user.email, true);
      return user;
    },
    freshInvitee: async (label) => {
      const user = await signUp(`t0402-${label}${EMAIL_DOMAIN}`, label);
      await setVerified(user.email, true);
      return user;
    },
    invite: ({ actor, tenantId, email, role, workspaceIds, key }) =>
      app.request("/api/auth/organization/invite-member", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: actor.cookie,
          "idempotency-key": key,
        },
        body: JSON.stringify({
          organizationId: tenantId,
          email,
          role: role ?? "member",
          ...(workspaceIds ? { workspaceIds } : {}),
        }),
      }),
    accept: (input) => respond("accept", input),
    reject: (input) => respond("reject", input),
    readInvitation: async (id) => {
      const rows =
        await sql`SELECT id, organization_id, email, role, status, team_id, expires_at::text AS expires_at
                    FROM auth_invitations WHERE id = ${id} LIMIT 1`;
      return rows[0] as InvitationRow | undefined;
    },
    memberRows: (tenantId, userId) =>
      sql`SELECT role FROM auth_members
            WHERE organization_id = ${tenantId} AND user_id = ${userId}`,
    principalRows: (userId) =>
      sql`SELECT id, status FROM enterprise_principals WHERE user_id = ${userId}`,
    clockRows: (tenantId, principalId, kind) =>
      sql`SELECT epoch::int AS epoch, generation::int AS generation, tombstone
            FROM auth_eligibility_clocks
           WHERE tenant_id = ${tenantId} AND principal_id = ${principalId} AND kind = ${kind}`,
    teamMemberRows: (teamId, userId) =>
      sql`SELECT 1 AS present FROM auth_team_members
           WHERE team_id = ${teamId} AND user_id = ${userId}`,
    businessMembership: (tenantId, principalId) =>
      sql`SELECT role, status, epoch FROM enterprise_memberships
           WHERE tenant_id = ${tenantId} AND principal_id = ${principalId}`,
    auditCountByOperation: async (tenantId, operation) => {
      const rows =
        await sql`SELECT count(*)::int AS n FROM enterprise_audit_events
                    WHERE tenant_id = ${tenantId}
                      AND event_type = 'directory.command.finalized'
                      AND payload->>'operation' = ${operation}`;
      return rows[0].n;
    },
    directoryWithSeatLimit: (limit) =>
      createDirectoryExecutor({
        database: db,
        bound,
        authority,
        registry: principalRegistry,
        finalizer,
        handlers: handlerSet(limit),
      }),
    teamOf,
    workspaceOf: (tenantId) => preAllocateProvisionWorkspaceId(tenantId),
    provision,
  };
}

describe("T04.02 invitation acceptance and rejection", () => {
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
        (${PLATFORM_ADMIN_ID}, ${`t0402-admin${EMAIL_DOMAIN}`})`;
    await sql`
      INSERT INTO user_roles (user_id, role) VALUES (${PLATFORM_ADMIN_ID}, 'admin')`;
    await setAuthority(sql, { phase: "M4", directoryAuthority: "ba" });
    harness = await buildHarness(sql);
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

  test("new_user_without_principal_accepts_invitation_atomically", async () => {
    const invitee = await harness.freshInvitee("acceptor");
    // Genuinely new: no principal before the command. Accepting creates it.
    expect(await harness.principalRows(invitee.userId)).toHaveLength(0);

    const invited = await harness.invite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email: invitee.email,
      role: "member",
      workspaceIds: [harness.workspaceA],
      key: "t0402-key-invite-atomic",
    });
    expect(invited.status).toBe(200);
    const { resourceId: invitationId } = (await invited.json()) as {
      resourceId: string;
    };
    expect(typeof invitationId).toBe("string");

    const accepted = await harness.accept({
      actor: invitee,
      invitationId,
      key: "t0402-key-accept-atomic",
    });
    expect(accepted.status).toBe(200);
    const result = (await accepted.json()) as {
      replayed: boolean;
      tenantId: string;
      versions: { key: { kind: string; scopeId: string } }[];
    };
    expect(result.replayed).toBe(false);
    expect(result.tenantId).toBe(harness.tenantA);
    // One command produced both the company and the team eligibility keys.
    expect(result.versions.map((version) => version.key.kind).sort()).toEqual([
      "company",
      "team",
    ]);

    const principalRows = await harness.principalRows(invitee.userId);
    expect(principalRows).toHaveLength(1);
    const principalId = principalRows[0].id;
    expect(principalRows[0].status).toBe("active");

    // The member row and its protected projection, both from this command.
    const memberRows = await harness.memberRows(
      harness.tenantA,
      invitee.userId,
    );
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0].role).toBe("member");
    const business = await harness.businessMembership(
      harness.tenantA,
      principalId,
    );
    expect(business).toHaveLength(1);
    expect(business[0].status).toBe("active");
    expect(business[0].role).toBe("member");

    // The invited team membership exists and the team's counter moved.
    expect(
      await harness.teamMemberRows(harness.teamA, invitee.userId),
    ).toHaveLength(1);
    const [teamRow] =
      await harness.sql`SELECT member_count FROM auth_teams WHERE id = ${harness.teamA}`;
    expect(teamRow.member_count).toBe(2); // the owner + the invitee

    // Both clocks exist at their establishment versions.
    const companyClock = await harness.clockRows(
      harness.tenantA,
      principalId,
      "company",
    );
    expect(companyClock).toHaveLength(1);
    expect(companyClock[0]).toMatchObject({
      epoch: 1,
      generation: 1,
      tombstone: false,
    });
    const teamClock = await harness.clockRows(
      harness.tenantA,
      principalId,
      "team",
    );
    expect(teamClock).toHaveLength(1);
    expect(teamClock[0]).toMatchObject({ epoch: 1, generation: 1 });

    // The record settled, and one audit fact covers the whole command.
    expect((await harness.readInvitation(invitationId))?.status).toBe(
      "accepted",
    );
    expect(
      await harness.auditCountByOperation(harness.tenantA, "invitation.accept"),
    ).toBe(1);
  });

  test("existing_member_role_is_not_overwritten", async () => {
    const member = await harness.freshInvitee("existing-member");
    // The member joins company B as an auditor through the ordinary path.
    const first = await harness.invite({
      actor: harness.ownerB,
      tenantId: harness.tenantB,
      email: member.email,
      role: "auditor",
      key: "t0402-key-invite-auditor",
    });
    expect(first.status).toBe(200);
    const { resourceId: auditorInvitation } = (await first.json()) as {
      resourceId: string;
    };
    expect(
      (
        await harness.accept({
          actor: member,
          invitationId: auditorInvitation,
          key: "t0402-key-accept-auditor",
        })
      ).status,
    ).toBe(200);
    const roleBefore = (
      await harness.memberRows(harness.tenantB, member.userId)
    )[0].role;
    expect(roleBefore).toBe("auditor");

    // While they are a live member, the company refuses to invite them again.
    const lowered = await harness.invite({
      actor: harness.ownerB,
      tenantId: harness.tenantB,
      email: member.email,
      role: "member",
      key: "t0402-key-invite-lower",
    });
    expect(lowered.status).toBe(409);

    // The overwrite rule belongs to the ordering that can actually produce it:
    // an invitation that PREDATES the membership. Forge that row (a fixture
    // write, hence the unguarded path) and accept it: the record settles, the
    // role does not move.
    const invitationId = "t0402-forged-lower-invitation";
    await unguarded(harness.sql, async (tx) => {
      await tx`INSERT INTO auth_invitations
                 (id, organization_id, email, role, status, inviter_id, expires_at)
               VALUES (${invitationId}, ${harness.tenantB}, ${member.email},
                       ${"member"}, 'pending', ${harness.ownerB.userId},
                       now() + interval '1 hour')`;
    });
    const acceptedLower = await harness.accept({
      actor: member,
      invitationId,
      key: "t0402-key-accept-lower",
    });
    expect(acceptedLower.status).toBe(200);

    const roleAfter = (
      await harness.memberRows(harness.tenantB, member.userId)
    )[0].role;
    expect(roleAfter).toBe(roleBefore);
    expect((await harness.readInvitation(invitationId))?.status).toBe(
      "accepted",
    );
    // Only the one membership row exists: no duplicate from the second accept.
    expect(
      await harness.memberRows(harness.tenantB, member.userId),
    ).toHaveLength(1);
  });

  test("invitation_failure_leaves_no_partial_membership", async () => {
    const rollbackUser = await harness.freshInvitee("rollback");
    const invited = await harness.invite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email: rollbackUser.email,
      role: "member",
      workspaceIds: [harness.workspaceA],
      key: "t0402-key-invite-rollback",
    });
    expect(invited.status).toBe(200);
    const { resourceId: invitationId } = (await invited.json()) as {
      resourceId: string;
    };

    const before = {
      members: await harness.memberRows(harness.tenantA, rollbackUser.userId),
      principals: await harness.principalRows(rollbackUser.userId),
      teamMembers: await harness.teamMemberRows(
        harness.teamA,
        rollbackUser.userId,
      ),
      invitation: (await harness.readInvitation(invitationId))?.status,
    };
    expect(before.members).toHaveLength(0);

    // The fault lands AFTER the membership/clock writes: the finalizer's own
    // audit insert is the first statement that fails. That is the partial-
    // membership window this case exists for (the T02.08 recipe).
    await harness.sql.unsafe(`
      CREATE OR REPLACE FUNCTION t0402_audit_fault() RETURNS trigger
      LANGUAGE plpgsql AS $t0402_fault$
      BEGIN
        RAISE EXCEPTION 't0402 injected audit failure' USING ERRCODE = 'P0001';
      END
      $t0402_fault$`);
    await harness.sql.unsafe(`
      CREATE TRIGGER t0402_audit_fault BEFORE INSERT ON enterprise_audit_events
        FOR EACH ROW EXECUTE FUNCTION t0402_audit_fault()`);

    let refusal: unknown;
    try {
      // The executor is driven directly: the ingress builds exactly this
      // actor from a session, and the fixed build is never asked to write
      // outside the command transaction.
      await harness.directory.execute(
        {
          userId: rollbackUser.userId,
          principalId: null,
          sessionId: "t0402-rollback-session",
          kind: "session",
          bindingId: null,
          provisioning: null,
        },
        {
          operation: "invitation.accept",
          tenantId: harness.tenantA,
          idempotencyKey: "t0402-key-accept-rollback",
          payload: { invitationId },
        },
      );
    } catch (error) {
      refusal = error;
    } finally {
      await harness.sql.unsafe(
        "DROP TRIGGER IF EXISTS t0402_audit_fault ON enterprise_audit_events",
      );
      await harness.sql.unsafe("DROP FUNCTION IF EXISTS t0402_audit_fault()");
    }

    expect(refusal).toBeDefined();
    let chain = "";
    for (
      let current: unknown = refusal;
      current && chain.length < 4000;
      current = (current as { cause?: unknown }).cause
    ) {
      chain += `${current instanceof Error ? current.message : String(current)} | `;
    }
    // The injected error survives — not a compensation's 25P02.
    expect(chain).toContain("t0402 injected audit failure");
    expect(chain).not.toContain("25P02");

    // Nothing partial survived.
    const after = {
      members: await harness.memberRows(harness.tenantA, rollbackUser.userId),
      principals: await harness.principalRows(rollbackUser.userId),
      teamMembers: await harness.teamMemberRows(
        harness.teamA,
        rollbackUser.userId,
      ),
      invitation: (await harness.readInvitation(invitationId))?.status,
    };
    expect(after).toEqual(before);
    const receipts =
      await harness.sql`SELECT count(*)::int AS n FROM auth_command_receipts
                         WHERE tenant_id = ${harness.tenantA}
                           AND idempotency_key = ${"t0402-key-accept-rollback"}`;
    expect(receipts[0].n).toBe(0);
  });

  test("acceptance_requires_the_matching_verified_mailbox", async () => {
    const invitee = await harness.freshInvitee("mailbox");
    const invited = await harness.invite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email: invitee.email,
      key: "t0402-key-invite-mailbox",
    });
    const { resourceId: invitationId } = (await invited.json()) as {
      resourceId: string;
    };

    // Another verified user is not the recipient: the address decides.
    const wrongAccount = await harness.accept({
      actor: harness.owner,
      invitationId,
      key: "t0402-key-accept-wrong-account",
    });
    expect(wrongAccount.status).toBe(403);
    expect(
      await (wrongAccount.json() as Promise<{ code: string }>),
    ).toMatchObject({
      code: expect.stringContaining("RECIPIENT_MISMATCH") as string,
    });

    // An unverified mailbox is refused even when the address matches.
    const unverifiedInvite = await harness.invite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email: harness.unverified.email,
      key: "t0402-key-invite-unverified",
    });
    const { resourceId: unverifiedInvitation } =
      (await unverifiedInvite.json()) as { resourceId: string };
    const unverifiedAnswer = await harness.accept({
      actor: harness.unverified,
      invitationId: unverifiedInvitation,
      key: "t0402-key-accept-unverified",
    });
    expect(unverifiedAnswer.status).toBe(403);
    expect(
      await (unverifiedAnswer.json() as Promise<{ code: string }>),
    ).toMatchObject({
      code: expect.stringContaining("EMAIL_UNVERIFIED") as string,
    });

    // Neither refusal wrote anything.
    expect(await harness.principalRows(harness.unverified.userId)).toHaveLength(
      0,
    );
    expect((await harness.readInvitation(invitationId))?.status).toBe(
      "pending",
    );
    expect(
      await harness.memberRows(harness.tenantA, invitee.userId),
    ).toHaveLength(0);
  });

  test("expired_canceled_and_unknown_invitations_are_refused", async () => {
    const invitee = await harness.freshInvitee("stale");
    const invited = await harness.invite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email: invitee.email,
      key: "t0402-key-invite-stale",
    });
    const { resourceId: invitationId } = (await invited.json()) as {
      resourceId: string;
    };

    // Expired: the record is old, and accepting never extends it.
    await unguarded(harness.sql, async (tx) => {
      await tx`UPDATE auth_invitations
                  SET expires_at = now() - interval '1 hour'
                WHERE id = ${invitationId}`;
    });
    const expired = await harness.accept({
      actor: invitee,
      invitationId,
      key: "t0402-key-accept-expired",
    });
    expect(expired.status).toBe(409);
    expect(await (expired.json() as Promise<{ code: string }>)).toMatchObject({
      code: expect.stringContaining("EXPIRED") as string,
    });
    expect(
      await harness.memberRows(harness.tenantA, invitee.userId),
    ).toHaveLength(0);

    // Canceled: only a pending record can be answered.
    await unguarded(harness.sql, async (tx) => {
      await tx`UPDATE auth_invitations
                  SET status = 'canceled', expires_at = now() + interval '1 hour'
                WHERE id = ${invitationId}`;
    });
    const canceled = await harness.accept({
      actor: invitee,
      invitationId,
      key: "t0402-key-accept-canceled",
    });
    expect(canceled.status).toBe(409);
    expect(await (canceled.json() as Promise<{ code: string }>)).toMatchObject({
      code: expect.stringContaining("NOT_PENDING") as string,
    });

    // Unknown: not-found, never a company-inventing 400.
    const unknown = await harness.accept({
      actor: invitee,
      invitationId: "t0402-does-not-exist",
      key: "t0402-key-accept-unknown",
    });
    expect(unknown.status).toBe(404);
    expect(await (unknown.json() as Promise<{ code: string }>)).toMatchObject({
      code: expect.stringContaining("NOT_FOUND") as string,
    });
  });

  test("concurrent_accept_settles_once_and_replays_by_key", async () => {
    const invitee = await harness.freshInvitee("racer");
    const invited = await harness.invite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email: invitee.email,
      key: "t0402-key-invite-race",
    });
    const { resourceId: invitationId } = (await invited.json()) as {
      resourceId: string;
    };

    const firstKey = "t0402-key-accept-race-one";
    const secondKey = "t0402-key-accept-race-two";
    const auditsBefore = await harness.auditCountByOperation(
      harness.tenantA,
      "invitation.accept",
    );
    const [first, second] = await Promise.all([
      harness.accept({ actor: invitee, invitationId, key: firstKey }),
      harness.accept({ actor: invitee, invitationId, key: secondKey }),
    ]);
    // Exactly one wins; the loser re-reads the settled record inside the
    // tenant lock and is refused, so one member row and one audit fact exist.
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(
      await harness.memberRows(harness.tenantA, invitee.userId),
    ).toHaveLength(1);
    expect(
      await harness.auditCountByOperation(harness.tenantA, "invitation.accept"),
    ).toBe(auditsBefore + 1);

    // The winner's key replays: same command, no second write.
    const winnerKey = first.status === 200 ? firstKey : secondKey;
    const replay = await harness.accept({
      actor: invitee,
      invitationId,
      key: winnerKey,
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as {
      replayed: boolean;
      commandId: string;
    };
    expect(replayBody.replayed).toBe(true);
    expect((await harness.readInvitation(invitationId))?.status).toBe(
      "accepted",
    );
    // Still exactly one membership after the replay.
    expect(
      await harness.memberRows(harness.tenantA, invitee.userId),
    ).toHaveLength(1);
  });

  test("acceptance_refuses_a_team_that_left_the_company", async () => {
    const invitee = await harness.freshInvitee("team-gone");
    const invited = await harness.invite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email: invitee.email,
      workspaceIds: [harness.workspaceA],
      key: "t0402-key-invite-team-gone",
    });
    const { resourceId: invitationId } = (await invited.json()) as {
      resourceId: string;
    };
    // Point the invitation at company B's team: the grant no longer belongs to
    // the company the invitation names, so the acceptance is refused rather
    // than silently narrowed.
    const teamB = await harness.teamOf(harness.tenantB);
    await unguarded(harness.sql, async (tx) => {
      await tx`UPDATE auth_invitations SET team_id = ${teamB}
                 WHERE id = ${invitationId}`;
    });
    const answer = await harness.accept({
      actor: invitee,
      invitationId,
      key: "t0402-key-accept-team-gone",
    });
    expect(answer.status).toBe(409);
    expect(await (answer.json() as Promise<{ code: string }>)).toMatchObject({
      code: expect.stringContaining("TEAM_GONE") as string,
    });
    expect(
      await harness.memberRows(harness.tenantA, invitee.userId),
    ).toHaveLength(0);
  });

  test("acceptance_refuses_a_suspended_company", async () => {
    const suspendee = await harness.freshInvitee("suspendee");
    const invited = await harness.invite({
      actor: harness.ownerB,
      tenantId: harness.tenantB,
      email: suspendee.email,
      key: "t0402-key-invite-suspended-company",
    });
    expect(invited.status).toBe(200);
    const { resourceId: invitationId } = (await invited.json()) as {
      resourceId: string;
    };

    await harness.directory.execute(
      {
        userId: PLATFORM_ADMIN_ID,
        principalId: null,
        sessionId: null,
        kind: "platform",
        bindingId: null,
        provisioning: null,
      },
      {
        operation: "company.suspend",
        tenantId: harness.tenantB,
        idempotencyKey: "t0402-key-suspend-b",
        payload: { reason: "t0402 暂停公司 B" },
      },
    );
    const answer = await harness.accept({
      actor: suspendee,
      invitationId,
      key: "t0402-key-accept-suspended-company",
    });
    expect(answer.status).toBe(403);
    expect(await (answer.json() as Promise<{ code: string }>)).toMatchObject({
      code: expect.stringContaining("COMPANY_CLOSED") as string,
    });
    expect(
      await harness.memberRows(harness.tenantB, suspendee.userId),
    ).toHaveLength(0);
  });

  test("reject_grants_nothing_and_settles_the_record", async () => {
    const invitee = await harness.freshInvitee("rejecter");
    const invited = await harness.invite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email: invitee.email,
      role: "admin",
      workspaceIds: [harness.workspaceA],
      key: "t0402-key-invite-reject",
    });
    const { resourceId: invitationId } = (await invited.json()) as {
      resourceId: string;
    };
    const principalsBefore = await harness.principalRows(invitee.userId);
    const teamMembersBefore = await harness.teamMemberRows(
      harness.teamA,
      invitee.userId,
    );

    const rejected = await harness.reject({
      actor: invitee,
      invitationId,
      key: "t0402-key-reject",
    });
    expect(rejected.status).toBe(200);
    const body = (await rejected.json()) as {
      tenantId: string;
      versions: unknown[];
    };
    // A rejection grants no eligibility: no change keys, hence no versions.
    expect(body.versions).toEqual([]);

    expect((await harness.readInvitation(invitationId))?.status).toBe(
      "rejected",
    );
    // Nothing was established, nothing was removed.
    expect(
      await harness.memberRows(harness.tenantA, invitee.userId),
    ).toHaveLength(0);
    /*
     * The principal is the executor's lock-layer work, not the acceptance's:
     * every directory command resolves (and, for a genuinely new user,
     * creates) the actor's company-independent principal before the handler
     * runs. Rejecting therefore leaves a principal that grants nothing — no
     * membership, no clock, no team, no seat — which is exactly the shape the
     * design separates (one User, one Principal; a Principal is not a
     * membership).
     */
    const principalsAfter = await harness.principalRows(invitee.userId);
    expect(principalsAfter).toHaveLength(
      principalsBefore.length === 0 ? 1 : principalsBefore.length,
    );
    if (principalsBefore.length > 0) {
      expect(principalsAfter[0].id).toBe(principalsBefore[0].id);
    }
    expect(
      await harness.clockRows(
        harness.tenantA,
        principalsAfter[0].id,
        "company",
      ),
    ).toHaveLength(0);
    expect(
      await harness.businessMembership(harness.tenantA, principalsAfter[0].id),
    ).toHaveLength(0);
    expect(await harness.teamMemberRows(harness.teamA, invitee.userId)).toEqual(
      teamMembersBefore,
    );
    expect(
      await harness.auditCountByOperation(harness.tenantA, "invitation.reject"),
    ).toBe(1);

    // A rejected record cannot then be accepted.
    const late = await harness.accept({
      actor: invitee,
      invitationId,
      key: "t0402-key-accept-after-reject",
    });
    expect(late.status).toBe(409);
  });

  test("acceptance_refuses_when_no_seat_is_left", async () => {
    // A company of its own, so the seat arithmetic does not depend on what the
    // other cases did: the owner holds seat 1, and the limit is 2.
    const seatOwner = await harness.freshInvitee("seat-owner");
    const tenant = await harness.provision("t0402-key-seats", seatOwner.userId);
    const guests = await Promise.all([
      harness.freshInvitee("seat-guest-1"),
      harness.freshInvitee("seat-guest-2"),
    ]);
    const invited = [];
    for (const [index, guest] of guests.entries()) {
      const response = await harness.invite({
        actor: seatOwner,
        tenantId: tenant,
        email: guest.email,
        key: `t0402-key-invite-seat-${index}`,
      });
      expect(response.status).toBe(200);
      invited.push(
        ((await response.json()) as { resourceId: string }).resourceId,
      );
    }

    const limited = harness.directoryWithSeatLimit(2);
    const actorOf = (user: HarnessUser) => ({
      userId: user.userId,
      principalId: null,
      sessionId: `t0402-session-${user.userId}`,
      kind: "session" as const,
      bindingId: null,
      provisioning: null,
    });
    const acceptAs = (user: HarnessUser, invitationId: string, key: string) =>
      limited.execute(actorOf(user), {
        operation: "invitation.accept" as const,
        tenantId: tenant,
        idempotencyKey: key,
        payload: { invitationId },
      });

    // Seat 2 goes to the first guest.
    await expect(
      acceptAs(guests[0], invited[0], "t0402-key-seat-accept-1"),
    ).resolves.toMatchObject({ tenantId: tenant });
    expect(await harness.memberRows(tenant, guests[0].userId)).toHaveLength(1);

    // The second guest meets a full company: refused in the tenant lock, and
    // nothing of their membership survives.
    await expect(
      acceptAs(guests[1], invited[1], "t0402-key-seat-accept-2"),
    ).rejects.toMatchObject({
      code: expect.stringContaining("SEATS_EXHAUSTED") as string,
    });
    expect(await harness.memberRows(tenant, guests[1].userId)).toHaveLength(0);
    expect((await harness.readInvitation(invited[1]))?.status).toBe("pending");
  });

  test("acceptance_and_rejection_refuse_outside_the_ba_authority", async () => {
    const invitee = await harness.freshInvitee("authority");
    const invited = await harness.invite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email: invitee.email,
      key: "t0402-key-invite-authority",
    });
    const { resourceId: invitationId } = (await invited.json()) as {
      resourceId: string;
    };
    const answer = async (): Promise<number> =>
      (
        await harness.accept({
          actor: invitee,
          invitationId,
          key: `t0402-key-authority-${Math.random().toString(36).slice(2)}`,
        })
      ).status;

    await setAuthority(harness.sql, {
      phase: "M1",
      directoryAuthority: "legacy",
    });
    expect(await answer()).toBe(503);
    await setAuthority(harness.sql, {
      phase: "M2",
      directoryAuthority: "paused",
    });
    expect(await answer()).toBe(503);
    expect((await harness.readInvitation(invitationId))?.status).toBe(
      "pending",
    );
    // The BA authority admits the very same command.
    await setAuthority(harness.sql, { phase: "M4", directoryAuthority: "ba" });
    expect(await answer()).toBe(200);
  });
});
