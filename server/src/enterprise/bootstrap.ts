/**
 * The standalone enterprise entry's bootstrap, per plan 02 §7 T3-C.
 *
 * This module is the one place the enterprise entry's real dependencies are assembled: three
 * least-privilege pools (auth / directory / data — one database, three logins, each able to reach
 * only what its capability role was granted), the deployment revocation list read through the auth
 * login, the auth factory wrapped so EVERY session validation re-checks revocation (a removed
 * person keeps their cookie but never keeps their session), the local authorization engine, and
 * the resource reader. Nothing here loads a Go, Intelligence or model module: the entry boots from
 * identity configuration alone (TEN-15).
 *
 * BEFORE anything listens, every login is checked against the live database (step 3, TEN-16). A
 * `SELECT 1` proves a server exists; it proves nothing about who logged in. What is checked
 * instead, per connection:
 *
 *   - the login is neither superuser nor BYPASSRLS;
 *   - the login is a member of neither operator capability role;
 *   - the login cannot `pg_has_role(..., relowner, 'MEMBER')` its way to any enterprise table's
 *     owner — because NOSUPERUSER alone does not stop a `SET ROLE` to the owner;
 *   - and for the directory and data logins, every enterprise table exists with ENABLE + FORCE
 *     row-level security. The identity login is NOT asked for RLS on the identity tables (they
 *     carry none today); it is only asked to hold no enterprise powers.
 *
 * Readiness (step 4) probes exactly the three databases the entry depends on — one `LIMIT 0`
 * statement per database inside its own short-timeout transaction, touching no customer rows and
 * calling no external authorization service — and caches the HEALTH ANSWER (never an authorization
 * decision) for one second. Draining turns ready=false immediately; a temporary database failure
 * keeps the process live and ready=false (TEN-19).
 *
 * Every statement below is a module-constant text executed through `unsafe` with no parameters, per
 * plan 02 §4.2: no runtime value is ever interpolated into SQL in this module (the revocation check
 * uses the query builder's bound parameters).
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getLogger } from "../../../shared/logger";
import { createAuth } from "../auth";
import type { AuthService } from "../auth/guards";
import { createDatabase, type Database } from "../db/client";
import { revokedAccess } from "../db/schema";
import { createEnterpriseApp } from "./app";
import { createResourceReader } from "./authz/repository";
import { createAuthz } from "./authz/service";
import type { EnterpriseConfig, RedactedSecurityError } from "./config";
import { createDirectory } from "./tenancy/directory";
const log = getLogger("server");

/**
 * The pool seam, per plan T3-C step 1: tests inject a factory whose third call fails, so a boot
 * that dies part-way can be held to closing what it already opened. The pool size travels with the
 * factory call rather than being decided inside it, because the plan's verified defaults (2 / 2 / 4)
 * belong to the bootstrap, not to whichever database happens to be named.
 */
export type DatabaseFactory = (url: string, pool: { max: number }) => Database;

export type EnterpriseProcess = {
  app: ReturnType<typeof createEnterpriseApp>;
  /** Synchronously starts draining: ready=false at once, new business requests refused 503. */
  beginDrain: () => void;
  /** Closes every pool the bootstrap opened; a failed close is a stable error, not silence. */
  close: () => Promise<void>;
};

/* ---------------------------------------------------------------------------
 * The startup role and schema checks. Static statement text: every identifier
 * below is a compile-time constant, and no runtime value is ever interpolated.
 * ------------------------------------------------------------------------- */

const SELECT_LOGIN_ROLE = `
  select current_user as user_name,
         r.rolsuper as superuser,
         r.rolbypassrls as bypasses_rls,
         pg_has_role(current_user, 'ob_ent_operator', 'MEMBER') as operator_member,
         pg_has_role(current_user, 'ob_ent_identity_operator', 'MEMBER') as identity_operator_member
  from pg_roles r
  where r.rolname = current_user`;

const SELECT_ENTERPRISE_TABLES = `
  select c.relname as table_name,
         c.relrowsecurity as rls_enabled,
         c.relforcerowsecurity as rls_forced,
         pg_has_role(current_user, c.relowner, 'MEMBER') as can_assume_owner
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('enterprise_principals', 'enterprise_memberships', 'enterprise_tenants',
                      'enterprise_workspaces', 'enterprise_resources', 'enterprise_resource_grants')`;

const ENTERPRISE_TABLE_COUNT = 6;

const LoginRoleSchema = z
  .object({
    user_name: z.string(),
    superuser: z.boolean(),
    bypasses_rls: z.boolean(),
    operator_member: z.boolean(),
    identity_operator_member: z.boolean(),
  })
  .strict();

