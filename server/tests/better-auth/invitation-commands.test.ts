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
import type { DirectoryActor } from "../../src/auth/directory/contracts";
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
 * T04.01 (#545, P08) — invitation create / cancel / resend through the
 * Directory, and the own narrow read surface, on the real 0209–0215 stack of
 * the isolated BA_TEST_* island (interfaces §2 payload table, §3.1 resend
 * ruling, §3.2 U-class adapter). What this file pins, as database facts:
 *
 * - `invitation_role_cannot_delegate_owner_or_finance`: the HTTP invite
 *   translation answers a non-delegable role (owner, finance, platform) with
 *   a named 403 and leaves zero invitation rows behind.
 * - `own_invitation_adapter_never_lists_another_email`: the own read adapter
 *   returns only invitations whose email matches the caller's verified
 *   address — never another person's, never the company's directory.
 * - create is one atomic command: the guarded pending row, the finalized
 *   receipt and its audit fact share one commit; a same-key retry replays;
 *   the in-lock checks (company live, actor admin, email shape, workspace
 *   ownership, already-member, already-pending) refuse by name.
 * - cancel/resend are OpenBot controlled commands: resend CANCELS the old
 *   record and INSERTS a fresh one in the same transaction (the inner
 *   invitation.create envelope the T02.06 guard's marker protocol admits),
 *   keeping an audit row for each half, and never touches the pinned build's
 *   native resend branch (crud-invites.mjs:138's direct expiresAt write is
 *   unreachable: `resend:true` is refused by name at the ingress).
 * - the native invitation GETs stay closed (X); accept/reject are wired by
 *   T04.02 and refuse an unknown invitation by name (404); a suspended
 *   company closes the invitation commands.
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
  "t0401-invitation-commands-fixed-test-secret-not-a-credential";
const DEFAULT_PASSWORD = "correct-horse-battery-staple";
const PLATFORM_ADMIN_ID = "t0401-platform-admin";
const EMAIL_DOMAIN = "@t0401.example.test";

/** Every provision key the suite creates companies under; cleanup is exact. */
const PROVISION_KEYS = ["t0401-key-company", "t0401-key-suspended"] as const;

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
        `${variable} is required: the invitation-commands suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
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

/** Returns the island to the pre-suite shape (the T03.04 recipe, t0401 rows). */
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
  await sql`DELETE FROM enterprise_principals WHERE user_id IN (
    SELECT id FROM users WHERE email LIKE ${`t0401-%${EMAIL_DOMAIN}`}
       OR id = ${PLATFORM_ADMIN_ID})`;
  await sql`DELETE FROM enterprise_workspaces WHERE tenant_id IN (${sql.unsafe(
    tenantIds.map((id) => `'${id}'`).join(","),
  )})`;
  await sql`DELETE FROM enterprise_tenants WHERE id IN (${sql.unsafe(
    tenantIds.map((id) => `'${id}'`).join(","),
  )})`;
  await sql`DELETE FROM user_roles WHERE user_id = ${PLATFORM_ADMIN_ID}`;
  await sql`DELETE FROM users WHERE email LIKE ${`t0401-%${EMAIL_DOMAIN}`} OR id = ${PLATFORM_ADMIN_ID}`;
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
  tenantB: string;
  workspaceB: string;
  owner: HarnessUser;
  outsider: HarnessUser;
  invitee1: HarnessUser;
  invitee2: HarnessUser;
  unverified: HarnessUser;
  directory: ReturnType<typeof createDirectoryExecutor>;
  postInvite(input: {
    actor: HarnessUser;
    tenantId: string;
    email: string;
    role?: string;
    workspaceIds?: string[];
    key: string;
    resend?: boolean;
  }): Promise<Response>;
  postCancel(input: {
    actor: HarnessUser;
    tenantId: string;
    invitationId: string;
    key: string;
  }): Promise<Response>;
  resendCommand(input: {
    actor: HarnessUser;
    tenantId: string;
    invitationId: string;
    key: string;
  }): Promise<{ status: number; body: Record<string, unknown> }>;
  readInvitation(id: string): Promise<InvitationRow | undefined>;
  pendingCount(tenantId: string): Promise<number>;
  auditCount(tenantId: string, commandId: string): Promise<number>;
  auditCountByOperation(tenantId: string, operation: string): Promise<number>;
}

async function buildHarness(sql: postgres.Sql): Promise<Harness> {
  const setupUrl = process.env[DATABASE_VARIABLE]!.trim();
  const db = createDatabase(setupUrl, { max: 4 });

  /*
   * The fixed Better Auth build over the island's REAL public tables: the
   * model→table map the pinned drizzle adapter resolves through, so the
   * harness's sign-ins and the handlers' fixed-build writes land on exactly
   * the guarded surfaces the production assembly owns.
   */
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
  const directory = createDirectoryExecutor({
    database: db,
    bound,
    authority,
    registry: principalRegistry,
    finalizer,
    handlers: {
      "company.provision": createCompanyProvisionHandler(),
      "company.suspend": createCompanySuspendHandler(),
      ...createInvitationMembershipHandlers({ ba }),
    },
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

  const reader = createOwnInvitationReader(db);
  const readRoutes = createInvitationReadRoutes({
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
    reader,
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
  app.route("/api/enterprise/invitations", readRoutes);

  const [owner, outsider, invitee1, invitee2, unverified] = await Promise.all([
    signUp(`t0401-owner${EMAIL_DOMAIN}`, "T04.01 Owner"),
    signUp(`t0401-outsider${EMAIL_DOMAIN}`, "T04.01 Outsider"),
    signUp(`t0401-invited-1${EMAIL_DOMAIN}`, "T04.01 Invitee One"),
    signUp(`t0401-invited-2${EMAIL_DOMAIN}`, "T04.01 Invitee Two"),
    signUp(`t0401-unverified${EMAIL_DOMAIN}`, "T04.01 Unverified"),
  ]);
  // The own read adapter matches on a VERIFIED address only; verification
  // mail itself is T04.04's wiring, so the harness pins the fact directly.
  await sql`UPDATE users SET email_verified = true
             WHERE email IN (${owner.email}, ${outsider.email}, ${invitee1.email}, ${invitee2.email})`;

  const provision = async (key: string, ownerUserId: string) => {
    const tenantId = preAllocateProvisionTenantId(key);
    await provisioner.provision({
      actorUserId: PLATFORM_ADMIN_ID,
      idempotencyKey: key,
      name: `T04.01 公司 ${key}`,
      slug: `t0401-${key}`,
      ownerUserId,
      defaultTeamName: "默认团队",
    });
    return tenantId;
  };
  const tenantA = await provision("t0401-key-company", owner.userId);
  const tenantB = await provision("t0401-key-suspended", outsider.userId);

  const sessionActorOf = async (user: HarnessUser): Promise<DirectoryActor> => {
    const rows =
      await sql`SELECT id FROM sessions WHERE token = ${user.sessionToken} LIMIT 1`;
    const sessionId = rows[0]?.id;
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error(`no session row for ${user.email}`);
    }
    return Object.freeze({
      userId: user.userId,
      principalId: null,
      sessionId,
      kind: "session" as const,
      bindingId: null,
      provisioning: null,
    });
  };

  return {
    app,
    sql,
    directory,
    tenantA,
    workspaceA: preAllocateProvisionWorkspaceId(tenantA),
    tenantB,
    workspaceB: preAllocateProvisionWorkspaceId(tenantB),
    owner,
    outsider,
    invitee1,
    invitee2,
    unverified,
    postInvite: ({ actor, tenantId, email, role, workspaceIds, key, resend }) =>
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
          ...(resend ? { resend: true } : {}),
        }),
      }),
    postCancel: ({ actor, tenantId, invitationId, key }) =>
      app.request("/api/auth/organization/cancel-invitation", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: actor.cookie,
          "idempotency-key": key,
        },
        body: JSON.stringify({ organizationId: tenantId, invitationId }),
      }),
    resendCommand: async ({ actor, tenantId, invitationId, key }) => {
      try {
        const result = await directory.execute(await sessionActorOf(actor), {
          operation: "invitation.resend",
          tenantId,
          idempotencyKey: key,
          payload: { invitationId },
        });
        return {
          status: 200,
          body: result as unknown as Record<string, unknown>,
        };
      } catch (error) {
        const refusal = error as { status?: number; code?: string };
        return {
          status: refusal.status ?? 500,
          body: { code: refusal.code ?? "UNKNOWN", error: String(error) },
        };
      }
    },
    readInvitation: async (id) => {
      const rows =
        await sql`SELECT id, organization_id, email, role, status, team_id, expires_at::text AS expires_at
                    FROM auth_invitations WHERE id = ${id} LIMIT 1`;
      return rows[0] as InvitationRow | undefined;
    },
    pendingCount: async (tenantId) => {
      const rows = await sql`SELECT count(*)::int AS n FROM auth_invitations
                              WHERE organization_id = ${tenantId}
                                AND status = 'pending' AND expires_at > now()`;
      return rows[0].n;
    },
    auditCount: async (tenantId, commandId) => {
      const rows =
        await sql`SELECT count(*)::int AS n FROM enterprise_audit_events
                              WHERE tenant_id = ${tenantId}
                                AND event_type = 'directory.command.finalized'
                                AND payload->>'commandId' = ${commandId}`;
      return rows[0].n;
    },
    auditCountByOperation: async (tenantId, operation) => {
      const rows =
        await sql`SELECT count(*)::int AS n FROM enterprise_audit_events
                              WHERE tenant_id = ${tenantId}
                                AND event_type = 'directory.command.finalized'
                                AND payload->>'operation' = ${operation}`;
      return rows[0].n;
    },
  };
}

describe("T04.01 invitation create/cancel/resend and the own narrow read", () => {
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
        (${PLATFORM_ADMIN_ID}, ${`t0401-admin${EMAIL_DOMAIN}`})`;
    await sql`
      INSERT INTO user_roles (user_id, role) VALUES (${PLATFORM_ADMIN_ID}, 'admin')`;
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

  test("invitation_role_cannot_delegate_owner_or_finance", async () => {
    const before = await harness.pendingCount(harness.tenantA);
    const ownerGrant = await harness.postInvite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email: `t0401-delegate-owner${EMAIL_DOMAIN}`,
      role: "owner",
      key: "t0401-key-role-owner",
    });
    expect(ownerGrant.status).toBe(403);
    expect(
      await (ownerGrant.json() as Promise<{ code: string }>),
    ).toMatchObject({
      code: expect.stringContaining("ROLE_NOT_DELEGABLE") as string,
    });
    const financeGrant = await harness.postInvite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email: `t0401-delegate-finance${EMAIL_DOMAIN}`,
      role: "finance",
      key: "t0401-key-role-finance",
    });
    expect(financeGrant.status).toBe(403);
    const platformGrant = await harness.postInvite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email: `t0401-delegate-platform${EMAIL_DOMAIN}`,
      role: "platform",
      key: "t0401-key-role-platform",
    });
    expect(platformGrant.status).toBe(403);
    // A refused delegation writes nothing.
    expect(await harness.pendingCount(harness.tenantA)).toBe(before);
  });

  test("invitation_create_is_one_atomic_command_with_audit_and_replay", async () => {
    const email = `t0401-atomic${EMAIL_DOMAIN}`;
    const created = await harness.postInvite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email,
      role: "member",
      key: "t0401-key-create-atomic",
    });
    expect(created.status).toBe(200);
    const body = (await created.json()) as {
      commandId: string;
      replayed: boolean;
      resourceId: string | null;
    };
    expect(body.replayed).toBe(false);
    expect(typeof body.resourceId).toBe("string");
    const row = await harness.readInvitation(body.resourceId as string);
    expect(row?.status).toBe("pending");
    expect(row?.email).toBe(email);
    expect(row?.organization_id).toBe(harness.tenantA);
    expect(row?.role).toBe("member");
    expect(await harness.auditCount(harness.tenantA, body.commandId)).toBe(1);

    // The same key + the same payload is a replay, not a second invitation.
    const replay = await harness.postInvite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email,
      role: "member",
      key: "t0401-key-create-atomic",
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as {
      replayed: boolean;
      commandId: string;
    };
    expect(replayBody.replayed).toBe(true);
    expect(replayBody.commandId).toBe(body.commandId);
    expect(await harness.pendingCount(harness.tenantA)).toBe(1);
  });

  test("invitation_create_validates_company_team_email_and_role_in_lock", async () => {
    const malformed = await harness.postInvite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email: "not-an-email",
      role: "member",
      key: "t0401-key-email-shape",
    });
    expect(malformed.status).toBe(400);

    // A workspace of ANOTHER company is an invisible object, never a guess.
    const foreignWorkspace = await harness.postInvite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email: `t0401-foreign-ws${EMAIL_DOMAIN}`,
      role: "member",
      workspaceIds: [harness.workspaceB],
      key: "t0401-key-foreign-workspace",
    });
    expect(foreignWorkspace.status).toBe(404);

    // A non-member of the company cannot invite, not even its own owner-of-
    // another-company self.
    const outsiderInvite = await harness.postInvite({
      actor: harness.outsider,
      tenantId: harness.tenantA,
      email: `t0401-by-outsider${EMAIL_DOMAIN}`,
      role: "member",
      key: "t0401-key-outsider",
    });
    expect(outsiderInvite.status).toBe(403);

    // An existing member of the company cannot be invited again.
    const memberInvite = await harness.postInvite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email: harness.owner.email,
      role: "member",
      key: "t0401-key-already-member",
    });
    expect(memberInvite.status).toBe(409);

    // A pending invitation for the same address is a conflict, and the
    // pinned build's native resend branch never runs to "resolve" it.
    const email = `t0401-duplicate${EMAIL_DOMAIN}`;
    await harness.postInvite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email,
      key: "t0401-key-duplicate-first",
    });
    const duplicate = await harness.postInvite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email,
      key: "t0401-key-duplicate-second",
    });
    expect(duplicate.status).toBe(409);
  });

  test("own_invitation_adapter_never_lists_another_email", async () => {
    await harness.postInvite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email: harness.invitee1.email,
      role: "member",
      key: "t0401-key-read-inv1",
    });
    await harness.postInvite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email: harness.invitee2.email,
      role: "auditor",
      key: "t0401-key-read-inv2",
    });
    const listed = await harness.app.request("/api/enterprise/invitations", {
      headers: { cookie: harness.invitee1.cookie },
    });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      invitations: { email: string; status: string }[];
    };
    const invites = body.invitations;
    expect(invites.length).toBeGreaterThan(0);
    const isOwn = (invitation: { email: string }) =>
      invitation.email === harness.invitee1.email;
    expect(invites.every(isOwn)).toBe(true);

    // The other invitee sees only their own invitation, never the first
    // one, never the company's directory.
    const others = await harness.app.request("/api/enterprise/invitations", {
      headers: { cookie: harness.invitee2.cookie },
    });
    const otherBody = (await others.json()) as {
      invitations: { email: string }[];
    };
    expect(otherBody.invitations.length).toBe(1);
    expect(otherBody.invitations[0].email).toBe(harness.invitee2.email);
  });

  test("own_adapter_landing_and_one_are_verified_email_scoped", async () => {
    const email = `t0401-landing${EMAIL_DOMAIN}`;
    const created = await harness.postInvite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email,
      role: "member",
      key: "t0401-key-landing",
    });
    expect(created.status).toBe(200);
    const { resourceId } = (await created.json()) as { resourceId: string };
    expect(typeof resourceId).toBe("string");

    // Unauthenticated: the minimal landing status only — no email, no
    // company, no role, no directory.
    const landing = await harness.app.request(
      `/api/enterprise/invitations/${resourceId}`,
    );
    expect(landing.status).toBe(200);
    const landingBody = (await landing.json()) as {
      invitation: Record<string, unknown>;
    };
    expect(Object.keys(landingBody.invitation).sort()).toEqual([
      "expired",
      "invitationId",
      "status",
    ]);
    expect(landingBody.invitation.status).toBe("pending");
    expect(landingBody.invitation.expired).toBe(false);

    // An unknown landing id is a not-found, never a directory oracle.
    const unknown = await harness.app.request(
      "/api/enterprise/invitations/t0401-does-not-exist",
    );
    expect(unknown.status).toBe(404);

    // Authenticated and verified: the full own view, matched by the verified
    // mailbox. The natural subject is invitee1's own pending tenant-A
    // invitation (the listing test's row — nobody owns the landing mailbox),
    // read straight from the table like every other harness verification.
    const [ownRow] = await harness.sql`SELECT id FROM auth_invitations
                                      WHERE organization_id = ${harness.tenantA}
                                        AND lower(email) = lower(${harness.invitee1.email})
                                        AND status = 'pending' LIMIT 1`;
    expect(typeof ownRow?.id).toBe("string");
    const own = await harness.app.request(
      `/api/enterprise/invitations/${ownRow.id}`,
      { headers: { cookie: harness.invitee1.cookie } },
    );
    expect(own.status).toBe(200);
    const ownBody = (await own.json()) as {
      invitation: { email: string; organizationId: string; role: string };
    };
    expect(ownBody.invitation.email).toBe(harness.invitee1.email);
    expect(ownBody.invitation.organizationId).toBe(harness.tenantA);
    expect(ownBody.invitation.role).toBe("member");
    const stranger = await harness.app.request(
      `/api/enterprise/invitations/${ownRow.id}`,
      { headers: { cookie: harness.invitee2.cookie } },
    );
    expect(stranger.status).toBe(404);

    // An unauthenticated listing has no "own" to serve.
    const anonymousList = await harness.app.request(
      "/api/enterprise/invitations",
    );
    expect(anonymousList.status).toBe(401);
  });

  test("unverified_email_matches_no_invitations", async () => {
    await harness.postInvite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email: harness.unverified.email,
      role: "member",
      key: "t0401-key-unverified",
    });
    const listed = await harness.app.request("/api/enterprise/invitations", {
      headers: { cookie: harness.unverified.cookie },
    });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { invitations: unknown[] };
    expect(body.invitations).toEqual([]);
    // Even a direct lookup by id answers not-found for an unverified email.
    const rows = await harness.sql`SELECT id FROM auth_invitations
                          WHERE email = ${harness.unverified.email} LIMIT 1`;
    const one = await harness.app.request(
      `/api/enterprise/invitations/${rows[0].id}`,
      { headers: { cookie: harness.unverified.cookie } },
    );
    expect(one.status).toBe(404);
  });

  test("invitation_cancel_is_a_controlled_command", async () => {
    const created = await harness.postInvite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email: `t0401-cancel${EMAIL_DOMAIN}`,
      role: "member",
      key: "t0401-key-cancel-create",
    });
    const { resourceId } = (await created.json()) as { resourceId: string };

    // The invitee (not a member of the company) cannot cancel.
    const byInvitee = await harness.postCancel({
      actor: harness.invitee1,
      tenantId: harness.tenantA,
      invitationId: resourceId,
      key: "t0401-key-cancel-by-invitee",
    });
    expect(byInvitee.status).toBe(403);

    const canceled = await harness.postCancel({
      actor: harness.owner,
      tenantId: harness.tenantA,
      invitationId: resourceId,
      key: "t0401-key-cancel-ok",
    });
    expect(canceled.status).toBe(200);
    expect((await harness.readInvitation(resourceId))?.status).toBe("canceled");

    // A same-key retry replays; a new key on a canceled record conflicts.
    const replay = await harness.postCancel({
      actor: harness.owner,
      tenantId: harness.tenantA,
      invitationId: resourceId,
      key: "t0401-key-cancel-ok",
    });
    expect(((await replay.json()) as { replayed: boolean }).replayed).toBe(
      true,
    );
    const again = await harness.postCancel({
      actor: harness.owner,
      tenantId: harness.tenantA,
      invitationId: resourceId,
      key: "t0401-key-cancel-again",
    });
    expect(again.status).toBe(409);
  });

  test("invitation_resend_cancels_old_and_creates_new_atomically", async () => {
    const email = `t0401-resend${EMAIL_DOMAIN}`;
    const created = await harness.postInvite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email,
      role: "admin",
      key: "t0401-key-resend-create",
    });
    const { resourceId: originalId } = (await created.json()) as {
      resourceId: string;
    };
    const original = await harness.readInvitation(originalId);
    const auditBefore = await harness.auditCountByOperation(
      harness.tenantA,
      "invitation.create",
    );

    const resent = await harness.resendCommand({
      actor: harness.owner,
      tenantId: harness.tenantA,
      invitationId: originalId,
      key: "t0401-key-resend-1",
    });
    expect(resent.status).toBe(200);
    const resentBody = resent.body as {
      resourceId: string | null;
      replayed: boolean;
    };
    expect(resentBody.replayed).toBe(false);
    const renewedId = resentBody.resourceId;
    expect(typeof renewedId).toBe("string");
    expect(renewedId).not.toBe(originalId);

    // The old record is CANCELED — the native branch would have flipped
    // expiresAt in place instead, and resurrection is what the ruling forbids.
    const oldRow = await harness.readInvitation(originalId);
    expect(oldRow?.status).toBe("canceled");
    const newRow = await harness.readInvitation(renewedId as string);
    expect(newRow?.status).toBe("pending");
    expect(newRow?.email).toBe(email);
    expect(newRow?.role).toBe("admin");
    expect(new Date(newRow!.expires_at).getTime()).toBeGreaterThan(
      new Date(original!.expires_at).getTime(),
    );

    // The compound keeps its audit facts: the fresh half rides the resend
    // command's own receipt (one audit, operation=invitation.resend — it is
    // not a second command, so no second create audit), and the original
    // create's audit is untouched.
    expect(
      await harness.auditCountByOperation(harness.tenantA, "invitation.create"),
    ).toBe(auditBefore);
    expect(
      await harness.auditCountByOperation(harness.tenantA, "invitation.resend"),
    ).toBe(1);

    // A same-key retry of the resend replays without a second renewal.
    const replay = await harness.resendCommand({
      actor: harness.owner,
      tenantId: harness.tenantA,
      invitationId: originalId,
      key: "t0401-key-resend-1",
    });
    expect((replay.body as { replayed: boolean }).replayed).toBe(true);
    // Exactly one live invitation remains for the address: the renewal.
    const liveForAddress = await harness.sql`SELECT count(*)::int AS n
                                               FROM auth_invitations
                                              WHERE organization_id = ${harness.tenantA}
                                                AND lower(email) = ${email}
                                                AND status = 'pending'
                                                AND expires_at > now()`;
    expect(liveForAddress[0].n).toBe(1);
  });

  test("resend_does_not_revive_canceled_records", async () => {
    const email = `t0401-resend-dead${EMAIL_DOMAIN}`;
    const created = await harness.postInvite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email,
      key: "t0401-key-resend-dead-create",
    });
    const { resourceId } = (await created.json()) as { resourceId: string };
    await harness.postCancel({
      actor: harness.owner,
      tenantId: harness.tenantA,
      invitationId: resourceId,
      key: "t0401-key-resend-dead-cancel",
    });
    const pendingBeforeRefusal = await harness.pendingCount(harness.tenantA);
    const resent = await harness.resendCommand({
      actor: harness.owner,
      tenantId: harness.tenantA,
      invitationId: resourceId,
      key: "t0401-key-resend-dead",
    });
    expect(resent.status).toBe(409);
    expect((resent.body as { code: string }).code).toContain(
      "INVITATION_NOT_PENDING",
    );
    // The dead record stays dead AND the island's pending set is unchanged:
    // a refused resend neither revives nor creates anything.
    expect(await harness.pendingCount(harness.tenantA)).toBe(
      pendingBeforeRefusal,
    );
  });

  test("native_resend_branch_is_unreachable_through_the_ingress", async () => {
    const email = `t0401-native-resend${EMAIL_DOMAIN}`;
    const created = await harness.postInvite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email,
      key: "t0401-key-native-resend-create",
    });
    const { resourceId } = (await created.json()) as { resourceId: string };
    const before = await harness.readInvitation(resourceId);
    const resendFlag = await harness.postInvite({
      actor: harness.owner,
      tenantId: harness.tenantA,
      email,
      key: "t0401-key-native-resend-flag",
      resend: true,
    });
    expect(resendFlag.status).toBe(400);
    expect(
      await (resendFlag.json() as Promise<{ code: string }>),
    ).toMatchObject({
      code: expect.stringContaining("RESEND_IS_CONTROLLED") as string,
    });
    // The old record is untouched: no in-place expiresAt extension.
    const after = await harness.readInvitation(resourceId);
    expect(after?.expires_at).toBe(before?.expires_at);
    expect(after?.status).toBe("pending");
  });

  test("native_invitation_gets_stay_closed", async () => {
    const getInvitation = await harness.app.request(
      `/api/auth/organization/get-invitation?id=t0401-anything`,
      { headers: { cookie: harness.owner.cookie } },
    );
    expect(getInvitation.status).toBe(403);
    const listUserInvitations = await harness.app.request(
      "/api/auth/organization/list-user-invitations",
      { headers: { cookie: harness.owner.cookie } },
    );
    expect(listUserInvitations.status).toBe(403);
  });

  // The premise of this case changed with T04.02: accept/reject are now wired
  // through the same handler factory, so an unknown invitation is refused by
  // the acceptance half (404) instead of falling through to "not wired" (503).
  test("accept_and_reject_are_wired_and_refuse_an_unknown_invitation", async () => {
    const post = async (path: string, key: string): Promise<Response> =>
      harness.app.request(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: harness.invitee1.cookie,
          "idempotency-key": key,
        },
        body: JSON.stringify({
          organizationId: harness.tenantA,
          invitationId: "t0401-unwired",
        }),
      });

    const accept = await post(
      "/api/auth/organization/accept-invitation",
      "t0401-key-accept-unwired",
    );
    expect(accept.status).toBe(404);
    expect(await (accept.json() as Promise<{ code: string }>)).toMatchObject({
      code: expect.stringContaining("INVITATION_NOT_FOUND") as string,
    });

    const reject = await post(
      "/api/auth/organization/reject-invitation",
      "t0401-key-reject-unwired",
    );
    expect(reject.status).toBe(404);
    expect(await (reject.json() as Promise<{ code: string }>)).toMatchObject({
      code: expect.stringContaining("INVITATION_NOT_FOUND") as string,
    });
  });

  test("authority_matrix_refuses_invitation_writes_outside_ba", async () => {
    const email = `t0401-authority${EMAIL_DOMAIN}`;
    const inviteUnder = async (): Promise<number> =>
      (
        await harness.postInvite({
          actor: harness.owner,
          tenantId: harness.tenantA,
          email,
          key: `t0401-key-authority-${Math.random().toString(36).slice(2)}`,
        })
      ).status;
    const before = await harness.pendingCount(harness.tenantA);
    await setAuthority(harness.sql, {
      phase: "M1",
      directoryAuthority: "legacy",
    });
    expect(await inviteUnder()).toBe(503);
    await setAuthority(harness.sql, {
      phase: "M2",
      directoryAuthority: "paused",
    });
    expect(await inviteUnder()).toBe(503);
    expect(await harness.pendingCount(harness.tenantA)).toBe(before);
    await setAuthority(harness.sql, { phase: "M4", directoryAuthority: "ba" });
  });

  test("suspended_company_closes_invitation_commands", async () => {
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
        idempotencyKey: "t0401-key-suspend-b",
        payload: { reason: "t0401 暂停公司 B" },
      },
    );
    const invited = await harness.postInvite({
      actor: harness.outsider,
      tenantId: harness.tenantB,
      email: `t0401-suspended${EMAIL_DOMAIN}`,
      key: "t0401-key-suspended-invite",
    });
    expect(invited.status).toBe(403);
    expect(await harness.pendingCount(harness.tenantB)).toBe(0);
  });
});
