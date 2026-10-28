import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { sql as dsql } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { createApp } from "../../src/app";
import type { DirectoryTx } from "../../src/auth/directory/contracts";
import { createIdentityFinalizer } from "../../src/auth/directory/finalizer";
import { createIdentityExecutor } from "../../src/auth/directory/identity";
import { principalRegistry } from "../../src/auth/directory/principal-registry";
import { createTransactionBoundBa } from "../../src/auth/directory/transaction-adapter";
import {
  createRequireUser,
  createRoleRepository,
  requireAdmin,
} from "../../src/auth/guards";
import { loadConfig } from "../../src/config";
import { createDatabase } from "../../src/db/client";
import {
  accounts,
  sessions,
  users,
  verifications,
} from "../../src/db/schema/core";
import { createPeopleStore } from "../../src/people/store";
import { testEnvironment } from "../support/environment";

/*
 * T05.07 (#563, original task P12) — the admin's global disable/restore,
 * role.set and session revocations are one identity command each, behind a
 * realtime platform actor, on the real 0209–0216/0218–0220 stack of the
 * isolated BA_TEST_* island (interfaces §2.1/§3.2; acceptance F1/M1).
 *
 * The three named behaviors, as facts:
 *
 * - `global_disable_invalidates_all_old_sessions`: one ban-user command
 *   through the mounted native surface leaves the target's every session
 *   dead (expect(oldSessionAuthorized).toBe(false)), the principal suspended
 *   with an ADVANCED generation, and the restore that follows does not
 *   resurrect what the disable killed — the old session stays dead.
 * - `identity_each_security_write_failure_rolls_back`: a fault thrown at each
 *   security write of the disable/restore/role.set/session-revoke commands —
 *   the receipt begin stamp, the principal/generation UPDATE, the session
 *   DELETE, the role pair, the finalize stamp — refuses the whole command
 *   with expect(after).toEqual(before); a leftover armed fault fails the arm
 *   loudly (it named a write the command never issues), and a clean command
 *   afterwards still succeeds, so a rolled-back arm poisons nothing.
 * - `company_admin_cannot_disable_global_user`: a company owner — a full
 *   directory member with the owner role in an organization — holds no
 *   platform authority: the native disable answers 403
 *   (expect(status).toBe(403)) and writes nothing, because the platform
 *   actor's gate reads the global user_roles domain in realtime, never a
 *   company role.
 *
 * The mounting is the real one: the production createApp carries the
 * production identity executor through the same `coworker.directory` seam
 * the assembly uses, a Bun server answers real fetches, and the deployment's
 * own admin screen (`/api/admin/people/...`) is exercised on both arms of
 * the matrix — with the executor assembled its security writes are identity
 * commands (a receipt names every one), and without it the legacy write and
 * DTO answer exactly as before.
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

const BA_SECRET = "t0507-global-identity-routes-fixed-test-secret";
const PASSWORD = "correct-horse-battery-staple";
const EMAIL_DOMAIN = "@t0507.example.test";
const BASE_URL = "http://127.0.0.1:3000";
const TENANT = "t0507-tenant";
const TENANT_NAME = "T0507 Company Admin Tenant";
const PREFIX = "t0507";

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
        `${variable} is required: the global-identity-routes suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
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
  companyAdmin: HarnessUser;
  auth: Awaited<ReturnType<typeof betterAuth>>;
  signUp(email: string, name: string): Promise<HarnessUser>;
  secondSession(user: HarnessUser): Promise<HarnessUser>;
  sessionAuthorized(user: HarnessUser): Promise<boolean>;
  armFault(pattern: string): void;
  faultArmed(): boolean;
  stateOf(userId: string): Promise<SecurityState>;
  probe(): postgres.Sql;
  close(): Promise<void>;
}

/**
 * The drizzle SQL text of a statement, so a fault can be named by the write
 * it refuses — the registry/builder statements carry no chunks and are left
 * alone; every security write of the identity command is a raw `sql` call.
 */
