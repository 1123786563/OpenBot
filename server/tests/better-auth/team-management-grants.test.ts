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
  Directory,
  DirectoryActor,
  DirectoryOperation,
  TeamManagementGrantView,
} from "../../src/auth/directory/contracts";
import { createDirectoryExecutor } from "../../src/auth/directory/executor";
import { createDirectoryFinalizer } from "../../src/auth/directory/finalizer";
import {
  createCompanyProvisionHandler,
  preAllocateProvisionTenantId,
} from "../../src/auth/directory/lifecycle";
import {
  createFixedVersionInvitationCommands,
  createInvitationMembershipHandlers,
} from "../../src/auth/directory/membership";
import { principalRegistry } from "../../src/auth/directory/principal-registry";
import {
  createDirectoryTeamGrantPort,
  createTeamManagementGrantHandler,
  createTeamManagementRevokeHandler,
  isTeamGrantRefusal,
  listTeamManagementGrants,
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
  createCompanyAdminRoutes,
  type CompanyAdminRouteDeps,
} from "../../src/enterprise/tenancy/company-admin-routes";
import {
  createPlatformCompanyProvisionService,
  type CompanyBillingInitializationPort,
} from "../../src/enterprise/tenancy/provision";

/*
 * T04.07 (#551, P09) — the company admin grants and revokes a team-management
 * Grant on the real 0209–0217 stack of the isolated BA_TEST_* island
 * (interfaces §2 payload table, §3 TeamManagementGrantView, design §4.4/§6.4).
 * What this file pins, as database facts and real HTTP responses:
 *
 * - `company_admin_grants_and_revokes_exact_team_actions` (the Brief's first
 *   named case): a company owner grants the exact requested actions
 *   (team.member.add/remove) to an existing active team member; the resulting
 *   grant row carries those exact actions, generation 1, status active. A
 *   re-grant with a different action set advances the SAME stable row (same
 *   grantId, +1); a revoke sets status revoked and advances generation again
 *   (the 0217 guard enforces +1 and the immutable identity columns).
 * - `scoped_manager_cannot_delegate_management_grant` (the Brief's second
 *   named case): a member who holds no owner/admin company role cannot issue
 *   team.management.grant — answered with a real HTTP 403 through the mounted
 *   company-admin route, the directory command's own locked company-role
 *   re-verification being the refusing layer.
 * - `management_grant_api_round_trip`: the Hono surface assembled over the
 *   directory-backed port answers POST 201 → same-key replay 200/replayed →
 *   GET {grants:[…]} → DELETE 200 (+1 generation); a revoke named under
 *   another workspace's route answers 404 and writes nothing; and with the
 *   port unwired — the production assembly state this task defers — the
 *   surface answers 503 instead of any permissive stand-in. The replay body
 *   carries no grant identity: the receipt's forward grant columns have no
 *   controlled writer in the frozen 0214 function set (the finalizer's
 *   disclosed boundary; extending that writer is the 0218 path, outside this
 *   task).
 * - `grant_to_non_team_member_is_refused`: a user who is not a member of the
 *   target team is refused by name before any row is written.
 *
 * The suite applies the real 0209–0217 migrations and cleans up exactly what
 * it created. All five BA_TEST_* role URLs are required; a missing one is a
 * blocked suite, never a fallback. No DSN is ever printed.
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
  "0217_better_auth_team_management_grants",
] as const;

/** Everything the migrations above create (the T02.15 inventory + 0217). */
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

const PLATFORM_ADMIN_ID = "t0407-platform-admin";
const EMAIL_DOMAIN = "@t0407.example.test";
const DEFAULT_PASSWORD = "correct-horse-battery-staple";

const PROVISION_KEYS = ["t0407-key-company", "t0407-key-second"] as const;

interface HarnessUser {
  userId: string;
  email: string;
}

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

