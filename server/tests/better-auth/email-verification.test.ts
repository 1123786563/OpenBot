import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import { genericOAuth, organization } from "better-auth/plugins";
import { SQL } from "bun";
import { sql as dsql } from "drizzle-orm";
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
import type { DirectoryTx } from "../../src/auth/directory/contracts";
import { createDirectoryExecutor } from "../../src/auth/directory/executor";
import { createDirectoryFinalizer } from "../../src/auth/directory/finalizer";
import { createDirectoryIngress } from "../../src/auth/directory/ingress";
import {
  createCompanyProvisionHandler,
  preAllocateProvisionTenantId,
  preAllocateProvisionWorkspaceId,
} from "../../src/auth/directory/lifecycle";
import {
  createFixedVersionInvitationCommands,
  createInvitationMembershipHandlers,
} from "../../src/auth/directory/membership";
import type { OutboxDeliverySender } from "../../src/auth/directory/outbox";
import {
  assertMailCallbackCompletion,
  createAuthMailOutbox,
  createMailCallbackFence,
  settleMailCallbackFence,
} from "../../src/auth/directory/outbox";
import { principalRegistry } from "../../src/auth/directory/principal-registry";
import {
  createDirectoryReadGate,
  createPlatformReadGate,
} from "../../src/auth/directory/read-gate";
import { createTransactionBoundBa } from "../../src/auth/directory/transaction-adapter";

/*
 * The T04.04 target module, loaded lazily so a worktree without it still
 * collects (and fails) every case with a message naming the missing target
 * behavior instead of dying at import time as a zero-case collection error
 * — the same discipline the T02.12 suite holds itself to.
 */
type MailModule = typeof import("../../src/auth/mail");
let mailPromise: Promise<MailModule> | undefined;
function loadMail(): Promise<MailModule> {
  mailPromise ??= import("../../src/auth/mail").catch((error: unknown) => {
    throw new Error(
      `server/src/auth/mail.ts is not loadable — ${error instanceof Error ? error.message : String(error)}: createAuthMail (the §5.1 converters and the SMTP delivery adapter) is the T04.04 target behavior, not an environment problem.`,
    );
  });
  return mailPromise;
}

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
  ssoProviders,
  users,
  verifications,
} from "../../src/db/schema/core";
import { createPlatformCompanyProvisionService } from "../../src/enterprise/tenancy/provision";
import { createOidcTestIdp, type OidcTestIdp } from "./support/oidc-idp";

/*
 * T04.04 (#548, original task P08) — the real verification-mail closed loop
 * over the transactional outbox, on the real 0209–0216 stack of the isolated
 * BA_TEST_* island (interfaces §3.1 notification table, §5.1; acceptance
 * F3/F-08).
 *
 * The five named behaviors, as facts:
 *
 * - `password_signup_verify_then_accept_invitation`: a password signup
 *   registers its verification mail as one encrypted outbox intent inside
 *   the signup's command transaction; the post-commit worker delivers it to
 *   the real SMTP receiver; the token the mail carries verifies the address
 *   through the fixed build's own verify endpoint; the now-verified user
 *   accepts an invitation through the real /api/auth/organization/
 *   accept-invitation endpoint and the membership is active. The verified
 *   mailbox granted no company proof: no assurance row exists.
 * - `expired_or_changed_email_verification_is_refused`: a token past its
 *   expiry, and a token whose identifier no longer matches the account's
 *   address, are both refused by the fixed build's verify endpoint.
 * - `verification_mail_is_not_sent_before_user_commit`: while the signup's
 *   transaction is still open — its intent row already written inside it —
 *   the receiver has received nothing and the intent is invisible on a
 *   second connection; only after the commit does delivery see it.
 * - `enabled_link_account_mail_uses_outbox_and_rollback_sends_nothing`: a
 *   real signed-IdP OIDC callback (deferNonDatabaseWrites genuinely true:
 *   resolveUser is configured) drives the pinned build's deferred
 *   dispatchVerificationEmail for both branches — sendOnSignUp (a brand-new
 *   provider user) and sendOnSignIn (the same provider identity signing in
 *   again, address still unverified). The deferred closure is converted
 *   inside the still-open command; nothing is received before the commit; a
 *   command that fails after the conversion rolls the intent back (zero
 *   rows, zero mail); the committed command delivers only through the
 *   outbox worker.
 * - `link_account_mail_retry_is_idempotent_and_missing_conversion_blocks_
 *   startup`: an injected delivery failure leaves the intent retryable and
 *   nothing received; the retry delivers exactly once under the same stable
 *   key; and a configuration that enables mail without the conversion
 *   installed (assertAuthMailTakeover — the factory's startup gate) never
 *   starts.
 *
 * Evidence level (coordinator ruling, 2026-10-27): the "real mail receiver"
 * is the local Mailpit sink — SMTP 127.0.0.1:1025, REST 127.0.0.1:8025.
 * This is LOCAL-SINK evidence, not a real provider: real-provider delivery
 * acceptance belongs to T08.06. The delivery adapter under test is the
 * production createAuthMail seam configured for standard SMTP — the sink is
 * named by the test's SMTP settings, never baked into the adapter.
 *
 * The signup and the SSO callback run in the executor-shaped command
 * transaction exactly as the T02.12 suite drives begin/finalize (the
 * production signup/SSO transcriptions are the assembly tickets'); the
 * invitation accept runs through the real ingress HTTP surface (T04.02's
 * production handlers).
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

const BA_SECRET = "t0404-email-verification-fixed-test-secret-not-a-credential";
const PAYLOAD_SECRET = "t0404-outbox-payload-secret-not-a-credential";
const DEFAULT_PASSWORD = "correct-horse-battery-staple";
const PLATFORM_ADMIN_ID = "t0404-platform-admin";
const EMAIL_DOMAIN = "@t0404.example.test";
const BASE_URL = "http://127.0.0.1:9";
const PROVIDER = "t0404-idp";
const OAUTH_PROVIDER = "t0404-oauth";
const FIXTURE_TARGET = "t0404-fixture-target";
const PROVISION_KEY = "t0404-key-company";

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
        `${variable} is required: the email-verification suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
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
  // AUDIT_TABLE is a module constant, so inline quoting is safe; postgres.js
  // has no sql.identifier (that helper belongs to drizzle-orm).
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
  const tenantId = preAllocateProvisionTenantId(PROVISION_KEY);
  await sql`DELETE FROM payer_accounts WHERE external_customer_id = ${`openbot-company-${tenantId}`}`;
  await sql`DELETE FROM billing_customers WHERE external_id = ${`openbot-company-${tenantId}`}`;
  const auditTableExists =
    await sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = ${AUDIT_TABLE}`;
  if (auditTableExists[0].n > 0) {
    await sql`DELETE FROM enterprise_audit_events WHERE tenant_id = ${tenantId}`;
  }
  await sql`DELETE FROM enterprise_workspace_memberships WHERE tenant_id = ${tenantId}`;
  await sql`DELETE FROM enterprise_memberships WHERE tenant_id = ${tenantId}`;
  await sql`DELETE FROM enterprise_principals WHERE user_id IN (
    SELECT id FROM users WHERE email LIKE ${`t0404-%${EMAIL_DOMAIN}`}
       OR id = ${PLATFORM_ADMIN_ID} OR id = ${FIXTURE_TARGET})`;
  await sql`DELETE FROM enterprise_workspaces WHERE tenant_id = ${tenantId}`;
  await sql`DELETE FROM enterprise_tenants WHERE id = ${tenantId}`;
  await sql`DELETE FROM user_roles WHERE user_id = ${PLATFORM_ADMIN_ID}`;
  await sql`DELETE FROM users WHERE email LIKE ${`t0404-%${EMAIL_DOMAIN}`} OR id = ${PLATFORM_ADMIN_ID} OR id = ${FIXTURE_TARGET}`;
  await sql`DELETE FROM sso_providers WHERE provider_id LIKE 't0404-%'`;
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

/* ---------------------------------------------------------------------- */
/* The real Mailpit sink: what delivery actually reached a receiver.       */
/* ---------------------------------------------------------------------- */

