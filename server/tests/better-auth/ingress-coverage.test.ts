import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { sql as dsql } from "drizzle-orm";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { createApp } from "../../src/app";
import {
  COMPANY_REAUTH_REQUIRED,
  type CompanyProofPolicyView,
} from "../../src/auth/company-assurance";
import { createDirectoryAuthority } from "../../src/auth/directory/authority";
import type { DirectoryTx } from "../../src/auth/directory/contracts";
import {
  CLOSED_SCIM_READ_UNBOUND,
  CLOSED_SCIM_WRITE_NOT_TRANSCRIBED,
  CLOSED_SSO_WRITE_NOT_TRANSCRIBED,
  classifyNativeAuthPath,
  DIRECTORY_INGRESS_EXECUTOR_UNWIRED,
  IDENTITY_INGRESS_EXECUTOR_UNWIRED,
  NATIVE_AUTH_ADMIN_REQUIRED,
  NATIVE_AUTH_ENDPOINT_CLOSED,
  NATIVE_AUTH_ENDPOINTS,
  NATIVE_AUTH_IDEMPOTENCY_KEY_REQUIRED,
  NATIVE_AUTH_MEMBER_ID_MUST_BE_USER_ID,
  NATIVE_AUTH_SELF_PREFERENCE_NOT_WIRED,
  NATIVE_AUTH_SESSION_REQUIRED,
  NATIVE_AUTH_STORAGE_REQUIRED,
  NATIVE_AUTH_TENANT_REQUIRED,
  NATIVE_AUTH_TRANSLATION_INCOMPLETE,
  NATIVE_AUTH_UNKNOWN_ENDPOINT,
} from "../../src/auth/directory/ingress";
import {
  DIRECTORY_READ_AUTHORITY_CLOSED,
  DIRECTORY_READ_COMPANY_SUSPENDED,
  DIRECTORY_READ_MEMBER_SUSPENDED,
  DIRECTORY_READ_MIGRATION_PAUSED,
  DIRECTORY_READ_ROLE_FORBIDDEN,
  DIRECTORY_READ_TEAM_OUT_OF_COMPANY,
  PLATFORM_READ_ADMIN_REQUIRED,
} from "../../src/auth/directory/read-gate";
import { loadConfig } from "../../src/config";
import { createDatabase } from "../../src/db/client";
import {
  authInvitations,
  authMembers,
  authOrganizations,
  authTeamMembers,
  authTeams,
} from "../../src/db/schema/auth-directory";
import { accounts, users, verifications } from "../../src/db/schema/core";
import { testEnvironment } from "../support/environment";

/*
 * T02.11 (#533, original task P04) — the forced classification and read gate
 * of the native Admin/Organization surface (interfaces §3.2/§3.3, design
 * §4.2/§5.2; acceptance P04).
 *
 * What this suite pins, and why each assertion is a real request against a
 * real assembly rather than a classification helper's answer:
 *
 * - `disabled_native_admin_and_deletion_routes_are_refused`: every X-class
 *   endpoint of the frozen table (remove-user, impersonate, organization
 *   create/delete/remove-team, the closed discovery reads, the dynamic-role
 *   endpoints) answers a backend 403, an unknown method/path under the
 *   directory prefixes answers 404, and NOT ONE of them writes a BA row. The
 *   requests are real fetches against a Bun server running the real createApp
 *   over a real fixed-build Better Auth instance.
 * - `native_directory_get_matrix_checks_lifecycle_and_assurance`: every
 *   R-class Organization GET is refused for a suspended member, a suspended
 *   company and a company whose proof policy cannot be satisfied
 *   (`expect([403,404]).toContain(status)`), and the SAME read succeeds for a
 *   live member under the ba authority — the gate is what changed, not the
 *   endpoint. The legacy/paused branches are asserted beside it: legacy answers
 *   404 (the native BA directory is not the record there) and paused answers
 *   503, and a non-directory native path (/api/auth/get-session) keeps working
 *   under every authority, because legacy keeps its own capability.
 * - `mounted_directory_http_writes_share_production_executor_tx`: the
 *   production ingress translates a native HTTP directory write into exactly
 *   one `Directory.execute` command, the production executor runs the pinned
 *   build's own `auth.api.updateOrganization` inside its outer transaction,
 *   and the txid recorded by a database trigger on the BA table equals the
 *   txid the command transaction reports. Every D/I endpoint that has no
 *   registered operation is refused (503 UNWIRED, unauthenticated 401,
 *   non-admin identity 403) with `dmlCount === 0`.
 *
 * Boundaries this suite deliberately does not claim: the per-operation
 * business handlers (P08/P09/P12) — the executor's handler set here is the
 * stand-in the executor contract expects, and the assembly that injects the
 * production executor into createApp arrives with those tasks; the stored
 * company-proof policy model (P11); and the SCIM/SSO translations interfaces
 * §3.2 gives P12, whose native contract this task keeps (see ingress.ts's
 * header).
 *
 * The five BA_TEST_* URLs are all required and must name one isolated
 * openbot_enterprise_* database. No DSN is ever printed.
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
] as const;
const MIGRATION_PATHS = MIGRATION_TAGS.map((tag) =>
  join(import.meta.dirname, `../../drizzle/${tag}.sql`),
);

const BA_TABLES = [
  "auth_company_session_assurances",
  "auth_company_auth_challenges",
  "auth_team_management_grants",
  "auth_provisioning_rules",
  "auth_command_outbox",
  "auth_command_change_keys",
  "auth_command_receipts",
  "auth_authority_states",
  "auth_eligibility_clocks",
  "auth_invitations",
  "auth_team_members",
  "auth_members",
  "auth_team_bindings",
  "auth_teams",
  "auth_organizations",
] as const;

const CONTROLLED_FUNCTIONS = [
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
] as const;

const MIGRATION_TRIGGERS = [
  ["auth_members", "auth_directory_dml_guard"],
  ["auth_team_members", "auth_directory_dml_guard"],
  ["auth_team_bindings", "auth_directory_dml_guard"],
  ["auth_organizations", "auth_directory_dml_guard"],
  ["auth_teams", "auth_directory_dml_guard"],
  ["auth_invitations", "auth_directory_dml_guard"],
  ["auth_command_receipts", "auth_command_receipt_fence"],
  ["auth_command_change_keys", "auth_change_key_fence"],
  ["auth_team_members", "auth_team_member_orphan_fence"],
  ["auth_members", "auth_member_orphan_fence"],
  // This suite's own DML capture (dropped with the stack so a crashed run's
  // orphan trigger cannot keep the function alive).
  ["auth_organizations", "t0211_capture"],
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

const TENANT = "t0211-tenant";
const TENANT_NAME = "T0211 Native Auth Tenant";
const WORKSPACE = "t0211-workspace";
const WORKSPACE_NAME = "T0211 Workspace";
const TEAM = "t0211-team";
const TEAM_NAME = "T0211 Team";
const OWNER_USER = "t0211-owner";
const MEMBER_USER = "t0211-member";
const ADMIN_USER = "t0211-admin";
const PASSWORD = "correct-horse-battery-staple";
const BA_SECRET =
  "t0211-native-auth-ingress-fixed-test-secret-not-a-credential";
const OWNER_PRINCIPAL = "t0211-owner-principal";
const MEMBER_PRINCIPAL = "t0211-member-principal";
const DML_EVENTS_TABLE = "t0211_dml_events";
const DML_CAPTURE_FUNCTION = "t0211_capture_dml";
const SESSION_ORG_COLUMNS = [
  "active_organization_id",
  "active_team_id",
] as const;

function shapeOf(variable: string, raw: string) {
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
  return { endpoint: `${host}:${url.port || "5432"}`, database };
}

function readBaUrls(): string {
  const shapes = new Map<string, string>();
  for (const variable of BA_URL_VARIABLES) {
    const raw = process.env[variable]?.trim();
    if (!raw) {
      throw new Error(
        `${variable} is required: a better-auth DB suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
      );
    }
    shapes.set(variable, shapeOf(variable, raw).endpoint);
  }
  const reference = shapes.get(DATABASE_VARIABLE);
  for (const [variable, endpoint] of shapes) {
    if (endpoint !== reference) {
      throw new Error(
        `${variable} must name the same PostgreSQL instance as ${DATABASE_VARIABLE}.`,
      );
    }
  }
  return process.env[DATABASE_VARIABLE]!.trim();
}

async function tableExists(
  sql: postgres.Sql | postgres.Sql<never>,
  name: string,
): Promise<boolean> {
  const [row] =
    await sql`SELECT to_regclass(${`public.${name}`}) IS NOT NULL AS present`;
  return Boolean(row?.present);
}

/** Pre-suite shape: this suite's tables, triggers, columns and rows gone. */
async function cleanupFixture(
  sql: postgres.Sql,
  options: { ownsAuditTable: boolean },
): Promise<void> {
  const triggerPairs = MIGRATION_TRIGGERS.map(
    ([table, trigger]) => `('${table}', '${trigger}')`,
  ).join(", ");
  const functions = [...CONTROLLED_FUNCTIONS, `${DML_CAPTURE_FUNCTION}()`]
    .map((signature) => `('${signature}')`)
    .join(", ");
  const tables = BA_TABLES.map((name) => `('${name}')`).join(", ");
  await sql.unsafe(`
    DO $t0211_cleanup$
    DECLARE
      target record;
    BEGIN
      FOR target IN SELECT * FROM (VALUES ${triggerPairs}) AS triggers(table_name, trigger_name) LOOP
        IF to_regclass('public.' || target.table_name) IS NOT NULL THEN
          EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', target.trigger_name, target.table_name);
        END IF;
      END LOOP;
      FOR target IN SELECT * FROM (VALUES ${functions}) AS functions(signature) LOOP
        EXECUTE format('DROP FUNCTION IF EXISTS public.%s', target.signature);
      END LOOP;
      FOR target IN SELECT * FROM (VALUES ${tables}) AS tables(table_name) LOOP
        IF to_regclass('public.' || target.table_name) IS NOT NULL THEN
          EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator, ob_ent_auth_writer', target.table_name);
        END IF;
      END LOOP;
    END
    $t0211_cleanup$`);
  await sql.unsafe(
    `DROP TABLE IF EXISTS ${DML_EVENTS_TABLE}, ${BA_TABLES.map((name) => `"${name}"`).join(", ")} CASCADE`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_principals" DROP COLUMN IF EXISTS "identity_generation"`,
  );
  for (const [table, constraint] of [
    ["enterprise_credentials", "enterprise_credential_owner_generation_pair"],
    [
      "enterprise_credential_actions",
      "enterprise_credential_action_generation_pair",
    ],
    [
      "billing_company_finance_grants",
      "billing_company_finance_grant_generation_pair",
    ],
    ["access_grants", "access_grants_principal_generation_pair"],
    ["access_grants", "access_grants_identity_generation_safe_integer"],
    ["access_grants", "access_grants_principal_fk"],
  ] as const) {
    await sql.unsafe(
      `ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${constraint}"`,
    );
  }
  for (const [table, column] of [
    ["enterprise_credentials", "owner_identity_generation"],
    ["enterprise_credentials", "owner_company_generation"],
    ["enterprise_credential_actions", "identity_generation"],
    ["enterprise_credential_actions", "company_generation"],
    ["enterprise_credential_actions", "source_team_generation"],
    ["billing_company_finance_grants", "identity_generation"],
    ["billing_company_finance_grants", "company_generation"],
    ["access_grants", "principal_id"],
    ["access_grants", "identity_generation"],
    ["gateway_virtual_keys", "source_identity_generation"],
  ] as const) {
    await sql.unsafe(
      `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "${column}"`,
    );
  }
  /*
   * The organization plugin's session columns. No migration adds them yet
   * (that schema task has not landed), so this suite adds them for its own
   * fixed-build instance and removes them again — an island that already
   * carries them (a later schema task ran) keeps them.
   */
  for (const column of SESSION_ORG_COLUMNS) {
    await sql.unsafe(
      `ALTER TABLE "sessions" DROP COLUMN IF EXISTS "${column}"`,
    );
  }
  if (await tableExists(sql, AUDIT_TABLE)) {
    await sql.unsafe(
      `DROP TRIGGER IF EXISTS t0211_audit_fault ON ${AUDIT_TABLE}`,
    );
    await sql.unsafe(
      `DELETE FROM ${AUDIT_TABLE} WHERE tenant_id = '${TENANT}'`,
    );
  }
  await sql`DELETE FROM verifications WHERE id LIKE 't0211-%'`;
  // The fixed build generates its own user ids, so this suite's people are
  // identified by the address it signed them up with; their sessions,
  // accounts, principals and projections cascade from the user row.
  await sql`DELETE FROM users WHERE id LIKE 't0211-%' OR email LIKE 't0211-%@example.test'`;
  await sql`DELETE FROM enterprise_workspaces WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM enterprise_tenants WHERE id = ${TENANT}`;
  if (options.ownsAuditTable) {
    await sql.unsafe(`DROP TABLE IF EXISTS ${AUDIT_TABLE}`);
  }
}

