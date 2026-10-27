import { AsyncLocalStorage } from "node:async_hooks";
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
import { createDirectoryAuthority } from "../../src/auth/directory/authority";
import type {
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
import { principalRegistry } from "../../src/auth/directory/principal-registry";
import { createTransactionBoundBa } from "../../src/auth/directory/transaction-adapter";
import type { PayerAccount } from "../../src/billing/payer";
import { ensureProvisionedCompanyPayerAccount } from "../../src/billing/payer-company";
import { createDatabase } from "../../src/db/client";
import {
  scimConnectionBindings,
  scimGroupMembers,
  scimGroups,
  scimIdentityTombstones,
  scimProjectionGrants,
  scimSubjects,
  scimUsers,
} from "../../src/db/schema";
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
import type { CompanyBillingInitializationPort } from "../../src/enterprise/tenancy/provision";
import { createPlatformCompanyProvisionService } from "../../src/enterprise/tenancy/provision";

/*
 * T05.05 (#561, P12) — the SCIM methods transcribed into the atomic directory
 * commands, over the real 0209–0216 stack of the isolated BA_TEST_* island.
 *
 * What this file pins, as database facts driven by REAL HTTP against the
 * fixed build's own SCIM 2.0 surface (auth.handler, bearer-authenticated per
 * connection, every write inside one transaction the plugin owns):
 *
 * - `scim_a_deactivate_preserves_b_and_personal_account` (the Brief's first
 *   named case): a person provisioned by company A's directory and a member
 *   of company B is deactivated in A's directory. Company A's membership is
 *   suspended (member.suspend through the executor: guard change key,
 *   generation +1, projection `suspended`); company B's membership is
 *   untouched (`bActive === true`); the global identity survives — the user
 *   row exists, the principal is still active, and no global deny-list row
 *   is written by the reaction (the old reconciler's global semantics).
 * - `scim_first_provision_hook_failure_rolls_back_roles_projection_members_and_clocks`
 *   (the Brief's second named case): the plugin's own post-hook fence — the
 *   connection-binding revision it increments AFTER the application hooks —
 *   fails (test fault trigger on the second mutation of a dedicated
 *   connection), and the user row, the scim rows, the member row, the team
 *   membership, the clocks, the receipt and the roles projection all roll
 *   back: `after === before`.
 * - `sso_factory_missing_or_false_disabled_flag_blocks_startup` (the Brief's
 *   third named case): the extracted factory precondition refuses a plugin
 *   list whose sso entry is missing organizationProvisioning or carries
 *   disabled:false, accepts disabled:true, and the real createAuth factory
 *   boots with the pinned configuration.
 *
 * Perimeters pinned beside the named cases: the first member.provision
 * establishes the Principal with no invitation (registry.ensure inside the
 * command transaction); the approved rule's team lands in the same atomic
 * command; GET answers only the authenticated connection's users; PUT's
 * replace-deactivation and PATCH agree; DELETE removes only the membership
 * this directory provisioned (the receipt tie), never an invited membership;
 * a directory reactivation lifts only its own suspension; and a paused
 * authority refuses the whole write (no half-provisioned user).
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

const PLATFORM_ADMIN_ID = "t0505-platform-admin";
const EMAIL_DOMAIN = "@t0505.example.test";
const DEFAULT_PASSWORD = "correct-horse-battery-staple";
const BASE_URL = "http://127.0.0.1:0";

const PROVISION_KEYS = [
  "t0505-key-a",
  "t0505-key-b",
  "t0505-key-fault",
] as const;

/** The dedicated connections: two companies plus the fault connection. */
const CONNECTION_A = "t0505-conn-a";
const CONNECTION_B = "t0505-conn-b";
const CONNECTION_FAULT = "t0505-conn-fault";
const TOKEN_A = "t0505-bearer-token-a";
const TOKEN_B = "t0505-bearer-token-b";
const TOKEN_FAULT = "t0505-bearer-token-fault";

const FAULT_FUNCTION = "t0505_fence_fault";
const FAULT_TRIGGER = "t0505_fence_fault_trigger";

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
        `${variable} is required: the scim-provisioning suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
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

/** Returns the island to the pre-suite shape (the T04.03 recipe, t0505 rows). */
async function cleanupFixture(sql: postgres.Sql): Promise<void> {
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
  await sql`DELETE FROM scim_projection_grants WHERE connection_id IN (${CONNECTION_A}, ${CONNECTION_B}, ${CONNECTION_FAULT})`;
  await sql`DELETE FROM scim_group_members WHERE connection_id IN (${CONNECTION_A}, ${CONNECTION_B}, ${CONNECTION_FAULT})`;
  await sql`DELETE FROM scim_groups WHERE connection_id IN (${CONNECTION_A}, ${CONNECTION_B}, ${CONNECTION_FAULT})`;
  await sql`DELETE FROM scim_users WHERE connection_id IN (${CONNECTION_A}, ${CONNECTION_B}, ${CONNECTION_FAULT})`;
  await sql`DELETE FROM scim_identity_tombstones WHERE connection_id IN (${CONNECTION_A}, ${CONNECTION_B}, ${CONNECTION_FAULT})`;
  await sql`DELETE FROM scim_connection_bindings WHERE connection_id IN (${CONNECTION_A}, ${CONNECTION_B}, ${CONNECTION_FAULT})`;
  await sql`DELETE FROM scim_subjects WHERE user_id IN (
    SELECT id FROM users WHERE email LIKE ${`t0505-%${EMAIL_DOMAIN}`}
       OR id = ${PLATFORM_ADMIN_ID})`;
  await sql`DELETE FROM enterprise_workspace_memberships WHERE tenant_id IN (${quoted})`;
  await sql`DELETE FROM enterprise_memberships WHERE tenant_id IN (${quoted})`;
  await sql`DELETE FROM enterprise_principals WHERE user_id IN (
    SELECT id FROM users WHERE email LIKE ${`t0505-%${EMAIL_DOMAIN}`}
       OR id = ${PLATFORM_ADMIN_ID})`;
  await sql`DELETE FROM enterprise_workspaces WHERE tenant_id IN (${quoted})`;
  await sql`DELETE FROM enterprise_tenants WHERE id IN (${quoted})`;
  await sql`DELETE FROM user_roles WHERE user_id = ${PLATFORM_ADMIN_ID}`;
  // The legacy SCIM reaction a RED pass runs writes global deny-list rows by
  // email; they are the pre-suite baseline's residue, not this suite's.
  await sql`DELETE FROM revoked_access WHERE email LIKE ${`t0505-%${EMAIL_DOMAIN}`}`;
  await sql`DELETE FROM users WHERE email LIKE ${`t0505-%${EMAIL_DOMAIN}`} OR id = ${PLATFORM_ADMIN_ID}`;
  // The migrations this suite re-applies ADD these columns; the island's
  // later state already carries them (the T04.03 recipe — same statements,
  // same order).
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

interface MembershipFact {
  status: string;
  epoch: number;
}

interface ClockFact {
  scope_id: string;
  epoch: number;
  generation: number;
  tombstone: boolean;
}

interface FaultSnapshot {
  user: { id: string; groups: string[] } | null;
  member: MembershipFact | null;
  members: number;
  clocks: number;
  receipts: number;
  users: number;
}

interface Harness {
  sql: postgres.Sql;
  owner: HarnessUser;
  tenantA: string;
  tenantB: string;
  tenantFault: string;
  /** Drives one SCIM HTTP request through the fixed build's own handler. */
  scim(input: {
    method: string;
    path: string;
    token: string;
    body?: Record<string, unknown>;
  }): Promise<{ status: number; body: Record<string, unknown> }>;
  /** Provisions a SCIM user over real HTTP and returns its resource id. */
  provision(
    token: string,
    input: { email: string; displayName: string },
  ): Promise<{ scimUserId: string; userId: string }>;
  /** Runs one admin lifecycle/invitation command through the real executor. */
  run(input: {
    actorUserId: string;
    tenantId: string;
    operation: DirectoryOperation;
    key: string;
    payload: Record<string, unknown>;
  }): Promise<{ replayed: boolean; resourceId: string | null }>;
  /** Adds a member through the real invitation path (no directory involved). */
  joinMember(input: {
    tenantId: string;
    workspaceIds: readonly string[];
    email: string;
    keySuffix: string;
  }): Promise<HarnessUser>;
  signUp(email: string): Promise<HarnessUser>;
  principalStatusOf(userId: string): Promise<string | null>;
  businessMembership(
    tenantId: string,
    userId: string,
  ): Promise<MembershipFact | null>;
  teamMemberCount(tenantId: string, userId: string): Promise<number>;
  clockRows(
    tenantId: string,
    userId: string,
    kind: "company" | "team",
  ): Promise<ClockFact[]>;
  userRow(email: string): Promise<{ id: string; groups: string[] } | null>;
  userIdOf(email: string): Promise<string | null>;
  revokedAccessCount(email: string): Promise<number>;
  faultSnapshot(email: string): Promise<FaultSnapshot>;
  setAuthority(mode: "legacy" | "paused" | "ba"): Promise<void>;
}

/**
 * The test-side transaction capture: every transaction the fixed build opens
 * on this database records its open tx, so the SCIM hooks can execute the
 * directory commands on exactly the transaction the plugin owns (the same
 * seam createAuth installs in production — `createScimTransactionCapture`).
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

async function buildHarness(sql: postgres.Sql): Promise<Harness> {
  const scimModule = await import("../../src/auth/scim");
  const { scimOptions } = scimModule;
  const { scim: scimPlugin } = await import("@better-auth/scim");
  const db = createDatabase(process.env[DATABASE_VARIABLE]!.trim(), { max: 6 });
  const tenantA = preAllocateProvisionTenantId("t0505-key-a");
  const tenantB = preAllocateProvisionTenantId("t0505-key-b");
  const tenantFault = preAllocateProvisionTenantId("t0505-key-fault");

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
    scimConnectionBinding: scimConnectionBindings,
    scimIdentityTombstone: scimIdentityTombstones,
    scimSubject: scimSubjects,
    scimUser: scimUsers,
    scimProjectionGrant: scimProjectionGrants,
    scimGroup: scimGroups,
    scimGroupMember: scimGroupMembers,
  };
  let resolvedOptions: unknown;
  const capture = createCapture(db);
  const authority = createDirectoryAuthority();
  // Assigned right after the auth instance exists; the SCIM hooks only reach
  // them at request time, so the late binding is the harness's own seam.
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

  const scimPluginOptions = scimOptions(
    {
      database: db,
      initialAdminEmails: [`t0505-owner${EMAIL_DOMAIN}`],
      connections: [
        {
          id: CONNECTION_A,
          provisioningDomainId: tenantA,
          credentials: [
            { type: "bearer", id: `${CONNECTION_A}-primary`, token: TOKEN_A },
          ],
        },
        {
          id: CONNECTION_B,
          provisioningDomainId: tenantB,
          credentials: [
            { type: "bearer", id: `${CONNECTION_B}-primary`, token: TOKEN_B },
          ],
        },
        {
          id: CONNECTION_FAULT,
          provisioningDomainId: tenantFault,
          credentials: [
            {
              type: "bearer",
              id: `${CONNECTION_FAULT}-primary`,
              token: TOKEN_FAULT,
            },
          ],
        },
      ],
      currentTransaction: capture.currentTransaction,
      directory: (tx) => (bound ? directoryOver(tx) : null),
    },
    // The baseline fallback a legacy deployment would read: one env token.
    // T05.05's scimOptions prefers the per-company connections above.
    { SCIM_BEARER_TOKEN: TOKEN_A, SCIM_CONNECTION_ID: CONNECTION_A },
  );

  const auth = betterAuth({
    secret: "{{SECRET_t0505}}",
    baseURL: BASE_URL,
    trustedOrigins: [BASE_URL],
    emailAndPassword: { enabled: true },
    plugins: [
      organization({ teams: { enabled: true } }),
      ...(scimPluginOptions ? [scimPlugin(scimPluginOptions)] : []),
    ],
    database: (options: unknown) => {
      resolvedOptions = options;
      return drizzleAdapter(capture.database as never, {
        provider: "pg",
        schema: baSchema as never,
        transaction: true,
      })(options as never);
    },
  });
  const authContext = await auth.$context;
  bound = createTransactionBoundBa({
    createTxAdapter: (tx) =>
      drizzleAdapter(tx as never, {
        provider: "pg",
        schema: baSchema as never,
        transaction: false,
      })(resolvedOptions as never),
  });
  const ba = createFixedVersionInvitationCommands(authContext, {
    teams: { enabled: true },
  });
  executorHandlers = {
    "company.provision": createCompanyProvisionHandler(),
    ...createInvitationMembershipHandlers({ ba }),
    ...createMembershipLifecycleHandlers(),
    // T05.05's handler family: member.provision plus the scim-actor admission
    // of the lifecycle trio. Absent at the RED baseline, which is exactly
    // what the RED pass pins (DIRECTORY_OPERATION_NOT_WIRED / actor refusal).
    ...(scimModule.createScimProvisioningHandlers
      ? scimModule.createScimProvisioningHandlers({ ba })
      : {}),
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
      throw new Error(`signUpEmail for ${email} failed: ${response.status}`);
    }
    const body = (await response.json()) as { user: { id: string } };
    await sql`UPDATE users SET email_verified = true WHERE email = ${email.toLowerCase()}`;
    return { userId: body.user.id, email: email.toLowerCase() };
  };

  const scim: Harness["scim"] = async (input) => {
    const response = await auth.handler(
      new Request(`${BASE_URL}/api/auth${input.path}`, {
        method: input.method,
        headers: {
          authorization: `Bearer ${input.token}`,
          "content-type": "application/scim+json",
        },
        ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      }),
    );
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    return { status: response.status, body };
  };

  const userIdOf = async (email: string): Promise<string | null> => {
    const rows =
      await sql`SELECT id FROM users WHERE email = ${email.toLowerCase()} LIMIT 1`;
    return rows[0] ? String(rows[0].id) : null;
  };

  const provision: Harness["provision"] = async (token, input) => {
    const answer = await scim({
      method: "POST",
      path: "/scim/v2/Users",
      token,
      body: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: input.email.split("@")[0],
        externalId: `t0505-${input.email.split("@")[0]}`,
        name: {
          formatted: input.displayName,
          givenName: input.displayName,
          familyName: "T0505",
        },
        emails: [{ value: input.email, primary: true }],
        active: true,
      },
    });
    if (answer.status !== 201) {
      throw new Error(
        `SCIM provision of ${input.email} failed: ${answer.status} ${JSON.stringify(answer.body).slice(0, 300)}`,
      );
    }
    const scimUserId = String(answer.body.id);
    const userId = await userIdOf(input.email);
    if (!userId) {
      throw new Error(
        `SCIM provision of ${input.email} returned no user row; the transcription cannot be asserted`,
      );
    }
    return { scimUserId, userId };
  };

  const owner = await signUp(`t0505-owner${EMAIL_DOMAIN}`);
  // BA authority before any directory command runs (the executor's own gate).
  await sql`
    UPDATE auth_authority_states
       SET phase = 'M4', directory_authority = 'ba', authority_version = 1
     WHERE id = 1`;
  // The platform actor company provisioning runs under needs a real row and
  // the current global admin role (the handler re-verifies both in-lock).
  await sql`INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
            VALUES (${PLATFORM_ADMIN_ID}, 'T0505 Platform Admin', ${`t0505-platform${EMAIL_DOMAIN}`}, true, now(), now())
            ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO user_roles (user_id, role)
            VALUES (${PLATFORM_ADMIN_ID}, 'admin') ON CONFLICT DO NOTHING`;
  const connectionOf = new Map(
    PROVISION_KEYS.map((key) => [
      key,
      key === "t0505-key-a"
        ? CONNECTION_A
        : key === "t0505-key-b"
          ? CONNECTION_B
          : CONNECTION_FAULT,
    ]),
  );
  for (const key of PROVISION_KEYS) {
    const tenantId = preAllocateProvisionTenantId(key);
    await provisioner.provision({
      actorUserId: PLATFORM_ADMIN_ID,
      idempotencyKey: key,
      name: `T05.05 公司 ${key}`,
      slug: key,
      ownerUserId: owner.userId,
      defaultTeamName: "默认团队",
    });
    const workspaceId = preAllocateProvisionWorkspaceId(tenantId);
    await sql`INSERT INTO auth_provisioning_rules
                (rule_id, tenant_id, binding_id, external_group, workspace_ids, minimum_role, revision, status)
              VALUES (${`t0505-rule-${key}`}, ${tenantId}, ${connectionOf.get(key)!}, NULL,
                      ARRAY[${workspaceId}]::text[], 'member', 1, 'approved')`;
  }

  const businessMembershipOf = async (
    tenantId: string,
    userId: string,
  ): Promise<MembershipFact | null> => {
    const rows =
      await sql`SELECT m.status, m.epoch::int AS epoch FROM enterprise_memberships m
                  JOIN enterprise_principals p ON p.id = m.principal_id
                 WHERE m.tenant_id = ${tenantId} AND p.user_id = ${userId} LIMIT 1`;
    return rows[0]
      ? { status: String(rows[0].status), epoch: Number(rows[0].epoch) }
      : null;
  };

  const platformActor = (userId: string): DirectoryActor => ({
    userId,
    principalId: null,
    sessionId: null,
    kind: "platform",
    bindingId: null,
    provisioning: null,
  });

  return {
    sql,
    owner,
    tenantA,
    tenantB,
    tenantFault,
    scim,
    provision,
    run: (input) =>
      directory.execute(platformActor(input.actorUserId), {
        operation: input.operation,
        tenantId: input.tenantId,
        idempotencyKey: input.key,
        payload: input.payload,
      }),
    signUp,
    joinMember: async (input) => {
      // The directory may already have created the account (the SCIM POST
      // establishes the BA user); the invitation path then adopts it instead
      // of colliding with signUpEmail.
      const existingId = await userIdOf(input.email);
      const user = existingId
        ? await (async () => {
            await sql`UPDATE users SET email_verified = true WHERE id = ${existingId}`;
            return { userId: existingId, email: input.email.toLowerCase() };
          })()
        : await signUp(input.email);
      const ownerSession: DirectoryActor = {
        userId: owner.userId,
        principalId: null,
        sessionId: `t0505-session-${owner.userId}`,
        kind: "session",
        bindingId: null,
        provisioning: null,
      };
      const invite = await directory.execute(ownerSession, {
        operation: "invitation.create",
        tenantId: input.tenantId,
        idempotencyKey: `t0505-invite-${input.keySuffix}`,
        payload: {
          email: user.email,
          role: "member",
          workspaceIds: [...input.workspaceIds],
        },
      });
      const invitationId = invite.resourceId;
      if (typeof invitationId !== "string") {
        throw new Error("invitation.create returned no invitation id");
      }
      const sessionActor: DirectoryActor = {
        userId: user.userId,
        principalId: null,
        sessionId: `t0505-session-${user.userId}`,
        kind: "session",
        bindingId: null,
        provisioning: null,
      };
      await directory.execute(sessionActor, {
        operation: "invitation.accept",
        tenantId: input.tenantId,
        idempotencyKey: `t0505-accept-${input.keySuffix}`,
        payload: { invitationId },
      });
      const principalRows =
        await sql`SELECT id FROM enterprise_principals WHERE user_id = ${user.userId} LIMIT 1`;
      const joinerPrincipalId = principalRows[0]?.id;
      if (typeof joinerPrincipalId !== "string") {
        throw new Error("invitation.accept left no principal");
      }
      for (const workspaceId of input.workspaceIds) {
        await sql`INSERT INTO enterprise_workspace_memberships
                    (tenant_id, workspace_id, principal_id, status, epoch)
                  VALUES (${input.tenantId}, ${workspaceId}, ${joinerPrincipalId}, 'active', 1)
                  ON CONFLICT DO NOTHING`;
      }
      return user;
    },
    principalStatusOf: async (userId) => {
      const rows =
        await sql`SELECT status FROM enterprise_principals WHERE user_id = ${userId} LIMIT 1`;
      return rows[0] ? String(rows[0].status) : null;
    },
    businessMembership: businessMembershipOf,
    teamMemberCount: async (tenantId, userId) => {
      const rows = await sql`SELECT count(*)::int AS n FROM auth_team_members tm
                    JOIN auth_teams t ON t.id = tm.team_id
                   WHERE t.organization_id = ${tenantId} AND tm.user_id = ${userId}`;
      return Number(rows[0]?.n ?? 0);
    },
    clockRows: async (tenantId, userId, kind) =>
      (
        await sql`SELECT c.scope_id, c.epoch::int AS epoch, c.generation::int AS generation, c.tombstone
              FROM auth_eligibility_clocks c
              JOIN enterprise_principals p ON p.id = c.principal_id
             WHERE c.tenant_id = ${tenantId} AND p.user_id = ${userId} AND c.kind = ${kind}
             ORDER BY c.scope_id`
      ).map((row) => ({
        scope_id: String(row.scope_id),
        epoch: Number(row.epoch),
        generation: Number(row.generation),
        tombstone: Boolean(row.tombstone),
      })),
    userRow: async (email) => {
      const rows =
        await sql`SELECT id, groups FROM users WHERE email = ${email.toLowerCase()} LIMIT 1`;
      return rows[0]
        ? { id: String(rows[0].id), groups: (rows[0].groups ?? []) as string[] }
        : null;
    },
    userIdOf,
    revokedAccessCount: async (email) => {
      const rows =
        await sql`SELECT count(*)::int AS n FROM revoked_access WHERE email = ${email.toLowerCase()}`;
      return Number(rows[0]?.n ?? 0);
    },
    faultSnapshot: async (email) => {
      const countOf = async (statement: postgres.PendingQuery<unknown[]>) =>
        Number((await statement)[0]?.n ?? 0);
      const faultUserId = await userIdOf(email);
      const member = faultUserId
        ? await businessMembershipOf(tenantFault, faultUserId)
        : null;
      const rows =
        await sql`SELECT id, groups FROM users WHERE email = ${email.toLowerCase()} LIMIT 1`;
      const user = rows[0]
        ? {
            id: String(rows[0].id),
            groups: (rows[0].groups ?? []) as string[],
          }
        : null;
      return {
        user,
        member,
        members: await countOf(
          sql`SELECT count(*)::int AS n FROM auth_members WHERE organization_id = ${tenantFault}`,
        ),
        clocks: await countOf(
          sql`SELECT count(*)::int AS n FROM auth_eligibility_clocks WHERE tenant_id = ${tenantFault}`,
        ),
        receipts: await countOf(
          sql`SELECT count(*)::int AS n FROM auth_command_receipts WHERE tenant_id = ${tenantFault}`,
        ),
        users: await countOf(
          sql`SELECT count(*)::int AS n FROM users WHERE email LIKE ${`t0505-fault-%${EMAIL_DOMAIN}`}`,
        ),
      };
    },
    setAuthority: async (mode) => {
      await sql`
        UPDATE auth_authority_states
           SET phase = ${mode === "ba" ? "M4" : mode === "paused" ? "M2" : "M1"},
               directory_authority = ${mode},
               authority_version = authority_version + 1
         WHERE id = 1`;
    },
  };
}

let harness: Harness;

beforeAll(async () => {
  readBaUrls();
  const sql = postgres(process.env[DATABASE_VARIABLE]!.trim(), { max: 2 });
  await cleanupFixture(sql);
  for (const tag of MIGRATION_TAGS) {
    for (const statement of loadMigrationSql(tag).split(
      "--> statement-breakpoint",
    )) {
      const text = statement.trim();
      if (text) await sql.unsafe(text);
    }
  }
  // The island's later suites leave their own audit table behind; this suite
  // owns its shape for the run (drop-and-recreate, the T04.03 recipe).
  await sql.unsafe(
    `DROP POLICY IF EXISTS "enterprise_audit_event_operator_insert" ON "enterprise_audit_events"`,
  );
  await sql.unsafe(
    `DROP POLICY IF EXISTS "enterprise_audit_event_operator_read" ON "enterprise_audit_events"`,
  );
  await sql.unsafe(`DROP TABLE IF EXISTS "enterprise_audit_events"`);
  for (const statement of AUDIT_TABLE_STATEMENTS) await sql.unsafe(statement);
  await sql.unsafe(`CREATE OR REPLACE FUNCTION ${FAULT_FUNCTION}() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.connection_id = '${CONNECTION_FAULT}' AND NEW.decommission_revision >= 2 THEN
        RAISE EXCEPTION 'T0505_FENCE_FAULT';
      END IF;
      RETURN NEW;
    END $$`);
  await sql.unsafe(
    `DROP TRIGGER IF EXISTS ${FAULT_TRIGGER} ON scim_connection_bindings`,
  );
  await sql.unsafe(`CREATE TRIGGER ${FAULT_TRIGGER}
    BEFORE UPDATE ON scim_connection_bindings
    FOR EACH ROW EXECUTE FUNCTION ${FAULT_FUNCTION}()`);
  harness = await buildHarness(sql);
  await harness.setAuthority("ba");
});

afterAll(async () => {
  if (harness) {
    await harness.sql.unsafe(
      `DROP TRIGGER IF EXISTS ${FAULT_TRIGGER} ON scim_connection_bindings`,
    );
    await harness.sql.unsafe(`DROP FUNCTION IF EXISTS ${FAULT_FUNCTION}()`);
    await cleanupFixture(harness.sql);
    await harness.sql.end();
  }
});

describe("T05.05 scim provisioning", () => {
  test("scim_first_provision_creates_principal_member_and_team_without_invitation", async () => {
    const { userId } = await harness.provision(TOKEN_A, {
      email: `t0505-first${EMAIL_DOMAIN}`,
      displayName: "First Provision",
    });
    const membership = await harness.businessMembership(
      harness.tenantA,
      userId,
    );
    expect(membership?.status).toBe("active");
    expect(membership?.epoch).toBe(1);
    expect(await harness.principalStatusOf(userId)).toBe("active");
    // The approved rule's team lands in the same atomic command.
    expect(
      await harness.teamMemberCount(harness.tenantA, userId),
    ).toBeGreaterThanOrEqual(1);
    const clocks = await harness.clockRows(harness.tenantA, userId, "company");
    expect(clocks).toHaveLength(1);
    expect(clocks[0]?.tombstone).toBe(false);
    const teamClocks = await harness.clockRows(harness.tenantA, userId, "team");
    expect(teamClocks.length).toBeGreaterThanOrEqual(1);
    const receipts =
      await harness.sql`SELECT count(*)::int AS n FROM auth_command_receipts
                         WHERE tenant_id = ${harness.tenantA} AND operation = 'member.provision'`;
    expect(Number(receipts[0]?.n ?? 0)).toBe(1);
  });

  test("scim_a_deactivate_preserves_b_and_personal_account", async () => {
    const { scimUserId, userId } = await harness.provision(TOKEN_A, {
      email: `t0505-shared${EMAIL_DOMAIN}`,
      displayName: "Shared Person",
    });
    // The second company arrives through the real invitation path — the
    // directory never touches it.
    await harness.joinMember({
      tenantId: harness.tenantB,
      workspaceIds: [],
      email: `t0505-shared${EMAIL_DOMAIN}`,
      keySuffix: "shared-b",
    });
    const before = await harness.businessMembership(harness.tenantB, userId);
    expect(before?.status).toBe("active");

    const answer = await harness.scim({
      method: "PATCH",
      path: `/scim/v2/Users/${scimUserId}`,
      token: TOKEN_A,
      body: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "active", value: false }],
      },
    });
    expect(answer.status).toBe(200);

    expect(
      await harness.businessMembership(harness.tenantA, userId),
    ).toMatchObject({ status: "suspended" });
    // The named assertion: company B's membership survives untouched.
    const b = await harness.businessMembership(harness.tenantB, userId);
    const bActive = b?.status === "active";
    expect(bActive).toBe(true);
    expect(b?.epoch).toBe(before?.epoch);
    // The personal account survives: the user row is still there, the global
    // identity is still active, and no global deny-list row was written.
    expect(await harness.userIdOf(`t0505-shared${EMAIL_DOMAIN}`)).toBe(userId);
    expect(
      await harness.revokedAccessCount(`t0505-shared${EMAIL_DOMAIN}`),
    ).toBe(0);
    expect(await harness.principalStatusOf(userId)).toBe("active");
  });

  test("scim_first_provision_hook_failure_rolls_back_roles_projection_members_and_clocks", async () => {
    // First mutation on the fault connection establishes the baseline (and
    // proves the transcription writes before the fault is armed at revision 2).
    const first = await harness.provision(TOKEN_FAULT, {
      email: `t0505-fault-first${EMAIL_DOMAIN}`,
      displayName: "Fault First",
    });
    expect(
      await harness.businessMembership(harness.tenantFault, first.userId),
    ).toMatchObject({ status: "active" });

    const secondEmail = `t0505-fault-second${EMAIL_DOMAIN}`;
    const before = await harness.faultSnapshot(secondEmail);
    expect(before.user).toBeNull();

    // The second mutation of the fault connection fails at the plugin's own
    // post-hook fence (decommission revision 2): the user, the member, the
    // clocks, the receipt and the projection must all roll back together.
    const answer = await harness.scim({
      method: "POST",
      path: "/scim/v2/Users",
      token: TOKEN_FAULT,
      body: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "t0505-fault-second",
        externalId: "t0505-fault-second",
        name: { formatted: "Fault Second", givenName: "Fault" },
        emails: [{ value: secondEmail, primary: true }],
        active: true,
      },
    });
    expect(answer.status).toBeGreaterThanOrEqual(500);

    const after = await harness.faultSnapshot(secondEmail);
    expect(after).toEqual(before);
  });

  test("sso_factory_missing_or_false_disabled_flag_blocks_startup", async () => {
    const authIndex = (await import("../../src/auth/index")) as {
      assertSsoOrganizationProvisioningDisabled?: (
        plugins: readonly unknown[],
      ) => void;
    };
    const assert = authIndex.assertSsoOrganizationProvisioningDisabled;
    if (typeof assert !== "function") {
      throw new Error(
        "T0505 target behavior missing: the factory's SSO precondition is not exported as assertSsoOrganizationProvisioningDisabled, so the missing/false variants cannot be pinned at startup",
      );
    }
    // missing organizationProvisioning → refuse
    let started = true;
    try {
      assert([{ id: "sso", options: {} }]);
    } catch {
      started = false;
    }
    expect(started).toBe(false);
    // disabled:false → refuse
    started = true;
    try {
      assert([
        {
          id: "sso",
          options: { organizationProvisioning: { disabled: false } },
        },
      ]);
    } catch {
      started = false;
    }
    expect(started).toBe(false);
    // disabled:true → boots
    started = true;
    try {
      assert([
        {
          id: "sso",
          options: { organizationProvisioning: { disabled: true } },
        },
      ]);
    } catch {
      started = false;
    }
    expect(started).toBe(true);
  });

  test("sso_factory_boots_with_the_pinned_configuration", async () => {
    const { createAuth } = (await import("../../src/auth/index")) as {
      createAuth: (config: unknown, database: unknown) => unknown;
    };
    const db = createDatabase(process.env[DATABASE_VARIABLE]!.trim(), {
      max: 2,
    });
    let started = true;
    try {
      const instance = createAuth(
        {
          auth: {
            baseUrl: BASE_URL,
            secret: "{{SECRET_t0505}}",
            trustedOrigins: [BASE_URL],
            initialAdminEmails: [`t0505-owner${EMAIL_DOMAIN}`],
          },
          keyEncryptionKey: "t0505-key-encryption-key",
        },
        db,
      );
      expect(instance).toBeTruthy();
    } catch {
      started = false;
    }
    expect(started).toBe(true);
    await db.$client?.end?.().catch(() => undefined);
  });

  test("scim_get_answers_only_the_authenticated_connection", async () => {
    await harness.provision(TOKEN_A, {
      email: `t0505-isolation-a${EMAIL_DOMAIN}`,
      displayName: "Isolation A",
    });
    await harness.provision(TOKEN_B, {
      email: `t0505-isolation-b${EMAIL_DOMAIN}`,
      displayName: "Isolation B",
    });
    const a = await harness.scim({
      method: "GET",
      path: "/scim/v2/Users?count=200",
      token: TOKEN_A,
    });
    expect(a.status).toBe(200);
    const aNames = ((a.body.Resources as Record<string, unknown>[]) ?? []).map(
      (row) => String(row.userName),
    );
    expect(aNames).toContain("t0505-isolation-a");
    expect(aNames).not.toContain("t0505-isolation-b");
    const b = await harness.scim({
      method: "GET",
      path: "/scim/v2/Users?count=200",
      token: TOKEN_B,
    });
    const bNames = ((b.body.Resources as Record<string, unknown>[]) ?? []).map(
      (row) => String(row.userName),
    );
    expect(bNames).toContain("t0505-isolation-b");
    expect(bNames).not.toContain("t0505-isolation-a");
  });

  test("scim_put_replace_deactivation_and_reactivation_match_patch", async () => {
    const { scimUserId, userId } = await harness.provision(TOKEN_A, {
      email: `t0505-put${EMAIL_DOMAIN}`,
      displayName: "Put Replace",
    });
    const replace = await harness.scim({
      method: "PUT",
      path: `/scim/v2/Users/${scimUserId}`,
      token: TOKEN_A,
      body: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "t0505-put",
        name: { formatted: "Put Replace", givenName: "Put" },
        emails: [{ value: `t0505-put${EMAIL_DOMAIN}`, primary: true }],
        active: false,
      },
    });
    expect(replace.status).toBe(200);
    expect(
      await harness.businessMembership(harness.tenantA, userId),
    ).toMatchObject({ status: "suspended" });

    const reactivate = await harness.scim({
      method: "PATCH",
      path: `/scim/v2/Users/${scimUserId}`,
      token: TOKEN_A,
      body: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "active", value: true }],
      },
    });
    expect(reactivate.status).toBe(200);
    const restored = await harness.businessMembership(harness.tenantA, userId);
    expect(restored?.status).toBe("active");
    // provision e1 → suspend keeps e1/g2 → restore advances e2, keeps g2:
    // the restored admission never resurrects the suspended generation.
    expect(restored?.epoch).toBe(2);
    const clocks = await harness.clockRows(harness.tenantA, userId, "company");
    expect(clocks[0]?.epoch).toBe(2);
    expect(clocks[0]?.generation).toBe(2);
    expect(clocks[0]?.tombstone).toBe(false);
  });

  test("scim_delete_removes_only_the_directory_provisioned_membership", async () => {
    const { scimUserId, userId } = await harness.provision(TOKEN_A, {
      email: `t0505-delete${EMAIL_DOMAIN}`,
      displayName: "Delete Target",
    });
    await harness.joinMember({
      tenantId: harness.tenantB,
      workspaceIds: [],
      email: `t0505-delete${EMAIL_DOMAIN}`,
      keySuffix: "delete-b",
    });
    const answer = await harness.scim({
      method: "DELETE",
      path: `/scim/v2/Users/${scimUserId}`,
      token: TOKEN_A,
    });
    expect(answer.status).toBe(204);
    // The removal's finalizer contract: the BA member row is gone, the
    // company clock tombstones, and the projection reads the legacy
    // suspension vocabulary of a removal.
    const memberRows = await harness.sql`SELECT id FROM auth_members
                         WHERE organization_id = ${harness.tenantA} AND user_id = ${userId}`;
    expect(memberRows).toHaveLength(0);
    const clocks = await harness.clockRows(harness.tenantA, userId, "company");
    expect(clocks[0]?.tombstone).toBe(true);
    expect(clocks[0]?.generation).toBe(2);
    // The invited membership in company B survives the directory deletion.
    expect(
      await harness.businessMembership(harness.tenantB, userId),
    ).toMatchObject({ status: "active" });
  });

  test("admin_suspension_blocks_directory_reactivation", async () => {
    const { scimUserId, userId } = await harness.provision(TOKEN_A, {
      email: `t0505-adminbar${EMAIL_DOMAIN}`,
      displayName: "Admin Barred",
    });
    // The directory suspends first; an administrator then moves the same
    // member's state on; the directory may lift only its own suspension.
    await harness.scim({
      method: "PATCH",
      path: `/scim/v2/Users/${scimUserId}`,
      token: TOKEN_A,
      body: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "active", value: false }],
      },
    });
    await harness.run({
      actorUserId: harness.owner.userId,
      tenantId: harness.tenantA,
      operation: "member.suspend",
      key: "t0505-admin-suspend",
      payload: { userId, reason: "t0505 管理员再停用" },
    });
    const answer = await harness.scim({
      method: "PATCH",
      path: `/scim/v2/Users/${scimUserId}`,
      token: TOKEN_A,
      body: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "active", value: true }],
      },
    });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(
      await harness.businessMembership(harness.tenantA, userId),
    ).toMatchObject({ status: "suspended" });
  });

  test("paused_authority_refuses_the_whole_scim_write", async () => {
    await harness.setAuthority("paused");
    try {
      const answer = await harness.scim({
        method: "POST",
        path: "/scim/v2/Users",
        token: TOKEN_A,
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "t0505-paused",
          externalId: "t0505-paused",
          name: { formatted: "Paused Write", givenName: "Paused" },
          emails: [{ value: `t0505-paused${EMAIL_DOMAIN}`, primary: true }],
          active: true,
        },
      });
      expect(answer.status).toBeGreaterThanOrEqual(500);
      // The rollback takes the user row with it: no half-provisioned person.
      expect(await harness.userIdOf(`t0505-paused${EMAIL_DOMAIN}`)).toBeNull();
    } finally {
      await harness.setAuthority("ba");
    }
  });
});