const textOf = (chunk: unknown): string => {
  if (typeof chunk === "string") return chunk;
  if (Array.isArray(chunk)) return chunk.map(textOf).join("");
  if (chunk && typeof chunk === "object") {
    if ("queryChunks" in chunk) {
      return textOf((chunk as { queryChunks: unknown[] }).queryChunks);
    }
    if ("value" in chunk) {
      return textOf((chunk as { value: unknown }).value);
    }
  }
  return "";
};

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
    await sql`INSERT INTO enterprise_tenants (id, name) VALUES (${TENANT}, ${TENANT_NAME})`;

    const db = createDatabase(setupUrl, { max: 6 });

    const baSchema = {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
    };
    let resolvedOptions: unknown;
    const auth = betterAuth({
      secret: BA_SECRET,
      baseURL: BASE_URL,
      trustedOrigins: [BASE_URL],
      emailAndPassword: { enabled: true, minPasswordLength: 8 },
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

    const bound = createTransactionBoundBa({
      createTxAdapter: (tx: DirectoryTx) =>
        drizzleAdapter(tx as never, {
          provider: "pg",
          schema: baSchema as never,
          transaction: false,
        })(resolvedOptions as never),
    });

    /*
     * The fault point of the second named case: the executor's transaction
     * wrapper refuses the FIRST statement that carries the armed pattern,
     * once, and the whole command must refuse with it. The registry's own
     * inserts ride the same rollback, which is the "Principal" arm of the
     * matrix (a rolled-back create leaves no principal row at all).
     */
    let faultPattern: string | null = null;
    const wrapTx = (tx: DirectoryTx): DirectoryTx =>
      new Proxy(tx, {
        get(target, property) {
          if (property === "execute") {
            return async (query: unknown) => {
              if (
                faultPattern !== null &&
                textOf(query).includes(faultPattern)
              ) {
                faultPattern = null;
                throw new Error(
                  `T0507_SECURITY_WRITE_FAULT: the armed security write refused inside the command transaction`,
                );
              }
              return target.execute(query as never);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    const faultDb = {
      transaction: (callback: Parameters<typeof db.transaction>[0]) =>
        db.transaction((tx) => callback(wrapTx(tx as never) as never)),
    } as unknown as Parameters<typeof createIdentityExecutor>[0]["database"];

    const identity = createIdentityExecutor({
      database: faultDb,
      bound,
      registry: principalRegistry,
      finalizer: createIdentityFinalizer(),
      ba: {
        createUser: async () => {
          throw new Error("T0507_BA_CREATE_USER_NOT_EXERCISED");
        },
        writePassword: async () => {
          throw new Error("T0507_BA_WRITE_PASSWORD_NOT_EXERCISED");
        },
        consumeResetToken: async () => {
          throw new Error("T0507_BA_CONSUME_RESET_TOKEN_NOT_EXERCISED");
        },
      },
      commitmentKey: createHash("sha256").update(BA_SECRET).digest(),
    });

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

    const signUp = async (
      email: string,
      name: string,
    ): Promise<HarnessUser> => {
      const response = await (
        auth.api as unknown as Record<
          string,
          (input: unknown) => Promise<Response>
        >
      ).signUpEmail({
        body: { email, password: PASSWORD, name },
        asResponse: true,
      });
      if (response.status !== 200) {
        throw new Error(`signUpEmail for ${email} failed: ${response.status}`);
      }
      const setCookie = response.headers.get("set-cookie");
      if (!setCookie) throw new Error("signUpEmail returned no session cookie");
      const body = (await response.json()) as { user: { id: string } };
      const userId = body.user.id;
      /*
       * The floor every signed-in person carries, and the principal the
       * identity commands lock through: this suite reads both before its
       * first command runs, so the harness writes the two rows the way the
       * deployment's own sign-in bootstrap does (bare inserts on the two
       * unguarded tables, the same fixture shape every sibling suite uses).
       */
      await sql`INSERT INTO user_roles (user_id, role) VALUES (${userId}, 'user')`;
      const principalId = `${PREFIX}-principal-${randomUUID().slice(0, 12)}`;
      await sql`INSERT INTO enterprise_principals (id, user_id, status, identity_generation)
                VALUES (${principalId}, ${userId}, 'active', 1)`;
      return {
        userId,
        email: email.toLowerCase(),
        cookie: setCookie.split(";")[0],
        principalId,
      };
    };

    const admin = await signUp(`${PREFIX}-admin${EMAIL_DOMAIN}`, "Admin");
    await sql`INSERT INTO user_roles (user_id, role) VALUES (${admin.userId}, 'admin')`;

    /*
     * The company administrator of the third named case: a full directory
     * member with the owner role in an organization, and no global role —
     * the 0214 DML guard owns these tables, so the fixture rides the real
     * command protocol the way every suite before this one wrote it.
     */
    const companyAdmin = await signUp(
      `${PREFIX}-company-admin${EMAIL_DOMAIN}`,
      "CompanyAdmin",
    );
    // The company owner's principal is the one signUp created; the fixture's
    // projection below refers to it.
    await db.transaction(async (tx) => {
      const commandId = `${PREFIX}-fixture-command`;
      await tx.execute(dsql`
        SELECT set_config('auth.current_command', public.auth_directory_begin_command(
          ${commandId}, 'company', 'company.provision', ${TENANT}, null,
          null, 'migration', ${`${PREFIX}-fixture-key`},
          ${`${PREFIX}-fixture-payload-hash`}), true)`);
      await tx.execute(dsql`
        INSERT INTO auth_organizations (id, name, slug)
        VALUES (${TENANT}, ${TENANT_NAME}, 't0507-company-admin')`);
      await tx.execute(dsql`
        INSERT INTO auth_members (id, organization_id, user_id, role)
        VALUES (${`${PREFIX}-owner-member`}, ${TENANT}, ${companyAdmin.userId}, 'owner')`);
      await tx.execute(
        dsql`SELECT public.auth_project_company_membership(
               ${TENANT}, ${companyAdmin.principalId}, 'tenant_admin', 'active', 1, ${commandId})`,
      );
      await tx.execute(
        dsql`SELECT public.auth_advance_eligibility_clock(
               ${TENANT}, ${companyAdmin.principalId}, 'company', ${TENANT}, 1, 1, false, ${commandId})`,
      );
      await tx.execute(
        dsql`SELECT public.auth_directory_finalize_command(${commandId})`,
      );
      await tx.execute(
        dsql`SELECT set_config('auth.current_command', '', true)`,
      );
      await tx.execute(dsql`SET CONSTRAINTS ALL IMMEDIATE`);
    });

    const secondSession = async (user: HarnessUser): Promise<HarnessUser> => {
      const response = await (
        auth.api as unknown as Record<
          string,
          (input: unknown) => Promise<Response>
        >
      ).signInEmail({
        body: { email: user.email, password: PASSWORD },
        asResponse: true,
      });
      if (response.status !== 200) {
        throw new Error(
          `signInEmail for ${user.email} failed: ${response.status}`,
        );
      }
      const setCookie = response.headers.get("set-cookie");
      if (!setCookie) throw new Error("signInEmail returned no session cookie");
      return { ...user, cookie: setCookie.split(";")[0] };
    };

    const sessionAuthorized = async (user: HarnessUser): Promise<boolean> => {
      const session = await (
        auth.api as unknown as {
          getSession: (input: {
            headers: Headers;
            query?: { disableCookieCache: boolean };
          }) => Promise<unknown>;
        }
      ).getSession({
        headers: new Headers({ cookie: user.cookie }),
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
      companyAdmin,
      auth,
      signUp,
      secondSession,
      sessionAuthorized,
      armFault: (pattern: string) => {
        faultPattern = pattern;
      },
      faultArmed: () => faultPattern !== null,
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

/** The deployment's own admin screen action, as a real fetch against the app. */
async function peopleWrite(
  server: { url: string },
  path: "role" | "access",
  userId: string,
  body: Record<string, unknown>,
  user: HarnessUser,
): Promise<Response> {
  if (!harness) throw new Error("the harness is not up");
  return fetch(`${server.url}/api/admin/people/${userId}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: user.cookie },
    body: JSON.stringify(body),
  });
}

describe("the global identity surface through the real mounts", () => {
  test("global_disable_invalidates_all_old_sessions", async () => {
    const target = await harness!.signUp(
      `${PREFIX}-disable-target${EMAIL_DOMAIN}`,
      "DisableTarget",
    );
    const oldSession = await harness!.secondSession(target);
    const before = await harness!.stateOf(target.userId);
    expect(before.sessions.length).toBeGreaterThanOrEqual(2);
    expect(before.principal[0]?.status).toBe("active");

    const response = await nativeWrite(
      harness!.baServer,
      "/admin/ban-user",
      { userId: target.userId, reason: "t0507 global disable" },
      harness!.admin,
    );
    expect(response.status).toBe(200);

    const after = await harness!.stateOf(target.userId);
    expect(after.sessions).toEqual([]);
    expect(after.principal[0]?.status).toBe("suspended");
    expect(after.principal[0]?.generation).toBeGreaterThan(
      before.principal[0]!.generation,
    );
    expect(
      after.receipts.some(
        (receipt) =>
          receipt.operation === "identity.disable" && receipt.finalized,
      ),
    ).toBe(true);

    const oldSessionAuthorized = await harness!.sessionAuthorized(oldSession);
    expect(oldSessionAuthorized).toBe(false);

    // The restore is its own command and hands out no authority the disable
    // took away: the generation advances again and the old session stays dead.
    const restore = await nativeWrite(
      harness!.baServer,
      "/admin/unban-user",
      { userId: target.userId, reason: "t0507 restore" },
      harness!.admin,
    );
    expect(restore.status).toBe(200);
    const restored = await harness!.stateOf(target.userId);
    expect(restored.principal[0]?.status).toBe("active");
    expect(restored.principal[0]?.generation).toBeGreaterThan(
      after.principal[0]!.generation,
    );
    expect(await harness!.sessionAuthorized(oldSession)).toBe(false);
  });

  test("identity_each_security_write_failure_rolls_back", async () => {
    const cases: ReadonlyArray<{
      operation: string;
      path: string;
      body: (
        userId: string,
        sessionId: string | null,
      ) => Record<string, unknown>;
      patterns: readonly string[];
      prepare?: (userId: string) => Promise<void>;
    }> = [
      {
        operation: "identity.disable",
        path: "/admin/ban-user",
        body: (userId) => ({ userId, reason: "t0507 fault arm" }),
        patterns: [
          "auth_directory_begin_command",
          "UPDATE enterprise_principals",
          "DELETE FROM sessions",
          "auth_directory_finalize_command",
        ],
      },
      {
        operation: "identity.restore",
        path: "/admin/unban-user",
        body: (userId) => ({ userId, reason: "t0507 fault arm" }),
        patterns: [
          "auth_directory_begin_command",
          "UPDATE enterprise_principals",
          "DELETE FROM sessions",
          "auth_directory_finalize_command",
        ],
        prepare: async (userId) => {
          await nativeWrite(
            harness!.baServer,
            "/admin/ban-user",
            { userId, reason: "t0507 prepare disable" },
            harness!.admin,
          );
        },
      },
      {
        operation: "identity.role.set",
        path: "/admin/set-role",
        body: (userId) => ({
          userId,
          role: "admin",
          reason: "t0507 fault arm",
        }),
        patterns: [
          "auth_directory_begin_command",
          "DELETE FROM user_roles",
          "INSERT INTO user_roles",
          "auth_directory_finalize_command",
        ],
      },
      {
        operation: "identity.session.revoke",
        path: "/admin/revoke-user-session",
        body: (userId, sessionId) => ({
          userId,
          sessionId: sessionId ?? "",
          reason: "t0507 fault arm",
        }),
        patterns: ["DELETE FROM sessions", "auth_directory_finalize_command"],
      },
      {
        operation: "identity.sessions.revoke",
        path: "/admin/revoke-user-sessions",
        body: (userId) => ({ userId, reason: "t0507 fault arm" }),
        patterns: ["DELETE FROM sessions", "auth_directory_finalize_command"],
      },
    ];

    for (const faultCase of cases) {
      for (const pattern of faultCase.patterns) {
        const email = `${PREFIX}-fault-${randomUUID().slice(0, 8)}${EMAIL_DOMAIN}`;
        const user = await harness!.signUp(email, "FaultArm");
        await harness!.secondSession(user);
        const [sessionRow] = await harness!.sql`
          SELECT id FROM sessions WHERE user_id = ${user.userId} ORDER BY id LIMIT 1`;
        if (faultCase.prepare) await faultCase.prepare(user.userId);

        const before = await harness!.stateOf(user.userId);
        harness!.armFault(pattern);
        const response = await nativeWrite(
          harness!.baServer,
          faultCase.path,
          faultCase.body(
            user.userId,
            sessionRow ? String(sessionRow.id) : null,
          ),
          harness!.admin,
        );
        // The armed write really ran: a leftover armed fault means the arm
        // named a statement this command never issues, and the arm fails
        // loudly instead of passing vacuously.
        expect(harness!.faultArmed()).toBe(false);
        expect(response.status).toBeGreaterThanOrEqual(400);
        const after = await harness!.stateOf(user.userId);
        expect(after).toEqual(before);
      }
    }

    // A rolled-back arm poisons nothing: the same surface takes a clean
    // disable right after the whole fault matrix.
    const clean = await harness!.signUp(
      `${PREFIX}-fault-clean${EMAIL_DOMAIN}`,
      "FaultClean",
    );
    const response = await nativeWrite(
      harness!.baServer,
      "/admin/ban-user",
      { userId: clean.userId, reason: "t0507 clean after faults" },
      harness!.admin,
    );
    expect(response.status).toBe(200);
    expect((await harness!.stateOf(clean.userId)).principal[0]?.status).toBe(
      "suspended",
    );
  });

  test("company_admin_cannot_disable_global_user", async () => {
    const target = await harness!.signUp(
      `${PREFIX}-company-target${EMAIL_DOMAIN}`,
      "CompanyTarget",
    );
    const before = await harness!.stateOf(target.userId);

    const response = await nativeWrite(
      harness!.baServer,
      "/admin/ban-user",
      { userId: target.userId, reason: "t0507 company admin attempt" },
      harness!.companyAdmin,
    );
    const status = response.status;
    const body = (await response.json()) as { code?: string };
    expect(status).toBe(403);
    expect(body.code).toBe("NATIVE_AUTH_ADMIN_REQUIRED");
    expect(await harness!.stateOf(target.userId)).toEqual(before);
  });

  test("single_and_batch_session_revoke_keep_the_long_term_generation", async () => {
    const target = await harness!.signUp(
      `${PREFIX}-session-target${EMAIL_DOMAIN}`,
      "SessionTarget",
    );
    const second = await harness!.secondSession(target);
    const before = await harness!.stateOf(target.userId);
    expect(before.sessions.length).toBe(2);

    // One named session dies, the other lives, and the long-term identity
    // generation does not move. The id revoked is whichever one the second
    // sign-in did NOT carry — session ids are not chronological.
    // The second sign-in's row is the newest one (cookie values are signed,
    // not raw ids, so the id is read from the table).
    const [newest] = await harness!.sql`
      SELECT id FROM sessions WHERE user_id = ${target.userId}
       ORDER BY created_at DESC LIMIT 1`;
    const secondId = String(newest.id);
    const doomedId = before.sessions.find((id) => id !== secondId);
    if (!doomedId) throw new Error("the target did not hold two sessions");
    const single = await nativeWrite(
      harness!.baServer,
      "/admin/revoke-user-session",
      {
        userId: target.userId,
        sessionId: doomedId,
        reason: "t0507 single revoke",
      },
      harness!.admin,
    );
    expect(single.status).toBe(200);
    const afterSingle = await harness!.stateOf(target.userId);
    expect(afterSingle.sessions).toEqual([secondId]);
    expect(afterSingle.principal[0]?.generation).toBe(
      before.principal[0]!.generation,
    );
    expect(await harness!.sessionAuthorized(second)).toBe(true);

    const batch = await nativeWrite(
      harness!.baServer,
      "/admin/revoke-user-sessions",
      { userId: target.userId, reason: "t0507 batch revoke" },
      harness!.admin,
    );
    expect(batch.status).toBe(200);
    const afterBatch = await harness!.stateOf(target.userId);
    expect(afterBatch.sessions).toEqual([]);
    expect(afterBatch.principal[0]?.generation).toBe(
      before.principal[0]!.generation,
    );
    expect(await harness!.sessionAuthorized(second)).toBe(false);
  });

  test("people_role_change_runs_through_identity_when_assembled", async () => {
    const target = await harness!.signUp(
      `${PREFIX}-people-role${EMAIL_DOMAIN}`,
      "PeopleRole",
    );

    const response = await peopleWrite(
      harness!.baServer,
      "role",
      target.userId,
      { role: "admin" },
      harness!.admin,
    );
    expect(response.status).toBe(200);
    const person = ((await response.json()) as { person: { role: string } })
      .person;
    // The legacy DTO is the answer both arms give.
    expect(person.role).toBe("admin");
    const state = await harness!.stateOf(target.userId);
    expect(state.roles).toEqual(["admin"]);
    expect(
      state.receipts.some(
        (receipt) => receipt.operation === "identity.role.set",
      ),
    ).toBe(true);
    // An effective role change is a security-state change: the generation
    // (born 1 at sign-up) advances, and the live session the target carried
    // does not survive the privilege change.
    expect(state.principal[0]?.generation).toBe(2);
    expect(await harness!.sessionAuthorized(target)).toBe(false);
  });

  test("people_access_revoke_and_restore_run_through_identity", async () => {
    const target = await harness!.signUp(
      `${PREFIX}-people-access${EMAIL_DOMAIN}`,
      "PeopleAccess",
    );
    const oldSession = await harness!.secondSession(target);
    const before = await harness!.stateOf(target.userId);

    const revoke = await peopleWrite(
      harness!.baServer,
      "access",
      target.userId,
      { revoked: true },
      harness!.admin,
    );
    expect(revoke.status).toBe(200);
    const revokedState = await harness!.stateOf(target.userId);
    expect(revokedState.principal[0]?.status).toBe("suspended");
    expect(revokedState.principal[0]?.generation).toBeGreaterThan(
      before.principal[0]!.generation,
    );
    expect(revokedState.sessions).toEqual([]);
    expect(
      revokedState.receipts.some(
        (receipt) => receipt.operation === "identity.disable",
      ),
    ).toBe(true);
    // The legacy sign-in block the screen always wrote is still there: the
    // identity command adds the discipline, it does not remove the blocklist.
    const [blocklist] = await harness!.sql`
      SELECT email FROM revoked_access WHERE email = ${target.email}`;
    expect(blocklist?.email).toBe(target.email);
    expect(await harness!.sessionAuthorized(oldSession)).toBe(false);

    const restore = await peopleWrite(
      harness!.baServer,
      "access",
      target.userId,
      { revoked: false },
      harness!.admin,
    );
    expect(restore.status).toBe(200);
    const restored = await harness!.stateOf(target.userId);
    expect(restored.principal[0]?.status).toBe("active");
    expect(
      restored.receipts.some(
        (receipt) => receipt.operation === "identity.restore",
      ),
    ).toBe(true);
    const [unblocked] = await harness!.sql`
      SELECT email FROM revoked_access WHERE email = ${target.email}`;
    expect(unblocked).toBeUndefined();
    // restore hands out no authority the disable took away.
    expect(await harness!.sessionAuthorized(oldSession)).toBe(false);
  });

  test("people_screen_keeps_the_legacy_write_and_dto_without_executor", async () => {
    const target = await harness!.signUp(
      `${PREFIX}-legacy-role${EMAIL_DOMAIN}`,
      "LegacyRole",
    );

    const response = await peopleWrite(
      harness!.legacyServer,
      "role",
      target.userId,
      { role: "admin" },
      harness!.admin,
    );
    expect(response.status).toBe(200);
    const person = ((await response.json()) as { person: { role: string } })
      .person;
    expect(person.role).toBe("admin");
    const state = await harness!.stateOf(target.userId);
    expect(state.roles).toEqual(["admin"]);
    // The legacy arm writes no identity command: no receipt names this
    // write (the principal row is the one signUp created, not a command's).
    expect(state.receipts).toEqual([]);

    // The native surface keeps its honest degradation on the same arm: the
    // translated write refuses with 503 rather than writing bare.
    const native = await nativeWrite(
      harness!.legacyServer,
      "/admin/ban-user",
      { userId: target.userId, reason: "t0507 legacy native" },
      harness!.admin,
    );
    const body = (await native.json()) as { code?: string };
    expect(native.status).toBe(503);
    expect(body.code).toBe("IDENTITY_INGRESS_EXECUTOR_UNWIRED");
  });

  test("platform_gate_reads_the_global_role_realtime_never_a_session_carried_one", async () => {
    if (!harness) throw new Error("the harness is not up");
    const app = new Hono();
    app.use(
      "*",
      createRequireUser(
        {
          handler: () => new Response(null, { status: 204 }),
          api: {
            getSession: async () => ({
              // A company (organization) authority's word about a membership,
              // never the deployment's: the gate must not take it.
              user: {
                id: harness.companyAdmin.userId,
                email: harness.companyAdmin.email,
                role: "admin" as const,
              },
            }),
          },
        },
        createRoleRepository(
          createDatabase(process.env[DATABASE_VARIABLE]!.trim(), { max: 1 }),
        ),
      ),
    );
    app.get(
      "/who",
      (context) =>
        requireAdmin(context) ?? context.json({ id: context.var.actor.id }),
    );
    const response = await app.request("http://127.0.0.1/who", {
      headers: { cookie: "session=anything" },
    });
    expect(response.status).toBe(403);
  });
});