interface FixtureUser {
  readonly userId: string;
  readonly cookie: string;
  readonly sessionId: string;
}

interface Harness {
  readonly sql: postgres.Sql;
  readonly db: ReturnType<typeof createDatabase>;
  readonly auth: Awaited<ReturnType<typeof buildAuth>>["auth"];
  readonly bound: Awaited<ReturnType<typeof buildAuth>>["bound"];
  readonly owner: FixtureUser;
  readonly member: FixtureUser;
  readonly admin: FixtureUser;
  readonly server: { stop(force?: boolean): void; port: number; url: string };
  /** The full fixed-build surface, mounted exactly as production mounts it. */
  readonly app: { fetch(request: Request): Response | Promise<Response> };
  /** The same ingress factory over the production executor (txid matrix). */
  readonly executorServer: { stop(force?: boolean): void; url: string };
  readonly txids: string[];
  readonly setProof: (required: boolean) => void;
  readonly setAuthority: (phase: "M1" | "M2" | "M4") => Promise<void>;
  readonly setMemberStatus: (status: "active" | "suspended") => Promise<void>;
  readonly setCompanyStatus: (status: "active" | "suspended") => Promise<void>;
  readonly setMemberRole: (role: string) => Promise<void>;
  readonly dmlCount: () => Promise<number>;
  readonly probe: () => postgres.Sql;
  readonly close: () => Promise<void>;
}

type NativeAuthInstance = Awaited<ReturnType<typeof buildAuth>>["auth"];

/*
 * The organization plugin's session model adds two fields no production
 * migration has landed yet, so the fixed-build instance in this suite maps
 * `session` to this table object (same columns as sessions plus the two
 * organization fields). The read gate reads the underlying table by name, so
 * both views see the same rows.
 */