function readBaUrls(): void {
  let reference: string | null = null;
  for (const variable of BA_URL_VARIABLES) {
    const raw = process.env[variable]?.trim();
    if (!raw) {
      throw new Error(
        `${variable} is required: the team-management-grants suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
      );
    }
    const shape = shapeOf(variable, raw);
    if (reference !== null && shape !== reference) {
      throw new Error(
        `${variable} must name the same PostgreSQL instance and database as ${DATABASE_VARIABLE}.`,
      );
    }
    reference = shape;
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

/**
 * Returns the island to the pre-suite shape: this suite's rows gone, the BA
 * tables gone, the shared-table columns the migrations re-add normalized
 * (the company-provision recipe). Idempotent; also recovers a crashed run.
 */
async function cleanupFixture(
  sql: postgres.Sql,
  options: { ownsAuditTable: boolean },
): Promise<void> {
  const tenantIds = PROVISION_KEYS.map((key) =>
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
  await sql`DELETE FROM enterprise_principals WHERE user_id IN (
    SELECT id FROM users WHERE email LIKE ${`%@t0407.example.test`}
       OR id = ${PLATFORM_ADMIN_ID})`;
  await sql`DELETE FROM enterprise_workspaces WHERE tenant_id IN (${sql.unsafe(
    tenantIds.map((id) => `'${id}'`).join(","),
  )})`;
  await sql`DELETE FROM enterprise_tenants WHERE id IN (${sql.unsafe(
    tenantIds.map((id) => `'${id}'`).join(","),
  )})`;
  await sql`DELETE FROM user_roles WHERE user_id = ${PLATFORM_ADMIN_ID}`;
  await sql`DELETE FROM users WHERE email LIKE ${`%@t0407.example.test`} OR id = ${PLATFORM_ADMIN_ID}`;
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
 * The assembled surfaces under test: the real executor stack over the
 * island's owner connection (the T04.03 assembly with the two T04.07 grant
 * handlers registered), and the company-admin surface built by the
 * production factory createCompanyAdminRoutes over the real directory-backed
 * port — only the authorizer is a fixture (it resolves a frozen admin
 * context for whichever actor the test pins; the authorizer's own
 * tenant_admin gate is the multitenancy suite's pin, not this one). The
 * other dep faces are untouched by the three grant routes and are left
 * unimplemented (the deps object is cast through unknown for that reason).
 */
interface Harness {
  sql: postgres.Sql;
  directory: Directory;
  owner: HarnessUser;
  freshUser(label: string): Promise<HarnessUser>;
  provision(key: string, ownerUserId: string): Promise<string>;
  workspaceOf(tenantId: string): Promise<string>;
  principalIdOf(userId: string): Promise<string>;
  run(input: {
    actorUserId: string;
    tenantId: string;
    operation: DirectoryOperation;
    key: string;
    payload: Record<string, unknown>;
  }): Promise<{
    replayed: boolean;
    workspaceId: string | null;
    resourceId: string | null;
    grantId: string | null;
    grantGeneration: number | null;
  }>;
  joinMember(input: {
    tenantId: string;
    workspaceIds: readonly string[];
    role?: string;
    label: string;
    keySuffix: string;
  }): Promise<HarnessUser>;
  listGrants(
    tenantId: string,
    workspaceId: string,
  ): Promise<
    readonly {
      readonly grantId: string;
      readonly userId: string;
      readonly actions: readonly string[];
      readonly generation: number;
      readonly status: string;
    }[]
  >;
  grantRows(
    grantId: string,
  ): Promise<{ status: string; generation: number }[]>;
  auditCountByOperation(tenantId: string, operation: string): Promise<number>;
}

interface RouteHarness {
  /** The admin context the fake authorizer resolves for the next request. */
  setActor(ref: { user: HarnessUser; principalId: string }): void;
  call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  /** The same surface assembled WITHOUT the port — the deferred-wiring face. */
  callWithoutPort(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
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
    // fact directly, exactly as the T04.01/T04.02/T04.03 suites do.
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
      "team.management.grant": createTeamManagementGrantHandler(),
      "team.management.revoke": createTeamManagementRevokeHandler(),
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

  const sessionActor = (userId: string): DirectoryActor => ({
    userId,
    principalId: null,
    sessionId: `t0407-session-${userId}`,
    kind: "session",
    bindingId: null,
    provisioning: null,
  });

  const run: Harness["run"] = async (input) => {
    const result = await directory.execute(sessionActor(input.actorUserId), {
      operation: input.operation,
      tenantId: input.tenantId,
      idempotencyKey: input.key,
      payload: input.payload,
    });
    return {
      replayed: result.replayed,
      workspaceId: result.workspaceId,
      resourceId: result.resourceId,
      grantId: result.grantId,
      grantGeneration: result.grantGeneration,
    };
  };

  const provision = async (key: string, ownerUserId: string) => {
    const tenantId = preAllocateProvisionTenantId(key);
    await provisioner.provision({
      actorUserId: PLATFORM_ADMIN_ID,
      idempotencyKey: key,
      name: `T04.07 公司 ${key}`,
      slug: `t0407-${key}`,
      ownerUserId,
      defaultTeamName: "默认团队",
    });
    return tenantId;
  };

  const workspaceOf = async (tenantId: string): Promise<string> => {
    const rows =
      await sql`SELECT workspace_id FROM auth_team_bindings WHERE tenant_id = ${tenantId} LIMIT 1`;
    const workspaceId = rows[0]?.workspace_id;
    if (typeof workspaceId !== "string") {
      throw new Error(`company ${tenantId} has no workspace binding`);
    }
    return workspaceId;
  };

  const owner = await signUp(`t0407-owner${EMAIL_DOMAIN}`, "T04.07 Owner");

  /**
   * Joins a member through the REAL invitation path (T04.02's accept): the
   * invite, the acceptance, the member row, the team membership and the
   * projection are all the commands' own work — no forged directory row.
   */
  const joinMember: Harness["joinMember"] = async (input) => {
    const user = await signUp(
      `t0407-${input.label}${EMAIL_DOMAIN}`,
      `T04.07 ${input.label}`,
    );
    const invite = await run({
      actorUserId: owner.userId,
      tenantId: input.tenantId,
      operation: "invitation.create",
      key: `t0407-invite-${input.keySuffix}`,
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
      key: `t0407-accept-${input.keySuffix}`,
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
    directory,
    owner,
    freshUser: (label) =>
      signUp(`t0407-${label}${EMAIL_DOMAIN}`, `T04.07 ${label}`),
    provision,
    workspaceOf,
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
    joinMember,
    listGrants: async (tenantId, workspaceId) =>
      listTeamManagementGrants(db as never, tenantId, workspaceId),
    grantRows: async (grantId) =>
      sql`SELECT status, generation::int AS generation
            FROM auth_team_management_grants WHERE grant_id = ${grantId}`,
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

/**
 * The company-admin surface assembled over the REAL directory-backed port:
 * `createCompanyAdminRoutes` is the production factory, the port is
 * `createDirectoryTeamGrantPort` over the same executor the command tests
 * drive, and only the authorizer is a fixture. The other dep faces are
 * untouched by the three grant routes and are left unimplemented (the deps
 * object is cast through unknown for exactly that reason).
 */
async function buildRouteHarness(
  harness: Harness,
  tenantId: string,
): Promise<RouteHarness> {
  const db = createDatabase(process.env[DATABASE_VARIABLE]!.trim(), {
    max: 2,
  });
  const port = createDirectoryTeamGrantPort(harness.directory, db as never);
  let acting: { user: HarnessUser; principalId: string } | null = null;

  const makeDeps = (withPort: boolean): CompanyAdminRouteDeps =>
    ({
      authorizer: {
        authenticate: async () =>
          acting
            ? { actorId: acting.user.userId, entrypoint: "web" as const }
            : null,
        resolveAdminContext: async () => {
          if (!acting) throw new Error("AUTH_REQUIRED");
          return Object.freeze({
            tenantId,
            principalId: acting.principalId,
            actorId: acting.user.userId,
            memberEpoch: 1,
          });
        },
        resolveMemberContext: async () => {
          if (!acting) throw new Error("AUTH_REQUIRED");
          return Object.freeze({
            tenantId,
            principalId: acting.principalId,
            actorId: acting.user.userId,
            role: "member" as const,
            memberEpoch: 1,
          });
        },
      },
      ...(withPort ? { teamGrants: port } : {}),
    }) as unknown as CompanyAdminRouteDeps;

  const callOn = async (
    app: Hono,
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await app.request(`http://127.0.0.1${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await response.json().catch(() => null);
    return { status: response.status, body: json };
  };

  const app = createCompanyAdminRoutes(makeDeps(true));
  const appWithoutPort = createCompanyAdminRoutes(makeDeps(false));
  return {
    setActor: (ref) => {
      acting = ref;
    },
    call: (method, path, body, headers) =>
      callOn(app, method, path, body, headers),
    callWithoutPort: (method, path, body) =>
      callOn(appWithoutPort, method, path, body),
  };
}

describe("T04.07 team management grants", () => {
  let harness: Harness;
  let routes: RouteHarness;
  let owner: HarnessUser;
  let ownerPrincipalId: string;
  let tenantA: string;
  let workspaceA: string;
  let tenantB: string;
  let workspaceB: string;
  let memberA: HarnessUser;
  let memberAPrincipalId: string;
  let memberB: HarnessUser;
  // The audit table's ownership is decided once, at setup — the island either
  // lacked it (we create and drop it) or predates us (we only clean our rows).
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
        (${PLATFORM_ADMIN_ID}, ${`t0407-admin${EMAIL_DOMAIN}`})`;
    await sql`
      INSERT INTO user_roles (user_id, role) VALUES (${PLATFORM_ADMIN_ID}, 'admin')`;
    await setAuthority(sql, { phase: "M4", directoryAuthority: "ba" });
    harness = await buildHarness(sql);
    owner = harness.owner;
    tenantA = await harness.provision("t0407-key-company", owner.userId);
    workspaceA = await harness.workspaceOf(tenantA);
    tenantB = await harness.provision("t0407-key-second", owner.userId);
    workspaceB = await harness.workspaceOf(tenantB);
    // The owner's principal is company.provision's own write — it exists only
    // once a company names them owner.
    ownerPrincipalId = await harness.principalIdOf(owner.userId);
    memberA = await harness.joinMember({
      tenantId: tenantA,
      workspaceIds: [workspaceA],
      label: "member",
      keySuffix: "member",
    });
    memberAPrincipalId = await harness.principalIdOf(memberA.userId);
    memberB = await harness.joinMember({
      tenantId: tenantA,
      workspaceIds: [workspaceA],
      label: "member-b",
      keySuffix: "member-b",
    });
    routes = await buildRouteHarness(harness, tenantA);
  });

  afterAll(async () => {
    if (!harness?.sql) return;
    await cleanupFixture(harness.sql, { ownsAuditTable });
    await harness.sql.end({ timeout: 5 }).catch(() => {});
  });

  test("company_admin_grants_and_revokes_exact_team_actions", async () => {
    const requestedActions = ["team.member.add", "team.member.remove"] as const;
    const granted = await harness.run({
      actorUserId: owner.userId,
      tenantId: tenantA,
      operation: "team.management.grant",
      key: "t0407-grant-1",
      payload: {
        workspaceId: workspaceA,
        userId: memberA.userId,
        actions: [...requestedActions],
      },
    });
    expect(granted.grantId).not.toBeNull();
    expect(granted.grantGeneration).toBe(1);

    const grants = await harness.listGrants(tenantA, workspaceA);
    expect(grants.length).toBe(1);
    const grant = grants[0]!;
    expect(grant.grantId).toBe(granted.grantId);
    expect(grant.userId).toBe(memberA.userId);
    expect(grant.actions).toEqual(requestedActions);
    expect(grant.generation).toBe(1);
    expect(grant.status).toBe("active");

    const rows1 = await harness.grantRows(grant.grantId);
    expect(rows1[0]?.status).toBe("active");
    expect(rows1[0]?.generation).toBe(1);
    expect(
      await harness.auditCountByOperation(tenantA, "team.management.grant"),
    ).toBe(1);

    // A re-grant with a differing action set advances the same stable row.
    const reGrant = await harness.run({
      actorUserId: owner.userId,
      tenantId: tenantA,
      operation: "team.management.grant",
      key: "t0407-grant-2",
      payload: {
        workspaceId: workspaceA,
        userId: memberA.userId,
        actions: ["team.member.add"],
      },
    });
    expect(reGrant.grantId).toBe(grant.grantId);
    expect(reGrant.grantGeneration).toBe(2);
    const rows2 = await harness.grantRows(grant.grantId);
    expect(rows2[0]?.status).toBe("active");
    expect(rows2[0]?.generation).toBe(2);
    const regrantView = (await harness.listGrants(tenantA, workspaceA))[0]!;
    expect(regrantView.actions).toEqual(["team.member.add"]);

    // Revoke advances the generation and sets status revoked.
    const revoke = await harness.run({
      actorUserId: owner.userId,
      tenantId: tenantA,
      operation: "team.management.revoke",
      key: "t0407-revoke-1",
      payload: { grantId: grant.grantId, reason: "no longer needed" },
    });
    expect(revoke.grantId).toBe(grant.grantId);
    expect(revoke.grantGeneration).toBe(3);
    const rows3 = await harness.grantRows(grant.grantId);
    expect(rows3[0]?.status).toBe("revoked");
    expect(rows3[0]?.generation).toBe(3);
    expect(
      await harness.auditCountByOperation(tenantA, "team.management.revoke"),
    ).toBe(1);

    // The list reflects the revoked status; the row is the only one.
    const grantsAfter = await harness.listGrants(tenantA, workspaceA);
    expect(grantsAfter.length).toBe(1);
    expect(grantsAfter[0]!.status).toBe("revoked");
    expect(grantsAfter[0]!.generation).toBe(3);
  });

  test("scoped_manager_cannot_delegate_management_grant", async () => {
    // Route level, real HTTP: the member holds no owner/admin company role, so
    // the directory command's own locked company-role re-verification refuses
    // the delegation with 403. The fake authorizer deliberately resolves the
    // member's context (the authorizer's own tenant_admin gate is the
    // multitenancy suite's pin); the command itself must be the refusing
    // layer, exactly as the Brief's named case demands.
    routes.setActor({ user: memberA, principalId: memberAPrincipalId });
    const { status } = await routes.call(
      "POST",
      `/admin/teams/${workspaceA}/management-grants`,
      { userId: owner.userId, actions: ["team.member.add"] },
      { "idempotency-key": "t0407-spoof-route" },
    );
    expect(status).toBe(403);
  });

  test("management_grant_api_round_trip", async () => {
    routes.setActor({ user: owner, principalId: ownerPrincipalId });
    const path = `/admin/teams/${workspaceA}/management-grants`;

    // memberB has no grant row yet — the POST is a fresh INSERT at generation
    // 1 (memberA's row from the named case above stays untouched).
    const grant = await routes.call(
      "POST",
      path,
      { userId: memberB.userId, actions: ["team.member.add"] },
      { "idempotency-key": "t0407-route-grant-1" },
    );
    expect(grant.status).toBe(201);
    const grantBody = grant.body as {
      grant: {
        grantId: string | null;
        grantGeneration: number;
        replayed: boolean;
      };
    };
    expect(grantBody.grant.grantId).not.toBeNull();
    expect(grantBody.grant.grantGeneration).toBe(1);
    expect(grantBody.grant.replayed).toBe(false);
    const grantId = grantBody.grant.grantId as string;

    // The same key replays: 200, replayed — and the disclosed receipt
    // forward-column boundary means the replay body carries no grant identity.
    const replay = await routes.call(
      "POST",
      path,
      { userId: memberB.userId, actions: ["team.member.add"] },
      { "idempotency-key": "t0407-route-grant-1" },
    );
    expect(replay.status).toBe(200);
    expect(
      (replay.body as { grant: { replayed: boolean } }).grant.replayed,
    ).toBe(true);

    const list = await routes.call("GET", path);
    expect(list.status).toBe(200);
    const views = (list.body as { grants: TeamManagementGrantView[] }).grants;
    expect(views).toHaveLength(2);
    const memberBView = views.find((view) => view.grantId === grantId)!;
    expect(memberBView.actions).toEqual(["team.member.add"]);
    expect(memberBView.status).toBe("active");
    expect(memberBView.userId).toBe(memberB.userId);

    const revoke = await routes.call(
      "DELETE",
      `${path}/${grantId}`,
      { reason: "route round trip" },
    );
    expect(revoke.status).toBe(200);
    const revokeBody = revoke.body as {
      grant: { grantId: string | null; grantGeneration: number };
    };
    expect(revokeBody.grant.grantId).toBe(grantId);
    expect(revokeBody.grant.grantGeneration).toBe(2);

    // Path containment: the same grant named under ANOTHER workspace's route
    // answers not-found and writes nothing there.
    const crossWorkspace = await routes.call(
      "DELETE",
      `/admin/teams/${workspaceB}/management-grants/${grantId}`,
      { reason: "wrong workspace" },
    );
    expect(crossWorkspace.status).toBe(404);

    // Without the port — the production assembly state this task defers —
    // the surface answers 503, never a permissive stand-in.
    const unavailable = await routes.callWithoutPort("GET", path);
    expect(unavailable.status).toBe(503);
    expect((unavailable.body as { error: { code: string } }).error.code).toBe(
      "MANAGEMENT_GRANTS_UNAVAILABLE",
    );
  });

  test("regranted_grant_is_revocable_again_per_generation_key", async () => {
    // Review r1 / R1-F1: with the old per-row key `revoke-${grantId}`, a
    // revoke → re-grant → second revoke collided with the first receipt —
    // the SAME reason replayed a silent no-op (row stayed active) and a
    // DIFFERENT reason answered 409 — so a re-granted grant could never be
    // revoked again over HTTP. The per-generation key (interfaces §3) makes
    // every revoke of a NEW generation a fresh command.
    routes.setActor({ user: owner, principalId: ownerPrincipalId });
    const path = `/admin/teams/${workspaceA}/management-grants`;
    const grantId = (await harness.listGrants(tenantA, workspaceA)).find(
      (view) => view.userId === memberB.userId,
    )!.grantId;

    // memberB's stable row sits revoked at generation 2 (the round trip
    // above); a re-grant reactivates it at generation 3.
    const regrant = await routes.call(
      "POST",
      path,
      { userId: memberB.userId, actions: ["team.member.add"] },
      { "idempotency-key": "t0407-revoke-arm-regrant-1" },
    );
    expect(regrant.status).toBe(201);
    expect(
      (regrant.body as { grant: { grantGeneration: number } }).grant
        .grantGeneration,
    ).toBe(3);

    // Arm 1 — the SAME reason as the round trip's revoke: a fresh command
    // against the re-granted generation, executed (not replayed).
    const sameReason = await routes.call("DELETE", `${path}/${grantId}`, {
      reason: "route round trip",
    });
    expect(sameReason.status).toBe(200);
    expect(
      (
        sameReason.body as {
          grant: { replayed: boolean; grantGeneration: number };
        }
      ).grant,
    ).toMatchObject({ replayed: false, grantGeneration: 4 });
    const rowsArm1 = await harness.grantRows(grantId);
    expect(rowsArm1[0]?.status).toBe("revoked");
    expect(rowsArm1[0]?.generation).toBe(4);

    // Arm 2 — after another re-grant, a DIFFERENT reason also takes effect
    // (the old key shape answered 409 IDEMPOTENCY_CONFLICT here).
    const regrant2 = await routes.call(
      "POST",
      path,
      { userId: memberB.userId, actions: ["team.member.add"] },
      { "idempotency-key": "t0407-revoke-arm-regrant-2" },
    );
    expect(regrant2.status).toBe(201);
    const differentReason = await routes.call("DELETE", `${path}/${grantId}`, {
      reason: "second rotation",
    });
    expect(differentReason.status).toBe(200);
    expect(
      (
        differentReason.body as {
          grant: { replayed: boolean; grantGeneration: number };
        }
      ).grant,
    ).toMatchObject({ replayed: false, grantGeneration: 6 });
    const rowsArm2 = await harness.grantRows(grantId);
    expect(rowsArm2[0]?.status).toBe("revoked");
    expect(rowsArm2[0]?.generation).toBe(6);

    // A revoke of the now-revoked row still answers 409 — the
    // per-generation key does not loosen the already-revoked refusal.
    const repeat = await routes.call("DELETE", `${path}/${grantId}`, {
      reason: "second rotation",
    });
    expect(repeat.status).toBe(409);
  });

  test("grant_to_non_team_member_is_refused", async () => {
    const outsider = await harness.freshUser("outsider");
    const code = await harness
      .run({
        actorUserId: owner.userId,
        tenantId: tenantA,
        operation: "team.management.grant",
        key: "t0407-grant-outsider",
        payload: {
          workspaceId: workspaceA,
          userId: outsider.userId,
          actions: ["team.member.add"],
        },
      })
      .then(
        () => "granted",
        (error) => (isTeamGrantRefusal(error) ? error.code : "other"),
      );
    expect(code).toBe("TEAM_GRANT_TARGET_NOT_TEAM_MEMBER");
    // The refusal wrote nothing: the workspace still carries exactly the two
    // earlier rows (memberA's and memberB's), none of them the outsider's.
    const grants = await harness.listGrants(tenantA, workspaceA);
    expect(grants.length).toBe(2);
    expect(grants.some((view) => view.userId === outsider.userId)).toBe(false);
  });
});
