import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
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
import type {
  DirectoryActor,
  DirectoryOperation,
} from "../../src/auth/directory/contracts";
import { createDirectoryExecutor } from "../../src/auth/directory/executor";
import { createDirectoryFinalizer } from "../../src/auth/directory/finalizer";
import {
  createCompanyProvisionHandler,
  preAllocateProvisionTenantId,
  preAllocateProvisionWorkspaceId,
} from "../../src/auth/directory/lifecycle";
import {
  createFixedVersionInvitationCommands,
  createInvitationMembershipHandlers,
  createMembershipAdminTranslation,
  createMembershipLifecycleHandlers,
  translateMembershipLifecycle,
} from "../../src/auth/directory/membership";
import { principalRegistry } from "../../src/auth/directory/principal-registry";
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
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  type CompanyBillingInitializationPort,
  createPlatformCompanyProvisionService,
} from "../../src/enterprise/tenancy/provision";
import { createBaRevocationGuard } from "../../src/enterprise/tenancy/revocation";
import { createBaScopeResolver } from "../../src/enterprise/tenancy/store";

/*
 * T04.03 (#547, P08) — member suspend / restore / role.set / remove / leave /
 * owner.transfer on the real 0209–0216 stack of the isolated BA_TEST_* island
 * (interfaces §2 payload table, §2's last-owner ruling, plan Task 3/4). What
 * this file pins, as database facts:
 *
 * - `concurrent_last_owner_leave_and_demotion_preserves_owner` (the Brief's
 *   first named case): a company with exactly one active owner receives a
 *   leave and a demotion of that same owner at the same time. Both are
 *   refused by the in-lock last-owner protection, so the company always keeps
 *   `activeOwners.length >= 1` — and the surviving owner is a real directory
 *   fact (member row, projection and untombstoned clock agree).
 * - `restored_member_does_not_revive_old_authority` (the Brief's second named
 *   case): a suspended member's pre-suspension scope never works again after
 *   `member.restore`. `member.suspend` advances the company GENERATION and
 *   `member.restore` advances the EPOCH, so the old version pair matches
 *   nothing (interfaces §2: 恢复身份不复活旧能力) — the restore is a new
 *   admission, never a resurrection of the old Grant/lease/credential
 *   authority.
 * - removal clears every team relation of THAT company (the 0214 orphan fence
 *   forces it), tombstones the company and team clocks, and keeps the durable
 *   receipt/change-key/audit trail.
 * - the in-lock authorization refuses a member actor (an ordinary member never
 *   suspends anyone), refuses another company's member with one invisible
 *   not-found, and refuses suspend/restore state that does not apply.
 * - `owner.transfer` is atomic: the successor becomes owner and the outgoing
 *   owner steps down to admin in the same command.
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

const PLATFORM_ADMIN_ID = "t0403-platform-admin";
const EMAIL_DOMAIN = "@t0403.example.test";
const DEFAULT_PASSWORD = "correct-horse-battery-staple";

const PROVISION_KEYS = [
  "t0403-key-company",
  "t0403-key-second",
  "t0403-key-third",
  "t0403-key-race",
  "t0403-key-solo",
  "t0403-key-wire",
  "t0403-key-wire2",
  "t0403-key-wire3",
  "t0403-key-wire4",
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
        `${variable} is required: the membership-lifecycle suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
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

/** Returns the island to the pre-suite shape (the T04.02 recipe, t0403 rows). */
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
    SELECT id FROM users WHERE email LIKE ${`t0403-%${EMAIL_DOMAIN}`}
       OR id = ${PLATFORM_ADMIN_ID})`;
  await sql`DELETE FROM enterprise_workspaces WHERE tenant_id IN (${quoted})`;
  await sql`DELETE FROM enterprise_tenants WHERE id IN (${quoted})`;
  await sql`DELETE FROM user_roles WHERE user_id = ${PLATFORM_ADMIN_ID}`;
  await sql`DELETE FROM users WHERE email LIKE ${`t0403-%${EMAIL_DOMAIN}`} OR id = ${PLATFORM_ADMIN_ID}`;
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

interface ClockRow {
  epoch: number;
  generation: number;
  tombstone: boolean;
}

interface Harness {
  sql: postgres.Sql;
  /** The provisioned owner of every company this suite creates. */
  owner: HarnessUser;
  /** A brand-new verified user with no principal and no membership. */
  freshUser(label: string): Promise<HarnessUser>;
  /** The provisioned company a key names. */
  provision(key: string, ownerUserId: string): Promise<string>;
  /** Runs one lifecycle command against the real executor. */
  run(input: {
    actorUserId: string;
    tenantId: string;
    operation: DirectoryOperation;
    key: string;
    payload: Record<string, unknown>;
  }): Promise<{ replayed: boolean; resourceId: string | null }>;
  /** The real executor the commands ran through (the translation port rides it). */
  directory: ReturnType<typeof createDirectoryExecutor>;
  /** The authority port the translation mode read goes through. */
  authority: ReturnType<typeof createDirectoryAuthority>;
  /** The single-writer connection (BA_TEST_DATABASE_URL) the port reads on. */
  directoryDatabase: ReturnType<typeof createDatabase>;
  /** Adds a member to the company through the real invitation accept path. */
  joinMember(input: {
    tenantId: string;
    workspaceIds: readonly string[];
    role?: string;
    label: string;
    keySuffix: string;
  }): Promise<HarnessUser>;
  memberRows(tenantId: string, userId: string): Promise<{ role: string }[]>;
  activeOwners(tenantId: string): Promise<{ user_id: string; role: string }[]>;
  principalOf(userId: string): Promise<string | null>;
  clockRows(
    tenantId: string,
    principalId: string,
    kind: "company" | "team",
    scopeId: string,
  ): Promise<ClockRow[]>;
  teamMemberRows(tenantId: string, userId: string): Promise<unknown[]>;
  teamCount(teamId: string): Promise<number>;
  businessMembership(
    tenantId: string,
    principalId: string,
  ): Promise<{ role: string; status: string; epoch: number }[]>;
  resolveScope(input: {
    actorUserId: string;
    tenantId: string;
    workspaceId: string;
  }): Promise<PlatformScope>;
  businessAllows(scope: PlatformScope): Promise<boolean>;
  auditCountByOperation(tenantId: string, operation: string): Promise<number>;
  changeKeyRows(
    commandId: string,
  ): Promise<{ kind: string; scope_id: string }[]>;
  receiptOf(
    tenantId: string,
    key: string,
  ): Promise<{ command_id: string } | null>;
  teamOf(tenantId: string): Promise<string>;
}

async function buildHarness(sql: postgres.Sql): Promise<Harness> {
  const setupUrl = process.env[DATABASE_VARIABLE]!.trim();
  const db = createDatabase(setupUrl, { max: 6 });
  const dataDb = createDatabase(process.env.BA_TEST_DATA_DATABASE_URL!.trim(), {
    max: 2,
  });

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
    secret: "{{SECRET_9mk3x2tp}}",
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
    // fact directly, exactly as the T04.01/T04.02 suites do.
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
    },
  });
  const provisioner = createPlatformCompanyProvisionService({
    database: db,
    directory,
    billing: {
      async initialize(tenantId: string): Promise<PayerAccount> {
        return ensureProvisionedCompanyPayerAccount(db, { tenantId });
      },
    } satisfies CompanyBillingInitializationPort,
  });

  const authenticate = async (request: Request) => {
    const actor = request.headers.get("x-test-actor");
    return actor ? { actorId: actor, entrypoint: "web" } : null;
  };
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

  const sessionActor = (userId: string): DirectoryActor => ({
    userId,
    principalId: null,
    sessionId: `t0403-session-${userId}`,
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
      name: `T04.03 公司 ${key}`,
      slug: `t0403-${key}`,
      ownerUserId,
      defaultTeamName: "默认团队",
    });
    return tenantId;
  };

  const teamOf = async (tenantId: string): Promise<string> => {
    const rows =
      await sql`SELECT team_id FROM auth_team_bindings WHERE tenant_id = ${tenantId} LIMIT 1`;
    const teamId = rows[0]?.team_id;
    if (typeof teamId !== "string") {
      throw new Error(`company ${tenantId} has no team binding`);
    }
    return teamId;
  };

  const owner = await signUp(`t0403-owner${EMAIL_DOMAIN}`, "T04.03 Owner");

  /**
   * Joins a member through the REAL invitation path (T04.02's accept): the
   * invite, the acceptance, the member row, the team membership, the clock
   * establishment and the projection are all the commands' own work — no
   * forged directory row anywhere in this suite.
   */
  const joinMember: Harness["joinMember"] = async (input) => {
    const user = await signUp(
      `t0403-${input.label}${EMAIL_DOMAIN}`,
      `T04.03 ${input.label}`,
    );
    const invite = await run({
      actorUserId: owner.userId,
      tenantId: input.tenantId,
      operation: "invitation.create",
      key: `t0403-invite-${input.keySuffix}`,
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
      key: `t0403-accept-${input.keySuffix}`,
      payload: { invitationId },
    });
    // The frozen finalizer only advances the team-keys clock — the legacy
    // workspace-membership projection is company.provision's manual write for
    // the owner (lifecycle.ts). Scope resolution still requires the row, so
    // the harness materializes it for the accepted member exactly the way
    // provision does, instead of forging any directory fact.
    const principalRows =
      await sql`SELECT id FROM enterprise_principals WHERE user_id = ${user.userId} LIMIT 1`;
    const joinerPrincipalId = principalRows[0]?.id;
    if (typeof joinerPrincipalId !== "string") {
      throw new Error(
        `invitation.accept for ${user.email} left no principal — the accept finalizer is broken`,
      );
    }
    for (const workspaceId of input.workspaceIds) {
      await sql`INSERT INTO enterprise_workspace_memberships
                  (tenant_id, workspace_id, principal_id, status, epoch)
                VALUES (${input.tenantId}, ${workspaceId}, ${joinerPrincipalId}, 'active', 1)
                ON CONFLICT DO NOTHING`;
    }
    return user;
  };

  return {
    sql,
    owner,
    freshUser: (label) =>
      signUp(`t0403-${label}${EMAIL_DOMAIN}`, `T04.03 ${label}`),
    provision,
    run,
    directory,
    authority,
    directoryDatabase: db,
    joinMember,
    memberRows: (tenantId, userId) =>
      sql`SELECT role FROM auth_members
            WHERE organization_id = ${tenantId} AND user_id = ${userId}`,
    activeOwners: (tenantId) =>
      sql`SELECT user_id, role FROM auth_members
            WHERE organization_id = ${tenantId} AND role = 'owner'
           ORDER BY user_id`,
    principalOf: async (userId) => {
      const rows =
        await sql`SELECT id FROM enterprise_principals WHERE user_id = ${userId} LIMIT 1`;
      return rows[0] ? String(rows[0].id) : null;
    },
    clockRows: (tenantId, principalId, kind, scopeId) =>
      sql`SELECT epoch::int AS epoch, generation::int AS generation, tombstone
            FROM auth_eligibility_clocks
           WHERE tenant_id = ${tenantId} AND principal_id = ${principalId}
             AND kind = ${kind} AND scope_id = ${scopeId}`,
    teamMemberRows: (tenantId, userId) =>
      sql`SELECT tm.id FROM auth_team_members tm
            JOIN auth_teams t ON t.id = tm.team_id
           WHERE t.organization_id = ${tenantId} AND tm.user_id = ${userId}`,
    teamCount: async (teamId) => {
      const rows =
        await sql`SELECT member_count AS n FROM auth_teams WHERE id = ${teamId}`;
      return Number(rows[0]?.n ?? -1);
    },
    businessMembership: (tenantId, principalId) =>
      sql`SELECT role, status, epoch::int AS epoch FROM enterprise_memberships
           WHERE tenant_id = ${tenantId} AND principal_id = ${principalId}`,
    resolveScope: ({ actorUserId, tenantId, workspaceId }) =>
      resolver.resolve(
        new Request("https://openbot.test/api/enterprise/scope", {
          headers: {
            "x-test-actor": actorUserId,
            "x-openbot-tenant": tenantId,
            "x-openbot-workspace": workspaceId,
          },
        }),
      ),
    businessAllows: async (scope) => {
      try {
        await guard.assert(scope, "list");
        return true;
      } catch {
        return false;
      }
    },
    auditCountByOperation: async (tenantId, operation) => {
      const rows =
        await sql`SELECT count(*)::int AS n FROM enterprise_audit_events
                    WHERE tenant_id = ${tenantId}
                      AND event_type = 'directory.command.finalized'
                      AND payload->>'operation' = ${operation}`;
      return rows[0].n;
    },
    changeKeyRows: (commandId) =>
      sql`SELECT kind, scope_id FROM auth_command_change_keys
           WHERE command_id = ${commandId} ORDER BY kind, scope_id`,
    receiptOf: async (tenantId, key) => {
      const rows = await sql`SELECT command_id FROM auth_command_receipts
                    WHERE tenant_id = ${tenantId} AND idempotency_key = ${key}
                    LIMIT 1`;
      return rows[0] ? { command_id: String(rows[0].command_id) } : null;
    },
    teamOf,
  };
}

/** The named refusal a failed command carried, or a readable surprise. */
async function refusalCodeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "COMMAND_SUCCEEDED";
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const match = text.match(/^([A-Z][A-Z0-9_]+):/);
    return match ? match[1] : text.slice(0, 160);
  }
}

describe("T04.03 member lifecycle and last-owner protection", () => {
  let harness: Harness;
  let owner: HarnessUser;
  let tenantA: string;
  let tenantB: string;
  let workspaceA: string;

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
        (${PLATFORM_ADMIN_ID}, ${`t0403-admin${EMAIL_DOMAIN}`})`;
    await sql`
      INSERT INTO user_roles (user_id, role) VALUES (${PLATFORM_ADMIN_ID}, 'admin')`;
    await setAuthority(sql, { phase: "M4", directoryAuthority: "ba" });
    harness = await buildHarness(sql);
    owner = harness.owner;
    tenantA = await harness.provision("t0403-key-company", owner.userId);
    tenantB = await harness.provision("t0403-key-second", owner.userId);
    workspaceA = preAllocateProvisionWorkspaceId(tenantA);
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

  test("concurrent_last_owner_leave_and_demotion_preserves_owner", async () => {
    // A company with EXACTLY ONE active owner: the provisioned owner. Both
    // racing commands would leave the company ownerless, so the in-lock
    // protection must refuse each of them.
    const soleOwnerTenant = await harness.provision(
      "t0403-key-race",
      owner.userId,
    );
    const ownersBefore = await harness.activeOwners(soleOwnerTenant);
    expect(ownersBefore.map((row) => row.user_id)).toEqual([owner.userId]);

    // The two commands race inside the executor's tenant advisory lock, which
    // serialises them per company: each is judged against the state the other
    // may already have changed.
    const [left, demoted] = await Promise.allSettled([
      harness.run({
        actorUserId: owner.userId,
        tenantId: soleOwnerTenant,
        operation: "member.leave",
        key: "{{SECRET_q7l4n2ws}}",
        payload: {},
      }),
      harness.run({
        actorUserId: owner.userId,
        tenantId: soleOwnerTenant,
        operation: "member.role.set",
        key: "{{SECRET_v9r6t1yk}}",
        payload: { userId: owner.userId, role: "member" },
      }),
    ]);
    const refused = [left, demoted].filter(
      (entry) => entry.status === "rejected",
    );
    // Both are refusals: neither the leave nor the demotion may strand the
    // company, and the reasons are the membership module's own last-owner
    // refusals rather than an incidental FK/guard error.
    expect(refused).toHaveLength(2);
    for (const entry of refused) {
      const reason = (entry as PromiseRejectedResult).reason;
      const text = reason instanceof Error ? reason.message : String(reason);
      expect(text).toMatch(/LAST_OWNER|last active owner/i);
    }

    // THE NAMED ASSERTION: the company still has at least one active owner.
    const activeOwners = await harness.activeOwners(soleOwnerTenant);
    expect(activeOwners.length).toBeGreaterThanOrEqual(1);
    expect(activeOwners.map((row) => row.user_id)).toEqual([owner.userId]);

    // The survivor is a real directory fact, not a stale row: member,
    // projection and clock agree, and the clock is not tombstoned.
    const survivorPrincipal = await harness.principalOf(owner.userId);
    expect(typeof survivorPrincipal).toBe("string");
    const [projection] = await harness.businessMembership(
      soleOwnerTenant,
      survivorPrincipal as string,
    );
    expect(projection.status).toBe("active");
    expect(projection.role).toBe("tenant_admin");
    const [clock] = await harness.clockRows(
      soleOwnerTenant,
      survivorPrincipal as string,
      "company",
      soleOwnerTenant,
    );
    expect(clock.tombstone).toBe(false);

    // Nothing moved: a refused command leaves no receipt and no audit fact.
    expect(
      await harness.receiptOf(soleOwnerTenant, "{{SECRET_q7l4n2ws}}"),
    ).toBeNull();
    expect(
      await harness.auditCountByOperation(soleOwnerTenant, "member.leave"),
    ).toBe(0);
    expect(
      await harness.auditCountByOperation(soleOwnerTenant, "member.role.set"),
    ).toBe(0);
  });

  test("restored_member_does_not_revive_old_authority", async () => {
    // A real second member, joined through the invitation accept path: the
    // member row, team membership, clock and projection are the commands' own
    // writes.
    const member = await harness.joinMember({
      tenantId: tenantA,
      workspaceIds: [workspaceA],
      label: "subject",
      keySuffix: "subject",
    });
    expect(await harness.memberRows(tenantA, member.userId)).toEqual([
      { role: "member" },
    ]);
    expect(await harness.teamMemberRows(tenantA, member.userId)).toHaveLength(
      1,
    );
    const memberPrincipal = await harness.principalOf(member.userId);
    expect(typeof memberPrincipal).toBe("string");
    const [established] = await harness.clockRows(
      tenantA,
      memberPrincipal as string,
      "company",
      tenantA,
    );
    expect(established.epoch).toBe(1);
    expect(established.generation).toBe(1);
    expect(established.tombstone).toBe(false);

    // The member's REAL pre-suspension scope — the authority the restore must
    // NOT revive (interfaces §2: 恢复身份不复活旧能力).
    const oldScope = await harness.resolveScope({
      actorUserId: member.userId,
      tenantId: tenantA,
      workspaceId: workspaceA,
    });
    expect(await harness.businessAllows(oldScope)).toBe(true);

    const suspended = await harness.run({
      actorUserId: owner.userId,
      tenantId: tenantA,
      operation: "member.suspend",
      key: "{{SECRET_m3k8p5xd}}",
      payload: { userId: member.userId, reason: "t0403 合规暂停" },
    });
    expect(suspended.replayed).toBe(false);

    // member.suspend advances the company GENERATION and keeps the epoch.
    const [afterSuspend] = await harness.clockRows(
      tenantA,
      memberPrincipal as string,
      "company",
      tenantA,
    );
    expect(afterSuspend.epoch).toBe(1);
    expect(afterSuspend.generation).toBe(2);
    expect(afterSuspend.tombstone).toBe(false);
    const [suspendedProjection] = await harness.businessMembership(
      tenantA,
      memberPrincipal as string,
    );
    expect(suspendedProjection.status).toBe("suspended");
    // A suspended member's pre-suspension scope is already dead.
    expect(await harness.businessAllows(oldScope)).toBe(false);

    const restored = await harness.run({
      actorUserId: owner.userId,
      tenantId: tenantA,
      operation: "member.restore",
      key: "{{SECRET_y6b1h9qe}}",
      payload: { userId: member.userId, reason: "t0403 受控恢复" },
    });
    expect(restored.replayed).toBe(false);

    // member.restore advances the EPOCH and keeps the already-advanced
    // generation — a new admission, never a resurrection.
    const [afterRestore] = await harness.clockRows(
      tenantA,
      memberPrincipal as string,
      "company",
      tenantA,
    );
    expect(afterRestore.epoch).toBe(2);
    expect(afterRestore.generation).toBe(2);
    expect(afterRestore.tombstone).toBe(false);
    const [restoredProjection] = await harness.businessMembership(
      tenantA,
      memberPrincipal as string,
    );
    expect(restoredProjection.status).toBe("active");
    expect(restoredProjection.epoch).toBe(2);

    // THE NAMED ASSERTION: the pre-suspension authority is dead and stays dead.
    const oldGrantAllowed = await harness.businessAllows(oldScope);
    expect(oldGrantAllowed).toBe(false);

    // A freshly minted scope reads the new versions and works: the restore
    // reopened the door without reopening the old key.
    const freshScope = await harness.resolveScope({
      actorUserId: member.userId,
      tenantId: tenantA,
      workspaceId: workspaceA,
    });
    expect(freshScope.memberEpoch).toBe(2);
    expect(freshScope.companyGeneration).toBe(2);
    expect(await harness.businessAllows(freshScope)).toBe(true);
  });

  test("member_remove_clears_every_team_relation_and_tombstones_the_clock", async () => {
    const removeTenant = await harness.provision(
      "t0403-key-third",
      owner.userId,
    );
    const removeTeam = await harness.teamOf(removeTenant);
    const removeWorkspace = preAllocateProvisionWorkspaceId(removeTenant);
    const member = await harness.joinMember({
      tenantId: removeTenant,
      workspaceIds: [removeWorkspace],
      label: "removable",
      keySuffix: "removable",
    });
    const memberPrincipal = await harness.principalOf(member.userId);
    expect(typeof memberPrincipal).toBe("string");
    const teamCountBefore = await harness.teamCount(removeTeam);
    expect(teamCountBefore).toBe(2); // the owner + the member

    const removed = await harness.run({
      actorUserId: owner.userId,
      tenantId: removeTenant,
      operation: "member.remove",
      key: "{{SECRET_r2w7c4na}}",
      payload: { userId: member.userId, reason: "t0403 移除" },
    });
    expect(removed.replayed).toBe(false);

    // The member row is gone and EVERY company team relation with it (the
    // 0214 orphan fence would have refused the commit otherwise).
    expect(await harness.memberRows(removeTenant, member.userId)).toHaveLength(
      0,
    );
    expect(
      await harness.teamMemberRows(removeTenant, member.userId),
    ).toHaveLength(0);
    expect(await harness.teamCount(removeTeam)).toBe(1);

    // The company clock tombstones and its generation advances; the durable
    // history (receipt, change key, audit) survives the removal.
    const [clock] = await harness.clockRows(
      removeTenant,
      memberPrincipal as string,
      "company",
      removeTenant,
    );
    expect(clock.tombstone).toBe(true);
    expect(clock.generation).toBe(2);
    const [projection] = await harness.businessMembership(
      removeTenant,
      memberPrincipal as string,
    );
    expect(projection.status).toBe("suspended");
    const receipt = await harness.receiptOf(
      removeTenant,
      "{{SECRET_r2w7c4na}}",
    );
    expect(receipt).not.toBeNull();
    expect(
      (await harness.changeKeyRows(receipt!.command_id)).map((row) => row.kind),
    ).toContain("company");
    expect(
      await harness.auditCountByOperation(removeTenant, "member.remove"),
    ).toBe(1);

    // A removed member can no longer mint a scope.
    expect(
      await refusalCodeOf(
        harness.resolveScope({
          actorUserId: member.userId,
          tenantId: removeTenant,
          workspaceId: removeWorkspace,
        }),
      ),
    ).toMatch(/TENANT_FORBIDDEN|SCOPE_REVOKED|WORKSPACE_FORBIDDEN/);
  });

  test("owner_transfer_is_atomic_and_keeps_exactly_one_owner", async () => {
    const transferTenant = await harness.provision(
      "t0403-key-solo",
      owner.userId,
    );
    const successor = await harness.joinMember({
      tenantId: transferTenant,
      workspaceIds: [preAllocateProvisionWorkspaceId(transferTenant)],
      role: "admin",
      label: "successor",
      keySuffix: "successor",
    });

    const transferred = await harness.run({
      actorUserId: owner.userId,
      tenantId: transferTenant,
      operation: "owner.transfer",
      key: "{{SECRET_f5j8l3bz}}",
      payload: { nextOwnerUserId: successor.userId },
    });
    expect(transferred.replayed).toBe(false);

    // Exactly one owner afterwards: the successor holds it, the outgoing
    // owner stepped down to admin in the SAME command.
    const owners = await harness.activeOwners(transferTenant);
    expect(owners.map((row) => row.user_id)).toEqual([successor.userId]);
    expect(await harness.memberRows(transferTenant, owner.userId)).toEqual([
      { role: "admin" },
    ]);

    // The successor's own real scope now works, and the transfer is one audit
    // fact with both members' company change keys.
    const receipt = await harness.receiptOf(
      transferTenant,
      "{{SECRET_f5j8l3bz}}",
    );
    expect(receipt).not.toBeNull();
    const keys = await harness.changeKeyRows(receipt!.command_id);
    expect(keys.filter((row) => row.kind === "company").length).toBe(2);
    expect(
      await harness.auditCountByOperation(transferTenant, "owner.transfer"),
    ).toBe(1);
  });

  test("member_commands_refuse_a_non_admin_actor_and_a_foreign_member", async () => {
    const guardTenant = await harness.provision(
      "t0403-key-company",
      owner.userId,
    );
    // The plain member of THIS company: a member never suspends anyone.
    const plain = await harness.joinMember({
      tenantId: guardTenant,
      workspaceIds: [preAllocateProvisionWorkspaceId(guardTenant)],
      label: "plain",
      keySuffix: "plain",
    });
    expect(
      await refusalCodeOf(
        harness.run({
          actorUserId: plain.userId,
          tenantId: guardTenant,
          operation: "member.suspend",
          key: "{{SECRET_h1n6d9tv}}",
          payload: { userId: owner.userId, reason: "t0403 越权尝试" },
        }),
      ),
    ).toBe("MEMBERSHIP_LIFECYCLE_ACTOR_FORBIDDEN");

    // Another company's member is answered exactly like a missing one: one
    // invisible not-found, never an existence leak across companies.
    const foreign = await harness.joinMember({
      tenantId: tenantB,
      workspaceIds: [preAllocateProvisionWorkspaceId(tenantB)],
      label: "foreign",
      keySuffix: "foreign",
    });
    expect(
      await refusalCodeOf(
        harness.run({
          actorUserId: owner.userId,
          tenantId: guardTenant,
          operation: "member.suspend",
          key: "{{SECRET_z4c2s8pm}}",
          payload: { userId: foreign.userId, reason: "t0403 跨公司" },
        }),
      ),
    ).toBe("MEMBERSHIP_LIFECYCLE_MEMBER_NOT_FOUND");

    // A restore of a member who is not suspended is a state conflict, not a
    // silent extra epoch.
    expect(
      await refusalCodeOf(
        harness.run({
          actorUserId: owner.userId,
          tenantId: guardTenant,
          operation: "member.restore",
          key: "{{SECRET_k8q5w1xe}}",
          payload: { userId: plain.userId, reason: "t0403 未暂停" },
        }),
      ),
    ).toBe("MEMBERSHIP_LIFECYCLE_NOT_SUSPENDED");

    // And the plain member's row is untouched by all three refusals.
    expect(await harness.memberRows(guardTenant, plain.userId)).toEqual([
      { role: "member" },
    ]);
  });

  test("a_replayed_member_command_reports_the_same_receipt", async () => {
    const replayTenant = await harness.provision(
      "t0403-key-second",
      owner.userId,
    );
    const member = await harness.joinMember({
      tenantId: replayTenant,
      workspaceIds: [preAllocateProvisionWorkspaceId(replayTenant)],
      label: "replayable",
      keySuffix: "replayable",
    });

    const first = await harness.run({
      actorUserId: owner.userId,
      tenantId: replayTenant,
      operation: "member.suspend",
      key: "{{SECRET_b7y3v2jg}}",
      payload: { userId: member.userId, reason: "t0403 重放" },
    });
    expect(first.replayed).toBe(false);
    const second = await harness.run({
      actorUserId: owner.userId,
      tenantId: replayTenant,
      operation: "member.suspend",
      key: "{{SECRET_b7y3v2jg}}",
      payload: { userId: member.userId, reason: "t0403 重放" },
    });
    // A replay reports the durable half and never re-runs the transition: one
    // audit fact, one receipt, and the generation did not move twice.
    expect(second.replayed).toBe(true);
    expect(
      await harness.auditCountByOperation(replayTenant, "member.suspend"),
    ).toBe(1);
    const memberPrincipal = await harness.principalOf(member.userId);
    const [clock] = await harness.clockRows(
      replayTenant,
      memberPrincipal as string,
      "company",
      replayTenant,
    );
    expect(clock.generation).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Scope B (ticket step 5): the old entrances' ba-branch translation. The
  // service-level branch needs the branded tenancy channels (ob_ent_* roles),
  // which the island deliberately does not carry — the port plus the shared
  // translation skeleton are what every old entrance (people-lifecycle,
  // workspace-admin, deletion-semantics) runs through, so that is the surface
  // pinned here on the real stack; the legacy/paused matrix of the services
  // themselves stays on the existing enterprise-DB suites (port absent ⇒ the
  // original path is byte-identical).
  // ---------------------------------------------------------------------------

  test("translation_port_serves_live_member_facts_and_the_commands_audit_row", async () => {
    const translation = createMembershipAdminTranslation({
      database: harness.directoryDatabase,
      authority: harness.authority,
      directory: harness.directory,
    });
    expect(await translation.modeOf()).toBe("ba");

    const wireTenant = await harness.provision("t0403-key-wire", owner.userId);
    const member = await harness.joinMember({
      tenantId: wireTenant,
      workspaceIds: [preAllocateProvisionWorkspaceId(wireTenant)],
      label: "wireport",
      keySuffix: "wireport",
    });
    const memberPrincipal = (await harness.principalOf(
      member.userId,
    )) as string;
    const ownerPrincipal = (await harness.principalOf(owner.userId)) as string;

    // The narrow member context: one principal's live projection facts.
    const ownerFacts = await translation.memberOf({
      tenantId: wireTenant,
      principalId: ownerPrincipal,
    });
    expect(ownerFacts?.userId).toBe(owner.userId);
    expect(ownerFacts?.role).toBe("tenant_admin");
    expect(ownerFacts?.status).toBe("active");
    const memberFacts = await translation.memberOf({
      tenantId: wireTenant,
      principalId: memberPrincipal,
    });
    expect(memberFacts).toMatchObject({
      userId: member.userId,
      role: "member",
      status: "active",
    });
    expect(Number.isSafeInteger(memberFacts?.epoch)).toBe(true);

    // A principal of ANOTHER company is the invisible not-found (no existence
    // leak across companies, the old entrances' discipline).
    expect(
      await translation.memberOf({
        tenantId: tenantB,
        principalId: memberPrincipal,
      }),
    ).toBeNull();
    expect(
      await translation.memberOf({
        tenantId: wireTenant,
        principalId: "t0403-no-such-principal",
      }),
    ).toBeNull();

    // The command's audit fact is addressable by its commandId — the id a
    // translated report's auditEventId carries.
    const suspended = await harness.run({
      actorUserId: owner.userId,
      tenantId: wireTenant,
      operation: "member.suspend",
      key: "t0403-wire-port-suspend",
      payload: { userId: member.userId, reason: "t0403 端口核验" },
    });
    expect(suspended.replayed).toBe(false);
    const receipt = await harness.receiptOf(
      wireTenant,
      "t0403-wire-port-suspend",
    );
    expect(receipt).not.toBeNull();
    const auditId = await translation.auditEventIdOf({
      tenantId: wireTenant,
      commandId: receipt!.command_id,
    });
    expect(typeof auditId).toBe("string");
    expect(auditId).toBeTruthy();

    // The actor shape the translated commands run under: a platform actor
    // whose userId is the acting administrator's — the old entrances carry no
    // session id, and a session actor must name one.
    expect(translation.actorOf(owner.userId)).toEqual({
      userId: owner.userId,
      principalId: null,
      sessionId: null,
      kind: "platform",
      bindingId: null,
      provisioning: null,
    });
  });

  test("shared_skeleton_suspend_restore_carries_report_facts_and_gates", async () => {
    const translation = createMembershipAdminTranslation({
      database: harness.directoryDatabase,
      authority: harness.authority,
      directory: harness.directory,
    });
    const tenant = await harness.provision("t0403-key-wire2", owner.userId);
    const member = await harness.joinMember({
      tenantId: tenant,
      workspaceIds: [preAllocateProvisionWorkspaceId(tenant)],
      label: "wiresus",
      keySuffix: "wiresus",
    });
    const memberPrincipal = (await harness.principalOf(
      member.userId,
    )) as string;

    const suspended = await translateMembershipLifecycle(translation, {
      actorUserId: owner.userId,
      tenantId: tenant,
      principalId: memberPrincipal,
      operation: "member.suspend",
      payloadOf: (userId) => ({ userId, reason: "t0403 骨架暂停" }),
    });
    expect(suspended.before).toMatchObject({
      userId: member.userId,
      role: "member",
      status: "active",
    });
    expect(suspended.after.status).toBe("suspended");
    // Suspend advances the clock's generation, not the projection epoch
    // (handler doc: only the other lifecycle commands advance the epoch).
    expect(suspended.after.epoch).toBe(suspended.before.epoch);
    expect(suspended.replayed).toBe(false);
    // The audit id IS the directory finalizer's own row, addressed by commandId.
    expect(
      await translation.auditEventIdOf({
        tenantId: tenant,
        commandId: suspended.commandId,
      }),
    ).toBe(suspended.auditEventId);
    // The real directory fact moved: the member row stays (suspension is not
    // removal), the projection reads suspended.
    expect(await harness.memberRows(tenant, member.userId)).toEqual([
      { role: "member" },
    ]);
    expect(
      (await harness.businessMembership(tenant, memberPrincipal))[0].status,
    ).toBe("suspended");

    // The gates ride the skeleton: an unknown principal and a second suspend
    // both refuse with the legacy invisible not-found.
    await expect(
      translateMembershipLifecycle(translation, {
        actorUserId: owner.userId,
        tenantId: tenant,
        principalId: "t0403-no-such-principal",
        operation: "member.suspend",
        payloadOf: (userId) => ({ userId, reason: "x" }),
      }),
    ).rejects.toThrow("COMPANY_MEMBER_NOT_FOUND");
    await expect(
      translateMembershipLifecycle(translation, {
        actorUserId: owner.userId,
        tenantId: tenant,
        principalId: memberPrincipal,
        operation: "member.suspend",
        payloadOf: (userId) => ({ userId, reason: "x" }),
      }),
    ).rejects.toThrow("COMPANY_MEMBER_NOT_FOUND");

    // member.restore through the same skeleton with the entrance's own gate:
    // a NEW admission, and the suspended member's door reopens.
    const restored = await translateMembershipLifecycle(translation, {
      actorUserId: owner.userId,
      tenantId: tenant,
      principalId: memberPrincipal,
      operation: "member.restore",
      payloadOf: (userId) => ({ userId, reason: "t0403 骨架恢复" }),
      stateGate: (member) => member.status === "suspended",
    });
    expect(restored.after.status).toBe("active");
    expect(restored.after.epoch).toBe(suspended.after.epoch + 1);
  });

  test("skeleton_remove_and_leave_keep_the_last_owner_protection", async () => {
    const translation = createMembershipAdminTranslation({
      database: harness.directoryDatabase,
      authority: harness.authority,
      directory: harness.directory,
    });
    const tenant = await harness.provision("t0403-key-wire3", owner.userId);
    const member = await harness.joinMember({
      tenantId: tenant,
      workspaceIds: [preAllocateProvisionWorkspaceId(tenant)],
      label: "wirerem",
      keySuffix: "wirerem",
    });
    const memberPrincipal = (await harness.principalOf(
      member.userId,
    )) as string;
    const team = await harness.teamOf(tenant);

    const removed = await translateMembershipLifecycle(translation, {
      actorUserId: owner.userId,
      tenantId: tenant,
      principalId: memberPrincipal,
      operation: "member.remove",
      payloadOf: (userId) => ({ userId, reason: "t0403 骨架移除" }),
    });
    expect(removed.after.status).toBe("suspended");
    expect(await harness.memberRows(tenant, member.userId)).toHaveLength(0);
    expect(await harness.teamMemberRows(tenant, member.userId)).toHaveLength(0);
    expect(await harness.teamCount(team)).toBe(1);

    // The last-owner protection rides the translation, by name.
    const ownerPrincipal = (await harness.principalOf(owner.userId)) as string;
    await expect(
      translateMembershipLifecycle(translation, {
        actorUserId: owner.userId,
        tenantId: tenant,
        principalId: ownerPrincipal,
        operation: "member.remove",
        payloadOf: (userId) => ({ userId, reason: "x" }),
      }),
    ).rejects.toThrow(/LAST_OWNER/);

    // member.leave is the member's own command (Track B's per-company
    // revocation in the ba branch): the actor IS the subject.
    const leaver = await harness.joinMember({
      tenantId: tenant,
      workspaceIds: [preAllocateProvisionWorkspaceId(tenant)],
      label: "wireleave",
      keySuffix: "wireleave",
    });
    const leaverPrincipal = (await harness.principalOf(
      leaver.userId,
    )) as string;
    const left = await translateMembershipLifecycle(translation, {
      actorUserId: leaver.userId,
      tenantId: tenant,
      principalId: leaverPrincipal,
      operation: "member.leave",
      payloadOf: () => ({}),
    });
    expect(left.after.status).toBe("suspended");
    expect(await harness.memberRows(tenant, leaver.userId)).toHaveLength(0);
    // And the owner still cannot strand the company by leaving.
    await expect(
      translateMembershipLifecycle(translation, {
        actorUserId: owner.userId,
        tenantId: tenant,
        principalId: ownerPrincipal,
        operation: "member.leave",
        payloadOf: () => ({}),
      }),
    ).rejects.toThrow(/LAST_OWNER/);
    expect(await harness.activeOwners(tenant)).toHaveLength(1);
  });

  test("paused_authority_refuses_before_any_write", async () => {
    const translation = createMembershipAdminTranslation({
      database: harness.directoryDatabase,
      authority: harness.authority,
      directory: harness.directory,
    });
    const tenant = await harness.provision("t0403-key-wire4", owner.userId);
    const member = await harness.joinMember({
      tenantId: tenant,
      workspaceIds: [preAllocateProvisionWorkspaceId(tenant)],
      label: "wirepaused",
      keySuffix: "wirepaused",
    });
    const memberPrincipal = (await harness.principalOf(
      member.userId,
    )) as string;

    // Paused authority lives in phase M2 (the backfill pause; the 0211 CHECK
    // binds paused to M2/M3, so M4+paused is not a representable state).
    await setAuthority(harness.sql, {
      phase: "M2",
      directoryAuthority: "paused",
    });
    try {
      expect(await translation.modeOf()).toBe("paused");
      // The service-level branch answers MEMBERSHIP_LIFECYCLE_PAUSED upstream
      // of the skeleton; the executor's own gate is the belt: a command under
      // paused authority is refused by name before any DML.
      await expect(
        harness.run({
          actorUserId: owner.userId,
          tenantId: tenant,
          operation: "member.suspend",
          key: "t0403-wire-paused-suspend",
          payload: { userId: member.userId, reason: "x" },
        }),
      ).rejects.toThrow(/PAUSED/);
    } finally {
      await setAuthority(harness.sql, {
        phase: "M4",
        directoryAuthority: "ba",
      });
    }
    // No receipt, no audit fact, and the member is untouched.
    expect(
      await harness.receiptOf(tenant, "t0403-wire-paused-suspend"),
    ).toBeNull();
    expect(
      (await harness.businessMembership(tenant, memberPrincipal))[0].status,
    ).toBe("active");
  });
});