const sessionWithOrganization = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  activeOrganizationId: text("active_organization_id"),
  activeTeamId: text("active_team_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

const adapterSchema = {
  user: users,
  session: sessionWithOrganization,
  account: accounts,
  verification: verifications,
  organization: authOrganizations,
  invitation: authInvitations,
  member: authMembers,
  team: authTeams,
  teamMember: authTeamMembers,
};

async function buildAuth(db: Awaited<ReturnType<typeof createDatabase>>) {
  let resolvedOptions: unknown;
  const auth = betterAuth({
    secret: BA_SECRET,
    baseURL: "http://127.0.0.1:3000",
    trustedOrigins: ["http://127.0.0.1:3000"],
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    plugins: [organization({ teams: { enabled: true } })],
    session: { storeSessionInDatabase: true },
    verification: { storeInDatabase: true },
    database: (options: unknown) => {
      resolvedOptions = options;
      return drizzleAdapter(db as never, {
        provider: "pg",
        schema: adapterSchema,
        transaction: true,
      })(options as never);
    },
  });
  await auth.$context;
  const bound = (
    await import("../../src/auth/directory/transaction-adapter")
  ).createTransactionBoundBa({
    createTxAdapter: (tx: DirectoryTx) =>
      drizzleAdapter(tx as never, {
        provider: "pg",
        schema: adapterSchema,
        transaction: false,
      })(resolvedOptions as never),
  });
  return { auth, bound };
}

function cookieOf(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const pair = header.split(";")[0]?.trim() ?? "";
  if (!pair.includes("=")) {
    throw new Error(
      "the fixed-build sign-up returned no session cookie; the suite cannot exercise a native session read",
    );
  }
  return pair;
}

async function signUp(
  auth: NativeAuthInstance,
  email: string,
  name: string,
): Promise<{ userId: string; cookie: string; sessionId: string }> {
  const response = await auth.api.signUpEmail({
    body: { email, name, password: PASSWORD },
    asResponse: true,
  });
  if (!response.ok) {
    const detail = await response
      .clone()
      .text()
      .catch(() => "");
    throw new Error(
      `the fixed-build sign-up failed with ${response.status}: ${detail.slice(0, 400)}; the harness cannot continue`,
    );
  }
  const payload = (await response.clone().json()) as {
    user?: { id?: string };
    token?: string;
  };
  const userId = payload.user?.id;
  if (!userId) {
    throw new Error("the fixed-build sign-up returned no user id");
  }
  const cookie = cookieOf(response);
  return { userId, cookie, sessionId: "" };
}

let harness: Harness | undefined;

async function createHarness(): Promise<Harness> {
  const setupUrl = readBaUrls();
  const sql = postgres(setupUrl, {
    max: 4,
    idle_timeout: 5,
    onnotice: () => {},
  });
  const islandHasMt078 = await tableExists(
    sql,
    "billing_company_manage_grants",
  );
  const ownsAuditTable = !islandHasMt078;
  try {
    await cleanupFixture(sql, { ownsAuditTable });
    for (const path of MIGRATION_PATHS) {
      if (!existsSync(path)) {
        throw new Error(
          `${path} does not exist: the native-auth ingress sits on the verified T02.01–T02.06 stack, and a missing prerequisite is a workspace problem, not a target behavior.`,
        );
      }
      await sql.unsafe(readFileSync(path, "utf8"));
    }
    if (ownsAuditTable) {
      for (const statement of AUDIT_TABLE_STATEMENTS) {
        await sql.unsafe(statement);
      }
    }
    for (const column of SESSION_ORG_COLUMNS) {
      await sql.unsafe(
        `ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "${column}" text`,
      );
    }
    await sql.unsafe(
      `CREATE TABLE ${DML_EVENTS_TABLE} (
         id bigserial PRIMARY KEY,
         table_name text NOT NULL,
         operation text NOT NULL,
         txid text NOT NULL,
         at timestamp with time zone DEFAULT now() NOT NULL
       )`,
    );
    await sql.unsafe(`
      CREATE FUNCTION ${DML_CAPTURE_FUNCTION}() RETURNS trigger
      LANGUAGE plpgsql AS $t0211_capture$
      BEGIN
        INSERT INTO ${DML_EVENTS_TABLE} (table_name, operation, txid)
        VALUES (TG_TABLE_NAME, TG_OP, txid_current()::text);
        RETURN NEW;
      END
      $t0211_capture$`);
    await sql.unsafe(
      `CREATE TRIGGER t0211_capture AFTER INSERT OR UPDATE OR DELETE ON auth_organizations
         FOR EACH ROW EXECUTE FUNCTION ${DML_CAPTURE_FUNCTION}()`,
    );

    // The baseline skeleton (outside the six guarded BA tables).
    await sql`INSERT INTO enterprise_tenants (id, name) VALUES (${TENANT}, ${TENANT_NAME})`;
    await sql`INSERT INTO enterprise_workspaces (tenant_id, id, name) VALUES (${TENANT}, ${WORKSPACE}, ${WORKSPACE_NAME})`;

    const db = createDatabase(setupUrl, { max: 4 });
    const { auth, bound } = await buildAuth(db);

    const owner = await signUp(auth, `${OWNER_USER}@example.test`, "Owner");
    const member = await signUp(auth, `${MEMBER_USER}@example.test`, "Member");
    const admin = await signUp(auth, `${ADMIN_USER}@example.test`, "Admin");

    const sessionIdOf = async (userId: string): Promise<string> => {
      const [row] =
        await sql`SELECT id FROM sessions WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 1`;
      if (!row?.id) {
        throw new Error(`no session row for ${userId} after sign-up`);
      }
      return String(row.id);
    };
    const ownerSession = await sessionIdOf(owner.userId);
    const memberSession = await sessionIdOf(member.userId);
    const adminSession = await sessionIdOf(admin.userId);
    await sql`UPDATE sessions SET active_organization_id = ${TENANT}
               WHERE user_id IN (${owner.userId}, ${member.userId})`;

    /*
     * The guarded directory skeleton is created through the real command
     * protocol — the begin marker, the rows, the projections and clocks the
     * controlled functions own, the finalize stamp — because the T02.06 DML
     * guard refuses a bare insert on every one of these tables. The
     * principals exist first: the guard resolves each member's principal
     * through auth_directory_guard_principal, so the fixture's users must be
     * principals before their member rows can be written.
     */
    await sql`INSERT INTO enterprise_principals (id, user_id, status, identity_generation)
              VALUES (${OWNER_PRINCIPAL}, ${owner.userId}, 'active', 1),
                     (${MEMBER_PRINCIPAL}, ${member.userId}, 'active', 1),
                     (${`t0211-admin-principal`}, ${admin.userId}, 'active', 1)`;
    await db.transaction(async (tx) => {
      const commandId = "t0211-fixture-command";
      await tx.execute(dsql`
        SELECT set_config('auth.current_command', public.auth_directory_begin_command(
          ${commandId}, 'company', 'company.provision', ${TENANT}, null,
          null, 'migration', 't0211-fixture-key',
          't0211-fixture-payload-hash'), true)`);
      await tx.execute(dsql`
        INSERT INTO auth_organizations (id, name, slug)
        VALUES (${TENANT}, ${TENANT_NAME}, 't0211-native-auth')`);
      await tx.execute(dsql`
        INSERT INTO auth_teams (id, organization_id, name)
        VALUES (${TEAM}, ${TENANT}, ${TEAM_NAME})`);
      await tx.execute(dsql`
        INSERT INTO auth_team_bindings (tenant_id, workspace_id, team_id)
        VALUES (${TENANT}, ${WORKSPACE}, ${TEAM})`);
      await tx.execute(dsql`
        INSERT INTO auth_members (id, organization_id, user_id, role)
        VALUES (${`t0211-owner-member`}, ${TENANT}, ${owner.userId}, 'owner'),
               (${`t0211-member-member`}, ${TENANT}, ${member.userId}, 'member')`);
      await tx.execute(dsql`
        INSERT INTO auth_team_members (id, team_id, user_id)
        VALUES (${`t0211-member-team-member`}, ${TEAM}, ${member.userId})`);
      for (const [principal, role] of [
        [OWNER_PRINCIPAL, "tenant_admin"],
        [MEMBER_PRINCIPAL, "member"],
      ] as const) {
        await tx.execute(
          dsql`SELECT public.auth_project_company_membership(
                 ${TENANT}, ${principal}, ${role}, 'active', 1, ${commandId})`,
        );
        await tx.execute(
          dsql`SELECT public.auth_advance_eligibility_clock(
                 ${TENANT}, ${principal}, 'company', ${TENANT}, 1, 1, false, ${commandId})`,
        );
      }
      await tx.execute(
        dsql`SELECT public.auth_advance_eligibility_clock(
               ${TENANT}, ${MEMBER_PRINCIPAL}, 'team', ${WORKSPACE}, 1, 1, false, ${commandId})`,
      );
      await tx.execute(
        dsql`SELECT public.auth_directory_finalize_command(${commandId})`,
      );
      await tx.execute(
        dsql`SELECT set_config('auth.current_command', '', true)`,
      );
      await tx.execute(dsql`SET CONSTRAINTS ALL IMMEDIATE`);
    });
    await sql`INSERT INTO user_roles (user_id, role) VALUES (${admin.userId}, 'admin')`;

    let proofRequired = false;
    const proofPolicy: CompanyProofPolicyView = {
      requiresProof: async () => proofRequired,
    };
    const txids: string[] = [];

    /*
     * The production executor, over the production handler contract. The one
     * registered operation is a stand-in of the shape P08 will ship:
     * `authorize` is the locked check, `sync` runs the pinned build's own
     * `auth.api.updateOrganization` inside TransactionBoundBa.
     */
    const executorModule = await import("../../src/auth/directory/executor");
    const finalizerModule = await import("../../src/auth/directory/finalizer");
    const { principalRegistry } = await import(
      "../../src/auth/directory/principal-registry"
    );
    const authority = createDirectoryAuthority();
    const profileHandler = {
      authorize: async () => {},
      sync: async (context: {
        tx: DirectoryTx;
        command: { payload: Record<string, unknown> };
      }) => {
        const [row] = (await context.tx.execute(
          dsql`SELECT txid_current()::text AS txid`,
        )) as unknown as { txid: string }[];
        if (row?.txid) txids.push(String(row.txid));
        const name = String(context.command.payload.name ?? "");
        await auth.api.updateOrganization({
          headers: new Headers({ cookie: owner.cookie }),
          body: { organizationId: TENANT, data: { name } },
        });
        return {};
      },
    };
    const directory = executorModule.createDirectoryExecutor({
      database: db,
      bound,
      authority,
      registry: principalRegistry,
      finalizer: finalizerModule.createDirectoryFinalizer(),
      handlers: { "company.profile.update": profileHandler } as never,
    });
    /*
     * The production identity executor, the same assembly P12 ships: the real
     * finalizer, the real registry, and a ba access whose two halves this
     * suite never exercises (create-user/password.reset) — identity.session.
     * revoke does its own session writes inside the command transaction.
     */
    const identityModule = await import("../../src/auth/directory/identity");
    const identity = identityModule.createIdentityExecutor({
      database: db,
      bound,
      registry: principalRegistry,
      finalizer: finalizerModule.createIdentityFinalizer(),
      ba: {
        createUser: async () => {
          throw new Error("T0211_BA_CREATE_USER_NOT_EXERCISED");
        },
        writePassword: async () => {
          throw new Error("T0211_BA_WRITE_PASSWORD_NOT_EXERCISED");
        },
        consumeResetToken: async () => {
          throw new Error("T0211_BA_CONSUME_RESET_TOKEN_NOT_EXERCISED");
        },
      },
      commitmentKey: await import("node:crypto").then((nodeCrypto) =>
        nodeCrypto.createHash("sha256").update(BA_SECRET).digest(),
      ),
    });

    // Reset the database transaction counter: only BA DML after this line is
    // counted for the zero-DML assertions.
    await sql`DELETE FROM ${sql(DML_EVENTS_TABLE)}`;

    const config = loadConfig(testEnvironment());
    const buildApp = (coworkerDirectory: unknown) => {
      const args: unknown[] = new Array(createApp.length).fill(undefined);
      args[0] = config;
      args[1] = auth;
      args[2] = {
        rolesForUser: async (userId: string) =>
          userId === admin.userId ? ["admin"] : ["user"],
      };
      args[25] = db;
      args[34] = { directory: coworkerDirectory };
      return createApp(...(args as never[]));
    };

    // The bare production assembly: no executor behind the ingress.
    const app = buildApp({ proofPolicy });

    /*
     * R1-F3: the transaction matrix runs against a real createApp too — the
     * same production ingress factory, now fed the production executors
     * through the same `coworker.directory` seam the P08/P09/P12 assembly
     * will use.
     */
    const executorApp = buildApp({ proofPolicy, directory, identity });

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => app.fetch(request),
    });

    const executorServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => executorApp.fetch(request),
    });

    const setAuthority = async (phase: "M1" | "M2" | "M4") => {
      const directoryAuthority =
        phase === "M4" ? "ba" : phase === "M2" ? "paused" : "legacy";
      await sql`UPDATE auth_authority_states
                   SET phase = ${phase}, directory_authority = ${directoryAuthority}, authority_version = authority_version + 1
                 WHERE id = 1`;
    };
    await setAuthority("M4");

    return {
      sql,
      db,
      auth,
      bound,
      owner: { ...owner, sessionId: ownerSession },
      member: { ...member, sessionId: memberSession },
      admin: { ...admin, sessionId: adminSession },
      app,
      server: {
        stop: (force?: boolean) => server.stop(force),
        port: server.port ?? 0,
        url: `http://127.0.0.1:${server.port}`,
      },
      executorServer: {
        stop: (force?: boolean) => executorServer.stop(force),
        url: `http://127.0.0.1:${executorServer.port}`,
      },
      txids,
      setProof: (required) => {
        proofRequired = required;
      },
      setAuthority,
      setMemberStatus: async (status) => {
        await sql`UPDATE enterprise_memberships
                     SET status = ${status}
                   WHERE tenant_id = ${TENANT} AND principal_id = ${MEMBER_PRINCIPAL}`;
      },
      setCompanyStatus: async (status) => {
        await sql`UPDATE enterprise_tenants SET status = ${status} WHERE id = ${TENANT}`;
      },
      dmlCount: async () => {
        const [row] = await sql`SELECT count(*)::int AS count FROM ${sql(
          DML_EVENTS_TABLE,
        )}`;
        return Number(row?.count ?? 0);
      },
      probe: () => postgres(setupUrl, { max: 1, idle_timeout: 5 }),
      close: async () => {
        try {
          server.stop(true);
          executorServer.stop(true);
          await cleanupFixture(sql, { ownsAuditTable });
        } finally {
          await sql.end({ timeout: 5 }).catch(() => {});
        }
      },
    };
  } catch (error) {
    await cleanupFixture(sql, { ownsAuditTable }).catch(() => {});
    await sql.end({ timeout: 5 }).catch(() => {});
    throw error;
  }
}