interface SinkMessage {
  ID: string;
  /** Mailpit's recipient list: [{Name, Address}] objects. */
  To: unknown[];
  Subject: string;
  Text: string;
  HTML: string;
}

/** Whether any recipient of the message carries the address. */
function toIncludes(message: SinkMessage, email: string): boolean {
  return JSON.stringify(message.To).includes(email);
}

/**
 * The message list with bodies: Mailpit's list endpoint answers with
 * metadata only, so each candidate's Text/HTML is read from its own
 * detail endpoint.
 */
async function sinkMessageWithBody(message: SinkMessage): Promise<SinkMessage> {
  const detail = await fetch(`${SINK_REST_BASE}/api/v1/message/${message.ID}`);
  if (!detail.ok) return message;
  return { ...message, ...((await detail.json()) as SinkMessage) };
}

async function sinkMessages(): Promise<SinkMessage[]> {
  const response = await fetch(`${SINK_REST_BASE}/api/v1/messages`);
  if (!response.ok) {
    throw new Error(
      `the local mail sink is not reachable at ${SINK_REST_BASE} (status ${response.status}); the T04.04 receiver is the coordinator-provisioned Mailpit container, and a missing sink is a blocked suite, not a skipped one`,
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

async function tokenOfMail(message: SinkMessage): Promise<string> {
  const withBody = await sinkMessageWithBody(message);
  const match = /verify-email\?token=([^&"'<\s]+)/.exec(
    `${withBody.Text} ${withBody.HTML}`,
  );
  if (!match) {
    throw new Error(
      `the delivered mail carries no verification token URL (subject "${message.Subject}")`,
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

interface CommandRun {
  commandId: string;
  /** Rows of auth_command_outbox committed by this run's command. */
  intents: { id: string; kind: string; status: string }[];
}

interface Harness {
  /**
   * The named refusal every case rethrows when the harness could not
   * assemble because the T04.04 target module is absent — a baseline
   * worktree fails all five named cases with the missing behavior, not
   * one unnamed collection error.
   */
  readonly assemblyRefusal?: Error;
  sql: postgres.Sql;
  app: Hono;
  tenantA: string;
  workspaceA: string;
  owner: HarnessUser;
  outbox: ReturnType<typeof createAuthMailOutbox>;
  authMail: AuthMailServices;
  /**
   * A password signup whose verification mail registers inside the signup's
   * own command transaction.
   *
   * The identity receipt's target-user FK is immediate, so the BA user row
   * lands first (the identity executor's own identity.user.create pattern:
   * createUser pre-receipt, same transaction), and the fixed build's own
   * verification dispatch — its /send-verification-email session branch —
   * runs inside the command, where the converter registers the encrypted
   * intent and the completion fence owns the swallow-proofing.
   */
  signupInCommand(input: {
    email: string;
    name: string;
    /** Called inside the open transaction, after the conversion. */
    insideOpenTransaction?: (commandId: string) => Promise<void>;
    /** Fail the command after the fence, before the commit. */
    failAfterConversion?: boolean;
  }): Promise<{
    response: Response;
    run: CommandRun | null;
    /** The signup's own session cookie (the signed set-cookie value). */
    cookie?: string;
  }>;
  /**
   * One real signed-IdP SSO callback inside a command transaction — the
   * sign-in branch (deferNonDatabaseWrites true, resolveUser configured):
   * the deferred dispatchVerificationEmail is converted inside the command.
   * `registerFirst` runs the brand-new-identity callback once outside the
   * command first (the user must exist for the receipt's target FK), which
   * also exercises the sendOnSignUp dispatch pre-command: refused unsent.
   */
  ssoCallbackInCommand(input: {
    subject: string;
    email: string;
    registerFirst?: boolean;
    /**
     * The register branch in-command: a brand-new identity whose user is
     * born inside the callback. The receipt's target-user FK is immediate,
     * so the command targets the fixture user exactly as the T02.12 suite's
     * notification commands do — the intent, not the receipt target, is
     * what the mail facts bind to.
     */
    fixtureTarget?: boolean;
    failAfterConversion?: boolean;
  }): Promise<{ response: Response; run: CommandRun | null }>;
  /**
   * The generic-OAuth provider's callback (the sign-in branch's own
   * reachable path): a real HTTP flow against the same signed test IdP,
   * the dispatch fired directly in-request inside the command.
   */
  oauthCallbackInCommand(input: {
    subject: string;
    email: string;
    failAfterConversion?: boolean;
  }): Promise<{ response: Response; run: CommandRun | null }>;
  /** The post-commit worker: delivers committed intents over SMTP. */
  drain(
    send?: OutboxDeliverySender,
    attempts?: number,
  ): Promise<{
    considered: number;
    delivered: number;
    failed: { id: string; error: string }[];
  }>;
  countIntents(commandId?: string): Promise<number>;
  invite(input: { email: string; key: string }): Promise<Response>;
  accept(input: {
    actor: HarnessUser;
    invitationId: string;
    key: string;
  }): Promise<Response>;
  businessMembership(
    tenantId: string,
    principalId: string,
  ): Promise<{ role: string; status: string }[]>;
  principalIdOf(userId: string): Promise<string | undefined>;
  verifyEmail(token: string): Promise<Response>;
  close(): Promise<void>;
}

let commandCounter = 0;
function uniqueCommandId(): string {
  commandCounter += 1;
  return `t0404-cmd-${process.pid}-${commandCounter}`;
}

async function buildHarness(setupUrl: string): Promise<Harness> {
  let assemblyRefusal: Error | undefined;
  try {
    await loadMail();
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

  const mail = await loadMail();
  const outbox = createAuthMailOutbox({ payloadSecret: PAYLOAD_SECRET });
  const authMail = mail.createAuthMail({
    smtp: {
      host: SINK_SMTP_HOST,
      port: SINK_SMTP_PORT,
      secure: false,
      from: "t0404-auth@example.test",
    } satisfies AuthMailSmtpSettings,
    outbox,
  });

  const idp: OidcTestIdp = harnessIdp!;

  let resolvedOptions: unknown;
  const auth = betterAuth({
    secret: BA_SECRET,
    baseURL: BASE_URL,
    trustedOrigins: [BASE_URL, idp.issuer],
    /*
     * The T04.04 wiring under test: both mail callbacks are the outbox
     * converters, and both dispatch branches are enabled — the exact
     * configuration the factory installs when SMTP is configured.
     */
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      sendResetPassword: authMail.sendResetPassword,
    },
    emailVerification: {
      sendVerificationEmail: authMail.sendVerificationEmail,
      sendOnSignUp: true,
      sendOnSignIn: true,
    },
    plugins: [
      organization({ teams: { enabled: true } }),
      sso({
        /*
         * deferNonDatabaseWrites must be genuinely true (the dispatch's own
         * coordinator ruling): resolveUser configured is what makes the
         * pinned build defer, and "continue" keeps its default user
         * resolution (implicit create for a new identity, link to the
         * existing account for a known one).
         */
        resolveUser: async () => ({ action: "continue" as const }),
        provisionUser: async () => {},
        organizationProvisioning: { disabled: true },
      }),
      /*
       * The generic OAuth provider the sign-in branch needs: 1.7.1 gates
       * sendOnSignIn on the provider's own requireEmailVerification, which
       * only a socialProviders entry can carry — and the deferred
       * (deferNonDatabaseWrites) path only the SSO resolveUser flow reaches,
       * whose providers never appear there. So the two link-account branches
       * are exercised each on the path the pinned build genuinely reaches:
       * register+deferred through the SSO callback, sign-in+direct through
       * this provider's callback.
       */
      genericOAuth({
        config: [
          {
            providerId: OAUTH_PROVIDER,
            clientId: harnessIdp!.clientId,
            clientSecret: harnessIdp!.clientSecret,
            authorizationUrl: `${harnessIdp!.issuer}/authorize`,
            tokenUrl: harnessIdp!.tokenEndpoint,
            userInfoUrl: harnessIdp!.userInfoEndpoint,
            scopes: ["openid", "email", "profile"],
            requireEmailVerification: true,
          },
        ],
      }),
    ],
    database: (options: unknown) => {
      resolvedOptions = options;
      return drizzleAdapter(db as never, {
        provider: "pg",
        schema: baSchema as never,
        transaction: true,
      })(options as never);
    },
  });

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
  const authority = createDirectoryAuthority();
  const finalizer = createDirectoryFinalizer();
  const ba = createFixedVersionInvitationCommands(await auth.$context, {
    teams: { enabled: true },
  });
  const directory = createDirectoryExecutor({
    database: db,
    bound,
    authority,
    registry: principalRegistry,
    finalizer,
    outbox,
    handlers: {
      "company.provision": createCompanyProvisionHandler(),
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

  const plainSignUp = async (
    email: string,
    name: string,
  ): Promise<HarnessUser> => {
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

  /**
   * The executor-shaped command transaction (the T02.12 recipe) with the
   * identity executor's own user-creation order: the BA rows the receipt's
   * immediate target-user FK needs land on THIS transaction first
   * (`preReceipt`, under bound.run — identity.user.create's pattern), then
   * begin, TransactionBoundBa run with the mail conversion context
   * installed, completion fence, finalize, commit. A dispatch that fires in
   * the pre-receipt half finds no command context and is refused unsent —
   * no fence exists there to owe a receipt.
   */
  const runInCommand = async <T>(
    preReceipt: (tx: DirectoryTx) => Promise<string>,
    operation: (tx: DirectoryTx, commandId: string) => Promise<T>,
    options: { failAfter?: boolean } = {},
  ): Promise<{ value: T | null; commandId: string }> => {
    const commandId = uniqueCommandId();
    const value = await txDb.transaction(async (trx) => {
      const tx = trx as never as DirectoryTx;
      const targetUserId = (await bound.run(tx, () => preReceipt(tx))).value;
      await tx.execute(dsql`SELECT set_config('auth.current_command',
        public.auth_directory_begin_command(
          ${commandId}, 'identity', 'identity.notify', null, ${targetUserId}, ${targetUserId},
          'platform', ${`t0404-idem-${commandId}`}, ${`t0404-hash-${commandId}`}),
        true)`);
      const fence = createMailCallbackFence(tx, commandId);
      let result: T;
      try {
        /*
         * The conversion context wraps the WHOLE bound.run — operation and
         * the deferred-hook classification that follows it — because the
         * link-account takeover converts the deferred closure at
         * classification time, still inside the command.
         */
        result = (
          await mail.runWithAuthMailCommand({ tx, fence, outbox }, () =>
            bound.run(tx, () => operation(tx, commandId)),
          )
        ).value;
        await assertMailCallbackCompletion(tx, fence);
        await tx.execute(
          dsql`SELECT public.auth_directory_finalize_command(${commandId})`,
        );
        await tx.execute(
          dsql`SELECT set_config('auth.current_command', '', true)`,
        );
        await tx.execute(dsql`SET CONSTRAINTS ALL IMMEDIATE`);
        if (options.failAfter) {
          throw new Error(
            "t0404 injected post-conversion failure: the command must roll its mail intent back with it",
          );
        }
      } catch (error) {
        settleMailCallbackFence(fence, "rolled-back");
        throw error;
      }
      settleMailCallbackFence(fence, "committed");
      return result;
    });
    return { value, commandId };
  };

  const intentsOf = async (commandId: string) =>
    sql`SELECT id, kind, status FROM auth_command_outbox WHERE command_id = ${commandId}`;

  const signupInCommand: Harness["signupInCommand"] = async (input) => {
    let signupCookie: string | undefined;
    let outcome: { value: Response | null; commandId: string };
    try {
      outcome = await runInCommand(
        // Pre-receipt: the fixed build's own signup creates the user, the
        // password account and the session on this transaction. Its
        // sendOnSignUp dispatch fires here with no command context and is
        // refused unsent — the receipt below is what owes the mail.
        async () => {
          const response = await (
            auth.api as unknown as Record<
              string,
              (input: unknown) => Promise<Response>
            >
          ).signUpEmail({
            body: {
              email: input.email,
              password: DEFAULT_PASSWORD,
              name: input.name,
            },
            asResponse: true,
          });
          if (response.status !== 200) {
            throw new Error(
              `signUpEmail for ${input.email} failed: ${response.status}`,
            );
          }
          signupCookie = response.headers
            .getSetCookie()
            .map((entry) => entry.split(";")[0])
            .join("; ");
          const body = (await response.json()) as { user: { id: string } };
          return body.user.id;
        },
        // In-command: the fixed build's own verification dispatch (its
        // /send-verification-email session branch) registers the intent.
        async (tx, commandId) => {
          const session = await (
            auth.api as unknown as Record<
              string,
              (input: unknown) => Promise<Response>
            >
          ).sendVerificationEmail({
            body: { email: input.email },
            headers: {
              cookie: `better-auth.session_token=${await sessionTokenOf(tx, input.email)}`,
            },
            asResponse: true,
          });
          if (session.status !== 200) {
            throw new Error(
              `sendVerificationEmail for ${input.email} failed: ${session.status}`,
            );
          }
          await input.insideOpenTransaction?.(commandId);
          return session.status;
        },
        { failAfter: input.failAfterConversion },
      );
    } catch {
      // The injected post-conversion failure (or a refused flow): the
      // command rolled back and nothing was sent.
      return { response: new Response(null, { status: 500 }), run: null };
    }
    return {
      response: new Response(null, { status: outcome.value ?? 500 }),
      run: {
        commandId: outcome.commandId,
        intents: await intentsOf(outcome.commandId),
      },
      cookie: signupCookie,
    };
  };

  /** The most recent session token of a user, read on the live transaction. */
  const sessionTokenOf = async (
    tx: DirectoryTx,
    email: string,
  ): Promise<string> => {
    const result = await tx.execute(dsql`
      SELECT s.token FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE u.email = ${email} ORDER BY s.created_at DESC LIMIT 1`);
    const rows = (
      Array.isArray(result)
        ? (result as Record<string, unknown>[])
        : ((result as { rows?: Record<string, unknown>[] }).rows ?? [])
    ) as { token: string }[];
    const token = rows[0]?.token;
    if (!token) throw new Error(`no session for ${email}`);
    return token;
  };

  /**
   * One real signed-IdP callback: initiate through the pinned build's own
   * /sign-in/sso (state + PKCE, cookie carried), mint the authorization code
   * at the live IdP with the flow's own nonce and challenge, then run the
   * callback endpoint inside the command transaction.
   */
  const ssoCallbackInCommand: Harness["ssoCallbackInCommand"] = async (
    input,
  ) => {
    /*
     * One full flow per callback invocation: the state (cookie + one-time
     * verification row) and the authorization code are each consumable
     * exactly once, so the register run and the in-command run each start
     * their own /sign-in/sso initiation and mint their own code at the IdP.
     */
    const runCallback = async (): Promise<Response> => {
      const initiate = await (
        auth.api as unknown as Record<
          string,
          (input: unknown) => Promise<Response>
        >
      ).signInSSO({
        body: { providerId: PROVIDER, callbackURL: "/" },
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
      const code = idp.authorize({
        nonce: state,
        codeChallenge: parsed.searchParams.get("code_challenge") ?? "",
        redirectUri: parsed.searchParams.get("redirect_uri") ?? "",
        claims: {
          sub: input.subject,
          email: input.email,
          email_verified: false,
          name: `T04.04 ${input.subject}`,
        },
      });
      return (
        auth.api as unknown as Record<
          string,
          (input: unknown) => Promise<Response>
        >
      ).callbackSSO({
        params: { providerId: PROVIDER },
        query: { code, state },
        headers: { cookie },
        asResponse: true,
      }) as Promise<Response>;
    };
    const userIdOf = async (
      tx: DirectoryTx,
      email: string,
    ): Promise<string> => {
      const result = await tx.execute(
        dsql`SELECT id FROM users WHERE email = ${email} LIMIT 1`,
      );
      const rows = (
        Array.isArray(result)
          ? (result as Record<string, unknown>[])
          : ((result as { rows?: Record<string, unknown>[] }).rows ?? [])
      ) as { id: string }[];
      const id = rows[0]?.id;
      if (!id) throw new Error(`no user row for ${email}`);
      return id;
    };
    let outcome: { value: Response | null; commandId: string };
    try {
      outcome = await runInCommand(
        // Pre-receipt: with registerFirst, the brand-new identity's callback
        // runs once here — the user and its provider account land on this
        // transaction, and the sendOnSignUp dispatch (deferNonDatabaseWrites
        // genuinely true) fires with no command context and is refused
        // unsent. Without it, the identity already exists from an earlier
        // call and the in-command callback is its sign-in.
        async (tx) => {
          if (input.fixtureTarget) return FIXTURE_TARGET;
          if (input.registerFirst) {
            const register = await runCallback();
            const location = register.headers.get("location") ?? "";
            if (register.status >= 400 || /[?&]error=/.test(location)) {
              throw new Error(
                `register callback failed: ${register.status} ${location.slice(0, 300)}`,
              );
            }
          }
          return userIdOf(tx, input.email);
        },
        async () => runCallback(),
        { failAfter: input.failAfterConversion },
      );
    } catch {
      // The injected post-conversion failure (or a refused flow): the
      // command rolled back and nothing was sent.
      return { response: new Response(null, { status: 500 }), run: null };
    }
    return {
      response: outcome.value ?? new Response(null, { status: 500 }),
      run: {
        commandId: outcome.commandId,
        intents: await intentsOf(outcome.commandId),
      },
    };
  };

  /**
   * The generic-OAuth flow: /sign-in/social initiation (state + PKCE), the
   * code minted at the live IdP, the shared /callback/:id endpoint run
   * inside the command. The register half (the identity's first callback,
   * which creates the user) runs pre-receipt on the same transaction; the
   * sign-in half runs in-command, where requireEmailVerification +
   * sendOnSignIn dispatch directly through the converter.
   */
  const oauthCallbackInCommand: Harness["oauthCallbackInCommand"] = async (
    input,
  ) => {
    const flow = async () => {
      const initiate = await (
        auth.api as unknown as Record<
          string,
          (input: unknown) => Promise<Response>
        >
      ).signInSocial({
        body: { provider: OAUTH_PROVIDER, callbackURL: "/" },
        asResponse: true,
      });
      if (initiate.status !== 200) {
        throw new Error(`/sign-in/social failed: ${initiate.status}`);
      }
      const cookie = initiate.headers
        .getSetCookie()
        .map((entry) => entry.split(";")[0])
        .join("; ");
      const body = (await initiate.json()) as { url: string };
      const parsed = new URL(body.url);
      return {
        state: parsed.searchParams.get("state") ?? "",
        codeChallenge: parsed.searchParams.get("code_challenge") ?? "",
        redirectUri: parsed.searchParams.get("redirect_uri") ?? "",
        cookie,
      };
    };
    const codeOf = (flow: Awaited<ReturnType<typeof flow>>) =>
      idp.authorize({
        nonce: flow.state,
        codeChallenge: flow.codeChallenge,
        redirectUri: flow.redirectUri,
        claims: {
          sub: input.subject,
          email: input.email,
          email_verified: false,
          name: `T04.04 ${input.subject}`,
        },
      });
    const runOAuthCallback = (state: string, code: string, cookie: string) =>
      (
        auth.api as unknown as Record<
          string,
          (input: unknown) => Promise<Response>
        >
      ).callbackOAuth({
        params: { id: OAUTH_PROVIDER },
        query: { code, state },
        headers: { cookie },
        asResponse: true,
      }) as Promise<Response>;
    const userIdOf = async (
      tx: DirectoryTx,
      email: string,
    ): Promise<string> => {
      const result = await tx.execute(
        dsql`SELECT id FROM users WHERE email = ${email} LIMIT 1`,
      );
      const rows = (
        Array.isArray(result)
          ? (result as Record<string, unknown>[])
          : ((result as { rows?: Record<string, unknown>[] }).rows ?? [])
      ) as { id: string }[];
      const id = rows[0]?.id;
      if (!id) throw new Error(`no user row for ${email}`);
      return id;
    };
    let outcome: { value: Response | null; commandId: string };
    try {
      outcome = await runInCommand(
        // Pre-receipt: the identity's first callback creates the user and
        // its provider account (its register dispatch, fired directly with
        // no command context, is refused unsent); the sign-in below is the
        // branch the command owns.
        async (tx) => {
          const first = await flow();
          const register = await runOAuthCallback(
            first.state,
            codeOf(first),
            first.cookie,
          );
          await register.text();
          return userIdOf(tx, input.email);
        },
        async () => {
          const second = await flow();
          return runOAuthCallback(second.state, codeOf(second), second.cookie);
        },
        { failAfter: input.failAfterConversion },
      );
    } catch {
      // The injected post-conversion failure: the command rolled back.
      return { response: new Response(null, { status: 500 }), run: null };
    }
    return {
      response: outcome.value ?? new Response(null, { status: 500 }),
      run: {
        commandId: outcome.commandId,
        intents: await intentsOf(outcome.commandId),
      },
    };
  };

  const drain: Harness["drain"] = (send, attempts) =>
    outbox.drainAuthMailOutbox({
      query: (text, params) => sql.unsafe(text, params),
      send: send ?? authMail.outboxSender,
      ...(attempts ? { attempts } : {}),
    });

  const countIntents: Harness["countIntents"] = (commandId) =>
    commandId
      ? sql`SELECT count(*)::int AS n FROM auth_command_outbox WHERE command_id = ${commandId}`.then(
          (rows) => Number(rows[0].n),
        )
      : sql`SELECT count(*)::int AS n FROM auth_command_outbox`.then((rows) =>
          Number(rows[0].n),
        );

  const owner = await plainSignUp(`t0404-owner${EMAIL_DOMAIN}`, "T04.04 Owner");
  await sql`UPDATE users SET email_verified = true WHERE id = ${owner.userId}`;

  const tenantA = preAllocateProvisionTenantId(PROVISION_KEY);
  await provisioner.provision({
    actorUserId: PLATFORM_ADMIN_ID,
    idempotencyKey: PROVISION_KEY,
    name: "T04.04 公司",
    slug: "t0404-company",
    ownerUserId: owner.userId,
    defaultTeamName: "默认团队",
  });

  return {
    sql,
    app,
    tenantA,
    workspaceA: preAllocateProvisionWorkspaceId(tenantA),
    owner,
    outbox,
    authMail,
    signupInCommand,
    ssoCallbackInCommand,
    oauthCallbackInCommand,
    drain,
    countIntents,
    invite: ({ email, key }) =>
      app.request("/api/auth/organization/invite-member", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: owner.cookie,
          "idempotency-key": key,
        },
        body: JSON.stringify({
          organizationId: tenantA,
          email,
          role: "member",
        }),
      }),
    accept: ({ actor, invitationId, key }) =>
      app.request("/api/auth/organization/accept-invitation", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: actor.cookie,
          "idempotency-key": key,
        },
        body: JSON.stringify({ invitationId }),
      }),
    businessMembership: (tenantId, principalId) =>
      sql`SELECT role, status FROM enterprise_memberships
           WHERE tenant_id = ${tenantId} AND principal_id = ${principalId}`,
    principalIdOf: async (userId) => {
      const rows =
        await sql`SELECT id FROM enterprise_principals WHERE user_id = ${userId} LIMIT 1`;
      return rows[0]?.id as string | undefined;
    },
    verifyEmail: (token) =>
      (
        auth.api as unknown as Record<
          string,
          (input: unknown) => Promise<Response>
        >
      ).verifyEmail({ query: { token }, asResponse: true }),
    close: async () => {
      await Promise.allSettled([sql.end({ timeout: 5 }), client.close()]);
    },
  };
}

let harnessIdp: OidcTestIdp | undefined;

describe("T04.04 verification mail over the transactional outbox", () => {
  let harness: Harness;
  let ownsAuditTable = false;

  beforeAll(async () => {
    readBaUrls();
    // The receiver is part of the pinned environment: a sink that cannot be
    // reached makes the suite blocked, never silently green.
    const probe = await fetch(`${SINK_REST_BASE}/api/v1/messages`);
    if (probe.status !== 200) {
      throw new Error(
        `the local mail sink at ${SINK_REST_BASE} answered ${probe.status}; the T04.04 acceptance runs against the coordinator-provisioned Mailpit container (SMTP 127.0.0.1:1025) — a missing sink is blocked, not a fallback`,
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
    await setup`INSERT INTO users (id, email) VALUES (${PLATFORM_ADMIN_ID}, ${`t0404-admin${EMAIL_DOMAIN}`}), (${FIXTURE_TARGET}, ${`t0404-fixture${EMAIL_DOMAIN}`})`;
    await setup`INSERT INTO user_roles (user_id, role) VALUES (${PLATFORM_ADMIN_ID}, 'admin')`;
    await setup`UPDATE auth_authority_states
                   SET phase = 'M4', directory_authority = 'ba', authority_version = 1
                 WHERE id = 1`;
    await setup.end({ timeout: 5 });

    harness = await buildHarness(setupUrl);
    if (harness.assemblyRefusal) return;
    await harness.sql`INSERT INTO sso_providers (id, provider_id, issuer, oidc_config, domain)
      VALUES (${`t0404-provider-row`}, ${PROVIDER}, ${harnessIdp.issuer},
              ${JSON.stringify({
                clientId: harnessIdp.clientId,
                clientSecret: harnessIdp.clientSecret,
                pkce: true,
              })},
              ${EMAIL_DOMAIN.replace("@", "")})`;
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
    await harnessIdp?.close();
  });

  test(
    "password_signup_verify_then_accept_invitation",
    60_000,
    async () => {
      if (harness.assemblyRefusal) throw harness.assemblyRefusal;
      await sinkClear();
      const email = `t0404-invitee${EMAIL_DOMAIN}`;

      // Signup: the mail intent registers inside the signup's transaction.
      const { response, run, cookie } = await harness.signupInCommand({
        email,
        name: "T04.04 Invitee",
      });
      expect(response.status).toBe(200);
      expect(run?.intents).toHaveLength(1);
      expect(run?.intents[0].kind).toBe("link-account.verify");
      // Nothing delivered before the drain: the commit alone owns delivery.
      expect(await sinkMessages()).toHaveLength(0);

      // Post-commit delivery over SMTP to the real receiver.
      const report = await harness.drain();
      expect(report.delivered).toBeGreaterThanOrEqual(1);
      const delivered = await sinkMessages();
      const mine = delivered.filter((message) => toIncludes(message, email));
      expect(mine).toHaveLength(1);
      expect(mine[0].Subject).toBe("Verify your email");
      const token = await tokenOfMail(mine[0]);
      expect(token).not.toContain("@"); // the sealed URL's token, not the address

      // The fixed build's own verify endpoint accepts the token the mail
      // carried, and only then does the address count as verified.
      const userRow =
        await harness.sql`SELECT id FROM users WHERE email = ${email}`;
      const userId = userRow[0].id as string;
      await harness.sql`UPDATE users SET email_verified = false WHERE id = ${userId}`.catch(
        () => {},
      );
      const verified = await harness.verifyEmail(token);
      expect(verified.status).toBe(200);
      const after =
        await harness.sql`SELECT email_verified FROM users WHERE id = ${userId}`;
      expect(after[0].email_verified).toBe(true);

      // The verified mailbox accepts the invitation through the real endpoint.
      const invited = await harness.invite({ email, key: "t0404-key-invite" });
      expect(invited.status).toBe(200);
      const { resourceId: invitationId } = (await invited.json()) as {
        resourceId: string;
      };
      expect(typeof cookie).toBe("string");
      const accepted = await harness.accept({
        actor: { userId, email, cookie },
        invitationId,
        key: "t0404-key-accept",
      });
      expect(accepted.status).toBe(200);

      const principalId = await harness.principalIdOf(userId);
      expect(typeof principalId).toBe("string");
      const memberships = await harness.businessMembership(
        harness.tenantA,
        principalId!,
      );
      expect(memberships).toHaveLength(1);
      expect(memberships[0].status).toBe("active");

      // 邮箱验证只改变邮箱控制权事实，不签发 CompanyAssurance。
      const assurances = await harness.sql`
      SELECT count(*)::int AS n FROM auth_company_session_assurances
       WHERE principal_id = ${principalId}`;
      expect(Number(assurances[0].n)).toBe(0);
    },
    60_000,
  );

  test("expired_or_changed_email_verification_is_refused", 60_000, async () => {
    if (harness.assemblyRefusal) throw harness.assemblyRefusal;
    await sinkClear();
    const email = `t0404-verify-owner${EMAIL_DOMAIN}`;

    // A real signup+mail, so the account under verification exists and the
    // verify endpoint's lookups answer about a live user.
    const { response } = await harness.signupInCommand({
      email,
      name: "T04.04 Verify Owner",
    });
    expect(response.status).toBe(200);
    await harness.drain();

    // The fixed build's verification token is a stateless HS256 JWT over
    // {email} (secret-signed, expiry inside), so the two refusals are
    // proven with tokens of exactly that shape: one whose time is past,
    // and one whose identifier no longer names the account's address.
    // HS256 by hand — the fixed build's token is exactly this shape, and a
    // six-line signer beats a transitive dependency for two crafted tokens.
    const b64url = (input: string | Buffer) =>
      Buffer.from(input).toString("base64url");
    const sign = (payload: Record<string, unknown>) =>
      [
        b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
        b64url(JSON.stringify(payload)),
      ]
        .join(".")
        .concat(
          ".",
          createHmac("sha256", BA_SECRET)
            .update(
              `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}`,
            )
            .digest("base64url"),
        );
    const now = Math.floor(Date.now() / 1000);
    const expired = sign({ email, iat: now - 20, exp: now - 10 });
    const expiredAnswer = await harness.verifyEmail(expired);
    expect(expiredAnswer.status).not.toBe(200);

    const changedEmail = `t0404-moved${EMAIL_DOMAIN}`;
    await harness.sql`UPDATE users SET email = ${changedEmail} WHERE email = ${email}`;
    const staleIdentifier = sign({ email, iat: now, exp: now + 3600 });
    const staleAnswer = await harness.verifyEmail(staleIdentifier);
    expect(staleAnswer.status).not.toBe(200);
  });

  test("verification_mail_is_not_sent_before_user_commit", 60_000, async () => {
    if (harness.assemblyRefusal) throw harness.assemblyRefusal;
    await sinkClear();
    const email = `t0404-precommit${EMAIL_DOMAIN}`;
    const sentBeforeCommit: string[] = [];

    const { response, run } = await harness.signupInCommand({
      email,
      name: "T04.04 Precommit",
      insideOpenTransaction: async (commandId) => {
        // While the signup's transaction is still open: the receiver holds
        // nothing for this address, and this command's intent is invisible
        // on a second connection — the commit is the only door.
        if (
          (await sinkMessages()).some((m) => toIncludes(m, email)) ||
          (await harness.countIntents(commandId)) > 0
        ) {
          sentBeforeCommit.push("leak");
        }
      },
    });
    expect(response.status).toBe(200);
    expect(sentBeforeCommit).toHaveLength(0);
    // The intent existed only inside the transaction: the drain is post
    // commit by construction, and only now does mail exist.
    expect((await sinkMessages()).some((m) => toIncludes(m, email))).toBe(
      false,
    );
    await harness.drain();
    expect(
      (await sinkMessages()).filter((m) => toIncludes(m, email)),
    ).toHaveLength(1);
    expect(run?.intents).toHaveLength(1);
  });

  test(
    "enabled_link_account_mail_uses_outbox_and_rollback_sends_nothing",
    60_000,
    async () => {
      if (harness.assemblyRefusal) throw harness.assemblyRefusal;
      await sinkClear();
      const ssoEmail = `t0404-sso-new${EMAIL_DOMAIN}`;

      // sendOnSignUp + deferNonDatabaseWrites (the SSO resolveUser flow): a
      // brand-new identity's callback runs inside the command and its
      // DEFERRED dispatchVerificationEmail is converted there — the takeover
      // itself, exercised on the path the pinned build actually defers.
      const register = await harness.ssoCallbackInCommand({
        subject: "t0404-sso-new",
        email: ssoEmail,
        fixtureTarget: true,
      });
      expect(register.response.status).toBeLessThan(400);
      expect(register.run?.intents).toHaveLength(1);
      expect(register.run?.intents[0].kind).toBe("link-account.verify");
      // Before the commit's drain: nothing sent, ever, from the callback.
      expect(await sinkMessages()).toHaveLength(0);
      await harness.drain();
      expect(
        (await sinkMessages()).filter((m) => toIncludes(m, ssoEmail)),
      ).toHaveLength(1);

      // sendOnSignIn (the generic provider's reachable path — 1.7.1 cannot
      // combine this branch with deferral, disclosed): the same signed IdP,
      // the dispatch fired directly in-request inside the command.
      const oauthEmail = `t0404-oauth-user${EMAIL_DOMAIN}`;
      const signIn = await harness.oauthCallbackInCommand({
        subject: "t0404-oauth-user",
        email: oauthEmail,
      });
      expect(signIn.run?.intents).toHaveLength(1);
      expect(signIn.run?.intents[0].kind).toBe("link-account.verify");
      expect(
        (await sinkMessages()).some((m) => toIncludes(m, oauthEmail)),
      ).toBe(false);
      await harness.drain();
      expect(
        (await sinkMessages()).filter((m) => toIncludes(m, oauthEmail)),
      ).toHaveLength(1);

      // Rollback: a command that fails after the conversion leaves no intent
      // and no mail — the commit owns both halves.
      const before = await harness.countIntents();
      const rolled = await harness.ssoCallbackInCommand({
        subject: "t0404-sso-rolled",
        email: `t0404-sso-rolled${EMAIL_DOMAIN}`,
        fixtureTarget: true,
        failAfterConversion: true,
      });
      expect(rolled.response.status).toBe(500);
      expect(await harness.countIntents()).toBe(before);
      expect(
        (await sinkMessages()).filter((m) =>
          toIncludes(m, `t0404-sso-rolled${EMAIL_DOMAIN}`),
        ),
      ).toHaveLength(0);
    },
  );

  test(
    "link_account_mail_retry_is_idempotent_and_missing_conversion_blocks_startup",
    60_000,
    async () => {
      if (harness.assemblyRefusal) throw harness.assemblyRefusal;
      await sinkClear();
      const email = `t0404-retry${EMAIL_DOMAIN}`;

      const { response, run } = await harness.ssoCallbackInCommand({
        subject: "t0404-sso-retry",
        email,
        fixtureTarget: true,
      });
      expect(response.status).toBeLessThan(400);
      const expectedKey = run?.intents[0]?.id;
      expect(typeof expectedKey).toBe("string");

      // An injected delivery failure with single-attempt drains: nothing
      // received, the intent left retryable for the next worker pass.
      const deliveredIdempotencyKeys: string[] = [];
      let failuresLeft = 1;
      const flaky: OutboxDeliverySender = async (request) => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("t0404 injected SMTP failure");
        }
        const result = await harness.authMail.outboxSender(request);
        deliveredIdempotencyKeys.push(request.idempotencyKey);
        return result;
      };
      const failedReport = await harness.drain(flaky, 1);
      expect(failedReport.delivered).toBe(0);
      expect(
        failedReport.failed.find((failure) => failure.id === expectedKey),
      ).toBeDefined();
      expect(await sinkMessages()).toHaveLength(0);

      // The retry (a later worker pass) delivers exactly once, under the
      // same stable key.
      const retryReport = await harness.drain(flaky, 1);
      expect(retryReport.delivered).toBeGreaterThanOrEqual(1);
      expect(deliveredIdempotencyKeys).toEqual([expectedKey]);
      const received = await sinkMessages();
      expect(received.filter((m) => toIncludes(m, email))).toHaveLength(1);

      // 启用邮件却缺转换器：启动拒绝。
      const mailNow = await loadMail();
      let started = false;
      try {
        mailNow.assertAuthMailTakeover({
          emailVerification: {
            sendOnSignUp: true,
            sendVerificationEmail: async () => {},
          },
          authMail: null,
        });
        started = true;
      } catch (error) {
        expect(String(error)).toContain("AUTH_MAIL_TAKEOVER_REQUIRED");
      }
      expect(started).toBe(false);

      // The installed configuration itself passes the same gate.
      mailNow.assertAuthMailTakeover({
        emailVerification: {
          sendOnSignUp: true,
          sendOnSignIn: true,
          sendVerificationEmail: harness.authMail.sendVerificationEmail,
        },
        emailAndPassword: {
          sendResetPassword: harness.authMail.sendResetPassword,
        },
        authMail: harness.authMail,
      });
    },
    60_000,
  );
});
