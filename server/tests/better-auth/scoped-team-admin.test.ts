import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import type { Hono } from "hono";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { createDirectoryAuthority } from "../../src/auth/directory/authority";
import type {
  DirectoryActor,
  DirectoryOperation,
  DirectoryResult,
} from "../../src/auth/directory/contracts";
import {
  createDirectoryExecutor,
  DirectoryCommandRefusal,
} from "../../src/auth/directory/executor";
import { createDirectoryFinalizer } from "../../src/auth/directory/finalizer";
import {
  createCompanyProvisionHandler,
  preAllocateProvisionTenantId,
} from "../../src/auth/directory/lifecycle";
import {
  createFixedVersionInvitationCommands,
  createInvitationMembershipHandlers,
  createMembershipAdminTranslation,
  createMembershipLifecycleHandlers,
  MEMBERSHIP_LIFECYCLE_PAUSED,
} from "../../src/auth/directory/membership";
import { principalRegistry } from "../../src/auth/directory/principal-registry";
import {
  createFixedVersionTeamMemberCommands,
  createScopedTeamExtension,
  createScopedTeamMemberHandlers,
  isTeamMemberRefusal,
  PROVISIONING_RULE_NOT_APPROVED,
  TEAM_MEMBER_ALREADY_MEMBER,
  TEAM_MEMBER_GRANT_NOT_COVERING,
  TEAM_MEMBER_GRANT_REQUIRED,
  TEAM_MEMBER_GRANT_STALE,
  TEAM_MEMBER_NOT_A_MEMBER,
  TEAM_MEMBER_TEAM_UNBOUND,
  TeamMemberRefusal,
} from "../../src/auth/directory/team-extension";
import {
  createTeamManagementGrantHandler,
  createTeamManagementRevokeHandler,
} from "../../src/auth/directory/team-grants";
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
import {
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import { createPlatformCompanyProvisionService } from "../../src/enterprise/tenancy/provision";
import {
  type CompanyAdminContext,
  createCompanyAdminAuthorizer,
  createWorkspaceAdminService,
} from "../../src/enterprise/tenancy/workspace-admin";
import { createWorkspaceScopeRoutes } from "../../src/enterprise/tenancy/workspace-scope-routes";

/*
 * T04.08 (#552, P09) — team.member.add / team.member.remove: the scoped
 * team-admin pair on the real 0209–0217 stack of the isolated BA_TEST_*
 * island. What this file pins, as database facts:
 *
 * - `scoped_team_admin_can_manage_only_team_a` (the Brief's first named
 *   case): a plain member holding the one stable grant for (tenant,
 *   workspace) seats and unseats exactly that team's members, through the
 *   capability-consuming extension; a grant of ANOTHER company authorizes
 *   nothing here (invisible, by name), and a re-grant narrowed to add-only
 *   refuses the remove half. The owner's company-role branch runs the same
 *   handler end to end.
 * - `revoked_grant_cannot_replay_success_receipt` (the second named case):
 *   after team.management.revoke, the SAME admin's next command re-runs the
 *   locked authorize and is refused 403 — the earlier success receipt never
 *   lends its authority to a revoked grant.
 * - `no_second_same_shape_member_route_is_registered` (the third named case):
 *   the workspace-scope surface registers exactly one POST members route and
 *   one DELETE member route; the translation rides the EXISTING routes
 *   (Hono reads :userId and :principalId as the same pattern, so a second
 *   same-shape route is a conflict, not an addition).
 * - plus: a stale grant basis (the grantee suspended — design §4.4's
 *   generation comparison) refuses by name; a scim actor is refused (the
 *   provisioning-rule branch is P12's wiring, disclosed in the task report);
 *   the old entrances' ba branch (the service's translatedTeamMemberOrNull)
 *   reports directory provenance over the REAL authorizer-issued admin
 *   context, keeps the invisible not-found for another company's principal,
 *   and answers the paused mode's one named 503; the route surface projects
 *   the refusal family with each refusal's own status instead of a 500.
 *
 * All five BA_TEST_* role URLs are required; a missing one is a blocked
 * suite, never a fallback. No DSN is ever printed. Every grant fact is
 * produced by the real team.management.grant command — no forged grant row.
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
  "0221_better_auth_directory",
  "0222_better_auth_clocks",
  "0223_better_auth_command_authority",
  "0224_better_auth_authority_sources",
  "0225_better_auth_assurance",
  "0226_better_auth_schema_roles",
  "0227_better_auth_company_lifecycle",
  "0228_better_auth_invitation_resend",
  "0229_better_auth_team_management_grants",
] as const;

/** Everything the migrations above create (the T02.15 closed inventory + 0217). */
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
 * of truth) rather than re-invented — and removes them again only when it
 * created them.
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