beforeAll(async () => {
  harness = await createHarness();
}, 180_000);

afterAll(async () => {
  if (!harness) return;
  const probe = harness.probe();
  await harness.close();
  try {
    const leaked = await probe`
      SELECT n.nspname || '.' || c.relname AS resource
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = ANY(${[...BA_TABLES, DML_EVENTS_TABLE]}::text[])
          OR c.relname LIKE 't0211%'
      UNION ALL
      SELECT 'users:' || id FROM users WHERE id LIKE 't0211-%' OR email LIKE 't0211-%@example.test'
      UNION ALL
      SELECT 'tenants:' || id FROM enterprise_tenants WHERE id LIKE 't0211-%'`;
    expect(leaked).toEqual([]);
  } finally {
    await probe.end({ timeout: 5 }).catch(() => {});
  }
});

/* ------------------------------------------------------------------------- */
/* Helpers for the tests themselves.                                          */
/* ------------------------------------------------------------------------- */

function api(
  path: string,
  init: RequestInit & { user?: "owner" | "member" | "admin" | "none" } = {},
): Promise<Response> {
  if (!harness) throw new Error("the harness is not up");
  const { user, ...rest } = init;
  const cookie =
    user === "owner"
      ? harness.owner.cookie
      : user === "member"
        ? harness.member.cookie
        : user === "admin"
          ? harness.admin.cookie
          : undefined;
  return fetch(`${harness.server.url}/api/auth${path}`, {
    ...rest,
    headers: {
      ...(rest.body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(rest.headers ?? {}),
    },
  });
}

function executorApi(
  path: string,
  init: RequestInit & { user?: "owner" | "member" | "admin" | "none" } = {},
): Promise<Response> {
  if (!harness) throw new Error("the harness is not up");
  const { user, ...rest } = init;
  const cookie =
    user === "owner"
      ? harness.owner.cookie
      : user === "member"
        ? harness.member.cookie
        : user === "admin"
          ? harness.admin.cookie
          : undefined;
  return fetch(`${harness.executorServer.url}/api/auth${path}`, {
    ...rest,
    headers: {
      ...(rest.body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(rest.headers ?? {}),
    },
  });
}

const R_GET_PATHS = [
  "/organization/get-organization",
  "/organization/get-full-organization",
  "/organization/list-members",
  "/organization/list-invitations",
  "/organization/list-teams",
  "/organization/list-team-members?teamId=t0211-team",
  "/organization/get-active-member",
  "/organization/get-active-member-role",
] as const;

/** The negative scenarios §3.2 demands for EVERY native directory GET. */
const READ_SCENARIOS = [
  { name: "suspended member", code: DIRECTORY_READ_MEMBER_SUSPENDED },
  { name: "suspended company", code: DIRECTORY_READ_COMPANY_SUSPENDED },
  { name: "missing company proof", code: COMPANY_REAUTH_REQUIRED },
] as const;

async function restoreFixture(): Promise<void> {
  if (!harness) throw new Error("the harness is not up");
  await harness.setMemberStatus("active");
  await harness.setCompanyStatus("active");
  harness.setProof(false);
}

/* ------------------------------------------------------------------------- */
/* The frozen classification table.                                           */
/* ------------------------------------------------------------------------- */

describe("the frozen native endpoint table", () => {
  test("carries every interfaces §3.2 surface without duplicates", () => {
    const seen = new Set<string>();
    for (const endpoint of NATIVE_AUTH_ENDPOINTS) {
      const key = `${endpoint.method} ${endpoint.path}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
      expect(endpoint.nativeOperation.length).toBeGreaterThan(0);
      expect(["D", "I", "R", "S", "P", "X", "native", "closed"]).toContain(
        endpoint.disposition,
      );
    }
    // Admin's 15 rows and the Organization table's 36, exactly once each.
    expect(
      NATIVE_AUTH_ENDPOINTS.filter((e) => e.path.startsWith("/admin/")),
    ).toHaveLength(15);
    expect(
      NATIVE_AUTH_ENDPOINTS.filter((e) => e.path.startsWith("/organization/")),
    ).toHaveLength(36);
    // The SSO management/callback family and the SCIM resource paths.
    expect(
      NATIVE_AUTH_ENDPOINTS.filter(
        (e) => e.path === "/sso/callback/:providerId",
      ),
    ).toHaveLength(1);
    expect(
      NATIVE_AUTH_ENDPOINTS.filter((e) => e.path.startsWith("/scim/")),
    ).toHaveLength(17);
    expect(
      classifyNativeAuthPath("POST", "/organization/create"),
    ).toMatchObject({ kind: "classified" });
    expect(classifyNativeAuthPath("POST", "/organization/nope")).toEqual({
      kind: "unknown",
    });
    expect(classifyNativeAuthPath("GET", "/get-session")).toEqual({
      kind: "outside",
    });
    // Every closed row names its 501 code and its owning task (R1-F4).
    for (const endpoint of NATIVE_AUTH_ENDPOINTS.filter(
      (candidate) => candidate.disposition === "closed",
    )) {
      expect(
        endpoint.closedCode,
        `${endpoint.method} ${endpoint.path}`,
      ).toBeTruthy();
    }
  });

  test("the frozen table reconciles with the fixed packages' actual route surface", async () => {
    const { admin, organization } = await import("better-auth/plugins");
    const { sso } = await import("@better-auth/sso");
    const { scim } = await import("@better-auth/scim");

    // `:name` params are name-agnostic on both sides.
    const normalizePath = (path: string) =>
      path
        .split("/")
        .map((segment) => (segment.startsWith(":") ? ":" : segment))
        .join("/");
    const declaredRows = (plugin: { endpoints: Record<string, unknown> }) =>
      Object.values(plugin.endpoints).flatMap((raw) => {
        const endpoint = raw as {
          path?: string;
          options?: { method?: string | string[] };
        };
        if (!endpoint.path || !endpoint.options?.method) return [];
        const methods = Array.isArray(endpoint.options.method)
          ? endpoint.options.method
          : [endpoint.options.method];
        return methods.map(
          (method) => `${method} ${normalizePath(endpoint.path as string)}`,
        );
      });

    const declared = new Set([
      ...declaredRows(organization({ teams: { enabled: true } })),
      ...declaredRows(
        organization({
          teams: { enabled: true },
          dynamicAccessControl: { enabled: true },
        }),
      ),
      ...declaredRows(admin()),
      ...declaredRows(sso({ provisionUser: async () => {} })),
      ...declaredRows(
        sso({
          provisionUser: async () => {},
          domainVerification: { enabled: true },
        }),
      ),
      ...declaredRows(
        scim({
          connections: [
            {
              id: "probe",
              credentials: [{ type: "bearer", id: "probe", token: "probe" }],
            },
          ],
        }),
      ),
    ]);
    const classified = new Set(
      NATIVE_AUTH_ENDPOINTS.map(
        (endpoint) => `${endpoint.method} ${normalizePath(endpoint.path)}`,
      ),
    );
    // A package route the table does not classify would be served by the
    // pinned build's handler — the exact drift this audit exists to fail on.
    const unclassified = [...declared].filter((row) => !classified.has(row));
    expect(unclassified).toEqual([]);
    // And conversely, except the two provider-less SAML posts, which the
    // fixed package registers at runtime outside its `endpoints` map (pinned
    // here by name; the closed-write test above drives them over HTTP).
    const pinnedExtras = new Set([
      "POST /sso/saml2/sp/acs",
      "POST /sso/saml2/sp/slo",
    ]);
    const invented = [...classified].filter(
      (row) => !declared.has(row) && !pinnedExtras.has(row),
    );
    expect(invented).toEqual([]);
  });

  test("classifies the closed native writes and impersonation as refused", () => {
    expect(
      classifyNativeAuthPath("POST", "/admin/impersonate-user"),
    ).toMatchObject({ kind: "classified", endpoint: { disposition: "X" } });
    expect(
      classifyNativeAuthPath("POST", "/organization/create"),
    ).toMatchObject({ kind: "classified", endpoint: { disposition: "X" } });
    expect(
      classifyNativeAuthPath("POST", "/organization/update"),
    ).toMatchObject({ kind: "classified", endpoint: { disposition: "D" } });
    expect(
      classifyNativeAuthPath("GET", "/organization/list-members"),
    ).toMatchObject({ kind: "classified", endpoint: { disposition: "R" } });
    expect(classifyNativeAuthPath("GET", "/organization/list")).toMatchObject({
      kind: "classified",
      endpoint: { disposition: "X" },
    });
  });
});

/* ------------------------------------------------------------------------- */
/* Refusals through the real createApp mount.                                 */
/* ------------------------------------------------------------------------- */

describe("the native directory surface through createApp", () => {
  test("disabled_native_admin_and_deletion_routes_are_refused", async () => {
    const before = await harness!.dmlCount();
    const closedPost = [
      "/admin/remove-user",
      "/admin/impersonate-user",
      "/admin/stop-impersonating",
      "/organization/create",
      "/organization/delete",
      "/organization/remove-team",
      "/organization/create-role",
      "/organization/update-role",
      "/organization/delete-role",
      "/organization/check-slug",
    ];
    const closedGet = [
      "/organization/list",
      "/organization/list-user-teams",
      "/organization/get-invitation",
      "/organization/list-user-invitations",
      "/organization/get-role",
      "/organization/list-roles",
    ];
    for (const path of closedPost) {
      const response = await api(path, {
        method: "POST",
        user: "owner",
        body: JSON.stringify({ organizationId: TENANT }),
      });
      expect(response.status, path).not.toBe(200);
      expect(response.status, path).toBe(403);
      const body = (await response.json()) as { code?: string };
      expect(body.code, path).toBe(NATIVE_AUTH_ENDPOINT_CLOSED);
    }
    for (const path of closedGet) {
      const response = await api(path, { method: "GET", user: "owner" });
      expect(response.status, path).not.toBe(200);
      expect(response.status, path).toBe(403);
      const body = (await response.json()) as { code?: string };
      expect(body.code, path).toBe(NATIVE_AUTH_ENDPOINT_CLOSED);
    }
    // The same endpoints refuse a signed-out caller identically: closed is
    // closed, not "closed unless you are nobody".
    for (const path of ["/organization/create", "/admin/impersonate-user"]) {
      const response = await api(path, {
        method: "POST",
        user: "none",
        body: JSON.stringify({ organizationId: TENANT }),
      });
      expect(response.status, path).toBe(403);
    }
    const after = await harness!.dmlCount();
    expect(after).toBe(before);
  });

  test("unknown native method and path are refused, never forwarded", async () => {
    const unknown = [
      ["POST", "/organization/no-such-action"],
      ["GET", "/organization/delete"],
      ["GET", "/organization/update"],
      ["POST", "/organization/get-organization"],
      ["POST", "/admin/nope"],
      ["GET", "/sso/nope"],
      ["POST", "/scim/v2/nope"],
    ] as const;
    for (const [method, path] of unknown) {
      const response = await api(path, { method, user: "owner" });
      expect(response.status, `${method} ${path}`).toBe(404);
      const body = (await response.json()) as { code?: string };
      expect(body.code, `${method} ${path}`).toBe(NATIVE_AUTH_UNKNOWN_ENDPOINT);
    }
    // A method the Hono mount does not even take is refused the same way
    // (its own 404, before any handler or transaction).
    for (const [method, path] of [
      ["DELETE", "/admin/remove-user"],
      ["PUT", "/organization/update"],
    ] as const) {
      const response = await fetch(`${harness!.server.url}/api/auth${path}`, {
        method,
      });
      expect(response.status, `${method} ${path}`).not.toBe(200);
    }
  });

  test("the self-preference writes are refused until P05 wires them", async () => {
    for (const path of [
      "/organization/set-active",
      "/organization/set-active-team",
    ]) {
      const response = await api(path, {
        method: "POST",
        user: "owner",
        body: JSON.stringify({ organizationId: TENANT }),
      });
      expect(response.status, path).toBe(503);
      const body = (await response.json()) as { code?: string };
      expect(body.code, path).toBe(NATIVE_AUTH_SELF_PREFERENCE_NOT_WIRED);
    }
  });

  test("SSO configuration and domain writes are closed until T05 transcribes them", async () => {
    const closed = [
      "/sso/register",
      "/sso/update-provider",
      "/sso/delete-provider",
      "/sso/request-domain-verification",
      "/sso/verify-domain",
      // The provider-less SAML posts the fixed package registers beside the
      // :providerId routes (R1-F5).
      "/sso/saml2/sp/acs",
      "/sso/saml2/sp/slo",
    ];
    for (const path of closed) {
      const response = await api(path, {
        method: "POST",
        user: "admin",
        body: JSON.stringify({
          providerId: "acme",
          issuer: "https://login.acme.test",
          domain: "acme.test",
        }),
      });
      expect(response.status, path).toBe(501);
      const body = (await response.json()) as { code?: string };
      expect(body.code, path).toBe(CLOSED_SSO_WRITE_NOT_TRANSCRIBED);
    }
    // The provider-less SAML GETs stay unknown (only the bare POSTs exist in
    // the fixed package), which is the same fail-closed answer.
    const bareGet = await api("/sso/saml2/sp/acs", { user: "admin" });
    expect(bareGet.status).toBe(404);
  });

  test("SCIM resource reads and provisioning writes are closed until T05 transcribes them", async () => {
    const closedReads = [
      "/scim/v2/Users",
      "/scim/v2/Users/some-id",
      "/scim/v2/Groups",
      "/scim/v2/Groups/some-id",
    ];
    for (const path of closedReads) {
      const response = await api(path, { user: "admin" });
      expect(response.status, path).toBe(501);
      const body = (await response.json()) as { code?: string };
      expect(body.code, path).toBe(CLOSED_SCIM_READ_UNBOUND);
    }
    const closedWrites = [
      ["POST", "/scim/v2/Users"],
      ["PATCH", "/scim/v2/Users/some-id"],
      ["PUT", "/scim/v2/Users/some-id"],
      ["DELETE", "/scim/v2/Users/some-id"],
      ["POST", "/scim/v2/Groups"],
      ["PATCH", "/scim/v2/Groups/some-id"],
      ["PUT", "/scim/v2/Groups/some-id"],
      ["DELETE", "/scim/v2/Groups/some-id"],
    ] as const;
    for (const [method, path] of closedWrites) {
      const response = await fetch(`${harness!.server.url}/api/auth${path}`, {
        method,
        headers: {
          cookie: harness!.admin.cookie,
          "content-type": "application/scim+json",
        },
        body: method === "DELETE" ? undefined : "{}",
      });
      expect(response.status, `${method} ${path}`).toBe(501);
      const body = (await response.json()) as { code?: string };
      expect(body.code, `${method} ${path}`).toBe(
        CLOSED_SCIM_WRITE_NOT_TRANSCRIBED,
      );
    }
    // The protocol discovery documents stay native (§3.2 只读保留): they reach
    // the pinned build and it answers about the protocol, not the directory.
    const discovery = await api("/scim/v2/ServiceProviderConfig", {
      user: "none",
    });
    expect(discovery.status).not.toBe(501);
  });

  test("a directory or identity write without its executor is refused before any DML", async () => {
    const before = await harness!.dmlCount();
    // Unauthenticated first: the gate's session rule, not the executor's.
    const anonymous = await api("/organization/update", {
      method: "POST",
      user: "none",
      body: JSON.stringify({ organizationId: TENANT, name: "No" }),
    });
    expect(anonymous.status).toBe(401);
    // Signed in: the classification reached the translation seam and the seam
    // honestly reported that no executor is assembled.
    const directoryWrite = await api("/organization/update", {
      method: "POST",
      user: "owner",
      body: JSON.stringify({ organizationId: TENANT, name: "No" }),
    });
    expect(directoryWrite.status).toBe(503);
    const directoryBody = (await directoryWrite.json()) as { code?: string };
    expect(directoryBody.code).toBe(DIRECTORY_INGRESS_EXECUTOR_UNWIRED);
    // Identity writes: a plain user never reaches the identity question.
    const nonAdmin = await api("/admin/ban-user", {
      method: "POST",
      user: "member",
      body: JSON.stringify({ userId: harness!.member.userId, reason: "test" }),
    });
    expect(nonAdmin.status).toBe(403);
    // A current administrator reaches it, and the same honest 503 answers.
    const adminWrite = await api("/admin/unban-user", {
      method: "POST",
      user: "admin",
      body: JSON.stringify({ userId: harness!.member.userId, reason: "test" }),
    });
    expect(adminWrite.status).toBe(503);
    const adminBody = (await adminWrite.json()) as { code?: string };
    expect(adminBody.code).toBe(IDENTITY_INGRESS_EXECUTOR_UNWIRED);
    const after = await harness!.dmlCount();
    expect(after).toBe(before);
  });

  test("an Admin read is gated on the current global administrator", async () => {
    const nonAdmin = await api("/admin/list-users", { user: "member" });
    expect(nonAdmin.status).toBe(403);
    const body = (await nonAdmin.json()) as { code?: string };
    expect(body.code).toBe(PLATFORM_READ_ADMIN_REQUIRED);
    // An administrator passes the gate; the pinned build answers (the admin
    // plugin is not mounted in this phase, so the forward ends in its own 404,
    // which is exactly "gated then forwarded").
    const admin = await api("/admin/list-users", { user: "admin" });
    expect(admin.status).toBe(404);
  });
});

/* ------------------------------------------------------------------------- */
/* The read matrix.                                                           */
/* ------------------------------------------------------------------------- */

describe("F-01: no classified write reaches the pinned build's handler", () => {
  const INGRESS_CODES = new Set([
    NATIVE_AUTH_ENDPOINT_CLOSED,
    NATIVE_AUTH_UNKNOWN_ENDPOINT,
    NATIVE_AUTH_SESSION_REQUIRED,
    NATIVE_AUTH_ADMIN_REQUIRED,
    NATIVE_AUTH_TENANT_REQUIRED,
    NATIVE_AUTH_STORAGE_REQUIRED,
    NATIVE_AUTH_TRANSLATION_INCOMPLETE,
    NATIVE_AUTH_SELF_PREFERENCE_NOT_WIRED,
    NATIVE_AUTH_IDEMPOTENCY_KEY_REQUIRED,
    NATIVE_AUTH_MEMBER_ID_MUST_BE_USER_ID,
    CLOSED_SSO_WRITE_NOT_TRANSCRIBED,
    CLOSED_SCIM_WRITE_NOT_TRANSCRIBED,
    CLOSED_SCIM_READ_UNBOUND,
    DIRECTORY_INGRESS_EXECUTOR_UNWIRED,
    IDENTITY_INGRESS_EXECUTOR_UNWIRED,
  ]);

  test("every write row answers with the ingress's own refusal", async () => {
    const before = await harness!.dmlCount();
    const nativeWrites: string[] = [];
    for (const endpoint of NATIVE_AUTH_ENDPOINTS) {
      if (endpoint.method === "GET") continue;
      // R/P rows are READS (has-permission and list-user-sessions are POSTs):
      // their gate may legitimately forward to the pinned build, which is the
      // read contract, not a write bypass. The write classes are the claim.
      if (endpoint.disposition === "R" || endpoint.disposition === "P") {
        continue;
      }
      if (endpoint.disposition === "native") {
        nativeWrites.push(`${endpoint.method} ${endpoint.path}`);
        continue;
      }
      const path = endpoint.path.replace(
        /:(providerId|userId|groupId|schemaId|resourceTypeId)/g,
        "probe-id",
      );
      const response = await fetch(`${harness!.server.url}/api/auth${path}`, {
        method: endpoint.method,
        headers: {
          cookie:
            endpoint.disposition === "I"
              ? harness!.admin.cookie
              : harness!.owner.cookie,
          "content-type": "application/json",
          "idempotency-key": `t0211-f01-${endpoint.method}-${endpoint.nativeOperation}`,
        },
        body:
          endpoint.method === "DELETE"
            ? undefined
            : JSON.stringify({
                organizationId: TENANT,
                userId: harness!.member.userId,
                memberIdOrEmail: harness!.member.userId,
                sessionId: "probe-session",
                reason: "f01",
                email: "probe@example.test",
                role: "member",
                invitationId: "probe-invitation",
                name: "probe",
                teamId: TEAM,
                providerId: "probe",
                issuer: "https://probe.test",
                domain: "probe.test",
              }),
      });
      expect(response.status, `${endpoint.method} ${endpoint.path}`).not.toBe(
        200,
      );
      const body = (await response.json()) as { code?: string };
      expect(
        INGRESS_CODES.has(String(body?.code)),
        `${endpoint.method} ${endpoint.path} answered ${JSON.stringify(body?.code)} (a pinned build error shape would mean the request was forwarded)`,
      ).toBe(true);
    }
    // The only writes still native are the login/callback family §3.2 keeps;
    // R/P rows are enumerated here too so a drift of one of them into a write
    // class (or a new native write) fails this very expectation.
    expect([...new Set(nativeWrites)].sort()).toEqual([
      "POST /sign-in/sso",
      "POST /sso/saml2/logout/:providerId",
      "POST /sso/saml2/sp/acs/:providerId",
      "POST /sso/saml2/sp/slo/:providerId",
    ]);
    const after = await harness!.dmlCount();
    expect(after).toBe(before);
  });
});

describe("the native directory read gate", () => {
  test("native_directory_get_matrix_checks_lifecycle_and_assurance", async () => {
    for (const path of R_GET_PATHS) {
      for (const scenario of READ_SCENARIOS) {
        try {
          if (scenario.name === "suspended member") {
            await harness!.setMemberStatus("suspended");
          } else if (scenario.name === "suspended company") {
            await harness!.setCompanyStatus("suspended");
          } else {
            harness!.setProof(true);
          }
          const response = await api(path, { user: "member" });
          expect([403, 404], `${scenario.name}: ${path}`).toContain(
            response.status,
          );
          const body = (await response.json()) as { code?: string };
          expect(body.code, `${scenario.name}: ${path}`).toBe(scenario.code);
        } finally {
          await restoreFixture();
        }
      }
    }
    // The POST read of the same family: organization/has-permission.
    for (const scenario of READ_SCENARIOS) {
      try {
        if (scenario.name === "suspended member") {
          await harness!.setMemberStatus("suspended");
        } else if (scenario.name === "suspended company") {
          await harness!.setCompanyStatus("suspended");
        } else {
          harness!.setProof(true);
        }
        const response = await api("/organization/has-permission", {
          method: "POST",
          user: "member",
          body: JSON.stringify({ permission: { member: ["read"] } }),
        });
        expect([403, 404], scenario.name).toContain(response.status);
        const body = (await response.json()) as { code?: string };
        expect(body.code, scenario.name).toBe(scenario.code);
      } finally {
        await restoreFixture();
      }
    }
  });

  test("a live member passes the gate and the fixed build answers", async () => {
    const response = await api("/organization/list-members", {
      user: "member",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { members?: unknown[] };
    expect(Array.isArray(body.members)).toBe(true);
    // The gate answered; the pinned build's payload crossed unchanged.
    expect(body.members?.length).toBe(2);
  });

  test("list-invitations keeps the owner/admin permission of the native contract", async () => {
    const asMember = await api("/organization/list-invitations", {
      user: "member",
    });
    expect(asMember.status).toBe(403);
    const body = (await asMember.json()) as { code?: string };
    expect(body.code).toBe(DIRECTORY_READ_ROLE_FORBIDDEN);
    const asOwner = await api("/organization/list-invitations", {
      user: "owner",
    });
    expect(asOwner.status).toBe(200);
  });

  test("list-team-members verifies the team belongs to the named company", async () => {
    const own = await api("/organization/list-team-members?teamId=t0211-team", {
      user: "member",
    });
    expect(own.status).toBe(200);
    const foreign = await api(
      "/organization/list-team-members?teamId=t0211-elsewhere",
      { user: "member" },
    );
    expect(foreign.status).toBe(404);
    const foreignBody = (await foreign.json()) as { code?: string };
    expect(foreignBody.code).toBe(DIRECTORY_READ_TEAM_OUT_OF_COMPANY);
  });

  test("legacy and paused authorities refuse the read but keep the native session surface", async () => {
    try {
      await harness!.setAuthority("M1");
      const legacyRead = await api("/organization/list-members", {
        user: "member",
      });
      expect(legacyRead.status).toBe(404);
      const legacyBody = (await legacyRead.json()) as { code?: string };
      expect(legacyBody.code).toBe(DIRECTORY_READ_AUTHORITY_CLOSED);
      // The legacy branch keeps the native non-directory surface.
      const legacySession = await api("/get-session", { user: "member" });
      expect(legacySession.status).toBe(200);

      await harness!.setAuthority("M2");
      const pausedRead = await api("/organization/list-members", {
        user: "member",
      });
      expect(pausedRead.status).toBe(503);
      const pausedBody = (await pausedRead.json()) as { code?: string };
      expect(pausedBody.code).toBe(DIRECTORY_READ_MIGRATION_PAUSED);
      const pausedSession = await api("/get-session", { user: "member" });
      expect(pausedSession.status).toBe(200);

      await harness!.setAuthority("M4");
      const baRead = await api("/organization/list-members", {
        user: "member",
      });
      expect(baRead.status).toBe(200);
    } finally {
      await harness!.setAuthority("M4");
    }
  });
});

/* ------------------------------------------------------------------------- */
/* The transaction matrix: production ingress + production executor.          */
/* ------------------------------------------------------------------------- */

describe("mounted directory HTTP writes share the production executor transaction", () => {
  test("a translated native write runs the pinned build's own api inside the command transaction", async () => {
    const before = await harness!.dmlCount();
    harness!.txids.length = 0;
    const response = await executorApi("/organization/update", {
      method: "POST",
      user: "owner",
      headers: { "idempotency-key": "t0211-tx-matrix-1" },
      body: JSON.stringify({ organizationId: TENANT, name: "Renamed Matrix" }),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      commandId?: string;
      tenantId?: string;
    };
    expect(result.tenantId).toBe(TENANT);
    // The executor ran exactly one command transaction, and the BA write the
    // pinned build made inside it recorded that same transaction id.
    expect(harness!.txids).toHaveLength(1);
    const outerTxid = harness!.txids[0];
    const events = await harness!.sql`
      SELECT table_name, operation, txid FROM ${harness!.sql(DML_EVENTS_TABLE)}
       WHERE table_name = 'auth_organizations' ORDER BY id`;
    expect(events.length - before).toBe(1);
    expect(events[0].operation).toBe("UPDATE");
    expect(String(events[0].txid)).toBe(outerTxid);
    // The projection took the command's value.
    const [organization] = await harness!.sql`
      SELECT name FROM auth_organizations WHERE id = ${TENANT}`;
    expect(organization?.name).toBe("Renamed Matrix");
  });

  test("every unwired native write is refused with zero DML", async () => {
    const before = await harness!.dmlCount();
    const unwired = [
      [
        "/organization/invite-member",
        { organizationId: TENANT, email: "new@example.test" },
      ],
      [
        "/organization/accept-invitation",
        { organizationId: TENANT, invitationId: "none" },
      ],
      [
        "/organization/reject-invitation",
        { organizationId: TENANT, invitationId: "none" },
      ],
      [
        "/organization/cancel-invitation",
        { organizationId: TENANT, invitationId: "none" },
      ],
      [
        "/organization/remove-member",
        {
          organizationId: TENANT,
          memberIdOrEmail: harness!.member.userId,
          reason: "test",
        },
      ],
      [
        "/organization/update-member-role",
        {
          organizationId: TENANT,
          memberIdOrEmail: harness!.member.userId,
          role: "admin",
        },
      ],
      ["/organization/leave", { organizationId: TENANT }],
      ["/organization/create-team", { organizationId: TENANT, name: "Nope" }],
      [
        "/organization/update-team",
        { organizationId: TENANT, teamId: TEAM, name: "Nope" },
      ],
      [
        "/organization/add-team-member",
        {
          organizationId: TENANT,
          teamId: TEAM,
          userId: harness!.member.userId,
        },
      ],
      [
        "/organization/remove-team-member",
        {
          organizationId: TENANT,
          teamId: TEAM,
          userId: harness!.member.userId,
        },
      ],
    ] as const;
    for (const [path, body] of unwired) {
      const response = await executorApi(path, {
        method: "POST",
        user: "owner",
        headers: { "idempotency-key": `t0211-unwired-${path}` },
        body: JSON.stringify(body),
      });
      expect(response.status, path).not.toBe(200);
      const payload = (await response.json()) as { code?: string };
      expect(payload.code, path).toBe("DIRECTORY_OPERATION_NOT_WIRED");
    }
    /*
     * Identity writes are NOT in this sweep: the production identity
     * executor implements every §2.1 operation, so nothing on the identity
     * side is "unwired" — the unwired-refusal answer itself is pinned on the
     * bare app above (IDENTITY_INGRESS_EXECUTOR_UNWIRED) and the positive
     * path below executes a real one.
     */
    const after = await harness!.dmlCount();
    expect(after).toBe(before);
  });

  test("a translated write requires the caller's idempotency key", async () => {
    const before = await harness!.dmlCount();
    const response = await executorApi("/organization/update", {
      method: "POST",
      user: "owner",
      body: JSON.stringify({ organizationId: TENANT, name: "No key" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe(NATIVE_AUTH_IDEMPOTENCY_KEY_REQUIRED);
    const identity = await executorApi("/admin/revoke-user-sessions", {
      method: "POST",
      user: "admin",
      body: JSON.stringify({ userId: harness!.member.userId, reason: "test" }),
    });
    expect(identity.status).toBe(400);
    expect(((await identity.json()) as { code?: string }).code).toBe(
      NATIVE_AUTH_IDEMPOTENCY_KEY_REQUIRED,
    );
    const after = await harness!.dmlCount();
    expect(after).toBe(before);
  });

  test("an email-shaped member selector is refused rather than used as a userId", async () => {
    const response = await executorApi("/organization/remove-member", {
      method: "POST",
      user: "owner",
      headers: { "idempotency-key": "t0211-email-selector" },
      body: JSON.stringify({
        organizationId: TENANT,
        memberIdOrEmail: `${MEMBER_USER}@example.test`,
        reason: "test",
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe(NATIVE_AUTH_MEMBER_ID_MUST_BE_USER_ID);
  });

  test("update-member-role with role=owner becomes the owner.transfer command", async () => {
    const response = await executorApi("/organization/update-member-role", {
      method: "POST",
      user: "owner",
      headers: { "idempotency-key": "t0211-owner-transfer" },
      body: JSON.stringify({
        organizationId: TENANT,
        memberIdOrEmail: harness!.member.userId,
        role: "owner",
      }),
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { code?: string; error?: string };
    expect(body.code).toBe("DIRECTORY_OPERATION_NOT_WIRED");
    expect(body.error).toContain("owner.transfer");
  });

  test("an anonymous native write never reaches the executor", async () => {
    const before = await harness!.dmlCount();
    const response = await executorApi("/organization/update", {
      method: "POST",
      user: "none",
      body: JSON.stringify({ organizationId: TENANT, name: "Nope" }),
    });
    expect(response.status).toBe(401);
    const after = await harness!.dmlCount();
    expect(after).toBe(before);
  });

  test("an identity write executes through the production executor with a session-less platform actor", async () => {
    // A second live session for the member, created after the harness's own
    // sign-up so revoking it leaves the harness's cookie alone.
    const signedIn = await harness!.auth.api.signInEmail({
      body: { email: `${MEMBER_USER}@example.test`, password: PASSWORD },
      asResponse: true,
    });
    expect(signedIn.status).toBe(200);
    const [row] = await harness!.sql`
      SELECT s.id FROM sessions s
       WHERE s.user_id = ${harness!.member.userId}
         AND s.id <> ${harness!.member.sessionId}
       ORDER BY s.created_at DESC LIMIT 1`;
    const revokedSessionId = String(row?.id ?? "");
    expect(revokedSessionId).not.toBe("");

    const response = await executorApi("/admin/revoke-user-session", {
      method: "POST",
      user: "admin",
      headers: { "idempotency-key": "t0211-identity-revoke-1" },
      body: JSON.stringify({
        userId: harness!.member.userId,
        sessionId: revokedSessionId,
        reason: "t0211 matrix",
      }),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      commandId?: string;
      userId?: string;
      replayed?: boolean;
    };
    expect(result.userId).toBe(harness!.member.userId);
    expect(result.replayed).toBe(false);

    // The session is gone and the identity-domain receipt is committed.
    const [gone] = await harness!.sql`
      SELECT count(*)::int AS count FROM sessions WHERE id = ${revokedSessionId}`;
    expect(gone?.count).toBe(0);
    const [receipt] = await harness!.sql`
      SELECT operation, target_user_id FROM auth_command_receipts
       WHERE command_id = ${result.commandId ?? ""}`;
    expect(receipt?.operation).toBe("identity.session.revoke");
    expect(receipt?.target_user_id).toBe(harness!.member.userId);

    /*
     * The replay re-runs the CURRENT checks (§2.1: a replay never borrows a
     * receipt): the session the receipt named is gone, so the replay refuses
     * with the named 404 rather than reporting the committed result — the
     * exact discipline the narrow identity idempotency domain demands.
     */
    const replay = await executorApi("/admin/revoke-user-session", {
      method: "POST",
      user: "admin",
      headers: { "idempotency-key": "t0211-identity-revoke-1" },
      body: JSON.stringify({
        userId: harness!.member.userId,
        sessionId: revokedSessionId,
        reason: "t0211 matrix",
      }),
    });
    expect(replay.status).toBe(404);
    const replayed = (await replay.json()) as { code?: string };
    expect(replayed.code).toBe("IDENTITY_SESSION_UNKNOWN");
    // And the committed facts stand: the receipt is still there, once.
    const [receiptCount] = await harness!.sql`
      SELECT count(*)::int AS count FROM auth_command_receipts
       WHERE command_id = ${result.commandId ?? ""}`;
    expect(receiptCount?.count).toBe(1);
  });
});
