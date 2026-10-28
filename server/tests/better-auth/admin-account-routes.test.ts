import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { createApp } from "../../src/app";
import { createRoleRepository } from "../../src/auth/guards";
import { createAuth } from "../../src/auth/index";
import { loadConfig } from "../../src/config";
import { createDatabase } from "../../src/db/client";
import { createPeopleStore } from "../../src/people/store";
import { testEnvironment } from "../support/environment";

/*
 * T05.08 (#564, original task P12) — the admin account surface: the native
 * create-user, update-user and set-user-password calls translate into one
 * identity command each, on the production executor the real createAuth
 * factory assembles, against the isolated BA_TEST_* island (interfaces
 * §2.1/§3.2; acceptance M1).
 *
 * The named behaviors, as facts:
 *
 * - `admin_create_edit_password_and_revoke_all_are_enveloped`: every one of
 *   the account writes — create without a credential (the SSO shape: a user,
 *   a role, a principal, no password account), create with a deployed
 *   credential, the profile edit, the administrator's password write (the
 *   platform actor, no recovery token) and the batch session revocation —
 *   lands behind a finalized receipt of its own operation, and
 *   expect(unenvelopedWrites).toBe(0) holds over the whole set. The password
 *   write kills every session the target had, advances the identity
 *   generation, leaves a credential hash that is not the plaintext, and the
 *   new password actually signs in; the batch revocation kills the sessions
 *   without touching the long-lived generation.
 * - `arbitrary_profile_security_fields_and_impersonation_are_rejected`: an
 *   update-user that carries a security field (email, emailVerified, role,
 *   banned, banReason, arbitrary data) is refused whole with 403 — the
 *   translated account surface writes name/image only, so the request is
 *   never trimmed to its editable half and nothing moves: no row, no role,
 *   no receipt. The same refusal answers a create-user that tries to
 *   smuggle a role. Impersonation and removal answer
 *   expect(status).toBe(403) outright, and the target survives both.
 *
 * The mounting is the real one: the production createAuth assembles the
 * identity executor behind its own fixed build (the pre-allocated id, the
 * build's own hashing, its own credential account linking), the production
 * createApp carries it through the `coworker.directory.identity` seam into
 * the native ingress, and a Bun server answers real fetches. The legacy arm
 * of the matrix mounts the same app without the executor: the three writes
 * answer their honest 503 and nothing is written, while the closed surface
 * (impersonate/remove) refuses 403 on both arms.
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
  "0227_better_auth_company_lifecycle",
  "0228_better_auth_invitation_resend",
  "0230_better_auth_company_auth_challenge",
  "0231_better_auth_company_auth_complete",
  "0232_better_auth_company_auth_policy_read",
] as const;
const MIGRATION_PATHS = MIGRATION_TAGS.map((tag) =>
  join(import.meta.dirname, `../../drizzle/${tag}.sql`),
);

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

const BA_SECRET = "t0508-admin-account-routes-fixed-test-secret";
const KEY_ENCRYPTION_KEY = "T0508PAYLOADSECRETKEY4AUTHCONFIG==";
const PASSWORD = "correct-horse-battery-staple";
const SECOND_PASSWORD = "a-second-horse-battery-staple-42";
const EMAIL_DOMAIN = "@t0508.example.test";
const BASE_URL = "http://127.0.0.1:3000";
const PREFIX = "t0508";

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

function readBaUrls(): string {
  let reference: string | undefined;
  for (const variable of BA_URL_VARIABLES) {
    const raw = process.env[variable]?.trim();
    if (!raw) {
      throw new Error(
        `${variable} is required: the admin-account-routes suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
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

async function cleanupFixture(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(
    `DROP TABLE IF EXISTS ${SUITE_TABLES.map((name) => `"${name}"`).join(", ")} CASCADE`,
  );
  // The migration chain this suite applies creates the auth_* controlled
  // function family; leaving them behind fails the T02.06.01 whole-database
  // leak check for every suite that runs afterwards.
  await sql.unsafe(`
    DO $$
    DECLARE target text;
    BEGIN
      FOR target IN SELECT proname::text FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND position('auth_' in proname) = 1
      LOOP
        EXECUTE format('DROP FUNCTION IF EXISTS public.%I CASCADE', target);
      END LOOP;
    END $$;
  `);
  const [auditTable] =
    await sql`SELECT to_regclass('public.enterprise_audit_events') AS reg`;
  if (auditTable?.reg) {
    await sql`DELETE FROM enterprise_audit_events WHERE actor_id LIKE ${`${PREFIX}-%`} OR payload::text LIKE ${`%${PREFIX}-%`}`;
  }
  await sql`DELETE FROM revoked_access WHERE email LIKE ${`${PREFIX}-%${EMAIL_DOMAIN}`}`;
  await sql`DELETE FROM enterprise_principals WHERE user_id IN (
    SELECT id FROM users WHERE email LIKE ${`${PREFIX}-%${EMAIL_DOMAIN}`})`;
  await sql`DELETE FROM user_roles WHERE user_id IN (
    SELECT id FROM users WHERE email LIKE ${`${PREFIX}-%${EMAIL_DOMAIN}`})`;
  await sql`DELETE FROM users WHERE email LIKE ${`${PREFIX}-%${EMAIL_DOMAIN}`}`;
  await sql`DELETE FROM enterprise_workspaces WHERE tenant_id LIKE ${`${PREFIX}%`}`;
  await sql`DELETE FROM enterprise_tenants WHERE id LIKE ${`${PREFIX}%`}`;
  await sql`DELETE FROM accounts WHERE user_id NOT IN (SELECT id FROM users)`;
  await sql`DELETE FROM sessions WHERE user_id NOT IN (SELECT id FROM users)`;
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
  principalId: string;
}

interface SecurityState {
  principal: { status: string; generation: number }[];
  sessions: string[];
  roles: string[];
  receipts: { operation: string; finalized: boolean }[];
}

interface Harness {
  sql: postgres.Sql;
  baServer: { url: string; stop: (force?: boolean) => void };
  legacyServer: { url: string; stop: (force?: boolean) => void };
  admin: HarnessUser;
  plain: HarnessUser;
  signUp(email: string, name: string): Promise<HarnessUser>;
  signIn(email: string, password: string): Promise<string>;
  sessionAuthorized(cookie: string): Promise<boolean>;
  stateOf(userId: string): Promise<SecurityState>;
  probe(): postgres.Sql;
  close(): Promise<void>;
}

let harness: Harness | undefined;

async function createHarness(): Promise<Harness> {
  const setupUrl = readBaUrls();
  const sql = postgres(setupUrl, {
    max: 4,
    idle_timeout: 5,
    onnotice: () => {},
  });
  try {
    await cleanupFixture(sql);
    for (const path of MIGRATION_PATHS) {
      if (!existsSync(path)) {
        throw new Error(
          `${path} does not exist: the identity command stack this suite pins is the integrated target behavior, not an environment problem.`,
        );
      }
      await sql.unsafe(readFileSync(path, "utf8"));
    }

    const db = createDatabase(setupUrl, { max: 6 });

    /*
     * The production factory, not a hand-built twin: createAuth assembles
     * the fixed build with its own database hooks, its validation gate and
     * — when the deployment wires the directory surface, which the empty
     * wiring object below declares — the transaction capture and the
     * identity executor this task exists to connect. The executor is read
     * back off the instance the same way the assembly will: as a property
     * the caller hands to createApp's `coworker.directory.identity` seam.
     */
    const auth = createAuth(
      {
        auth: {
          baseUrl: BASE_URL,
          secret: BA_SECRET,
          trustedOrigins: [BASE_URL],
          initialAdminEmails: [],
          allowedEmailDomains: [],
          emailPassword: true,
        },
        keyEncryptionKey: KEY_ENCRYPTION_KEY,
      },
      db,
      undefined,
      undefined,
      {},
    );
    await auth.$context;
    const identity = (auth as { directoryIdentity?: unknown } & object)
      .directoryIdentity;

    const config = loadConfig(testEnvironment());
    const buildApp = (executor: unknown) => {
      const args: unknown[] = new Array(createApp.length).fill(undefined);
      args[0] = config;
      args[1] = auth;
      args[2] = createRoleRepository(db);
      args[17] = createPeopleStore(db, []);
      args[25] = db;
      args[34] = executor
        ? { directory: { identity: executor } }
        : { directory: {} };
      return createApp(...(args as never[]));
    };
    const legacyApp = buildApp(null);
    const baApp = buildApp(identity);

    const baServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => baApp.fetch(request),
    });
    const legacyServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => legacyApp.fetch(request),
    });

    const baContext = await auth.$context;
    const signIn = async (email: string, password: string): Promise<string> => {
      const response = await (
        auth.api as unknown as Record<
          string,
          (input: unknown) => Promise<Response>
        >
      ).signInEmail({
        body: { email, password },
        asResponse: true,
      });
      if (response.status !== 200) {
        throw new Error(`signInEmail for ${email} failed: ${response.status}`);
      }
      const setCookie = response.headers.get("set-cookie");
      if (!setCookie) throw new Error("signInEmail returned no session cookie");
      return setCookie.split(";")[0];
    };

    /*
     * The harness user is written directly, the way the sibling suites seed
     * theirs, and signed in through the fixed build's own sign-in endpoint:
     * the production factory's sign-up surface carries the deployment's
     * validateUserInfo gate, which in a cold process has no endpoint context
     * to show for itself — in-process sign-up there answers its named 403
     * before any fixture row exists. The rows below are the same ones that
     * gate would have produced (the build's own password hashing included),
     * and the session is a real one: sign-in mints it and the cookie is
     * read back off the response.
     */
    const signUp = async (
      email: string,
      name: string,
    ): Promise<HarnessUser> => {
      const userId = randomUUID();
      const hashed = await baContext.password.hash(PASSWORD);
      await sql`INSERT INTO users (id, email, name, email_verified, created_at, updated_at)
                VALUES (${userId}, ${email.toLowerCase()}, ${name}, true, now(), now())`;
      await sql`INSERT INTO accounts (id, user_id, account_id, provider_id, issuer, password, created_at, updated_at)
                VALUES (${randomUUID()}, ${userId}, ${userId}, 'credential', 'local:credential', ${hashed}, now(), now())`;
      await sql`INSERT INTO user_roles (user_id, role) VALUES (${userId}, 'user')`;
      const principalId = `${PREFIX}-principal-${randomUUID().slice(0, 12)}`;
      await sql`INSERT INTO enterprise_principals (id, user_id, status, identity_generation)
                VALUES (${principalId}, ${userId}, 'active', 1)`;
      const cookie = await signIn(email, PASSWORD);
      return { userId, email: email.toLowerCase(), cookie, principalId };
    };

    const sessionAuthorized = async (cookie: string): Promise<boolean> => {
      const session = await (
        auth.api as unknown as {
          getSession: (input: {
            headers: Headers;
            query?: { disableCookieCache: boolean };
          }) => Promise<unknown>;
        }
      ).getSession({
        headers: new Headers({ cookie }),
        query: { disableCookieCache: true },
      });
      return session !== null;
    };

    const stateOf = async (userId: string): Promise<SecurityState> => {
      const principals = await sql`
        SELECT status::text AS status, identity_generation::int AS generation
          FROM enterprise_principals WHERE user_id = ${userId}`;
      const sessionRows = await sql`
        SELECT id FROM sessions WHERE user_id = ${userId} ORDER BY id`;
      const roleRows = await sql`
        SELECT role::text AS role FROM user_roles WHERE user_id = ${userId} ORDER BY role`;
      const receiptRows = await sql`
        SELECT operation, finalized FROM auth_command_receipts
         WHERE target_user_id = ${userId} ORDER BY idempotency_key`;
      return {
        principal: principals.map((row) => ({
          status: String(row.status),
          generation: Number(row.generation),
        })),
        sessions: sessionRows.map((row) => String(row.id)),
        roles: roleRows.map((row) => String(row.role)),
        receipts: receiptRows.map((row) => ({
          operation: String(row.operation),
          finalized: Boolean(row.finalized),
        })),
      };
    };

    const admin = await signUp(`${PREFIX}-admin${EMAIL_DOMAIN}`, "Admin");
    await sql`INSERT INTO user_roles (user_id, role) VALUES (${admin.userId}, 'admin')`;
    const plain = await signUp(`${PREFIX}-plain${EMAIL_DOMAIN}`, "Plain");

    return {
      sql,
      baServer: {
        url: `http://127.0.0.1:${baServer.port}`,
        stop: (force?: boolean) => baServer.stop(force),
      },
      legacyServer: {
        url: `http://127.0.0.1:${legacyServer.port}`,
        stop: (force?: boolean) => legacyServer.stop(force),
      },
      admin,
      plain,
      signUp,
      signIn,
      sessionAuthorized,
      stateOf,
      probe: () => postgres(setupUrl, { max: 1, idle_timeout: 5 }),
      close: async () => {
        try {
          baServer.stop(true);
          legacyServer.stop(true);
          await cleanupFixture(sql);
        } finally {
          await sql.end({ timeout: 5 }).catch(() => {});
        }
      },
    };
  } catch (error) {
    await cleanupFixture(sql).catch(() => {});
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
      SELECT 'users:' || id FROM users WHERE email LIKE ${`${PREFIX}-%${EMAIL_DOMAIN}`}
      UNION ALL
      SELECT 'tenants:' || id FROM enterprise_tenants WHERE id LIKE ${`${PREFIX}%`}`;
    expect(leaked).toEqual([]);
  } finally {
    await probe.end({ timeout: 5 }).catch(() => {});
  }
});

/* ------------------------------------------------------------------------- */
/* Helpers for the tests themselves.                                          */
/* ------------------------------------------------------------------------- */

/** One translated native identity write, as a real fetch against the mount. */
async function nativeWrite(
  server: { url: string },
  path: string,
  body: Record<string, unknown>,
  user: HarnessUser,
  idempotencyKey = randomUUID(),
): Promise<Response> {
  if (!harness) throw new Error("the harness is not up");
  return fetch(`${server.url}/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: user.cookie,
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

/** Whether a finalized receipt of exactly this operation names the user. */
async function hasFinalizedReceipt(
  userId: string,
  operation: string,
): Promise<boolean> {
  if (!harness) throw new Error("the harness is not up");
  return (await harness.stateOf(userId)).receipts.some(
    (receipt) => receipt.operation === operation && receipt.finalized,
  );
}

describe("the admin account surface through the real mounts", () => {
  test("admin_create_edit_password_and_revoke_all_are_enveloped", async () => {
    const h = harness!;

    /* (a) create without a credential — the SSO shape: a user, the default
     * role, a principal at generation 1, and no password account at all. */
    const create = await nativeWrite(
      h.baServer,
      "/admin/create-user",
      { email: `${PREFIX}-born${EMAIL_DOMAIN}`, name: "Born" },
      h.admin,
    );
    expect(create.status).toBe(200);
    const born = (await create.json()) as {
      userId: string;
      principalId: string;
      identityGeneration: number;
      replayed: boolean;
    };
    // The target id is the server's pre-allocation, and the receipt binds it.
    expect(born.replayed).toBe(false);
    expect(born.identityGeneration).toBe(1);
    const bornState = await h.stateOf(born.userId);
    expect(bornState.roles).toEqual(["user"]);
    expect(bornState.principal[0]).toEqual({ status: "active", generation: 1 });
    const bornAccounts = await h.sql`
      SELECT provider_id FROM accounts WHERE user_id = ${born.userId}`;
    expect(bornAccounts).toEqual([]);
    expect(await hasFinalizedReceipt(born.userId, "identity.user.create")).toBe(
      true,
    );

    /* (b) the profile edit: the name the command carried, nothing else. */
    const edit = await nativeWrite(
      h.baServer,
      "/admin/update-user",
      { userId: born.userId, name: "Renamed" },
      h.admin,
    );
    expect(edit.status).toBe(200);
    const [profile] = await h.sql`
      SELECT name FROM users WHERE id = ${born.userId}`;
    expect(profile.name).toBe("Renamed");
    expect(
      await hasFinalizedReceipt(born.userId, "identity.profile.update"),
    ).toBe(true);

    /* (c) create WITH a credential, then the administrator's password write:
     * the platform actor demands no recovery token, the same-transaction
     * finalizer kills every session the target had and advances the
     * generation, and the new password is the one that signs in. */
    const created = await nativeWrite(
      h.baServer,
      "/admin/create-user",
      {
        email: `${PREFIX}-passworded${EMAIL_DOMAIN}`,
        name: "Passworded",
        password: PASSWORD,
      },
      h.admin,
    );
    expect(created.status).toBe(200);
    const passworded = (await created.json()) as { userId: string };
    await h.signIn(`${PREFIX}-passworded${EMAIL_DOMAIN}`, PASSWORD);
    await h.signIn(`${PREFIX}-passworded${EMAIL_DOMAIN}`, PASSWORD);
    const before = await h.stateOf(passworded.userId);
    expect(before.sessions.length).toBeGreaterThanOrEqual(2);

    const reset = await nativeWrite(
      h.baServer,
      "/admin/set-user-password",
      {
        userId: passworded.userId,
        newPassword: SECOND_PASSWORD,
        reason: "t0508 administrator reset",
      },
      h.admin,
    );
    expect(reset.status).toBe(200);
    const after = await h.stateOf(passworded.userId);
    expect(after.sessions).toEqual([]);
    expect(after.principal[0]!.generation).toBeGreaterThan(
      before.principal[0]!.generation,
    );
    expect(
      await hasFinalizedReceipt(passworded.userId, "identity.password.reset"),
    ).toBe(true);
    // The deployed credential is a hash, never the plaintext, and no
    // receipt row carries the secret either.
    const [account] = await h.sql`
      SELECT password FROM accounts
       WHERE user_id = ${passworded.userId} AND provider_id = 'credential'`;
    expect(account.password).not.toBe(SECOND_PASSWORD);
    expect(String(account.password)).not.toContain(SECOND_PASSWORD);
    const resetReceipts = await h.sql`
      SELECT * FROM auth_command_receipts
       WHERE target_user_id = ${passworded.userId}
         AND operation = 'identity.password.reset'`;
    expect(JSON.stringify(resetReceipts)).not.toContain(SECOND_PASSWORD);
    // The old password is dead and the new one works.
    await expect(
      h.signIn(`${PREFIX}-passworded${EMAIL_DOMAIN}`, PASSWORD),
    ).rejects.toThrow();
    const freshCookie = await h.signIn(
      `${PREFIX}-passworded${EMAIL_DOMAIN}`,
      SECOND_PASSWORD,
    );
    expect(await h.sessionAuthorized(freshCookie)).toBe(true);

    /* (d) the batch session revocation: every session dies, the long-lived
     * generation does not move (a session sweep is not an identity change). */
    const generationBeforeSweep = (await h.stateOf(passworded.userId))
      .principal[0]!.generation;
    const sweep = await nativeWrite(
      h.baServer,
      "/admin/revoke-user-sessions",
      { userId: passworded.userId, reason: "t0508 batch revoke" },
      h.admin,
    );
    expect(sweep.status).toBe(200);
    const swept = await h.stateOf(passworded.userId);
    expect(swept.sessions).toEqual([]);
    expect(swept.principal[0]!.generation).toBe(generationBeforeSweep);
    expect(
      await hasFinalizedReceipt(passworded.userId, "identity.sessions.revoke"),
    ).toBe(true);

    /* (e) the deploy arm: a password write for a target with no credential
     * (the user from (a)) deploys one, and it signs in. */
    const deploy = await nativeWrite(
      h.baServer,
      "/admin/set-user-password",
      {
        userId: born.userId,
        newPassword: SECOND_PASSWORD,
        reason: "t0508 credential deploy",
      },
      h.admin,
    );
    expect(deploy.status).toBe(200);
    const deployedCookie = await h.signIn(
      `${PREFIX}-born${EMAIL_DOMAIN}`,
      SECOND_PASSWORD,
    );
    expect(await h.sessionAuthorized(deployedCookie)).toBe(true);

    /* The envelope itself: every observable account write above is named by
     * a finalized receipt of its own operation. */
    const arms: ReadonlyArray<[string, string]> = [
      [born.userId, "identity.user.create"],
      [born.userId, "identity.profile.update"],
      [born.userId, "identity.password.reset"],
      [passworded.userId, "identity.user.create"],
      [passworded.userId, "identity.password.reset"],
      [passworded.userId, "identity.sessions.revoke"],
    ];
    const unenvelopedWrites = (
      await Promise.all(
        arms.map(([userId, operation]) =>
          hasFinalizedReceipt(userId, operation).then((found) =>
            found ? null : `${operation}:${userId}`,
          ),
        ),
      )
    ).filter((entry): entry is string => entry !== null).length;
    expect(unenvelopedWrites).toBe(0);
  });

  test("arbitrary_profile_security_fields_and_impersonation_are_rejected", async () => {
    const h = harness!;
    const target = await h.signUp(`${PREFIX}-guard${EMAIL_DOMAIN}`, "Guard");
    const emailBefore = (
      await h.sql`SELECT email FROM users WHERE id = ${target.userId}`
    )[0].email;

    // A body whose only edits are security fields is refused whole: the
    // translated account surface writes name/image only, and the ingress
    // refuses a request that carries anything else rather than trimming it
    // to its editable half and reporting a write that never happened.
    for (const body of [
      { userId: target.userId, email: `${PREFIX}-hijack${EMAIL_DOMAIN}` },
      { userId: target.userId, emailVerified: true },
      { userId: target.userId, role: "admin" },
      { userId: target.userId, banned: true },
      { userId: target.userId, banReason: "smuggled" },
      { userId: target.userId, data: { arbitrary: "payload" } },
    ] as Record<string, unknown>[]) {
      const response = await nativeWrite(
        h.baServer,
        "/admin/update-user",
        body,
        h.admin,
      );
      expect(response.status).toBe(403);
      expect(((await response.json()) as { code?: string }).code).toBe(
        "NATIVE_AUTH_PROFILE_FIELDS_NOT_WRITABLE",
      );
    }
    // The refusal reaches the create surface too: a create-user body may
    // carry its first credential, never a role or a status.
    const smugglingCreate = await nativeWrite(
      h.baServer,
      "/admin/create-user",
      {
        email: `${PREFIX}-smuggled${EMAIL_DOMAIN}`,
        name: "Smuggled",
        role: "admin",
      },
      h.admin,
    );
    expect(smugglingCreate.status).toBe(403);

    // A mixed body is refused the same way — the whole request, not just
    // its editable half — and nothing moves: the email, the name, the role
    // and the receipts are exactly what they were.
    const before = await h.stateOf(target.userId);
    const mixed = await nativeWrite(
      h.baServer,
      "/admin/update-user",
      {
        userId: target.userId,
        name: "SafeName",
        email: `${PREFIX}-hijack${EMAIL_DOMAIN}`,
        role: "admin",
      },
      h.admin,
    );
    expect(mixed.status).toBe(403);
    expect(await h.stateOf(target.userId)).toEqual(before);
    const [mixedProfile] = await h.sql`
      SELECT name, email FROM users WHERE id = ${target.userId}`;
    expect(mixedProfile.email).toBe(emailBefore);
    expect(mixedProfile.name).not.toBe("SafeName");

    // The closed surface: impersonation and removal are refused outright,
    // on both arms of the matrix, and the target survives both refusals.
    for (const server of [h.baServer, h.legacyServer]) {
      const impersonation = await nativeWrite(
        server,
        "/admin/impersonate-user",
        { userId: target.userId },
        h.admin,
      );
      expect(impersonation.status).toBe(403);
      const removal = await nativeWrite(
        server,
        "/admin/remove-user",
        { userId: target.userId },
        h.admin,
      );
      expect(removal.status).toBe(403);
    }
    const survivors = await h.sql`
      SELECT count(*)::int AS n FROM users WHERE id = ${target.userId}`;
    expect(survivors[0].n).toBe(1);
  });

  test("non_admin_cannot_create_users", async () => {
    const h = harness!;
    const email = `${PREFIX}-denied${EMAIL_DOMAIN}`;
    const response = await nativeWrite(
      h.baServer,
      "/admin/create-user",
      { email, name: "Denied" },
      h.plain,
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("NATIVE_AUTH_ADMIN_REQUIRED");
    const users = await h.sql`
      SELECT count(*)::int AS n FROM users WHERE email = ${email}`;
    expect(users[0].n).toBe(0);
  });

  test("legacy_arm_refuses_writes_without_executor", async () => {
    const h = harness!;
    const before = (await h.sql`SELECT count(*)::int AS n FROM users`)[0].n;
    for (const [path, body] of [
      [
        "/admin/create-user",
        { email: `${PREFIX}-legacy${EMAIL_DOMAIN}`, name: "Legacy" },
      ],
      ["/admin/update-user", { userId: h.admin.userId, name: "LegacyName" }],
      [
        "/admin/set-user-password",
        {
          userId: h.admin.userId,
          newPassword: SECOND_PASSWORD,
          reason: "t0508 legacy arm",
        },
      ],
    ] as [string, Record<string, unknown>][]) {
      const response = await nativeWrite(h.legacyServer, path, body, h.admin);
      expect(response.status).toBe(503);
      const bodyOf = (await response.json()) as { code?: string };
      expect(bodyOf.code).toBe("IDENTITY_INGRESS_EXECUTOR_UNWIRED");
    }
    const after = (await h.sql`SELECT count(*)::int AS n FROM users`)[0].n;
    expect(after).toBe(before);
  });
});