const PLATFORM_ADMIN_ID = "t0408-platform-admin";
const EMAIL_DOMAIN = "@t0408.example.test";
const DEFAULT_PASSWORD = "correct-horse-battery-staple";

const PROVISION_KEYS = [
  "t0408-key-company",
  "t0408-key-second",
  "t0408-key-third",
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
        `${variable} is required: the scoped-team-admin suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
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

async function dropAuditTable(sql: postgres.Sql): Promise<void> {
  await sql`DROP POLICY IF EXISTS "enterprise_audit_event_operator_insert" ON "enterprise_audit_events"`;
  await sql`DROP POLICY IF EXISTS "enterprise_audit_event_operator_read" ON "enterprise_audit_events"`;
  await sql`DROP TABLE IF EXISTS "enterprise_audit_events"`;
}

/** Returns the island to the pre-suite shape (the T04.02 recipe, t0408 rows). */
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
    SELECT id FROM users WHERE email LIKE ${`t0408-%${EMAIL_DOMAIN}`}
       OR id = ${PLATFORM_ADMIN_ID})`;
  await sql`DELETE FROM enterprise_workspaces WHERE tenant_id IN (${quoted})`;
  await sql`DELETE FROM enterprise_tenants WHERE id IN (${quoted})`;
  await sql`DELETE FROM user_roles WHERE user_id = ${PLATFORM_ADMIN_ID}`;
  await sql`DELETE FROM users WHERE email LIKE ${`t0408-%${EMAIL_DOMAIN}`} OR id = ${PLATFORM_ADMIN_ID}`;
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
}

interface Harness {
  sql: postgres.Sql;
  /** The provisioned owner of every company this suite creates. */
  owner: HarnessUser;
  provision(key: string, ownerUserId: string): Promise<string>;
  workspaceOf(tenantId: string): Promise<string>;
  principalIdOf(userId: string): Promise<string>;
  /** Runs one directory command against the real executor (session actor). */
  run(input: {
    actorUserId: string;
    tenantId: string;
    operation: DirectoryOperation;
    key: string;
    payload: Record<string, unknown>;
  }): Promise<DirectoryResult>;
  /** The translation port every old entrance's ba branch runs through. */
  translation: Awaited<ReturnType<typeof createMembershipAdminTranslation>>;
  joinMember(input: {
    tenantId: string;
    workspaceIds: readonly string[];
    role?: string;
    label: string;
    keySuffix: string;
  }): Promise<HarnessUser>;
  auditCountByOperation(tenantId: string, operation: string): Promise<number>;
  receiptOf(
    tenantId: string,
    key: string,
  ): Promise<{ command_id: string } | null>;
  grantRows(grantId: string): Promise<{ status: string }[]>;
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
    secret: "t0408-island-test-secret",
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
    const body = (await response.json()) as { user: { id: string } };
    // Verification MAIL delivery is T04.04's wiring; the harness pins the
    // fact directly, exactly as the T04.01–T04.03 suites do.
    await sql`UPDATE users SET email_verified = true WHERE email = ${email.toLowerCase()}`;
    return { userId: body.user.id, email: email.toLowerCase() };
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
  const ba = createFixedVersionInvitationCommands(authContext, {
    teams: { enabled: true },
  });
  const directory = createDirectoryExecutor({
    database: db,
    bound,
    authority,
    registry: principalRegistry,
    finalizer: createDirectoryFinalizer(),
    handlers: {
      "company.provision": createCompanyProvisionHandler(),
      ...createInvitationMembershipHandlers({ ba }),
      ...createMembershipLifecycleHandlers(),
      "team.management.grant": createTeamManagementGrantHandler(),
      "team.management.revoke": createTeamManagementRevokeHandler(),
      // T04.08's own pair: the capability's only consumption path. The
      // extension rides the SAME fixed adapter the invitation commands use,
      // so a translated seat change and an accepted invitation write through
      // one indistinguishable BA surface.
      ...createScopedTeamMemberHandlers({
        extension: createScopedTeamExtension({
          commands: createFixedVersionTeamMemberCommands(authContext, {
            teams: { enabled: true },
          }),
        }),
      }),
    },
  });
  const translation = createMembershipAdminTranslation({
    database: db,
    authority,
    directory,
  });
  const provisioner = createPlatformCompanyProvisionService({
    database: db,
    directory,
    billing: {
      async initialize(tenantId: string): Promise<PayerAccount> {
        return ensureProvisionedCompanyPayerAccount(db, { tenantId });
      },
    },
  });

