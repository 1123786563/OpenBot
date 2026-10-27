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
import {
  createClosedCompanyAssurance,
  createCompanyAssurance,
} from "../../src/auth/company-assurance";
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
 * behavior instead of dying at import time as a zero-case collection error.
 */
type RecoveryModule = typeof import("../../src/auth/password-recovery");
let recoveryPromise: Promise<RecoveryModule> | undefined;
function loadRecovery(): Promise<RecoveryModule> {
  recoveryPromise ??= import("../../src/auth/password-recovery").catch(
    (error: unknown) => {
      throw new Error(
        `server/src/auth/password-recovery.ts is not loadable — ${error instanceof Error ? error.message : String(error)}: the RecoveryIngress whose POST /reset-password translation drives the T04.06 unique-consumption cases is the target behavior, not an environment problem.`,
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
 * T04.06 (#550, original task P08) — the reset POST's unique consumption and
 * the security-generation finalization, on the real 0209–0216/0218–0220 stack
 * of the isolated BA_TEST_* island (interfaces §5.1 step 2; acceptance F3).
 *
 * The three named behaviors, as facts:
 *
 * - `native_reset_post_consumes_once_and_failure_leaves_token_retryable`:
 *   a fault thrown AFTER the native consume and the finalizer's writes (the
 *   deepest point of the single transaction) rolls everything back — token,
 *   hash, generation, sessions and proofs are byte-identical to before — and
 *   the same token retries to success once the fault is gone. A replay of the
 *   consumed token afterwards is refused without borrowing the committed
 *   receipt.
 * - `concurrent_reset_consumes_once_without_receipt_bypass`: two concurrent
 *   POSTs on the same token (and therefore the same idempotency key) end in
 *   exactly one 200; the loser is refused by the located token's absence
 *   BEFORE any receipt could answer for it — expect(successCount).toBe(1).
 * - `password_reset_invalidates_old_proof_and_long_lived_authority`: the
 *   finalizer's same-transaction revocation leaves no session and no active
 *   company proof behind, and a long-lived authority that survives the reset
 *   carrying the pre-reset identity generation is refused by the live
 *   generation comparison the assurance gate performs —
 *   expect(oldAuthorityAllowed).toBe(false).
 * - `expired_reset_token_is_refused_and_left_unconsumed`: an expired token is
 *   refused with the named expiry refusal inside the lock, and the refusal
 *   consumes nothing.
 *
 * Evidence level: the reset POST path needs no mail delivery — the token is
 * minted through the real request POST whose converter registers the
 * transactional intent (T04.05 proved delivery against the local Mailpit
 * sink; real-provider delivery stays T08.06's). This suite wires the same
 * production createAuthMail converter and never drains.
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
  // The assurance read gate's own chain half (T05.02/T05.04): the stored
  // policy row and its controlled read are what makes the third named case's
  // live generation comparison answer, not a stub.
  "0218_better_auth_company_auth_challenge",
  "0219_better_auth_company_auth_complete",
  "0220_better_auth_company_auth_policy_read",
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
  "auth_company_auth_policies",
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

const BA_SECRET = "t0406-password-recovery-fixed-test-secret-not-a-credential";
const PAYLOAD_SECRET = "t0406-outbox-payload-secret-not-a-credential";
const COMMITMENT_KEY = Buffer.from(
  "t0406-recovery-commitment-key-not-a-credential",
);
const ASSURANCE_KEY = "t0406-assurance-encryption-key-not-a-credential";
const DEFAULT_PASSWORD = "correct-horse-battery-staple";
const NEW_PASSWORD = "staple-battery-horse-correct";
const EMAIL_DOMAIN = "@t0406.example.test";
const BASE_URL = "http://127.0.0.1:9";
const TENANT = "t0406-tenant";
const SINK_SMTP_HOST = "127.0.0.1";
const SINK_SMTP_PORT = 1025;

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
        `${variable} is required: the password-recovery suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
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
      `${tag}.sql does not exist: the BA directory model this suite pins is the integrated target behavior, not an environment problem.`,
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
  // The 0218-0220 half of the chain replays: its functions and the 0220
  // data-role grant are restored to the pre-0218 shape, exactly the way the
  // assurance suite (T05.04) leaves the island, so suites that expect no
  // completion half see none.
  await sql
    .unsafe(
      `REVOKE EXECUTE ON FUNCTION public.auth_read_company_auth_policy(text) FROM ob_ent_data`,
    )
    .catch(() => {});
  for (const signature of [
    "auth_read_company_auth_policy(text)",
    "auth_consume_company_auth_challenge(text)",
    "auth_record_company_session_assurance(text,text,text,text,text,timestamp with time zone,text)",
    "auth_issue_company_auth_challenge(text,text,text,text,text,text,bigint,text,text,text,timestamptz)",
  ]) {
    await sql.unsafe(`DROP FUNCTION IF EXISTS public.${signature} CASCADE`);
  }
  await sql.unsafe(
    `DROP TABLE IF EXISTS ${SUITE_TABLES.map((name) => `"${name}"`).join(", ")} CASCADE`,
  );
  // The audit table is island-shared: a suite that owned it dropped it
  // after its own run, so the residue DELETE only runs when it is there.
  const [auditTable] =
    await sql`SELECT to_regclass('public.enterprise_audit_events') AS reg`;
  if (auditTable?.reg) {
    await sql`DELETE FROM enterprise_audit_events WHERE actor_id LIKE 't0406-%' OR payload::text LIKE '%t0406-%'`;
  }
  await sql`DELETE FROM enterprise_tenants WHERE id LIKE 't0406-%'`;
  await sql`DELETE FROM enterprise_principals WHERE user_id IN (
    SELECT id FROM users WHERE email LIKE ${`t0406-%${EMAIL_DOMAIN}`})`;
  await sql`DELETE FROM user_roles WHERE user_id IN (
    SELECT id FROM users WHERE email LIKE ${`t0406-%${EMAIL_DOMAIN}`})`;
  // Only this suite's own tokens: the verifications rows its users' request
  // POSTs created (the users go below, but the rows carry no FK).
  await sql`DELETE FROM verifications WHERE identifier LIKE 'reset-password:%' AND value IN (
    SELECT id FROM users WHERE email LIKE ${`t0406-%${EMAIL_DOMAIN}`})`;
  await sql`DELETE FROM users WHERE email LIKE ${`t0406-%${EMAIL_DOMAIN}`}`;
  await sql`DELETE FROM accounts WHERE user_id NOT IN (SELECT id FROM users)`;
  await sql`DELETE FROM sessions WHERE user_id NOT IN (SELECT id FROM users)`;
  if (options.ownsAuditTable) await dropAuditTable(sql);
  // Earlier suites' ALTERs (migration-expand and friends) leave columns and
  // constraints the migrations this suite replays would collide with; the
  // island is shared, so the residue is dropped before replay.
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
/* The harness.                                                            */
/* ---------------------------------------------------------------------- */

interface HarnessUser {
  userId: string;
  email: string;
  cookie: string;
}

/** The observable facts every failure arm must leave untouched. */
interface ResetState {
  status: string;
  generation: number;
  tokenCount: number;
  hash: string | null;
  sessions: number;
  proofs: number;
  recoveryReceipts: number;
}

interface Harness {
  /**
   * The named refusal every case rethrows when the harness could not
   * assemble because the target module is absent.
   */
  readonly assemblyRefusal?: Error;
  sql: postgres.Sql;
  app: Hono;
  /** Turns the post-finalizer fault on and off (one shot at a time). */
  setPostFinalizeFault(on: boolean): void;
  /** The last notification the request converter carried (its token). */
  lastNotification():
    | { user: { id: string; email: string }; url: string; token: string }
    | undefined;
  stateOf(userId: string): Promise<ResetState>;
  signUp(email: string, name: string): Promise<HarnessUser>;
  signInStatus(email: string, password: string): Promise<number>;
  /** Mints one real reset token through the request POST. */
  mintResetToken(email: string): Promise<string>;
  principalIdOf(userId: string): Promise<string>;
  activeProofCount(userId: string): Promise<number>;
  requireAs(
    actor: { userId: string; sessionId: string },
    tenantId: string,
  ): Promise<{ identityGeneration: number } | null>;
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
      from: "t0406-auth@example.test",
    } satisfies AuthMailSmtpSettings,
    outbox,
  });

  /*
   * The recorder: the last notification the fixed build handed the reset
   * converter — this suite never drains, so the captured token is the only
   * thing the mail side contributes to the reset cases.
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
     * The §5.1 factory wiring: the reset callback is the outbox converter,
     * the token TTL and the session revocation are the factory's fixed
     * constants (resetPasswordTokenExpiresIn 3600,
     * revokeSessionsOnPasswordReset true) — the exact configuration
     * server/src/auth/index.ts installs when password accounts and SMTP are
     * configured.
     */
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      requireEmailVerification: false,
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
      if (!user) throw new Error("T0406_CREATE_USER_FAILED");
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

  /*
   * The fault point the first named case needs: AFTER the finalizer's own
   * writes (hash check, generation bump, session/proof revocation, audit)
   * and before the commit. The whole single transaction refuses, so nothing
   * it wrote survives — the deepest honest failure the boundary can meet.
   */
  let postFinalizeFault = false;
  const realFinalizer = createIdentityFinalizer();
  const identity = createIdentityExecutor({
    database: db,
    bound,
    registry: principalRegistry,
    finalizer: {
      finalize: async (tx, commandId, command) => {
        const result = await realFinalizer.finalize(tx, commandId, command);
        if (postFinalizeFault) {
          postFinalizeFault = false;
          throw new Error(
            "T0406_POST_FINALIZE_FAULT: the finalization wrote everything and the transaction is still refused",
          );
        }
        return result;
      },
    },
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

  /*
   * The live company assurance gate (T05.04's factory against the real
   * writer connection and authority): its require() performs the live
   * policy/proof/generation comparison the third named case answers through.
   * Only the issuance-side views are stubs; require() reads the stored
   * policy and proof rows through the controlled functions.
   */
  const assurance = createCompanyAssurance({
    policy: {
      async requiresProof(tenantId: string) {
        return tenantId === TENANT;
      },
    },
    challengePolicy: {
      async challengePolicy(tenantId: string) {
        return tenantId === TENANT
          ? {
              providerId: "t0406-idp",
              protocol: "oidc",
              policyRevision: 1,
            }
          : null;
      },
    },
    redirect: {
      async buildRedirect(request) {
        const url = new URL("https://idp.t0406.example.test/authorize");
        url.searchParams.set("state", request.state);
        return url.toString();
      },
    },
    database: db,
    authority: createDirectoryAuthority(),
    encryptionKey: ASSURANCE_KEY,
  });

  const ingress = createDirectoryIngress({
    database: db,
    auth: auth as never,
    readGate: createDirectoryReadGate({
      authority: createDirectoryAuthority(),
      assurance: createClosedCompanyAssurance({
        policy: { requiresProof: async () => false },
      }),
    }),
    platformReadGate: createPlatformReadGate(),
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

  const principalIdOf = async (userId: string): Promise<string> => {
    // The executor's own registry call, on the real transaction database: a
    // principal exists (generation 1) before any state is snapshotted.
    await db.transaction(async (tx) => {
      await principalRegistry.ensure(tx as never, userId);
    });
    const rows =
      await sql`SELECT id FROM enterprise_principals WHERE user_id = ${userId} LIMIT 1`;
    const principalId = String(rows[0]?.id ?? "");
    if (!principalId) throw new Error(`no principal for ${userId}`);
    return principalId;
  };

  return {
    sql,
    app,
    setPostFinalizeFault: (on: boolean) => {
      postFinalizeFault = on;
    },
    lastNotification: () => captured,
    principalIdOf,
    activeProofCount: async (userId: string) => {
      const rows =
        await sql`SELECT count(*)::int AS n FROM auth_company_session_assurances WHERE user_id = ${userId} AND status = 'active'`;
      return Number(rows[0].n);
    },
    stateOf: async (userId: string): Promise<ResetState> => {
      const [principal] = await sql`
        SELECT status, identity_generation::int AS generation
          FROM enterprise_principals WHERE user_id = ${userId} LIMIT 1`;
      const [account] = await sql`
        SELECT password FROM accounts
         WHERE user_id = ${userId} AND provider_id = 'credential' LIMIT 1`;
      const [tokens] = await sql`
        SELECT count(*)::int AS n FROM verifications
         WHERE value = ${userId} AND identifier LIKE 'reset-password:%'`;
      const [sessionRows] = await sql`
        SELECT count(*)::int AS n FROM sessions WHERE user_id = ${userId}`;
      const [proofRows] = await sql`
        SELECT count(*)::int AS n FROM auth_company_session_assurances
         WHERE user_id = ${userId} AND status = 'active'`;
      const [receiptRows] = await sql`
        SELECT count(*)::int AS n FROM auth_command_receipts
         WHERE actor_kind = 'recovery'`;
      return {
        status: String(principal?.status ?? "missing"),
        generation: Number(principal?.generation ?? -1),
        tokenCount: Number(tokens.n),
        hash: account?.password ?? null,
        sessions: Number(sessionRows.n),
        proofs: Number(proofRows.n),
        recoveryReceipts: Number(receiptRows.n),
      };
    },
    signUp,
    signInStatus,
    mintResetToken: async (email: string): Promise<string> => {
      captured = undefined;
      const response = await app.request(
        "/api/auth/request-password-reset",
        postReset({ email }),
      );
      const body = (await response.json()) as Record<string, unknown>;
      if (response.status !== 200 || !body.status) {
        throw new Error(
          `the request POST for ${email} answered ${response.status}`,
        );
      }
      const token = captured?.token;
      if (!token) {
        throw new Error(
          "the request POST answered success but converted no notification — no token to reset with",
        );
      }
      return token;
    },
    requireAs: async (actor: { userId: string; sessionId: string }, tenantId) =>
      db.transaction((tx) =>
        assurance.require(
          tx as never,
          {
            userId: actor.userId,
            principalId: null,
            sessionId: actor.sessionId,
            kind: "session",
            bindingId: null,
            provisioning: null,
          },
          tenantId,
        ),
      ),
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

async function responseOf(
  response: Response,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

/**
 * Seeds one company's proof facts exactly the way the stored model shapes
 * them: the stored policy row (the demand), the company clock (the live
 * company generation), a challenge row and one active proof bound to a live
 * session at the given identity generation. Direct rows, the same seeding
 * shape the identity-command suite uses; the real challenge/complete flow
 * that writes these tables is T05.02/T05.04's own acceptance.
 */
async function seedProofFacts(
  sql: postgres.Sql,
  facts: {
    userId: string;
    principalId: string;
    sessionId: string;
    proofId: string;
    identityGeneration: number;
  },
): Promise<void> {
  await sql`
    INSERT INTO enterprise_tenants (id, name) VALUES (${TENANT}, 'T04.06 proof tenant')
    ON CONFLICT (id) DO NOTHING`;
  await sql`
    INSERT INTO auth_company_auth_policies
      (tenant_id, provider_id, protocol, policy_revision, max_auth_age_seconds)
    VALUES (${TENANT}, 't0406-idp', 'oidc', 1, 3600)
    ON CONFLICT (tenant_id) DO NOTHING`;
  await sql`
    INSERT INTO auth_eligibility_clocks
      (tenant_id, principal_id, kind, scope_id, epoch, generation, tombstone, last_command_id)
    VALUES (${TENANT}, ${facts.principalId}, 'company', ${TENANT}, 1, 1, false, 't0406-seed')
    ON CONFLICT (tenant_id, principal_id, kind, scope_id) DO NOTHING`;
  await sql`
    INSERT INTO auth_company_auth_challenges
      (challenge_id, user_id, session_id, tenant_id, provider_id, protocol,
       policy_revision, return_path, state_digest, secret_envelope, expires_at, created_at)
    VALUES (${`${facts.proofId}-challenge`}, ${facts.userId}, ${facts.sessionId}, ${TENANT},
            't0406-idp', 'oidc', 1, '/t0406', ${`digest-${facts.proofId}`},
            'sealed', now() + interval '10 minutes', now())`;
  await sql`
    INSERT INTO auth_company_session_assurances
      (assurance_id, user_id, principal_id, session_id, tenant_id, challenge_id,
       provider_id, authentication_method, issuer, subject, authenticated_at,
       strength, expires_at, policy_revision, identity_generation,
       company_generation, status, created_at)
    VALUES (${facts.proofId}, ${facts.userId}, ${facts.principalId}, ${facts.sessionId},
            ${TENANT}, ${`${facts.proofId}-challenge`}, 't0406-idp', 'oidc',
            'https://t0406-idp.example.test', ${`subject-${facts.userId}`},
            now() - interval '2 minutes', 'sufficient',
            now() + interval '1 day', 1, ${facts.identityGeneration},
            1, 'active', now())`;
}

describe("T04.06 reset consumption and security generation", () => {
  let harness: Harness;
  let ownsAuditTable = false;

  beforeAll(async () => {
    readBaUrls();
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

  test(
    "native_reset_post_consumes_once_and_failure_leaves_token_retryable",
    60_000,
    async () => {
      if (harness.assemblyRefusal) throw harness.assemblyRefusal;
      const email = `t0406-fault${EMAIL_DOMAIN}`;
      const user = await harness.signUp(email, "T04.06 Fault");
      await harness.principalIdOf(user.userId);
      const token = await harness.mintResetToken(email);
      const before = await harness.stateOf(user.userId);
      expect(before.status).toBe("active");
      expect(before.generation).toBe(1);
      expect(before.tokenCount).toBe(1);
      expect(before.hash).toBeTruthy();
      expect(before.sessions).toBe(1);

      // The deepest failure: the native consume, the hash write, the
      // generation bump, the session/proof revocation and the audit all
      // happened — and the transaction still refuses.
      harness.setPostFinalizeFault(true);
      const failed = await responseOf(
        await harness.app.request(
          "/api/auth/reset-password",
          postReset({ token, newPassword: NEW_PASSWORD }),
        ),
      );
      expect(failed.status).toBe(500);
      expect(failed.body.code).toBe("PASSWORD_RECOVERY_FAILED");
      expect(String(failed.body.error)).toContain("T0406_POST_FINALIZE_FAULT");

      // The named assertion: nothing the failed attempt wrote survived.
      const after = await harness.stateOf(user.userId);
      expect(after).toEqual(before);

      // The token retries to success once the fault is gone.
      const retried = await responseOf(
        await harness.app.request(
          "/api/auth/reset-password",
          postReset({ token, newPassword: NEW_PASSWORD }),
        ),
      );
      expect(retried.status).toBe(200);
      expect(retried.body).toEqual({ status: true });
      const consumed = await harness.stateOf(user.userId);
      expect(consumed.tokenCount).toBe(0);
      expect(consumed.hash).not.toBe(before.hash);
      expect(consumed.generation).toBe(before.generation + 1);
      expect(consumed.sessions).toBe(0);
      expect(consumed.recoveryReceipts).toBe(before.recoveryReceipts + 1);
      // The consumed token never replays into a second success — and borrows
      // no receipt: the replay's refusal changed no fact. (Before the sign-in
      // below, which is itself a session write.)
      const replay = await responseOf(
        await harness.app.request(
          "/api/auth/reset-password",
          postReset({ token, newPassword: "another-new-password-1" }),
        ),
      );
      expect(replay.status).toBe(404);
      expect(replay.body.code).toBe("IDENTITY_RECOVERY_TOKEN_UNKNOWN");
      expect(await harness.stateOf(user.userId)).toEqual(consumed);
      expect(await harness.signInStatus(email, NEW_PASSWORD)).toBe(200);
    },
  );

  test(
    "concurrent_reset_consumes_once_without_receipt_bypass",
    60_000,
    async () => {
      if (harness.assemblyRefusal) throw harness.assemblyRefusal;
      const email = `t0406-race${EMAIL_DOMAIN}`;
      const user = await harness.signUp(email, "T04.06 Race");
      await harness.principalIdOf(user.userId);
      const token = await harness.mintResetToken(email);
      const before = await harness.stateOf(user.userId);

      // Two simultaneous POSTs on the same token and the same new password
      // (the concurrent-retry shape): one idempotency key, two transactions
      // racing for one verification row.
      const [first, second] = await Promise.all([
        harness.app.request(
          "/api/auth/reset-password",
          postReset({ token, newPassword: NEW_PASSWORD }),
        ),
        harness.app.request(
          "/api/auth/reset-password",
          postReset({ token, newPassword: NEW_PASSWORD }),
        ),
      ]);
      const firstAnswer = await responseOf(first);
      const secondAnswer = await responseOf(second);
      const answers = [firstAnswer, secondAnswer].sort(
        (left, right) => left.status - right.status,
      );

      const successCount = answers.filter(
        (answer) => answer.status === 200,
      ).length;
      expect(successCount).toBe(1);
      // The loser's refusal is the located token's absence — named, and read
      // BEFORE any receipt could answer for the shared idempotency key.
      // (Sorted ascending: the 200 is the winner, the 404 the loser.)
      expect(answers[0].status).toBe(200);
      expect(answers[1].status).toBe(404);
      expect(answers[1].body.code).toBe("IDENTITY_RECOVERY_TOKEN_UNKNOWN");

      // One consumption, one generation advance, one recovery receipt.
      const after = await harness.stateOf(user.userId);
      expect(after.tokenCount).toBe(0);
      expect(after.generation).toBe(before.generation + 1);
      expect(after.sessions).toBe(0);
      expect(after.recoveryReceipts).toBe(before.recoveryReceipts + 1);
      // The committed password works, and the pre-reset one does not.
      expect(await harness.signInStatus(email, NEW_PASSWORD)).toBe(200);
      expect(
        await harness.signInStatus(email, DEFAULT_PASSWORD),
      ).toBeGreaterThanOrEqual(400);
    },
  );

  test(
    "password_reset_invalidates_old_proof_and_long_lived_authority",
    60_000,
    async () => {
      if (harness.assemblyRefusal) throw harness.assemblyRefusal;
      const sql = harness.sql;
      const email = `t0406-proof${EMAIL_DOMAIN}`;
      const user = await harness.signUp(email, "T04.06 Proof");
      const principalId = await harness.principalIdOf(user.userId);

      // A live session holding an active company proof at generation 1.
      const OLD_SESSION = "t0406-session-old";
      await sql`INSERT INTO sessions (id, user_id, token, expires_at) VALUES
      (${OLD_SESSION}, ${user.userId}, ${`token-${OLD_SESSION}`}, now() + interval '1 day')`;
      await seedProofFacts(sql, {
        userId: user.userId,
        principalId,
        sessionId: OLD_SESSION,
        proofId: "t0406-proof-old",
        identityGeneration: 1,
      });

      // The proof answers before the reset: the gate's live comparison passes
      // (a mis-shaped seed would fail here, not at the refusal below).
      const usable = await harness.requireAs(
        { userId: user.userId, sessionId: OLD_SESSION },
        TENANT,
      );
      expect(usable?.identityGeneration).toBe(1);

      const token = await harness.mintResetToken(email);
      const reset = await responseOf(
        await harness.app.request(
          "/api/auth/reset-password",
          postReset({ token, newPassword: NEW_PASSWORD }),
        ),
      );
      expect(reset.status).toBe(200);

      // The finalizer's revocation, verified after the commit: no session, no
      // active proof (the cascade took the session-bound proof with it, and
      // the in-transaction verifyNoActiveProofs refused anything less), and
      // the generation advanced.
      const state = await harness.stateOf(user.userId);
      expect(state.sessions).toBe(0);
      expect(state.proofs).toBe(0);
      expect(state.generation).toBe(2);

      // The long-lived authority arm: an authority that survived the reset
      // carrying the pre-reset identity generation — a fresh session holding
      // the stored proof the reset could not revoke (only its own sessions'
      // proofs cascaded). The live generation comparison is what kills it.
      const NEW_SESSION = "t0406-session-survivor";
      await sql`INSERT INTO sessions (id, user_id, token, expires_at) VALUES
      (${NEW_SESSION}, ${user.userId}, ${`token-${NEW_SESSION}`}, now() + interval '1 day')`;
      await seedProofFacts(sql, {
        userId: user.userId,
        principalId,
        sessionId: NEW_SESSION,
        proofId: "t0406-proof-stale",
        identityGeneration: 1,
      });
      let oldAuthorityAllowed = true;
      let refusalMessage = "";
      try {
        await harness.requireAs(
          { userId: user.userId, sessionId: NEW_SESSION },
          TENANT,
        );
      } catch (error) {
        oldAuthorityAllowed = false;
        refusalMessage = error instanceof Error ? error.message : String(error);
      }
      expect(oldAuthorityAllowed).toBe(false);
      expect(refusalMessage).toContain(
        "the identity generation changed since the proof was issued (1 → 2)",
      );

      // The control: the SAME row at the live generation answers — the
      // generation comparison alone decided the refusal above.
      await sql`UPDATE auth_company_session_assurances
                SET identity_generation = 2
              WHERE assurance_id = 't0406-proof-stale'`;
      const control = await harness.requireAs(
        { userId: user.userId, sessionId: NEW_SESSION },
        TENANT,
      );
      expect(control?.identityGeneration).toBe(2);
    },
  );

  test(
    "expired_reset_token_is_refused_and_left_unconsumed",
    60_000,
    async () => {
      if (harness.assemblyRefusal) throw harness.assemblyRefusal;
      const sql = harness.sql;
      const email = `t0406-expired${EMAIL_DOMAIN}`;
      const user = await harness.signUp(email, "T04.06 Expired");
      await harness.principalIdOf(user.userId);
      const token = await harness.mintResetToken(email);
      const before = await harness.stateOf(user.userId);

      await sql`UPDATE verifications SET expires_at = now() - interval '1 hour'
              WHERE identifier = ${`reset-password:${token}`}`;
      const refused = await responseOf(
        await harness.app.request(
          "/api/auth/reset-password",
          postReset({ token, newPassword: NEW_PASSWORD }),
        ),
      );
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe("IDENTITY_RECOVERY_TOKEN_INVALID");
      expect(String(refused.body.error)).toContain("has expired");

      // The refusal consumed nothing: the expired token row is still there,
      // and no password fact moved.
      const after = await harness.stateOf(user.userId);
      expect(after.tokenCount).toBe(before.tokenCount);
      expect(after.hash).toBe(before.hash);
      expect(after.generation).toBe(before.generation);
      expect(after.sessions).toBe(before.sessions);
      // A fresh request mints a fresh token that completes — the expiry
      // refusal closed one token, never the account.
      const fresh = await harness.mintResetToken(email);
      const completed = await responseOf(
        await harness.app.request(
          "/api/auth/reset-password",
          postReset({ token: fresh, newPassword: NEW_PASSWORD }),
        ),
      );
      expect(completed.status).toBe(200);
      expect(await harness.signInStatus(email, NEW_PASSWORD)).toBe(200);
    },
  );
});
