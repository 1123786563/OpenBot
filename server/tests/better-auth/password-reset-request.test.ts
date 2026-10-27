import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
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
import { createIdentityFinalizer } from "../../src/auth/directory/finalizer";
import { createIdentityExecutor } from "../../src/auth/directory/identity";
import { createDirectoryIngress } from "../../src/auth/directory/ingress";
import { createAuthMailOutbox } from "../../src/auth/directory/outbox";
import { principalRegistry } from "../../src/auth/directory/principal-registry";
import {
  createDirectoryReadGate,
  createPlatformReadGate,
} from "../../src/auth/directory/read-gate";
import { createTransactionBoundBa } from "../../src/auth/directory/transaction-adapter";

/*
 * The T04.05 target module, loaded lazily so a worktree without it still
 * collects (and fails) every case with a message naming the missing target
 * behavior instead of dying at import time as a zero-case collection error —
 * the same discipline the T04.04 suite holds itself to.
 */
type RecoveryModule = typeof import("../../src/auth/password-recovery");
let recoveryPromise: Promise<RecoveryModule> | undefined;
function loadRecovery(): Promise<RecoveryModule> {
  recoveryPromise ??= import("../../src/auth/password-recovery").catch(
    (error: unknown) => {
      throw new Error(
        `server/src/auth/password-recovery.ts is not loadable — ${error instanceof Error ? error.message : String(error)}: createPasswordRecoveryIngress (§5.1's RecoveryIngress over the native request/reset routes) is the T04.05 target behavior, not an environment problem.`,
      );
    },
  );
  return recoveryPromise;
}

import type {
  AuthMailServices,
  AuthMailSmtpSettings,
} from "../../src/auth/mail";
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
  ssoProviders,
  users,
  verifications,
} from "../../src/db/schema/core";