  const sessionActor = (userId: string): DirectoryActor => ({
    userId,
    principalId: null,
    sessionId: `t0408-session-${userId}`,
    kind: "session",
    bindingId: null,
    provisioning: null,
  });

  const run: Harness["run"] = (input) =>
    directory.execute(sessionActor(input.actorUserId), {
      operation: input.operation,
      tenantId: input.tenantId,
      idempotencyKey: input.key,
      payload: input.payload,
    });

  const provision = async (key: string, ownerUserId: string) => {
    const tenantId = preAllocateProvisionTenantId(key);
    await provisioner.provision({
      actorUserId: PLATFORM_ADMIN_ID,
      idempotencyKey: key,
      name: `T04.08 公司 ${key}`,
      slug: `t0408-${key}`,
      ownerUserId,
      defaultTeamName: "默认团队",
    });
    return tenantId;
  };

  const owner = await signUp(`t0408-owner${EMAIL_DOMAIN}`, "T04.08 Owner");

  /**
   * Joins a member through the REAL invitation path (T04.02's accept): the
   * invite, the acceptance, the member row and the clocks are all the
   * commands' own work — no forged directory row anywhere in this suite. An
   * empty workspaceIds joins the company WITHOUT a team seat, which is the
   * state team.member.add exists to change.
   */
  const joinMember: Harness["joinMember"] = async (input) => {
    const user = await signUp(
      `t0408-${input.label}${EMAIL_DOMAIN}`,
      `T04.08 ${input.label}`,
    );
    const invite = await run({
      actorUserId: owner.userId,
      tenantId: input.tenantId,
      operation: "invitation.create",
      key: `t0408-invite-${input.keySuffix}`,
      payload: {
        email: user.email,
        role: input.role ?? "member",
        workspaceIds: [...input.workspaceIds],
      },
    });
    const invitationId = invite.resourceId;
    if (typeof invitationId !== "string") {
      throw new Error(
        `invitation.create for ${user.email} returned no invitation id; the accept half cannot name the record`,
      );
    }
    await run({
      actorUserId: user.userId,
      tenantId: input.tenantId,
      operation: "invitation.accept",
      key: `t0408-accept-${input.keySuffix}`,
      payload: { invitationId },
    });
    return user;
  };

  return {
    sql,
    owner,
    provision,
    workspaceOf: async (tenantId) => {
      const rows =
        await sql`SELECT workspace_id FROM auth_team_bindings WHERE tenant_id = ${tenantId} LIMIT 1`;
      const workspaceId = rows[0]?.workspace_id;
      if (typeof workspaceId !== "string") {
        throw new Error(`company ${tenantId} has no workspace binding`);
      }
      return workspaceId;
    },
    principalIdOf: async (userId) => {
      const rows =
        await sql`SELECT id FROM enterprise_principals WHERE user_id = ${userId} LIMIT 1`;
      const id = rows[0]?.id;
      if (typeof id !== "string") {
        throw new Error(`user ${userId} has no principal`);
      }
      return id;
    },
    run,
    translation,
    joinMember,
    auditCountByOperation: async (tenantId, operation) => {
      const rows =
        await sql`SELECT count(*)::int AS n FROM enterprise_audit_events
                    WHERE tenant_id = ${tenantId}
                      AND event_type = 'directory.command.finalized'
                      AND payload->>'operation' = ${operation}`;
      return rows[0].n;
    },
    receiptOf: async (tenantId, key) => {
      const rows = await sql`SELECT command_id FROM auth_command_receipts
                    WHERE tenant_id = ${tenantId} AND idempotency_key = ${key}
                    LIMIT 1`;
      return rows[0] ? { command_id: String(rows[0].command_id) } : null;
    },
    grantRows: async (grantId) =>
      sql`SELECT status FROM auth_team_management_grants WHERE grant_id = ${grantId}`,
  };
}

/** The error a failed promise carried, or null when it unexpectedly resolved. */
async function refusalOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