const EnterpriseTableSchema = z
  .object({
    table_name: z.string(),
    rls_enabled: z.boolean(),
    rls_forced: z.boolean(),
    can_assume_owner: z.boolean(),
  })
  .strict();

/**
 * Reads one login's live role attributes. The error text is deliberately a stable code: the
 * underlying driver message can name a URL or a role, and a boot failure reaches an operator's
 * console — the diagnosis goes to the database, not to the log.
 */
async function loginRole(
  database: Database,
): Promise<z.infer<typeof LoginRoleSchema>> {
  let rows: unknown;
  try {
    rows = await database.$client.unsafe(SELECT_LOGIN_ROLE);
  } catch {
    throw new Error("ENTERPRISE_BOOT_ROLE_CHECK_FAILED");
  }
  const parsed = z.array(LoginRoleSchema).safeParse(rows);
  if (!parsed.success || parsed.data.length !== 1) {
    throw new Error("ENTERPRISE_BOOT_ROLE_LOOKUP_FAILED");
  }
  return parsed.data[0] as z.infer<typeof LoginRoleSchema>;
}

async function assertLoginHoldsNoPowers(database: Database): Promise<void> {
  const role = await loginRole(database);
  if (role.superuser) throw new Error("ENTERPRISE_BOOT_ROLE_SUPERUSER");
  if (role.bypasses_rls) throw new Error("ENTERPRISE_BOOT_ROLE_BYPASSRLS");
  if (role.operator_member || role.identity_operator_member) {
    throw new Error("ENTERPRISE_BOOT_ROLE_OPERATOR_MEMBER");
  }
}

async function enterpriseTables(
  database: Database,
): Promise<z.infer<typeof EnterpriseTableSchema>[]> {
  let rows: unknown;
  try {
    rows = await database.$client.unsafe(SELECT_ENTERPRISE_TABLES);
  } catch {
    throw new Error("ENTERPRISE_BOOT_TABLE_CHECK_FAILED");
  }
  return z.array(EnterpriseTableSchema).parse(rows);
}

/**
 * The identity login is only asked to hold no enterprise table powers; RLS on the identity tables
 * is not part of today's deployment and is not asserted here.
 */
async function assertIdentityLoginOwnsNothing(
  database: Database,
): Promise<void> {
  const tables = await enterpriseTables(database);
  if (tables.length !== ENTERPRISE_TABLE_COUNT) {
    throw new Error("ENTERPRISE_BOOT_TABLE_MISSING");
  }
  if (tables.some((table) => table.can_assume_owner)) {
    throw new Error("ENTERPRISE_BOOT_TABLE_OWNER_ASSUMABLE");
  }
}

/** The directory and data logins additionally need every enterprise table ENABLE + FORCE RLS. */
async function assertTenantBoundaryTables(database: Database): Promise<void> {
  const tables = await enterpriseTables(database);
  if (tables.length !== ENTERPRISE_TABLE_COUNT) {
    throw new Error("ENTERPRISE_BOOT_TABLE_MISSING");
  }
  if (
    tables.some(
      (table) => table.rls_enabled !== true || table.rls_forced !== true,
    )
  ) {
    throw new Error("ENTERPRISE_BOOT_TABLE_RLS_DISABLED");
  }
  if (tables.some((table) => table.can_assume_owner)) {
    throw new Error("ENTERPRISE_BOOT_TABLE_OWNER_ASSUMABLE");
  }
}

/* ---------------------------------------------------------------------------
 * The deployment revocation list, read through the auth login (plan step 2).
 * ------------------------------------------------------------------------- */

/**
 * Whether an administrator has removed this address, against the existing `revoked_access` table,
 * with the same normalization the SCIM writer uses (trimmed, lowercased) so a revoked address
 * cannot survive by signing in as `First.Last@`.
 *
 * This is checked by the auth wrapper below on EVERY session validation, not only at sign-in: a
 * person removed mid-session loses the next request, while a SUSPENDED member is a scope question
 * the tenant boundary answers — one tenant's suspension never revokes a person globally.
 */
export function createRevocationCheck(
  database: Database,
): (email: string) => Promise<boolean> {
  return async (email: string) => {
    const rows = await database
      .select({ email: revokedAccess.email })
      .from(revokedAccess)
      .where(eq(revokedAccess.email, email.trim().toLowerCase()))
      .limit(1);
    return rows.length > 0;
  };
}

/* ---------------------------------------------------------------------------
 * The readiness probes: one static text per dependency, LIMIT 0, no rows out.
 * ------------------------------------------------------------------------- */

const SET_PROBE_TIMEOUT = "set local statement_timeout='1s'";
const PROBE_USERS = "select id from users limit 0";
const PROBE_MEMBERSHIPS =
  "select tenant_id from enterprise_memberships limit 0";
