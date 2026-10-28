import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { betterAuth } from "better-auth";
import { SQL } from "bun";
import { sql as dsql } from "drizzle-orm";
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
  DirectoryTx,
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
  createMembershipLifecycleHandlers,
} from "../../src/auth/directory/membership";
import {
  assertMailCallbackCompletion,
  createAuthMailOutbox,
  createMailCallbackFence,
  settleMailCallbackFence,
} from "../../src/auth/directory/outbox";
import { principalRegistry } from "../../src/auth/directory/principal-registry";
import { createTransactionBoundBa } from "../../src/auth/directory/transaction-adapter";
import { createAuth } from "../../src/auth/index";
import { setRole } from "../../src/auth/roles";
import { createScimProvisioningHandlers } from "../../src/auth/scim";
import type { PayerAccount } from "../../src/billing/payer";
import { ensureProvisionedCompanyPayerAccount } from "../../src/billing/payer-company";
import { createDatabase } from "../../src/db/client";
import {
  authMembers,
  authOrganizations,
  authTeamBindings,
  authTeamMembers,
  authTeams,
} from "../../src/db/schema/auth-directory";
import {
  accounts,
  sessions,
  ssoProviders,
  users,
  verifications,
} from "../../src/db/schema/core";
import {
  type CompanyAdminRouteDeps,
  createCompanyAdminRoutes,
} from "../../src/enterprise/tenancy/company-admin-routes";
import {
  type CompanyBillingInitializationPort,
  createPlatformCompanyProvisionService,
} from "../../src/enterprise/tenancy/provision";
import { createOidcTestIdp } from "./support/oidc-idp";

/*
 * T05.06 (#562, P12) — the JIT and approved-group-rule wiring against the
 * single-use team capability, on the real 0209–0221 stack of the isolated
 * BA_TEST_* island. The five named cases:
 *
 * - `approved_rule_adds_team_and_revoked_rule_rejects`: a company owner
 *   approves a provisioning rule for a fixed server-issued binding through the
 *   company-admin surface; a jit actor carrying the verified event provisions
 *   a member into the rule's fixed team, and its single-use team capabilities
 *   (remove, then add) land through the capability path. After the revoke,
 *   the same evidence is refused — a revoked rule's revision no longer
 *   matches the event, and no later write borrows the old authority.
 * - `provisioning_capability_cannot_cross_company_or_request`: approving a
 *   rule whose binding belongs to ANOTHER company is a real HTTP 403 through
 *   the mounted company-admin route, and a jit event of company A cannot run
 *   its team command against company B — the binding fixes the company both
 *   at approval time and at consumption time.
 * - `ordinary_login_cannot_reapply_initial_admin`: the configured admin floor
 *   is applied once at account creation (the bootstrap) and a later sign-in
 *   never re-applies it — after an administrator demotes the user, the next
 *   ordinary login leaves the role exactly where the admin screen put it.
 * - `sso_callback_with_provider_organization_id_never_creates_member`: a
 *   provider row carrying organizationId (the server's fixed binding) with no
 *   approved rule for it produces a successful SSO callback and zero member
 *   rows — the pinned build's organizationProvisioning stays disabled and the
 *   JIT ingress supplies nothing without an approved rule.
 * - `mounted_sso_link_account_mail_has_no_post_commit_callback_bypass`: with
 *   the production createAuth mail wiring mounted (SMTP sink + the outbox
 *   converters), an SSO callback's deferred link-account dispatch registers
 *   as a committed outbox intent and sends NOTHING before the commit's drain
 *   — rawCallbackSends is exactly 0.
 *
 * All five BA_TEST_* role URLs are required; a missing one is a blocked
 * suite, never a fallback. No DSN is ever printed. The P12 wiring
 * (provisioning-rule handlers, the jit admission) is loaded lazily so a tree
 * without it still collects every case and fails on the missing target
 * behavior instead of dying at import time.
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

const SINK_SMTP_HOST = "127.0.0.1";
const SINK_SMTP_PORT = 1025;
const SINK_REST_BASE = "http://127.0.0.1:8025";

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
  "0230_better_auth_company_auth_challenge",
  "0231_better_auth_company_auth_complete",
  "0232_better_auth_company_auth_policy_read",
  "0233_better_auth_provisioning_rules",
] as const;

/** Everything the migrations above create (the T02.15 inventory + 0217–0219). */
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
  "auth_company_auth_policies",
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

const PLATFORM_ADMIN_ID = "t0506-platform-admin";
/** The identity command's receipt target (the T04.04 fixture-target order). */
const FIXTURE_TARGET = "t0506-fixture-target";
const EMAIL_DOMAIN = "@t0506.example.test";
const DEFAULT_PASSWORD = "correct-horse-battery-staple";
const INITIAL_ADMIN_EMAIL = `t0506-initial${EMAIL_DOMAIN}`;
const BASE_URL = "http://127.0.0.1:9";
const BA_SECRET = "t0506-provisioning-fixed-test-secret-not-a-credential";
const PAYLOAD_SECRET = "t0506-outbox-payload-secret-not-a-credential";

const PROVISION_KEYS = ["t0506-key-a", "t0506-key-b"] as const;
const BINDING_A = "t0506-jit-binding-a";
const BINDING_B = "t0506-jit-binding-b";
const IDP_ORG = "t0506-idp-org";
const IDP_MAIL = "t0506-idp-mail";
const IDEMPOTENCY_HEADER = "idempotency-key";