describe("T04.08 scoped team admin", () => {
  let harness: Harness;
  let owner: HarnessUser;
  let tenantA: string;
  let workspaceA: string;
  let tenantB: string;
  let workspaceB: string;
  let tenantC: string;
  let workspaceC: string;
  let ownsAuditTable = false;

  beforeAll(async () => {
    readBaUrls();
    const setupUrl = process.env[DATABASE_VARIABLE]!.trim();
    const sql = postgres(setupUrl, { max: 2, onnotice: () => {} });
    ownsAuditTable =
      await sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = ${AUDIT_TABLE}`.then(
        (r) => r[0].n === 0,
      );
    await cleanupFixture(sql, { ownsAuditTable });
    for (const tag of MIGRATION_TAGS) {
      await sql.unsafe(loadMigrationSql(tag));
    }
    if (ownsAuditTable) {
      for (const statement of AUDIT_TABLE_STATEMENTS) {
        await sql.unsafe(statement);
      }
    }
    await sql`
      INSERT INTO users (id, email) VALUES
        (${PLATFORM_ADMIN_ID}, ${`t0408-admin${EMAIL_DOMAIN}`})`;
    await sql`
      INSERT INTO user_roles (user_id, role) VALUES (${PLATFORM_ADMIN_ID}, 'admin')`;
    await setAuthority(sql, { phase: "M4", directoryAuthority: "ba" });
    harness = await buildHarness(sql);
    owner = harness.owner;
    tenantA = await harness.provision("t0408-key-company", owner.userId);
    workspaceA = await harness.workspaceOf(tenantA);
    tenantB = await harness.provision("t0408-key-second", owner.userId);
    workspaceB = await harness.workspaceOf(tenantB);
    tenantC = await harness.provision("t0408-key-third", owner.userId);
    workspaceC = await harness.workspaceOf(tenantC);
  });

  afterAll(async () => {
    if (!harness?.sql) return;
    await cleanupFixture(harness.sql, { ownsAuditTable });
    await harness.sql.end({ timeout: 5 }).catch(() => {});
  });

  // -------------------------------------------------------------------------
  // The Brief's third named case first: the translation rides the EXISTING
  // routes, so the surface registers each member shape exactly once (Hono
  // reads :userId and :principalId as one pattern — a second same-shape
  // route would silently shadow the first).
  // -------------------------------------------------------------------------

  test("no_second_same_shape_member_route_is_registered", () => {
    const routes = createWorkspaceScopeRoutes({
      authenticate: async () => null,
      lister: { list: async () => ({ companies: [], teams: [] }) } as never,
    });
    const registered = (
      routes.routes as readonly { method: string; path: string }[]
    ).filter((route) => route.path.startsWith("/admin/teams/"));
    const memberDeletes = registered.filter(
      (route) =>
        route.method === "DELETE" &&
        /^\/admin\/teams\/:[^/]+\/members\/:[^/]+$/.test(route.path),
    );
    const memberPosts = registered.filter(
      (route) =>
        route.method === "POST" &&
        /^\/admin\/teams\/:[^/]+\/members$/.test(route.path),
    );
    expect(memberDeletes).toHaveLength(1);
    expect(memberDeletes[0]!.path).toBe(
      "/admin/teams/:workspaceId/members/:principalId",
    );
    expect(memberPosts).toHaveLength(1);
    expect(memberPosts[0]!.path).toBe("/admin/teams/:workspaceId/members");
  });

  // -------------------------------------------------------------------------
  // The route surface's own contract: the refusal family projects with each
  // refusal's own status (and the paused mode's 503), never a 500 collapse.
  // The service behind the route is a stub that throws exactly the refusals
  // the real translated branch produces; the service's real behavior is the
  // later tests' pin (T04.07's fixture-authorizer liberty, same disclosure).
  // -------------------------------------------------------------------------

  test("route_projects_team_member_refusals_with_their_own_status", async () => {
    const adminAuthorizer = {
      authenticate: async () => ({ actorId: "t0408-route-actor" }),
      resolveAdminContext: async () =>
        Object.freeze({
          tenantId: "t0408-route-tenant",
          principalId: "t0408-route-principal",
          actorId: "t0408-route-actor",
          memberEpoch: 1,
        }) as CompanyAdminContext,
    };
    const call = async (
      service: unknown,
      method: string,
      path: string,
      body?: unknown,
    ): Promise<{ status: number; code: string | null }> => {
      const app: Hono = createWorkspaceScopeRoutes({
        authenticate: async () => ({ actorId: "t0408-route-actor" }),
        lister: { list: async () => ({ companies: [], teams: [] }) } as never,
        admin: { authorizer: adminAuthorizer, service: service as never },
      });
      const response = await app.request(`http://127.0.0.1${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json = (await response.json().catch(() => null)) as {
        error?: { code?: string };
      } | null;
      return { status: response.status, code: json?.error?.code ?? null };
    };

    // The handler's own refusal family: the refusal's status is the route's.
    const handlerRefusals = {
      addTeamMember: async () => {
        throw new TeamMemberRefusal(
          TEAM_MEMBER_ALREADY_MEMBER,
          "stub refusal",
          409,
        );
      },
      removeTeamMember: async () => {
        throw new TeamMemberRefusal(
          TEAM_MEMBER_NOT_A_MEMBER,
          "stub refusal",
          404,
        );
      },
    };
    const addRefusal = await call(
      handlerRefusals,
      "POST",
      "/admin/teams/t0408-ws/members",
      { principalId: "t0408-target-principal" },
    );
    expect(addRefusal.status).toBe(409);
    expect(addRefusal.code).toBe(TEAM_MEMBER_ALREADY_MEMBER);
    const removeRefusal = await call(
      handlerRefusals,
      "DELETE",
      "/admin/teams/t0408-ws/members/t0408-target-principal",
    );
    expect(removeRefusal.status).toBe(404);
    expect(removeRefusal.code).toBe(TEAM_MEMBER_NOT_A_MEMBER);

    // The envelope's refusal family projects the same way, and the paused
    // mode keeps its one named 503 — none of these collapse into a 500.
    const envelopeRefusals = {
      addTeamMember: async () => {
        throw new DirectoryCommandRefusal(
          "DIRECTORY_OPERATION_NOT_WIRED",
          "stub envelope refusal",
          503,
        );
      },
      removeTeamMember: async () => {
        throw new Error(MEMBERSHIP_LIFECYCLE_PAUSED);
      },
    };
    const envelopeRefusal = await call(
      envelopeRefusals,
      "POST",
      "/admin/teams/t0408-ws/members",
      { principalId: "t0408-target-principal" },
    );
    expect(envelopeRefusal.status).toBe(503);
    expect(envelopeRefusal.code).toBe("DIRECTORY_OPERATION_NOT_WIRED");
    const pausedRefusal = await call(
      envelopeRefusals,
      "DELETE",
      "/admin/teams/t0408-ws/members/t0408-target-principal",
    );
    expect(pausedRefusal.status).toBe(503);
    expect(pausedRefusal.code).toBe(MEMBERSHIP_LIFECYCLE_PAUSED);
  });

  // -------------------------------------------------------------------------
  // The Brief's first named case: the grant holder manages exactly the
  // granted team — through the translation port, the entrance every old
  // entrance's ba branch runs (T04.03's scope-B precedent), against the real
  // executor with the capability-consuming handlers registered.
  // -------------------------------------------------------------------------

  test("scoped_team_admin_can_manage_only_team_a", async () => {
    // The grant command's own gate requires the grantee to hold a seat in
    // the target team (T04.07's AC), so the scoped admin joins through the
    // real invitation path WITH the workspace before being granted.
    const scoped = await harness.joinMember({
      tenantId: tenantA,
      workspaceIds: [workspaceA],
      label: "scoped",
      keySuffix: "scoped",
    });
    const seatHolder = await harness.joinMember({
      tenantId: tenantA,
      workspaceIds: [workspaceA],
      label: "seat-holder",
      keySuffix: "seatholder",
    });
    const outsider = await harness.joinMember({
      tenantId: tenantB,
      workspaceIds: [],
      label: "outsider",
      keySuffix: "outsider",
    });
    const seatPrincipal = await harness.principalIdOf(seatHolder.userId);

    // The real grant: owner grants the scoped admin both actions on team A.
    const granted = await harness.run({
      actorUserId: owner.userId,
      tenantId: tenantA,
      operation: "team.management.grant",
      key: "t0408-grant-a",
      payload: {
        workspaceId: workspaceA,
        userId: scoped.userId,
        actions: ["team.member.add", "team.member.remove"],
      },
    });
    expect(granted.grantId).not.toBeNull();

    const translate = (
      userId: string,
      key: string,
      operation: DirectoryOperation,
      payload: Record<string, unknown>,
    ) =>
      harness.translation.execute(harness.translation.actorOf(userId), {
        operation,
        tenantId: tenantA,
        idempotencyKey: key,
        payload,
      });
    const seatsOf = async (tenantId: string, userId: string) =>
      Number(
        (
          await harness.sql`SELECT count(*)::int AS n FROM auth_team_members tm
              JOIN auth_teams t ON t.id = tm.team_id
             WHERE t.organization_id = ${tenantId} AND tm.user_id = ${userId}`
        )[0].n,
      );

    // REMOVE through the grant: the seat holder leaves team A.
    const removed = await translate(
      scoped.userId,
      "t0408-remove-1",
      "team.member.remove",
      { workspaceId: workspaceA, userId: seatHolder.userId },
    );
    expect(removed.replayed).toBe(false);
    expect(await seatsOf(tenantA, seatHolder.userId)).toBe(0);

    // ADD through the grant: the member takes the seat back, and the receipt
    // carries the team change key the report reads its epoch from.
    const added = await translate(
      scoped.userId,
      "t0408-add-1",
      "team.member.add",
      {
        workspaceId: workspaceA,
        userId: seatHolder.userId,
      },
    );
    expect(added.replayed).toBe(false);
    const teamKey = added.versions.find(
      (version) =>
        version.key.kind === "team" &&
        version.key.scopeId === workspaceA &&
        version.key.principalId === seatPrincipal,
    );
    expect(teamKey).toBeDefined();
    expect(await seatsOf(tenantA, seatHolder.userId)).toBe(1);

    // The invisible family: another company's workspace inside this tenant
    // is answered exactly like a missing one, and a member without a grant
    // in this company is refused by name — never a fallback role.
    const unbound = await refusalOf(
      translate(scoped.userId, "t0408-unbound-1", "team.member.add", {
        workspaceId: workspaceB,
        userId: seatHolder.userId,
      }),
    );
    expect(isTeamMemberRefusal(unbound)).toBe(true);
    expect((unbound as TeamMemberRefusal).code).toBe(TEAM_MEMBER_TEAM_UNBOUND);
    expect((unbound as TeamMemberRefusal).status).toBe(404);
    const noGrant = await refusalOf(
      translate(outsider.userId, "t0408-nogrant-1", "team.member.add", {
        workspaceId: workspaceA,
        userId: seatHolder.userId,
      }),
    );
    expect(isTeamMemberRefusal(noGrant)).toBe(true);
    expect((noGrant as TeamMemberRefusal).code).toBe(
      TEAM_MEMBER_GRANT_REQUIRED,
    );
    expect((noGrant as TeamMemberRefusal).status).toBe(403);

    // Pair-state refusals reach the projection before any DML: a duplicate
    // seat is 409, a missing one 404. (Both while the grant still covers
    // both actions — the narrowed re-grant below would refuse these before
    // the pair state could speak.)
    const duplicate = await refusalOf(
      translate(scoped.userId, "t0408-add-dup", "team.member.add", {
        workspaceId: workspaceA,
        userId: seatHolder.userId,
      }),
    );
    expect((duplicate as TeamMemberRefusal).code).toBe(
      TEAM_MEMBER_ALREADY_MEMBER,
    );
    expect((duplicate as TeamMemberRefusal).status).toBe(409);
    const missing = await refusalOf(
      translate(scoped.userId, "t0408-remove-missing", "team.member.remove", {
        workspaceId: workspaceA,
        userId: outsider.userId,
      }),
    );
    expect((missing as TeamMemberRefusal).code).toBe(TEAM_MEMBER_NOT_A_MEMBER);
    expect((missing as TeamMemberRefusal).status).toBe(404);

    // A re-grant narrowed to add-only refuses the remove half: the exact
    // live grant is the only authority (the stable row advanced a generation).
    await harness.run({
      actorUserId: owner.userId,
      tenantId: tenantA,
      operation: "team.management.grant",
      key: "t0408-grant-a-narrow",
      payload: {
        workspaceId: workspaceA,
        userId: scoped.userId,
        actions: ["team.member.add"],
      },
    });
    const narrowed = await refusalOf(
      translate(scoped.userId, "t0408-remove-2", "team.member.remove", {
        workspaceId: workspaceA,
        userId: seatHolder.userId,
      }),
    );
    expect(isTeamMemberRefusal(narrowed)).toBe(true);
    expect((narrowed as TeamMemberRefusal).code).toBe(
      TEAM_MEMBER_GRANT_NOT_COVERING,
    );
    expect((narrowed as TeamMemberRefusal).status).toBe(403);

    // The owner's company-role branch runs the same handler end to end.
    const ownerRemoved = await translate(
      owner.userId,
      "t0408-owner-remove",
      "team.member.remove",
      { workspaceId: workspaceA, userId: seatHolder.userId },
    );
    expect(ownerRemoved.replayed).toBe(false);
    expect(await seatsOf(tenantA, seatHolder.userId)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // The Brief's second named case: revocation closes the grant; the earlier
  // success receipt never lends its authority to the next command.
  // -------------------------------------------------------------------------

  test("revoked_grant_cannot_replay_success_receipt", async () => {
    const admin = await harness.joinMember({
      tenantId: tenantB,
      workspaceIds: [workspaceB],
      label: "admin-b",
      keySuffix: "adminb",
    });
    const target = await harness.joinMember({
      tenantId: tenantB,
      workspaceIds: [],
      label: "target-b",
      keySuffix: "targetb",
    });
    const granted = await harness.run({
      actorUserId: owner.userId,
      tenantId: tenantB,
      operation: "team.management.grant",
      key: "t0408-grant-b",
      payload: {
        workspaceId: workspaceB,
        userId: admin.userId,
        actions: ["team.member.add"],
      },
    });
    expect(granted.grantId).not.toBeNull();

    const first = await harness.translation.execute(
      harness.translation.actorOf(admin.userId),
      {
        operation: "team.member.add",
        tenantId: tenantB,
        idempotencyKey: "t0408-b-add-1",
        payload: { workspaceId: workspaceB, userId: target.userId },
      },
    );
    expect(first.replayed).toBe(false);
    expect(
      await harness.auditCountByOperation(tenantB, "team.member.add"),
    ).toBe(1);

    await harness.run({
      actorUserId: owner.userId,
      tenantId: tenantB,
      operation: "team.management.revoke",
      key: "t0408-revoke-b",
      payload: { grantId: granted.grantId, reason: "t0408 撤销" },
    });
    expect((await harness.grantRows(granted.grantId!))[0]?.status).toBe(
      "revoked",
    );

    // The SAME admin, the SAME target: a new command whose authorize re-runs
    // against the live grant row and is refused — 403, not a replay.
    const second = await refusalOf(
      harness.translation.execute(harness.translation.actorOf(admin.userId), {
        operation: "team.member.add",
        tenantId: tenantB,
        idempotencyKey: "t0408-b-add-2",
        payload: { workspaceId: workspaceB, userId: target.userId },
      }),
    );
    expect(isTeamMemberRefusal(second)).toBe(true);
    const secondRefusal = second as TeamMemberRefusal;
    expect(secondRefusal.status).toBe(403);
    expect(secondRefusal.code).toBe(TEAM_MEMBER_GRANT_NOT_COVERING);
    // No second success receipt: the refused command wrote nothing.
    expect(
      await harness.auditCountByOperation(tenantB, "team.member.add"),
    ).toBe(1);
    expect(await harness.receiptOf(tenantB, "t0408-b-add-2")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Design §4.4: the grant's basis is compared live. A suspended grantee's
  // company generation no longer matches the snapshot the grant was issued
  // with — the grant is stale and refuses by name, never grandfathered.
  // -------------------------------------------------------------------------

  test("suspended_grantee_makes_the_grant_stale", async () => {
    const grantee = await harness.joinMember({
      tenantId: tenantC,
      workspaceIds: [workspaceC],
      label: "grantee-c",
      keySuffix: "granteec",
    });
    const target = await harness.joinMember({
      tenantId: tenantC,
      workspaceIds: [],
      label: "target-c",
      keySuffix: "targetc",
    });
    await harness.run({
      actorUserId: owner.userId,
      tenantId: tenantC,
      operation: "team.management.grant",
      key: "t0408-grant-c",
      payload: {
        workspaceId: workspaceC,
        userId: grantee.userId,
        actions: ["team.member.add"],
      },
    });
    // member.suspend advances the grantee's company generation.
    await harness.run({
      actorUserId: owner.userId,
      tenantId: tenantC,
      operation: "member.suspend",
      key: "t0408-suspend-c",
      payload: { userId: grantee.userId, reason: "t0408 过期基线" },
    });
    const stale = await refusalOf(
      harness.translation.execute(harness.translation.actorOf(grantee.userId), {
        operation: "team.member.add",
        tenantId: tenantC,
        idempotencyKey: "t0408-c-add-1",
        payload: { workspaceId: workspaceC, userId: target.userId },
      }),
    );
    expect(isTeamMemberRefusal(stale)).toBe(true);
    expect((stale as TeamMemberRefusal).code).toBe(TEAM_MEMBER_GRANT_STALE);
    expect((stale as TeamMemberRefusal).status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // The P12 disclosure branch: a scim actor has no session/platform identity
  // to discriminate with; the provisioning-rule authority is P12's wiring,
  // so this deployment refuses it by name instead of approximating it.
  // -------------------------------------------------------------------------

  test("scim_actor_team_command_is_refused_by_name", async () => {
    // Shape-valid per the envelope (a scim actor carries its binding and the
    // provisioning event it derives from). T05.06 wired the
    // provisioning-rule branch, so the refusal is the rule verification's
    // own: an event naming a rule that is not this company's approved rule
    // at that revision never authorizes — a forged or stale event is
    // refused, never replayed against a real one.
    const scimActor: DirectoryActor = {
      userId: owner.userId,
      principalId: null,
      sessionId: null,
      kind: "scim",
      bindingId: "t0408-binding",
      provisioning: {
        eventId: "t0408-event",
        ruleId: "t0408-rule",
        ruleRevision: 1,
        sourceSubject: "t0408-subject",
      },
    };
    const refused = await refusalOf(
      harness.translation.execute(scimActor, {
        operation: "team.member.add",
        tenantId: tenantA,
        idempotencyKey: "t0408-scim-add-1",
        payload: { workspaceId: workspaceA, userId: owner.userId },
      }),
    );
    expect(isTeamMemberRefusal(refused)).toBe(true);
    expect((refused as TeamMemberRefusal).code).toBe(
      PROVISIONING_RULE_NOT_APPROVED,
    );
    expect((refused as TeamMemberRefusal).status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // The old entrances' ba branch, end to end over the REAL authorizer (the
  // admin context is the WeakSet-issued one the service asserts) and the
  // real operator channel: directory provenance in the legacy report shape,
  // the invisible not-found for another company's principal, and the paused
  // mode's one named 503.
  // -------------------------------------------------------------------------

  test("service_translation_branch_reports_directory_provenance", async () => {
    // The island's role URLs carry the login only; the verified capabilities
    // need the role-scoped connection — exactly the shape the island's
    // auth-writer URL spells with its options parameter.
    const directoryRoleUrl = new URL(
      process.env.BA_TEST_DIRECTORY_DATABASE_URL!.trim(),
    );
    directoryRoleUrl.searchParams.set("options", "-c role=ob_ent_directory");
    const operatorRoleUrl = new URL(
      process.env.BA_TEST_OPERATOR_DATABASE_URL!.trim(),
    );
    operatorRoleUrl.searchParams.set("options", "-c role=ob_ent_operator");
    const directoryDb = await verifyDirectoryDatabase(
      createDatabase(directoryRoleUrl.href, { max: 2 }),
    );
    const operator = await verifyOperatorDatabase(
      createDatabase(operatorRoleUrl.href, { max: 2 }),
    );
    const authorizer = createCompanyAdminAuthorizer(directoryDb, {
      authenticate: async (request) => {
        const actor = request.headers.get("x-test-actor");
        return actor ? { actorId: actor, entrypoint: "web" } : null;
      },
      selectTenant: (request) => request.headers.get("x-test-tenant"),
    });
    const service = createWorkspaceAdminService(operator, harness.translation);

    const adminContext = await authorizer.resolveAdminContext(
      new Request("https://openbot.test/admin/teams", {
        headers: {
          "x-test-actor": owner.userId,
          "x-test-tenant": tenantA,
        },
      }),
    );
    expect(adminContext.actorId).toBe(owner.userId);

    const fresh = await harness.joinMember({
      tenantId: tenantA,
      workspaceIds: [],
      label: "fresh-wire",
      keySuffix: "freshwire",
    });
    const freshPrincipal = await harness.principalIdOf(fresh.userId);

    const added = await service.addTeamMember(adminContext, {
      workspaceId: workspaceA,
      principalId: freshPrincipal,
    });
    expect(added.outcome).toBe("created");
    expect(added.membership).toMatchObject({
      workspaceId: workspaceA,
      principalId: freshPrincipal,
      status: "active",
    });
    expect(added.via).toBe("directory");
    expect(added.operation).toBe("team.member.add");
    expect(added.commandId).toBeTruthy();
    expect(added.auditEventId).toBeTruthy();
    expect(added.replayed).toBe(false);

    const removed = await service.removeTeamMember(adminContext, {
      workspaceId: workspaceA,
      principalId: freshPrincipal,
    });
    expect(removed.removed).toBe(true);
    expect(removed.via).toBe("directory");
    expect(removed.operation).toBe("team.member.remove");
    expect(removed.auditEventId).toBeTruthy();

    // Another company's principal is the invisible not-found: the service's
    // pre-gate names the company membership with the legacy entrance's own
    // code, and the handler's target check (never reached here) carries the
    // same invisible discipline for the command path.
    const crossCompanyTarget = await harness.joinMember({
      tenantId: tenantB,
      workspaceIds: [],
      label: "cross-wire",
      keySuffix: "crosswire",
    });
    const crossPrincipal = await harness.principalIdOf(
      crossCompanyTarget.userId,
    );
    await expect(
      service.addTeamMember(adminContext, {
        workspaceId: workspaceA,
        principalId: crossPrincipal,
      }),
    ).rejects.toThrow("TEAM_MEMBER_NOT_COMPANY_MEMBER");

    // The paused mode answers its one named 503 code through the same branch.
    // The authority row's phase/authority pair is CHECK-constrained: paused
    // rides M2, exactly the migration state machine's own pause shape.
    await setAuthority(harness.sql, {
      phase: "M2",
      directoryAuthority: "paused",
    });
    try {
      await expect(
        service.addTeamMember(adminContext, {
          workspaceId: workspaceA,
          principalId: freshPrincipal,
        }),
      ).rejects.toThrow(MEMBERSHIP_LIFECYCLE_PAUSED);
    } finally {
      await setAuthority(harness.sql, {
        phase: "M4",
        directoryAuthority: "ba",
      });
    }
  });
});