const PROBE_RESOURCES = "select id from enterprise_resources limit 0";

/* ---------------------------------------------------------------------------
 * The bootstrap itself.
 * ------------------------------------------------------------------------- */

export async function bootstrapEnterprise(
  config: EnterpriseConfig,
  options: { createDatabase?: DatabaseFactory } = {},
): Promise<EnterpriseProcess> {
  const factory: DatabaseFactory =
    options.createDatabase ?? ((url, pool) => createDatabase(url, pool));

  /*
   * Every pool that gets opened lands in `opened` immediately, so any later failure — a later
   * factory call, a role check — closes exactly what was established, once, before the original
   * error is re-raised. The original error wins over a close failure: the cause of the boot dying
   * is what the operator needs, and the pools are gone either way.
   */
  const opened: Database[] = [];
  const closeOpened = async (): Promise<void> => {
    const results = await Promise.allSettled(
      opened.map((database) => database.$client.close()),
    );
    if (results.some((result) => result.status === "rejected")) {
      throw new Error("ENTERPRISE_DATABASE_CLOSE_FAILED");
    }
  };

  try {
    const authDb = factory(config.authDatabaseUrl, { max: 2 });
    opened.push(authDb);
    const directoryDb = factory(config.directoryDatabaseUrl, { max: 2 });
    opened.push(directoryDb);
    const dataDb = factory(config.dataDatabaseUrl, { max: 4 });
    opened.push(dataDb);

    /* Role and schema checks BEFORE anything listens (plan step 3). Failing here closes the
     * pools in the catch below; the entry never gets a port. */
    await assertLoginHoldsNoPowers(authDb);
    await assertIdentityLoginOwnsNothing(authDb);
    await assertLoginHoldsNoPowers(directoryDb);
    await assertTenantBoundaryTables(directoryDb);
    await assertLoginHoldsNoPowers(dataDb);
    await assertTenantBoundaryTables(dataDb);

    const isRevoked = createRevocationCheck(authDb);
    const baseAuth = createAuth(
      { auth: config.auth, keyEncryptionKey: config.keyEncryptionKey },
      authDb,
      isRevoked,
    );
    /* New sign-ins AND every existing-session validation pass through the revocation list: the
     * factory checks it at sign-in, this wrapper checks it on every getSession. */
    const auth: AuthService = {
      handler: (request) => baseAuth.handler(request),
      api: {
        getSession: async (input) => {
          const session = await baseAuth.api.getSession(input);
          if (!session || (await isRevoked(session.user.email))) return null;
          return session;
        },
      },
    };

    const directory = createDirectory(directoryDb);
    const authz = createAuthz();
    const resources = createResourceReader(dataDb, authz);

    /*
     * Draining and readiness, owned by this closure (plan step 4): the entry file never touches an
     * undefined ready state. The cache holds the health ANSWER for one second — never an
     * authorization decision; a request that fails on a dead database fails closed on its own.
     */
    let draining = false;
    const beginDrain = () => {
      draining = true;
    };
    const logRedactedSecurityError = (event: RedactedSecurityError): void => {
      log.error(
        {
          request_id: event.requestId,
          status: event.status,
          code: event.code,
        },
        "redacted-security-error",
      );
    };
    let checkedAt = 0;
    let lastReady = false;
    async function checkDependencies(): Promise<boolean> {
      if (draining) return false;
      if (Date.now() - checkedAt < 1000) return lastReady;
      try {
        await Promise.all([
          authDb.$client.begin(async (tx) => {
            await tx.unsafe(SET_PROBE_TIMEOUT);
            await tx.unsafe(PROBE_USERS);
          }),
          directoryDb.$client.begin(async (tx) => {
            await tx.unsafe(SET_PROBE_TIMEOUT);
            await tx.unsafe(PROBE_MEMBERSHIPS);
          }),
          dataDb.$client.begin(async (tx) => {
            await tx.unsafe(SET_PROBE_TIMEOUT);
            await tx.unsafe(PROBE_RESOURCES);
          }),
        ]);
        lastReady = true;
      } catch {
        lastReady = false;
      }
      checkedAt = Date.now();
      return lastReady;
    }

    const app = createEnterpriseApp({
      auth,
      directory,
      resources,
      authz,
      allowedOrigins: config.allowedOrigins,
      authRoutes: config.authRoutes,
      logRedactedSecurityError,
      ready: checkDependencies,
      isDraining: () => draining,
    });
    return { app, beginDrain, close: closeOpened };
  } catch (error) {
    try {
      await closeOpened();
    } catch {
      /* The original failure is the diagnosis; the pools are closed or broken either way. */
    }
    throw error;
  }
}