let harnessIdp: Awaited<ReturnType<typeof createOidcTestIdp>> | null = null;

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
        `${variable} is required: the provisioning-global-admin suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
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

/**
 * The controlled functions this suite's chain creates (0214's set plus the
 * challenge/policy functions of 0218/0219), dropped at cleanup so the next
 * suite's leak check sees the island as it found it.
 */
const CHAIN_FUNCTIONS = [
  "auth_directory_begin_command(text,text,text,text,text,text,text,text,text)",
  "auth_directory_finalize_command(text)",
  "auth_command_append_outbox(text,text,text,text)",
  "auth_principals_register(text,text,text)",
  "auth_project_company_membership(text,text,text,text,integer,text)",
  "auth_advance_eligibility_clock(text,text,text,text,bigint,bigint,boolean,text)",
  "auth_read_eligibility_clocks(text,text)",
  "auth_read_session_assurances(text,text)",
  "auth_directory_dml_guard()",
  "auth_directory_commit_fence()",
  "auth_directory_guard_principal(text)",
  "auth_issue_company_auth_challenge(text,text,text,text,text,text,bigint,text,text,text,timestamptz)",
  "auth_read_company_auth_policy(text)",
  "auth_consume_company_auth_challenge(text)",
  "auth_record_company_session_assurance(text,text,text,text,text,timestamp with time zone,text)",
] as const;

async function cleanupFixture(
  sql: postgres.Sql,
  options: { ownsAuditTable: boolean },
): Promise<void> {
  const tenantIds = PROVISION_KEYS.map((key) =>
    preAllocateProvisionTenantId(key),
  );
  for (const signature of CHAIN_FUNCTIONS) {
    await sql.unsafe(`DROP FUNCTION IF EXISTS public.${signature} CASCADE`);
  }
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
  await sql`DELETE FROM sso_providers WHERE provider_id IN (${BINDING_A}, ${BINDING_B}, ${IDP_ORG}, ${IDP_MAIL})`;
  await sql`DELETE FROM accounts WHERE account_id IN ('t0506-sub-target', 't0506-sub-target2', 't0506-sub-target3', 't0506-sub-org', 't0506-sub-mail')`;
  await sql`DELETE FROM enterprise_workspace_memberships WHERE tenant_id IN (${sql.unsafe(
    tenantIds.map((id) => `'${id}'`).join(","),
  )})`;
  await sql`DELETE FROM enterprise_memberships WHERE tenant_id IN (${sql.unsafe(
    tenantIds.map((id) => `'${id}'`).join(","),
  )})`;
  await sql`DELETE FROM enterprise_principals WHERE user_id IN (
    SELECT id FROM users WHERE email LIKE ${`%${EMAIL_DOMAIN}`}
       OR id = ${PLATFORM_ADMIN_ID})`;
  await sql`DELETE FROM enterprise_workspaces WHERE tenant_id IN (${sql.unsafe(
    tenantIds.map((id) => `'${id}'`).join(","),
  )})`;
  await sql`DELETE FROM enterprise_tenants WHERE id IN (${sql.unsafe(
    tenantIds.map((id) => `'${id}'`).join(","),
  )})`;
  await sql`DELETE FROM user_roles WHERE user_id IN (
    SELECT id FROM users WHERE email LIKE ${`%${EMAIL_DOMAIN}`}
       OR id = ${PLATFORM_ADMIN_ID})`;
  await sql`DELETE FROM users WHERE email LIKE ${`%${EMAIL_DOMAIN}`} OR id = ${PLATFORM_ADMIN_ID} OR id = ${FIXTURE_TARGET}`;
  if (options.ownsAuditTable) {
    await sql.unsafe(
      `DROP POLICY IF EXISTS "enterprise_audit_event_operator_insert" ON ${AUDIT_TABLE}`,
    );
    await sql.unsafe(
      `DROP POLICY IF EXISTS "enterprise_audit_event_operator_read" ON ${AUDIT_TABLE}`,
    );
    await sql.unsafe(`DROP TABLE IF EXISTS ${AUDIT_TABLE}`);
  }
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

async function sinkClear(): Promise<void> {
  await fetch(`${SINK_REST_BASE}/api/v1/messages`, { method: "DELETE" });
}

interface SinkMessage {
  ID: string;
  Subject: string;
  To: { Address: string; Name: string }[];
}

async function sinkMessages(): Promise<SinkMessage[]> {
  const response = await fetch(`${SINK_REST_BASE}/api/v1/messages?limit=100`);
  const body = (await response.json()) as { messages: SinkMessage[] };
  return body.messages ?? [];
}

/*
 * The T05.06 target surface, loaded lazily so a worktree without the P12
 * wiring still collects every case (and fails it by name) instead of dying at
 * import time as a zero-case collection error — the same discipline the
 * T02.12 and T04.04 suites hold themselves to.
 */
type TeamExtensionModule =
  typeof import("../../src/auth/directory/team-extension");
let teamExtensionPromise: Promise<TeamExtensionModule> | undefined;
function loadTeamExtension(): Promise<TeamExtensionModule> {
  teamExtensionPromise ??= import("../../src/auth/directory/team-extension");
  return teamExtensionPromise;
}

interface RouteCall {
  status: number;
  body: Record<string, unknown>;
}

interface RouteHarness {
  setActor(ref: { userId: string; principalId: string } | null): void;
  call(
    method: "POST" | "DELETE",
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<RouteCall>;
}

interface Harness {
  sql: postgres.Sql;
  directory: Directory;
  auth: ReturnType<typeof betterAuth>;
  routes: RouteHarness;
  tenantA: string;
  tenantB: string;
  workspaceA: string;
  workspaceB: string;
  ownerA: HarnessUser;
  ownerB: HarnessUser;
  principalIdOf(userId: string): Promise<string>;
  teamIdOf(tenantId: string, workspaceId: string): Promise<string | null>;
  ruleRow(
    bindingId: string,
  ): Promise<{ ruleId: string; revision: number; status: string } | null>;
  memberRows(tenantId: string): Promise<{ user_id: string }[]>;
  teamMemberRows(
    tenantId: string,
    teamId: string,
  ): Promise<{ user_id: string }[]>;
  signUp(email: string): Promise<HarnessUser>;
  signUpProduction(email: string): Promise<HarnessUser>;
  signIn(email: string): Promise<Response>;
  roleOf(userId: string): Promise<string | null>;
  ssoCallback(input: {
    providerId: string;
    subject: string;
    email: string;
  }): Promise<Response>;
  /** The same callback inside an identity command (T04.04's shape). */
  ssoCallbackInCommand(input: {
    providerId: string;
    subject: string;
    email: string;
    failAfterConversion?: boolean;
  }): Promise<{ status: number; intents: number }>;
  drain(): Promise<{ delivered: number }>;
  intentsCount(): Promise<number>;
}

/**
 * The test-side transaction capture, the same seam createAuth installs in
 * production (`createScimTransactionCapture`): every transaction the fixed
 * build opens on this database records its open tx, so the SSO hooks execute
 * their directory commands on exactly the transaction the plugin owns.
 */
function createCapture(database: ReturnType<typeof createDatabase>): {
  database: ReturnType<typeof createDatabase>;
  currentTransaction: () => DirectoryTx | null;
} {
  const storage = new AsyncLocalStorage<DirectoryTx>();
  const captured = new Proxy(database, {
    get(target, property) {
      if (property === "transaction") {
        return (run: (tx: DirectoryTx) => Promise<unknown>) =>
          target.transaction(((tx: DirectoryTx) =>
            storage.run(tx, () => run(tx))) as never);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    database: captured,
    currentTransaction: () => storage.getStore() ?? null,
  };
}

async function buildHarness(setupUrl: string): Promise<Harness> {
  const sql = postgres(setupUrl, {
    max: 4,
    idle_timeout: 5,
    onnotice: () => {},
  });
  const db = createDatabase(process.env[DATABASE_VARIABLE]!.trim(), { max: 6 });
  const tenantA = preAllocateProvisionTenantId("t0506-key-a");
  const tenantB = preAllocateProvisionTenantId("t0506-key-b");

  const baSchema = {
    user: users,
    session: sessions,
    account: accounts,
    verification: verifications,
    organization: authOrganizations,
    member: authMembers,
    team: authTeams,
    teamMember: authTeamMembers,
    teamBinding: authTeamBindings,
    ssoProvider: ssoProviders,
  };
  const capture = createCapture(db);
  const authority = createDirectoryAuthority();
  let bound: ReturnType<typeof createTransactionBoundBa> | null = null;
  let executorHandlers: Record<string, unknown> = {};
  const directoryOver = (tx: DirectoryTx) =>
    createDirectoryExecutor({
      database: { transaction: (run) => run(tx) } as never,
      bound: bound!,
      authority,
      registry: principalRegistry,
      finalizer: createDirectoryFinalizer(),
      handlers: executorHandlers,
    });

  /*
   * The directory instance: the fixed build with the organization plugin
   * mounted (the teams the directory commands write through — the same shape
   * the T05.05 harness drives; the production createAuth does not mount it
   * yet, which is the T08 assembly task's, not this suite's). All directory
   * commands, the company fixture and the admin routes run on this one.
   */
  const { drizzleAdapter } = await import("@better-auth/drizzle-adapter");
  const { organization } = await import("better-auth/plugins");
  const authDirectory = betterAuth({
    secret: BA_SECRET,
    baseURL: BASE_URL,
    trustedOrigins: [BASE_URL],
    emailAndPassword: { enabled: true },
    plugins: [organization({ teams: { enabled: true } })],
    database: (options: unknown) =>
      drizzleAdapter(capture.database as never, {
        provider: "pg",
        schema: baSchema as never,
        transaction: true,
      })(options as never),
  });
  const directoryContext = await authDirectory.$context;
  bound = createTransactionBoundBa({
    createTxAdapter: (tx) =>
      drizzleAdapter(tx as never, {
        provider: "pg",
        schema: baSchema as never,
        transaction: false,
      })(authDirectory.options as never),
  });
  const ba = createFixedVersionInvitationCommands(directoryContext, {
    teams: { enabled: true },
  });
  const p12 = (await loadTeamExtension()) as TeamExtensionModule & {
    createProvisioningRuleHandlers?: () => Partial<
      Record<
        DirectoryOperation,
        Parameters<typeof createDirectoryExecutor>[0]["handlers"][string]
      >
    >;
    createDirectoryProvisioningRulePort?: (
      directory: Directory,
      db: unknown,
    ) => unknown;
  };
  const teamHandlers =
    typeof p12.createScopedTeamMemberHandlers === "function"
      ? p12.createScopedTeamMemberHandlers({
          extension: p12.createScopedTeamExtension({
            commands: p12.createFixedVersionTeamMemberCommands(
              directoryContext,
              {
                teams: { enabled: true },
              },
            ),
          }),
        })
      : {};
  executorHandlers = {
    "company.provision": createCompanyProvisionHandler(),
    ...createInvitationMembershipHandlers({ ba }),
    ...createMembershipLifecycleHandlers(),
    ...createScimProvisioningHandlers({ ba }),
    // The P12 pair: the rule commands and the capability's team-member
    // handlers. Absent at the RED baseline — exactly what the RED pass pins.
    ...(p12.createProvisioningRuleHandlers
      ? p12.createProvisioningRuleHandlers()
      : {}),
    ...teamHandlers,
  };
  const directory = createDirectoryExecutor({
    database: db,
    bound,
    authority,
    registry: principalRegistry,
    finalizer: createDirectoryFinalizer(),
    handlers: executorHandlers,
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

  const signUp = async (email: string): Promise<HarnessUser> => {
    const response = await (
      authDirectory.api as unknown as Record<
        string,
        (input: unknown) => Promise<Response>
      >
    ).signUpEmail({
      body: {
        email,
        password: DEFAULT_PASSWORD,
        name: email.split("@")[0],
      },
      asResponse: true,
    });
    if (response.status !== 200) {
      throw new Error(`signUpEmail for ${email} failed: ${response.status}`);
    }
    const body = (await response.json()) as { user: { id: string } };
    await sql`UPDATE users SET email_verified = true WHERE email = ${email.toLowerCase()}`;
    return { userId: body.user.id, email: email.toLowerCase() };
  };

  /** The production factory's own signup (its bootstrap hooks included). */
  const signUpProduction = async (email: string): Promise<HarnessUser> => {
    const response = await (
      auth.api as unknown as Record<
        string,
        (input: unknown) => Promise<Response>
      >
    ).signUpEmail({
      body: {
        email,
        password: DEFAULT_PASSWORD,
        name: email.split("@")[0],
      },
      asResponse: true,
    });
    if (response.status !== 200) {
      throw new Error(
        `production signUpEmail for ${email} failed: ${response.status}`,
      );
    }
    const body = (await response.json()) as { user: { id: string } };
    return { userId: body.user.id, email: email.toLowerCase() };
  };

  const signIn = async (email: string): Promise<Response> =>
    (
      auth.api as unknown as Record<
        string,
        (input: unknown) => Promise<Response>
      >
    ).signInEmail({
      body: { email, password: DEFAULT_PASSWORD },
      asResponse: true,
    });

  const ssoCallback = async (input: {
    providerId: string;
    subject: string;
    email: string;
  }): Promise<Response> => {
    const api = auth.api as unknown as Record<
      string,
      (input: unknown) => Promise<Response>
    >;
    const initiate = await api.signInSSO({
      body: { providerId: input.providerId, callbackURL: "/" },
      asResponse: true,
    });
    if (initiate.status !== 200) {
      throw new Error(`/sign-in/sso initiation failed: ${initiate.status}`);
    }
    const cookie = initiate.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    const { url: authorizationUrl } = (await initiate.json()) as {
      url: string;
    };
    const parsed = new URL(authorizationUrl);
    const state = parsed.searchParams.get("state") ?? "";
    const code = harnessIdp!.authorize({
      nonce: state,
      codeChallenge: parsed.searchParams.get("code_challenge") ?? "",
      redirectUri: parsed.searchParams.get("redirect_uri") ?? "",
      claims: {
        sub: input.subject,
        email: input.email,
        email_verified: false,
        name: `T05.06 ${input.subject}`,
      },
    });
    return api.callbackSSO({
      params: { providerId: input.providerId },
      query: { code, state },
      headers: { cookie },
      asResponse: true,
    });
  };

  /*
   * The real SMTP delivery half (the T04.04 module's own sender over the
   * coordinator-provisioned Mailpit sink): the drain is the production
   * worker's shape, never a mocked transport.
   */
  const { createAuthMail } = await import("../../src/auth/mail");
  /*
   * The executor-shaped command transaction (the T04.04 recipe, the
   * fixture-target order): the receipt names a pre-seeded fixture user, and
   * the SSO callback runs inside the command's mail conversion context — its
   * deferred link-account dispatch converts there (an intent on this
   * transaction) or is refused unsent. The identity's own user row lands in
   * the fixed build's transaction exactly as production writes it.
   */
  const { drizzle: drizzleBun } = await import("drizzle-orm/bun-sql");
  const client = new SQL(setupUrl, {
    max: 2,
    idleTimeout: 5,
    connectionTimeout: 10_000,
    onnotice: () => {},
  });
  const txDb = drizzleBun({ client });
  let commandCounter = 0;
  const ssoCallbackInCommand = async (input: {
    providerId: string;
    subject: string;
    email: string;
    failAfterConversion?: boolean;
  }): Promise<{ status: number; intents: number }> => {
    const commandId = `t0506-cmd-${++commandCounter}-${Date.now()}`;
    try {
      const status = await txDb.transaction(async (trx) => {
        const tx = trx as never as DirectoryTx;
        await tx.execute(
          dsql`SELECT set_config('auth.current_command',
            public.auth_directory_begin_command(
              ${commandId}, 'identity', 'identity.notify', null, ${FIXTURE_TARGET}, ${FIXTURE_TARGET},
              'platform', ${`t0506-idem-${commandId}`}, ${`t0506-hash-${commandId}`}),
            true)`,
        );
        const fence = createMailCallbackFence(tx, commandId);
        const { runWithAuthMailCommand } = await import("../../src/auth/mail");
        let callbackStatus: number;
        try {
          const inCommand = await runWithAuthMailCommand(
            { tx, fence, outbox },
            async () => {
              const run = await ssoCallback({
                providerId: input.providerId,
                subject: input.subject,
                email: input.email,
              });
              return run.status;
            },
          );
          callbackStatus = inCommand;
          await assertMailCallbackCompletion(tx, fence);
          await tx.execute(
            dsql`SELECT public.auth_directory_finalize_command(${commandId})`,
          );
          await tx.execute(
            dsql`SELECT set_config('auth.current_command', '', true)`,
          );
          await tx.execute(dsql`SET CONSTRAINTS ALL IMMEDIATE`);
          if (input.failAfterConversion) {
            throw new Error(
              "t0506 injected post-conversion failure: the command must roll its mail intent back with it",
            );
          }
        } catch (error) {
          settleMailCallbackFence(fence, "rolled-back");
          throw error;
        }
        settleMailCallbackFence(fence, "committed");
        return callbackStatus;
      });
      const rows =
        await sql`SELECT count(*)::int AS n FROM auth_command_outbox WHERE command_id = ${commandId}`;
      return { status, intents: Number(rows[0].n) };
    } catch {
      return { status: 500, intents: 0 };
    }
  };

  const outbox = createAuthMailOutbox({ payloadSecret: PAYLOAD_SECRET });
  const authMail = createAuthMail({
    smtp: {
      host: SINK_SMTP_HOST,
      port: SINK_SMTP_PORT,
      secure: false,
      from: "t0506-auth@example.test",
    },
    outbox,
  });
  const drain = async (): Promise<{ delivered: number }> =>
    outbox.drainAuthMailOutbox({
      query: (text, params) => sql.unsafe(text, params),
      send: authMail.outboxSender,
    });

  const principalIdOf = async (userId: string): Promise<string> => {
    const rows =
      await sql`SELECT id FROM enterprise_principals WHERE user_id = ${userId} LIMIT 1`;
    return String(rows[0].id);
  };
  const teamIdOf = async (tenantId: string, workspaceId: string) => {
    const rows =
      await sql`SELECT team_id FROM auth_team_bindings WHERE tenant_id = ${tenantId} AND workspace_id = ${workspaceId} LIMIT 1`;
    return rows[0] ? String(rows[0].team_id) : null;
  };
  const ruleRow = async (bindingId: string) => {
    const rows =
      await sql`SELECT rule_id, revision::int AS revision, status FROM auth_provisioning_rules WHERE binding_id = ${bindingId} LIMIT 1`;
    return rows[0]
      ? {
          ruleId: String(rows[0].rule_id),
          revision: Number(rows[0].revision),
          status: String(rows[0].status),
        }
      : null;
  };
  const memberRows = async (tenantId: string) =>
    sql`SELECT user_id FROM auth_members WHERE organization_id = ${tenantId}`;
  const teamMemberRows = async (tenantId: string, teamId: string) =>
    sql`SELECT tm.user_id FROM auth_team_members tm
          JOIN auth_teams t ON t.id = tm.team_id
         WHERE t.organization_id = ${tenantId} AND tm.team_id = ${teamId}`;
  const roleOf = async (userId: string) => {
    const rows =
      await sql`SELECT role FROM user_roles WHERE user_id = ${userId} ORDER BY role LIMIT 1`;
    return rows[0] ? String(rows[0].role) : null;
  };
  const intentsCount = async (): Promise<number> => {
    const rows =
      await sql`SELECT count(*)::int AS n FROM auth_command_outbox WHERE kind = 'link-account.verify'`;
    return Number(rows[0].n);
  };

  /*
   * The production factory for the sign-in faces: createAuth with the T04.04
   * mail converters (SMTP = the coordinator-provisioned Mailpit sink), the
   * email+password surface for the ordinary-login case, the SSO plugin under
   * the frozen organizationProvisioning:{disabled:true} precondition, and the
   * T05.05 directory seam so the SSO transaction capture and the JIT ingress
   * run exactly the wiring a deployment assembles.
   */
  const auth = createAuth(
    {
      auth: {
        baseUrl: BASE_URL,
        secret: BA_SECRET,
        trustedOrigins: [BASE_URL, harnessIdp!.issuer],
        initialAdminEmails: [INITIAL_ADMIN_EMAIL],
        allowedEmailDomains: [],
        emailPassword: true,
        authSmtp: {
          host: SINK_SMTP_HOST,
          port: SINK_SMTP_PORT,
          secure: false,
          from: "t0506-auth@example.test",
        },
      },
      keyEncryptionKey: PAYLOAD_SECRET,
    },
    capture.database,
    undefined,
    undefined,
    {
      directory: (tx: DirectoryTx) => (bound ? directoryOver(tx) : null),
    },
  );
  await auth.$context;

  /*
   * The company-admin surface over the REAL directory-backed port: the
   * production createCompanyAdminRoutes factory, the T04.07-style fixture
   * authorizer (a frozen admin context for whichever actor the test pins),
   * and only the provisioning-rules dep implemented.
   */
  let acting: { userId: string; principalId: string } | null = null;
  const actingTenant = tenantA;
  const rulePort = p12.createDirectoryProvisioningRulePort
    ? (
        p12.createDirectoryProvisioningRulePort as (
          directory: Directory,
          db: unknown,
        ) => unknown
      )(directory, db)
    : null;
  const deps = {
    authorizer: {
      resolveAdminContext: async () => {
        if (!acting) throw new Error("AUTH_REQUIRED");
        return Object.freeze({
          tenantId: actingTenant,
          principalId: acting.principalId,
          actorId: acting.userId,
          memberEpoch: 1,
        });
      },
      resolveMemberContext: async () => {
        if (!acting) throw new Error("AUTH_REQUIRED");
        return Object.freeze({
          tenantId: actingTenant,
          principalId: acting.principalId,
          actorId: acting.userId,
          role: "member" as const,
          memberEpoch: 1,
        });
      },
    },
    ...(rulePort ? { provisioningRules: rulePort } : {}),
  } as unknown as CompanyAdminRouteDeps;
  const app: Hono = createCompanyAdminRoutes(deps);
  const callOn = async (
    method: "POST" | "DELETE",
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<RouteCall> => {
    const response = await app.request(`http://127.0.0.1${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await response.json().catch(() => null);
    return { status: response.status, body: json ?? {} };
  };

  const ownerA = await signUp(`t0506-owner-a${EMAIL_DOMAIN}`);
  const ownerB = await signUp(`t0506-owner-b${EMAIL_DOMAIN}`);
  await sql`
    UPDATE auth_authority_states
       SET phase = 'M4', directory_authority = 'ba', authority_version = 1
     WHERE id = 1`;
  await sql`INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
            VALUES (${PLATFORM_ADMIN_ID}, 'T05.06 Platform Admin', ${`t0506-platform${EMAIL_DOMAIN}`}, true, now(), now())
            ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO user_roles (user_id, role)
            VALUES (${PLATFORM_ADMIN_ID}, 'admin') ON CONFLICT DO NOTHING`;
  for (const [key, owner, binding] of [
    ["t0506-key-a", ownerA, BINDING_A],
    ["t0506-key-b", ownerB, BINDING_B],
  ] as const) {
    await provisioner.provision({
      actorUserId: PLATFORM_ADMIN_ID,
      idempotencyKey: key,
      name: `T05.06 公司 ${key}`,
      slug: key,
      ownerUserId: owner.userId,
      defaultTeamName: "默认团队",
    });
    const tenantId = preAllocateProvisionTenantId(key);
    /*
     * The server-issued provider↔company binding (design §9): the fixed row
     * the approve command resolves — never a client field. The fixture
     * writes it the way the platform's own controlled register path would.
     */
    await sql`INSERT INTO sso_providers (id, provider_id, issuer, oidc_config, domain, organization_id)
              VALUES (${`t0506-provider-row-${binding}`}, ${binding}, ${harnessIdp!.issuer},
                      ${JSON.stringify({
                        clientId: harnessIdp!.clientId,
                        clientSecret: harnessIdp!.clientSecret,
                        pkce: true,
                      })},
                      ${binding}, ${tenantId})`;
  }
  const workspaceA = preAllocateProvisionWorkspaceId(tenantA);
  const workspaceB = preAllocateProvisionWorkspaceId(tenantB);

  return {
    sql,
    directory,
    auth,
    tenantA,
    tenantB,
    workspaceA,
    workspaceB,
    ownerA,
    ownerB,
    routes: {
      setActor: (ref) => {
        acting = ref;
      },
      call: (method, path, body, headers) => {
        if (!acting) throw new Error("t0506: set an actor before calling");
        return callOn(method, path, body, headers);
      },
    },
    principalIdOf,
    teamIdOf,
    ruleRow,
    memberRows,
    teamMemberRows,
    signUp,
    signUpProduction,
    signIn,
    roleOf,
    ssoCallback,
    ssoCallbackInCommand,
    drain,
    intentsCount,
  };
}