/*
 * T04.05 (#549, original task P08) — the password-reset request and
 * consumption closed loop over the transactional outbox and the identity
 * recovery boundary, on the real 0209–0216 stack of the isolated BA_TEST_*
 * island (interfaces §5.1's two POSTs and the mail-link GET; acceptance F3).
 *
 * The six named behaviors, as facts:
 *
 * - `password_reset_request_and_consume_full_loop`: a request-reset POST
 *   wraps the fixed build's own request route in one command transaction;
 *   the token and its encrypted outbox intent commit together; only the
 *   post-commit worker delivers to the real SMTP receiver; the mail link's
 *   GET validates and redirects to the local /reset-password without
 *   consuming; the reset POST runs the identity recovery boundary (the
 *   native POST is the only token consumer), rewrites the password hash,
 *   revokes every session, advances the identity generation and deletes the
 *   token; the old password stops working, the new one signs in; a replay
 *   of the consumed token is refused and changes nothing.
 * - `request_reset_outbox_failure_rolls_back_token_despite_ba_success`: an
 *   outbox fault the fixed build swallows (runInBackgroundOrAwait) still
 *   rolls the token back — the native success is never the commit answer.
 * - `late_reset_mail_callback_cannot_write_or_send`: the notification the
 *   request carried, re-fired after the transaction settled, writes no
 *   outbox row and sends nothing.
 * - `untrusted_reset_redirect_is_rejected_before_delivery`: a redirectTo
 *   that is not the local /reset-password surface is refused with a named
 *   code before any token or intent exists, and nothing is delivered.
 * - `unknown_email_password_reset_answers_native_shape_and_writes_nothing`:
 *   an unknown address answers the fixed build's exact success shape with
 *   no token, no intent and no mail.
 * - `pure_sso_deployment_refuses_password_recovery`: a deployment without
 *   password accounts refuses every recovery entrance before any write.
 *
 * Evidence level (coordinator ruling, 2026-10-27): the "real mail receiver"
 * is the local Mailpit sink — SMTP 127.0.0.1:1025, REST 127.0.0.1:8025.
 * This is LOCAL-SINK evidence, not a real provider: real-provider delivery
 * acceptance belongs to T08.06. The delivery adapter under test is the
 * production createAuthMail seam configured for standard SMTP.
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

const SINK_SMTP_HOST = "127.0.0.1";
const SINK_SMTP_PORT = 1025;
const SINK_REST_BASE = "http://127.0.0.1:8025";

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

const BA_SECRET = "t0405-password-recovery-fixed-test-secret-not-a-credential";
const PAYLOAD_SECRET = "t0405-outbox-payload-secret-not-a-credential";
const COMMITMENT_KEY = Buffer.from(
  "t0405-recovery-commitment-key-not-a-credential",
);
const DEFAULT_PASSWORD = "correct-horse-battery-staple";
const NEW_PASSWORD = "staple-battery-horse-correct";
const EMAIL_DOMAIN = "@t0405.example.test";
const BASE_URL = "http://127.0.0.1:9";

/** The fixed build's own answer shape, byte-for-byte. */
const NATIVE_RESET_RESPONSE = {
  status: true,
  message:
    "If this email exists in our system, check your email for the reset link",
};

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
  let reference: string | undefined;
  for (const variable of BA_URL_VARIABLES) {
    const raw = process.env[variable]?.trim();
    if (!raw) {
      throw new Error(
        `${variable} is required: the password-reset-request suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
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

async function dropAuditTable(sql: postgres.Sql): Promise<void> {
  await sql`DROP POLICY IF EXISTS "enterprise_audit_event_operator_insert" ON ${sql(`"${AUDIT_TABLE}"`)}`;
  await sql`DROP POLICY IF EXISTS "enterprise_audit_event_operator_read" ON ${sql(`"${AUDIT_TABLE}"`)}`;
  await sql`DROP TABLE IF EXISTS ${sql(`"${AUDIT_TABLE}"`)}`;
}

async function cleanupFixture(
  sql: postgres.Sql,
  options: { ownsAuditTable: boolean },
): Promise<void> {
  await sql.unsafe(
    `DROP TABLE IF EXISTS ${SUITE_TABLES.map((name) => `"${name}"`).join(", ")} CASCADE`,
  );
  await sql`DELETE FROM enterprise_audit_events WHERE actor_id LIKE 't0405-%' OR payload::text LIKE '%t0405-%'`;
  await sql`DELETE FROM enterprise_principals WHERE user_id IN (
    SELECT id FROM users WHERE email LIKE ${`t0405-%${EMAIL_DOMAIN}`})`;
  await sql`DELETE FROM user_roles WHERE user_id IN (
    SELECT id FROM users WHERE email LIKE ${`t0405-%${EMAIL_DOMAIN}`})`;
  await sql`DELETE FROM users WHERE email LIKE ${`t0405-%${EMAIL_DOMAIN}`}`;
  await sql`DELETE FROM accounts WHERE user_id NOT IN (SELECT id FROM users)`;
  await sql`DELETE FROM sessions WHERE user_id NOT IN (SELECT id FROM users)`;
  if (options.ownsAuditTable) await dropAuditTable(sql);
  // Earlier suites' ALTERs (migration-expand and friends) leave columns and
  // constraints the 0209–0216 migrations this suite replays would collide
  // with; the island is shared, so the residue is dropped before replay.
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

/* ---------------------------------------------------------------------- */
/* The real Mailpit sink: what delivery actually reached a receiver.       */
/* ---------------------------------------------------------------------- */

interface SinkMessage {
  ID: string;
  To: unknown[];
  Subject: string;
  Text: string;
  HTML: string;
}

function toIncludes(message: SinkMessage, email: string): boolean {
  return JSON.stringify(message.To).includes(email);
}

async function sinkMessageWithBody(message: SinkMessage): Promise<SinkMessage> {
  const detail = await fetch(`${SINK_REST_BASE}/api/v1/message/${message.ID}`);
  if (!detail.ok) return message;
  return { ...message, ...((await detail.json()) as SinkMessage) };
}

async function sinkMessages(): Promise<SinkMessage[]> {
  const response = await fetch(`${SINK_REST_BASE}/api/v1/messages`);
  if (!response.ok) {
    throw new Error(
      `the local mail sink is not reachable at ${SINK_REST_BASE} (status ${response.status}); the T04.05 receiver is the coordinator-provisioned Mailpit container, and a missing sink is a blocked suite, not a skipped one`,
    );
  }
  const body = (await response.json()) as { messages?: SinkMessage[] };
  return body.messages ?? [];
}

async function sinkClear(): Promise<void> {
  const response = await fetch(`${SINK_REST_BASE}/api/v1/messages`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(`clearing the mail sink failed (${response.status})`);
  }
}

async function resetTokenOfMail(message: SinkMessage): Promise<string> {
  const withBody = await sinkMessageWithBody(message);
  const match = /reset-password\/([^?&"'<\s]+)/.exec(
    `${withBody.Text} ${withBody.HTML}`,
  );
  if (!match) {
    throw new Error(
      `the delivered mail carries no reset-password link (subject "${message.Subject}")`,
    );
  }
  return decodeURIComponent(match[1]);
}

/* ---------------------------------------------------------------------- */
/* The harness.                                                            */
/* ---------------------------------------------------------------------- */

interface HarnessUser {
  userId: string;
  email: string;
  cookie: string;
}

interface Harness {
  /**
   * The named refusal every case rethrows when the harness could not
   * assemble because the T04.05 target module is absent — a baseline
   * worktree fails all six named cases with the missing behavior, not one
   * unnamed collection error.
   */
  readonly assemblyRefusal?: Error;
  sql: postgres.Sql;
  app: Hono;
  outbox: ReturnType<typeof createAuthMailOutbox>;
  authMail: AuthMailServices;
  /** The pure-SSO instance: same seams, password surface closed. */
  pureSsoHandle(request: Request): Promise<Response | null>;
  /** The notification payload the last reset request carried (the late
   * callback case re-fires it through the real converter). */
  lastNotification():
    | { user: { id: string; email: string }; url: string; token: string }
    | undefined;
  drain(): Promise<{
    considered: number;
    delivered: number;
    failed: { id: string; error: string }[];
  }>;
  countIntents(): Promise<number>;
  resetTokenRows(userId: string): Promise<string[]>;
  identityGeneration(userId: string): Promise<number | null>;
  sessionCount(userId: string): Promise<number>;
  signUp(email: string, name: string): Promise<HarnessUser>;
  signInStatus(email: string, password: string): Promise<number>;
  outboxFault(on: boolean): Promise<void>;
  close(): Promise<void>;
}

async function buildHarness(setupUrl: string): Promise<Harness> {
  let assemblyRefusal: Error | undefined;
  try {
    await loadRecovery();
  } catch (error) {
    assemblyRefusal = error instanceof Error ? error : new Error(String(error));
  }
  if (assemblyRefusal) return { assemblyRefusal } as unknown as Harness;

  const sql = postgres(setupUrl, {
    max: 4,
    idle_timeout: 5,
    onnotice: () => {},
  });
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
    ssoProvider: ssoProviders,
  };

  const outbox = createAuthMailOutbox({ payloadSecret: PAYLOAD_SECRET });
  const authMail = await (await import("../../src/auth/mail")).createAuthMail({
    smtp: {
      host: SINK_SMTP_HOST,
      port: SINK_SMTP_PORT,
      secure: false,
      from: "t0405-auth@example.test",
    } satisfies AuthMailSmtpSettings,
    outbox,
  });

  /*
   * The recorder: the last notification the fixed build handed the reset
   * converter, captured without changing the converter's behavior — the
   * late-callback case re-fires exactly this notification after the
   * request's transaction settled.
   */
  let captured:
    | Parameters<AuthMailServices["sendResetPassword"]>[0]
    | undefined;
  const recordedReset = (
    payload: Parameters<AuthMailServices["sendResetPassword"]>[0],
    request?: unknown,
  ) => {
    captured = payload;
    return authMail.sendResetPassword(payload, request);
  };

  let resolvedOptions: unknown;
  const auth = betterAuth({
    secret: BA_SECRET,
    baseURL: BASE_URL,
    trustedOrigins: [BASE_URL],
    /*
     * The T04.05 wiring under test: the reset callback is the outbox
     * converter, the token TTL and the session revocation are the factory's
     * fixed constants (resetPasswordTokenExpiresIn 3600,
     * revokeSessionsOnPasswordReset true) — the exact configuration the
     * factory installs when password accounts and SMTP are configured.
     */
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      sendResetPassword: recordedReset,
      resetPasswordTokenExpiresIn: 3600,
      revokeSessionsOnPasswordReset: true,
    },
    // The §3.1 factory hard preconditions, the way the authority factory
    // must set them; assertBaAuthorityPreconditions refuses anything else.
    session: { storeSessionInDatabase: true },
    verification: { storeInDatabase: true },
    database: (options: unknown) => {
      resolvedOptions = options;
      return drizzleAdapter(db as never, {
        provider: "pg",
        schema: baSchema as never,
        transaction: true,
      })(options as never);
    },
  });
  await auth.$context;

  const client = new SQL(setupUrl, {
    max: 2,
    idleTimeout: 5,
    connectionTimeout: 10_000,
    onnotice: () => {},
  });
  const txDb = drizzle({ client });

  const bound = createTransactionBoundBa({
    createTxAdapter: (tx) =>
      drizzleAdapter(tx as never, {
        provider: "pg",
        schema: baSchema as never,
        transaction: false,
      })(resolvedOptions as never),
  });

  const baContext = await auth.$context;
  const baAccess = {
    createUser: async (input: {
      userId: string;
      email: string;
      name: string;
      image: string | null;
      password: string | null;
    }) => {
      const user = await baContext.internalAdapter.createUser({
        id: input.userId,
        email: input.email.toLowerCase(),
        name: input.name,
        ...(input.image ? { image: input.image } : {}),
      });
      if (!user) throw new Error("T0405_CREATE_USER_FAILED");
      if (input.password !== null) {
        const hashed = await baContext.password.hash(input.password);
        await baContext.internalAdapter.linkAccount({
          providerId: "credential",
          issuer: "local:credential",
          accountId: user.id,
          password: hashed,
          userId: user.id,
        });
      }
    },
    writePassword: async (input: { userId: string; newPassword: string }) => {
      const hashed = await baContext.password.hash(input.newPassword);
      const existing = await baContext.internalAdapter.findCredentialAccount(
        input.userId,
      );
      if (existing) {
        await baContext.internalAdapter.updatePassword(input.userId, hashed);
      } else {
        await baContext.internalAdapter.createAccount({
          userId: input.userId,
          providerId: "credential",
          issuer: "local:credential",
          accountId: input.userId,
          password: hashed,
        });
      }
    },
    // §5.1 step 2: the native reset POST is the token's ONLY consumer, and
    // it runs inside the executor's TransactionBoundBa — the recovery
    // ingress never calls it directly.
    consumeResetToken: async (input: {
      resetToken: string;
      newPassword: string;
    }) => {
      await auth.api.resetPassword({
        body: { token: input.resetToken, newPassword: input.newPassword },
      });
    },
  };

  const identity = createIdentityExecutor({
    database: db,
    bound,
    registry: principalRegistry,
    finalizer: createIdentityFinalizer(),
    ba: baAccess,
    commitmentKey: COMMITMENT_KEY,
    outbox,
  });

  const recoveryModule = await loadRecovery();
  const recovery = recoveryModule.createPasswordRecoveryIngress({
    database: txDb,
    auth: auth as never,
    bound,
    outbox,
    identity,
    passwordEnabled: true,
  });
  const pureSso = recoveryModule.createPasswordRecoveryIngress({
    database: txDb,
    auth: auth as never,
    bound,
    outbox,
    identity,
    passwordEnabled: false,
  });

  const authority = createDirectoryAuthority();
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
    // The T04.05 seam: the directory ingress classifies the recovery
    // endpoints and delegates them to the RecoveryIngress exclusively.
    passwordRecovery: recovery,
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
    const body = (await response.json()) as { user: { id: string } };
    return {
      userId: body.user.id,
      email: email.toLowerCase(),
      cookie: setCookie.split(";")[0],
    };
  };

  const signInStatus = async (email: string, password: string) => {
    const response = await (
      auth.api as unknown as Record<
        string,
        (input: unknown) => Promise<Response>
      >
    ).signInEmail({
      body: { email, password },
      asResponse: true,
    });
    return response.status;
  };

  return {
    sql,
    app,
    outbox,
    authMail,
    pureSsoHandle: (request) => pureSso.handle(request),
    lastNotification: () => captured,
    drain: () =>
      outbox.drainAuthMailOutbox({
        query: (text, params) => sql.unsafe(text, params),
        send: authMail.outboxSender,
      }),
    countIntents: () =>
      sql`SELECT count(*)::int AS n FROM auth_command_outbox`.then((rows) =>
        Number(rows[0].n),
      ),
    resetTokenRows: async (userId: string) => {
      const rows =
        await sql`SELECT identifier FROM verifications WHERE value = ${userId} AND identifier LIKE 'reset-password:%'`;
      return rows.map((row) => row.identifier as string);
    },
    identityGeneration: async (userId: string) => {
      const rows =
        await sql`SELECT identity_generation::int AS generation FROM enterprise_principals WHERE user_id = ${userId} LIMIT 1`;
      return rows[0] ? Number(rows[0].generation) : null;
    },
    sessionCount: async (userId: string) => {
      const rows =
        await sql`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${userId}`;
      return Number(rows[0].n);
    },
    signUp,
    signInStatus,
    outboxFault: async (on: boolean) => {
      if (on) {
        await sql.unsafe(`CREATE OR REPLACE FUNCTION "t0405_outbox_fault"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'injected outbox fault (T04.05 reset fence)' USING ERRCODE = 'P0001';
END
$fn$`);
        await sql.unsafe(`CREATE TRIGGER "t0405_outbox_fault_trigger"
  BEFORE INSERT ON auth_command_outbox
  FOR EACH ROW EXECUTE FUNCTION "t0405_outbox_fault"()`);
      } else {
        await sql.unsafe(
          `DROP TRIGGER IF EXISTS "t0405_outbox_fault_trigger" ON auth_command_outbox`,
        );
        await sql.unsafe(`DROP FUNCTION IF EXISTS "t0405_outbox_fault"()`);
      }
    },
    close: async () => {
      await Promise.allSettled([sql.end({ timeout: 5 }), client.close()]);
    },
  };
}

function postReset(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  };
}

describe("T04.05 password reset request and consumption", () => {
  let harness: Harness;
  let ownsAuditTable = false;

  beforeAll(async () => {
    readBaUrls();
    // The receiver is part of the pinned environment: a sink that cannot
    // be reached makes the suite blocked, never silently green.
    const probe = await fetch(`${SINK_REST_BASE}/api/v1/messages`);
    if (probe.status !== 200) {
      throw new Error(
        `the local mail sink at ${SINK_REST_BASE} answered ${probe.status}; the T04.05 acceptance runs against the coordinator-provisioned Mailpit container (SMTP 127.0.0.1:1025) — a missing sink is blocked, not a fallback`,
      );
    }
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
    await setup`UPDATE auth_authority_states
                   SET phase = 'M4', directory_authority = 'ba', authority_version = 1
                 WHERE id = 1`;
    await setup.end({ timeout: 5 });

    harness = await buildHarness(setupUrl);
  }, 240_000);

  afterAll(async () => {
    if (!harness?.sql) return;
    const setup = postgres(process.env[DATABASE_VARIABLE]!.trim(), {
      max: 1,
      onnotice: () => {},
    });
    await cleanupFixture(setup, { ownsAuditTable: ownsAuditTable });
    await setup.end({ timeout: 5 });
    await harness.close();
  });

  test("password_reset_request_and_consume_full_loop", 60_000, async () => {
    if (harness.assemblyRefusal) throw harness.assemblyRefusal;
    await sinkClear();
    const email = `t0405-loop${EMAIL_DOMAIN}`;
    const user = await harness.signUp(email, "T04.05 Loop");
    expect(await harness.sessionCount(user.userId)).toBe(1);

    // Step 1 (§5.1): the request inside one command transaction.
    const request = await harness.app.request(
      "/api/auth/request-password-reset",
      postReset({ email, redirectTo: "/reset-password" }),
    );
    expect(request.status).toBe(200);
    expect(await request.json()).toEqual(NATIVE_RESET_RESPONSE);
    // Nothing delivered before the drain: the commit alone owns delivery.
    expect(await sinkMessages()).toHaveLength(0);
    const report = await harness.drain();
    expect(report.delivered).toBeGreaterThanOrEqual(1);
    const delivered = await sinkMessages();
    const mine = delivered.filter((message) => toIncludes(message, email));
    expect(mine).toHaveLength(1);
    expect(mine[0].Subject).toBe("Reset your password");
    const token = await resetTokenOfMail(mine[0]);
    expect(token).not.toContain("@");
    // The mail link carries only the local /reset-password callback.
    const withBody = await sinkMessageWithBody(mine[0]);
    expect(`${withBody.Text}${withBody.HTML}`).toContain(
      "callbackURL=%2Freset-password",
    );
    // The token committed beside exactly one encrypted intent.
    expect(await harness.resetTokenRows(user.userId)).toHaveLength(1);
    expect(await harness.countIntents()).toBe(1);

    // Step 2's mail link: the GET validates and redirects to the local
    // reset surface WITHOUT consuming the token.
    const link = await harness.app.request(
      `/api/auth/reset-password/${token}?callbackURL=${encodeURIComponent("/reset-password")}`,
    );
    expect(link.status).toBe(302);
    const location = link.headers.get("location") ?? "";
    expect(location).toContain("/reset-password");
    expect(location).toContain(`token=${token}`);
    expect(await harness.resetTokenRows(user.userId)).toHaveLength(1);

    // Step 2: the identity recovery boundary consumes the token through
    // the native POST, rewrites the hash, revokes sessions and advances
    // the generation — all in one committed transaction.
    const reset = await harness.app.request(
      "/api/auth/reset-password",
      postReset({ token, newPassword: NEW_PASSWORD }),
    );
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ status: true });
    expect(await harness.resetTokenRows(user.userId)).toHaveLength(0);
    expect(await harness.sessionCount(user.userId)).toBe(0);
    expect(
      await harness.identityGeneration(user.userId),
    ).toBeGreaterThanOrEqual(1);
    // The old password stopped working; the new one signs in.
    expect(
      await harness.signInStatus(email, DEFAULT_PASSWORD),
    ).toBeGreaterThanOrEqual(400);
    expect(await harness.signInStatus(email, NEW_PASSWORD)).toBe(200);

    // A replay of the consumed token borrows nothing: refused, and the
    // working password keeps working.
    const replay = await harness.app.request(
      "/api/auth/reset-password",
      postReset({ token, newPassword: "another-new-password-1" }),
    );
    expect(replay.status).toBe(404);
    const replayBody = (await replay.json()) as { code?: string };
    expect(replayBody.code).toBe("IDENTITY_RECOVERY_TOKEN_UNKNOWN");
    expect(await harness.signInStatus(email, NEW_PASSWORD)).toBe(200);
  });

  test(
    "request_reset_outbox_failure_rolls_back_token_despite_ba_success",
    60_000,
    async () => {
      if (harness.assemblyRefusal) throw harness.assemblyRefusal;
      await sinkClear();
      const email = `t0405-fault${EMAIL_DOMAIN}`;
      const user = await harness.signUp(email, "T04.05 Fault");
      const intentsBefore = await harness.countIntents();

      // The outbox insert faults; the fixed build swallows the callback
      // error and still answers success — the commit fence must not.
      await harness.outboxFault(true);
      try {
        const blocked = await harness.app.request(
          "/api/auth/request-password-reset",
          postReset({ email, redirectTo: "/reset-password" }),
        );
        expect(blocked.status).toBe(500);
        const body = (await blocked.json()) as { error?: string };
        expect(body.error).toContain(
          "injected outbox fault (T04.05 reset fence)",
        );
        // The named assertion: the token never commits alone.
        expect(await harness.resetTokenRows(user.userId)).toHaveLength(0);
        expect(await harness.countIntents()).toBe(intentsBefore);
        expect(await sinkMessages()).toHaveLength(0);
      } finally {
        await harness.outboxFault(false);
      }

      // With the fault gone, the same request commits token + intent.
      const ok = await harness.app.request(
        "/api/auth/request-password-reset",
        postReset({ email, redirectTo: "/reset-password" }),
      );
      expect(ok.status).toBe(200);
      expect(await harness.resetTokenRows(user.userId)).toHaveLength(1);
      await harness.drain(); // its own intent leaves with it
    },
  );

  test("late_reset_mail_callback_cannot_write_or_send", 60_000, async () => {
    if (harness.assemblyRefusal) throw harness.assemblyRefusal;
    await sinkClear();
    const email = `t0405-late${EMAIL_DOMAIN}`;
    await harness.signUp(email, "T04.05 Late");
    const request = await harness.app.request(
      "/api/auth/request-password-reset",
      postReset({ email, redirectTo: "/reset-password" }),
    );
    expect(request.status).toBe(200);
    const intentsAfterCommit = await harness.countIntents();
    await harness.drain();
    const mine = (await sinkMessages()).filter((message) =>
      toIncludes(message, email),
    );
    expect(mine).toHaveLength(1);

    // The notification the request carried, re-fired after the
    // transaction settled: the converter refuses before any write.
    const notification = harness.lastNotification();
    expect(notification?.token).toBeTruthy();
    let lateWrites = 0;
    try {
      await harness.authMail.sendResetPassword(notification!);
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).toMatch(
        /outside a live command transaction|already settled/,
      );
      lateWrites = (await harness.countIntents()) - intentsAfterCommit;
    }
    expect(lateWrites).toBe(0);
    // Nothing new was delivered either: this recipient still holds
    // exactly the one message the committed intent earned.
    const stillMine = (await sinkMessages()).filter((message) =>
      toIncludes(message, email),
    );
    expect(stillMine).toHaveLength(1);
  });

  test(
    "untrusted_reset_redirect_is_rejected_before_delivery",
    60_000,
    async () => {
      if (harness.assemblyRefusal) throw harness.assemblyRefusal;
      await sinkClear();
      const email = `t0405-redirect${EMAIL_DOMAIN}`;
      const user = await harness.signUp(email, "T04.05 Redirect");
      const intentsBefore = await harness.countIntents();
      const untrusted = [
        "https://evil.example/reset-password",
        "//evil.example/reset-password",
        "/account",
      ];
      for (const redirectTo of untrusted) {
        const refused = await harness.app.request(
          "/api/auth/request-password-reset",
          postReset({ email, redirectTo }),
        );
        expect(refused.status).toBe(400);
        const body = (await refused.json()) as { code?: string };
        expect(body.code).toBe("PASSWORD_RECOVERY_REDIRECT_UNTRUSTED");
      }
      // The named assertion: nothing was tokenized, registered or sent.
      expect(await harness.resetTokenRows(user.userId)).toHaveLength(0);
      expect(await harness.countIntents()).toBe(intentsBefore);
      const sentMail = await sinkMessages();
      expect(sentMail).toHaveLength(0);
    },
  );

  test(
    "unknown_email_password_reset_answers_native_shape_and_writes_nothing",
    60_000,
    async () => {
      if (harness.assemblyRefusal) throw harness.assemblyRefusal;
      await sinkClear();
      const intentsBefore = await harness.countIntents();
      const tokensBefore =
        await harness.sql`SELECT count(*)::int AS n FROM verifications WHERE identifier LIKE 'reset-password:%'`;
      const unknown = await harness.app.request(
        "/api/auth/request-password-reset",
        postReset({
          email: `nobody-t0405${EMAIL_DOMAIN}`,
          redirectTo: "/reset-password",
        }),
      );
      expect(unknown.status).toBe(200);
      expect(await unknown.json()).toEqual(NATIVE_RESET_RESPONSE);
      // No command, no token, no intent, no mail — the same success shape
      // the fixed build answers, with nothing behind it.
      const tokens =
        await harness.sql`SELECT count(*)::int AS n FROM verifications WHERE identifier LIKE 'reset-password:%'`;
      expect(Number(tokens[0].n)).toBe(Number(tokensBefore[0].n));
      expect(await harness.countIntents()).toBe(intentsBefore);
      expect(await sinkMessages()).toHaveLength(0);
    },
  );

  test("pure_sso_deployment_refuses_password_recovery", 60_000, async () => {
    if (harness.assemblyRefusal) throw harness.assemblyRefusal;
    await sinkClear();
    const email = `t0405-sso${EMAIL_DOMAIN}`;
    const user = await harness.signUp(email, "T04.05 SSO");
    const intentsBefore = await harness.countIntents();

    const request = await harness.pureSsoHandle(
      new Request(`${BASE_URL}/api/auth/request-password-reset`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, redirectTo: "/reset-password" }),
      }),
    );
    expect(request?.status).toBe(503);
    const requestBody = (await request!.json()) as { code?: string };
    expect(requestBody.code).toBe("PASSWORD_RECOVERY_CLOSED_FOR_SSO");

    const reset = await harness.pureSsoHandle(
      new Request(`${BASE_URL}/api/auth/reset-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "any-token", newPassword: NEW_PASSWORD }),
      }),
    );
    expect(reset?.status).toBe(503);

    expect(await harness.resetTokenRows(user.userId)).toHaveLength(0);
    expect(await harness.countIntents()).toBe(intentsBefore);
    expect(await sinkMessages()).toHaveLength(0);
  });
});