/** The jit event actor of one binding, carrying the rule evidence it derived from. */
function jitActorOf(
  userId: string,
  bindingId: string,
  rule: { ruleId: string; revision: number },
  subject: string,
): DirectoryActor {
  return {
    userId,
    principalId: null,
    sessionId: null,
    kind: "jit",
    bindingId,
    provisioning: {
      eventId: `jit:${bindingId}:${subject}`,
      ruleId: rule.ruleId,
      ruleRevision: rule.revision,
      sourceSubject: subject,
    },
  };
}

describe("T05.06 JIT and approved provisioning rules", () => {
  let harness: Harness;
  let ownsAuditTable = false;
  let idpClosed = false;

  beforeAll(async () => {
    readBaUrls();
    const probe = await fetch(`${SINK_REST_BASE}/api/v1/messages`);
    if (probe.status !== 200) {
      throw new Error(
        `the local mail sink at ${SINK_REST_BASE} answered ${probe.status}; the T05.06 acceptance runs against the coordinator-provisioned Mailpit container (SMTP 127.0.0.1:1025) — a missing sink is blocked, not a fallback`,
      );
    }
    harnessIdp = await createOidcTestIdp();

    const setupUrl = process.env[DATABASE_VARIABLE]!.trim();
    const setup = postgres(setupUrl, { max: 2, onnotice: () => {} });
    ownsAuditTable =
      await setup`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = ${AUDIT_TABLE}`.then(
        (r) => r[0].n === 0,
      );
    await cleanupFixture(setup, { ownsAuditTable: ownsAuditTable });
    for (const tag of MIGRATION_TAGS) {
      await setup.unsafe(loadMigrationSql(tag));
    }
    if (ownsAuditTable) {
      for (const statement of AUDIT_TABLE_STATEMENTS) {
        await setup.unsafe(statement);
      }
    }
    await setup`INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
      VALUES (${FIXTURE_TARGET}, 'T05.06 Fixture Target', ${`t0506-fixture${EMAIL_DOMAIN}`}, true, now(), now())
      ON CONFLICT (id) DO NOTHING`;
    await setup.end({ timeout: 5 });

    harness = await buildHarness(setupUrl);
  }, 240_000);

  afterAll(async () => {
    if (harnessIdp && !idpClosed) {
      await harnessIdp.close().catch(() => {});
      idpClosed = true;
    }
    if (!harness?.sql) return;
    await cleanupFixture(harness.sql, { ownsAuditTable: ownsAuditTable });
    await harness.sql.end({ timeout: 5 }).catch(() => {});
  });

  test("approved_rule_adds_team_and_revoked_rule_rejects", 60_000, async () => {
    const extension = await loadTeamExtension();
    if (typeof extension.createProvisioningRuleHandlers !== "function") {
      throw new Error(
        "server/src/auth/directory/team-extension.ts does not export createProvisioningRuleHandlers: the provisioning.rule.approve/revoke commands are the T05.06 target behavior, not an environment problem",
      );
    }
    const ownerPrincipal = await harness.principalIdOf(harness.ownerA.userId);
    harness.routes.setActor({
      userId: harness.ownerA.userId,
      principalId: ownerPrincipal,
    });

    // The owner approves the rule for the company's own fixed binding and the
    // company's own workspace — the company-role authorization lives in the
    // directory command the port runs.
    const approved = await harness.routes.call(
      "POST",
      "/admin/provisioning-rules",
      { bindingId: BINDING_A, workspaceIds: [harness.workspaceA] },
      { [IDEMPOTENCY_HEADER]: "t0506-approve-1" },
    );
    expect(approved.status).toBe(201);

    const rule = await harness.ruleRow(BINDING_A);
    expect(rule).not.toBeNull();
    expect(rule!.revision).toBe(1);
    expect(rule!.status).toBe("approved");

    const teamA = await harness.teamIdOf(harness.tenantA, harness.workspaceA);
    expect(teamA).not.toBeNull();

    // The jit event provisions a member into the rule's fixed team: the
    // capability path and the membership land in one atomic command.
    const target = await harness.signUp(`t0506-target${EMAIL_DOMAIN}`);
    const provisioned = await harness.directory.execute(
      jitActorOf(target.userId, BINDING_A, rule!, "t0506-sub-target"),
      {
        operation: "member.provision",
        tenantId: harness.tenantA,
        idempotencyKey: `jit:${BINDING_A}:provision:${target.userId}`,
        payload: { userId: target.userId },
      },
    );
    expect(provisioned.resourceId).not.toBeNull();
    expect(
      (await harness.memberRows(harness.tenantA)).map((row) => row.user_id),
    ).toContain(target.userId);
    expect(
      (await harness.teamMemberRows(harness.tenantA, teamA!)).map(
        (row) => row.user_id,
      ),
    ).toContain(target.userId);

    // The single-use team capability under the approved rule: remove, then
    // add back, each its own command with its own capability.
    await harness.directory.execute(
      jitActorOf(target.userId, BINDING_A, rule!, "t0506-sub-target"),
      {
        operation: "team.member.remove",
        tenantId: harness.tenantA,
        idempotencyKey: `t0506-jit-remove-${target.userId}`,
        payload: { workspaceId: harness.workspaceA, userId: target.userId },
      },
    );
    expect(
      (await harness.teamMemberRows(harness.tenantA, teamA!)).map(
        (row) => row.user_id,
      ),
    ).not.toContain(target.userId);
    await harness.directory.execute(
      jitActorOf(target.userId, BINDING_A, rule!, "t0506-sub-target"),
      {
        operation: "team.member.add",
        tenantId: harness.tenantA,
        idempotencyKey: `t0506-jit-add-${target.userId}`,
        payload: { workspaceId: harness.workspaceA, userId: target.userId },
      },
    );
    expect(
      (await harness.teamMemberRows(harness.tenantA, teamA!)).map(
        (row) => row.user_id,
      ),
    ).toContain(target.userId);

    // The revoke: the same owner, through the company-admin surface.
    const revoked = await harness.routes.call(
      "DELETE",
      `/admin/provisioning-rules/${rule!.ruleId}`,
      { reason: "t0506: the directory is being re-approved" },
    );
    expect(revoked.status).toBe(200);
    const afterRevoke = await harness.ruleRow(BINDING_A);
    expect(afterRevoke!.status).toBe("revoked");
    expect(afterRevoke!.revision).toBe(2);

    // The revoked rule's evidence is stale: a later event carrying the old
    // revision is refused, and a fresh read cannot mint authority either.
    const target2 = await harness.signUp(`t0506-target2${EMAIL_DOMAIN}`);
    let allowedAfterRevoke = false;
    try {
      await harness.directory.execute(
        jitActorOf(target2.userId, BINDING_A, rule!, "t0506-sub-target2"),
        {
          operation: "member.provision",
          tenantId: harness.tenantA,
          idempotencyKey: `t0506-jit-provision-after-revoke-${target2.userId}`,
          payload: { userId: target2.userId },
        },
      );
      allowedAfterRevoke = true;
    } catch {
      allowedAfterRevoke = false;
    }
    expect(allowedAfterRevoke).toBe(false);
    let capabilityAfterRevoke = false;
    try {
      await harness.directory.execute(
        jitActorOf(target.userId, BINDING_A, rule!, "t0506-sub-target"),
        {
          operation: "team.member.remove",
          tenantId: harness.tenantA,
          idempotencyKey: `t0506-jit-remove-after-revoke-${target.userId}`,
          payload: { workspaceId: harness.workspaceA, userId: target.userId },
        },
      );
      capabilityAfterRevoke = true;
    } catch {
      capabilityAfterRevoke = false;
    }
    expect(capabilityAfterRevoke).toBe(false);
  });

  test(
    "provisioning_capability_cannot_cross_company_or_request",
    60_000,
    async () => {
      const extension = await loadTeamExtension();
      if (typeof extension.createProvisioningRuleHandlers !== "function") {
        throw new Error(
          "server/src/auth/directory/team-extension.ts does not export createProvisioningRuleHandlers: the provisioning.rule.approve/revoke commands are the T05.06 target behavior, not an environment problem",
        );
      }
      const ownerAPrincipal = await harness.principalIdOf(
        harness.ownerA.userId,
      );
      harness.routes.setActor({
        userId: harness.ownerA.userId,
        principalId: ownerAPrincipal,
      });

      // A's owner names company B's binding: the binding is fixed to company B
      // by the server's own provider row, so the approve command is a 403 —
      // a rule may only hang on a binding of the approving company.
      const crossed = await harness.routes.call(
        "POST",
        "/admin/provisioning-rules",
        { bindingId: BINDING_B, workspaceIds: [harness.workspaceA] },
        { [IDEMPOTENCY_HEADER]: "t0506-cross-1" },
      );
      expect(crossed.status).toBe(403);
      expect(await harness.ruleRow(BINDING_B)).toBeNull();

      // A jit event of company A cannot run its team command against company
      // B, even with an approved rule behind it: the event's binding and
      // evidence must match the command's company exactly.
      const ruleA = await harness.ruleRow(BINDING_A);
      let crossCompanyCapability = false;
      try {
        await harness.directory.execute(
          jitActorOf(harness.ownerA.userId, BINDING_A, ruleA!, "t0506-sub-a"),
          {
            operation: "team.member.add",
            tenantId: harness.tenantB,
            idempotencyKey: "t0506-cross-capability",
            payload: {
              workspaceId: harness.workspaceB,
              userId: harness.ownerA.userId,
            },
          },
        );
        crossCompanyCapability = true;
      } catch {
        crossCompanyCapability = false;
      }
      expect(crossCompanyCapability).toBe(false);

      // The other crossing: this company's own binding with ANOTHER company's
      // workspace as the fixed target — the workspace is answered exactly like
      // a missing one (an invisible not-found, never a disclosure of B's
      // shape), and the refusal leaves the binding's own rule row exactly as
      // it was (no new revision, no re-approval).
      const bindingABefore = await harness.ruleRow(BINDING_A);
      const foreignWorkspace = await harness.routes.call(
        "POST",
        "/admin/provisioning-rules",
        { bindingId: BINDING_A, workspaceIds: [harness.workspaceB] },
        { [IDEMPOTENCY_HEADER]: "t0506-cross-2" },
      );
      expect(foreignWorkspace.status).toBe(404);
      const bindingAAfter = await harness.ruleRow(BINDING_A);
      if (bindingABefore) {
        expect(bindingAAfter).not.toBeNull();
        expect(bindingAAfter!.revision).toBe(bindingABefore.revision);
        expect(bindingAAfter!.status).toBe(bindingABefore.status);
      } else {
        expect(bindingAAfter).toBeNull();
      }
    },
  );

  test("ordinary_login_cannot_reapply_initial_admin", 60_000, async () => {
    // The bootstrap floor, applied once at account creation — through the
    // production factory's own signup, whose hooks are the wiring under test.
    const initial = await harness.signUpProduction(INITIAL_ADMIN_EMAIL);
    expect(await harness.roleOf(initial.userId)).toBe("admin");

    // An administrator demotes them; the role is the admin screen's to
    // decide from here on.
    const db = createDatabase(process.env[DATABASE_VARIABLE]!.trim(), {
      max: 1,
    });
    await setRole(db, initial.userId, "user");

    // An ordinary sign-in must not re-apply the configured floor: the
    // next login leaves the role exactly where the administrator put it.
    const signedIn = await harness.signIn(INITIAL_ADMIN_EMAIL);
    expect(signedIn.status).toBe(200);
    expect(await harness.roleOf(initial.userId)).toBe("user");
  });

  test(
    "sso_callback_with_provider_organization_id_never_creates_member",
    60_000,
    async () => {
      // The provider row carries the server's fixed company binding. No
      // approved rule exists for it, and the pinned build runs with
      // organizationProvisioning disabled — neither path may produce a member.
      await harness.sql`INSERT INTO sso_providers (id, provider_id, issuer, oidc_config, domain, organization_id)
      VALUES (${"t0506-provider-row-org"}, ${IDP_ORG}, ${harnessIdp!.issuer},
              ${JSON.stringify({
                clientId: harnessIdp!.clientId,
                clientSecret: harnessIdp!.clientSecret,
                pkce: true,
              })},
              ${"t0506-org"}, ${harness.tenantA})`;

      const before = await harness.memberRows(harness.tenantA);
      const callback = await harness.ssoCallback({
        providerId: IDP_ORG,
        subject: "t0506-sub-org",
        email: `t0506-sso-org${EMAIL_DOMAIN}`,
      });
      expect(callback.status).toBeLessThan(400);

      // The callback created no member row: the company's members are exactly
      // what they were, and the arriving identity (t0506-sso-org) holds no
      // member row anywhere — the provider-carried organizationId provisioned
      // nobody, with or without a rule for a different binding.
      const memberRowsAfter = await harness.memberRows(harness.tenantA);
      expect(memberRowsAfter).toHaveLength(before.length);
      const arrivingRows = await harness.sql`SELECT user_id FROM auth_members m
          JOIN users u ON u.id = m.user_id
         WHERE u.email = ${`t0506-sso-org${EMAIL_DOMAIN}`}`;
      expect(arrivingRows).toHaveLength(0);
    },
  );

  test(
    "mounted_sso_link_account_mail_has_no_post_commit_callback_bypass",
    60_000,
    async () => {
      await sinkClear();
      await harness.sql`INSERT INTO sso_providers (id, provider_id, issuer, oidc_config, domain)
      VALUES (${"t0506-provider-row-mail"}, ${IDP_MAIL}, ${harnessIdp!.issuer},
              ${JSON.stringify({
                clientId: harnessIdp!.clientId,
                clientSecret: harnessIdp!.clientSecret,
                pkce: true,
              })},
              ${"t0506-mail"})`;
      const { runWithAuthMailCommand: _takeover } = await import(
        "../../src/auth/mail"
      );
      expect(typeof _takeover).toBe("function");

      const beforeIntents = await harness.intentsCount();
      const run = await harness.ssoCallbackInCommand({
        providerId: IDP_MAIL,
        subject: "t0506-sub-mail",
        email: `t0506-sso-mail${EMAIL_DOMAIN}`,
      });
      expect(run.status).toBeLessThan(400);
      expect(run.intents).toBe(1);

      /*
       * The raw-callback bypass count: everything the mounted SSO callbacks
       * sent outside the committed outbox. The converters register the intent
       * instead, so before the drain the sink holds nothing and the command
       * holds exactly one link-account intent — only a committed outbox
       * delivery may send.
       */
      const beforeDrain = await sinkMessages();
      expect(beforeDrain).toHaveLength(0);
      const rawCallbackSends = beforeDrain.filter((message) =>
        message.To.some((entry) =>
          entry.Address.includes(`t0506-sso-mail${EMAIL_DOMAIN}`),
        ),
      ).length;
      expect(rawCallbackSends).toBe(0);
      expect(await harness.intentsCount()).toBe(beforeIntents + 1);

      const report = await harness.drain();
      expect(report.delivered).toBeGreaterThanOrEqual(1);
      const afterDrain = await sinkMessages();
      expect(
        afterDrain.filter((message) =>
          message.To.some((entry) =>
            entry.Address.includes(`t0506-sso-mail${EMAIL_DOMAIN}`),
          ),
        ),
      ).toHaveLength(1);

      // Rollback: a command that fails after the conversion leaves no intent
      // and no mail — the commit owns both halves, so the retry is clean.
      const intentsBeforeRollback = await harness.intentsCount();
      const rolled = await harness.ssoCallbackInCommand({
        providerId: IDP_MAIL,
        subject: "t0506-sub-rolled",
        email: `t0506-sso-rolled${EMAIL_DOMAIN}`,
        failAfterConversion: true,
      });
      expect(rolled.status).toBe(500);
      expect(await harness.intentsCount()).toBe(intentsBeforeRollback);
      expect(
        (await sinkMessages()).filter((message) =>
          message.To.some((entry) =>
            entry.Address.includes(`t0506-sso-rolled${EMAIL_DOMAIN}`),
          ),
        ),
      ).toHaveLength(0);
    },
  );
});
