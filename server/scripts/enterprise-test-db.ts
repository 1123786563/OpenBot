import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { createDatabase } from "../src/db/client";
import { reasonWithoutStatement } from "../src/db/query-failure";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseSetupDatabaseVariable,
  enterpriseTestDatabaseNameFrom,
  enterpriseTestDatabaseUrlFrom,
  ROLE_DATABASE_VARIABLES,
  type EnterpriseRuntimeRole,
} from "../tests/support/enterprise-database";
import {
  assertFreshSetupDatabaseIdentity,
  ENTERPRISE_CAPABILITY_ROLES,
  parseRuntimeTestLogin,
  type ParsedRuntimeTestLogin,
  type SetupDatabaseIdentity,
  type PgRolePrivilegeFlags,
} from "./enterprise-test-db-guard";

const requestedMode = process.argv[2] ?? "";
if (!new Set(["generate", "custom", "migrate", "provision"]).has(requestedMode)) {
  throw new Error(
    "Use enterprise-test-db.ts generate, custom, migrate, or provision.",
  );
}
const mode = requestedMode as "generate" | "custom" | "migrate" | "provision";

const databaseUrl = enterpriseTestDatabaseUrlFrom();

/*
 * Pure environment validation runs BEFORE the one-shot migration: a bad
 * second or third role URL failing only after the migration applied would
 * leave a half-provisioned database that the fresh-schema guard then refuses
 * to re-migrate, forcing a manual drop. Everything that can fail on
 * configuration alone is checked here; only pg_roles-dependent checks stay
 * in provisioning below.
 */
const parsedLogins =
  mode === "migrate" || mode === "provision"
    ? (() => {
        const seenLoginNames = new Set<string>();
        // Derived from ROLE_DATABASE_VARIABLES so a future runtime role added
        // to the map cannot silently skip pre-migration validation.
        return (
          Object.keys(ROLE_DATABASE_VARIABLES) as EnterpriseRuntimeRole[]
        ).map((role) => {
          // Runs the remaining pure-config checks (protocol, loopback host,
          // openbot_enterprise_* database name, same instance as the setup
          // URL) so a mis-pointed role URL fails before the migration makes
          // the database non-fresh, not only when the suite dials it later.
          enterpriseRuntimeDatabaseUrlFrom(role);
          return parseRuntimeTestLogin(
            role,
            ROLE_DATABASE_VARIABLES[role],
            process.env,
            seenLoginNames,
          );
        });
      })()
    : [];
if (mode === "migrate") {
  const identity = await assertFreshSetupDatabase(
    databaseUrl,
    enterpriseSetupDatabaseVariable(),
  );
  // Provisioning follows the migration in this script and needs full
  // superuser; checking it here keeps a bypassrls-only setup URL from
  // consuming the one-shot migration before provisioning can fail.
  if (!identity.setup_is_superuser) {
    throw new Error(
      "Migrating with this script provisions runtime test logins, which requires a superuser setup connection.",
    );
  }
  // A login name colliding with an existing privileged role is the one
  // pg_roles-dependent failure that can be known before the one-shot
  // migration consumes the fresh database; check it now so it cannot strand.
  await precheckRuntimeTestLoginRoles(databaseUrl, parsedLogins);
}

// provision runs no child process: it only re-provisions login roles.
let command: string[] | null = null;
if (mode === "migrate") {
  command = ["bun", "scripts/migrate.ts"];
} else if (mode === "custom" || mode === "generate") {
  command = [
    "bun",
    "--no-env-file",
    "x",
    "--no-install",
    "drizzle-kit",
    "generate",
    ...(mode === "custom"
      ? ["--custom", "--name=enterprise_tenancy_rls"]
      : []),
    "--config=drizzle.config.ts",
  ];
}
const serverRoot = fileURLToPath(new URL("../", import.meta.url));
const exitCode = command
  ? await Bun.spawn(command, {
      cwd: serverRoot,
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
        DATABASE_URL: databaseUrl,
        ...(mode === "migrate"
          ? { OPENBOT_BOOTSTRAP_ENTERPRISE_ROLES: "on" }
          : {}),
      },
      stdout: "inherit",
      stderr: "inherit",
    }).exited
  : 0;
if ((mode === "migrate" && exitCode === 0) || mode === "provision") {
  // `provision` is the re-entry point: if provisioning ever failed after a
  // successful migration left the database non-fresh, this mode repairs the
  // logins without re-running (and being refused by) the fresh-schema guard.
  await provisionRuntimeTestLogins(databaseUrl, parsedLogins);
}
process.exit(exitCode);

/**
 * Quotes a string as a PostgreSQL identifier, doubling embedded double
 * quotes. Lets the defense-in-depth claim below hold even for callers that
 * skip parseRuntimeTestLogin validation.
 */
function ident(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Shared by the migrate-mode precheck and the provisioning transaction. */
function assertLoginNotPrivileged(
  existing: PgRolePrivilegeFlags | undefined,
  name: string,
  variable: string,
): void {
  // CREATEDB/CREATEROLE/REPLICATION are cluster-wide powers; a mis-pointed
  // role URL must be refused here, not silently have them reset.
  if (
    existing?.rolsuper ||
    existing?.rolbypassrls ||
    existing?.rolcreatedb ||
    existing?.rolcreaterole ||
    existing?.rolreplication
  ) {
    throw new Error(
      `${variable} must not name the privileged setup role "${name}"`,
    );
  }
}

/*
 * The login name and password are read from each URL's userinfo (validated
 * above, before the migration ran), so the login the tests dial is exactly
 * the one provisioned — both CI's `enterprise_*_login` credentials and a
 * developer's `ent_*` official test credentials work without either name
 * living in this file. What this sub-command owns is the shape: each login
 * gets exactly one capability membership and no escalating attributes, which
 * is what the runtime capability verifier demands.
 */
async function provisionRuntimeTestLogins(
  url: string,
  logins: ParsedRuntimeTestLogin[],
) {
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const database = postgres(url, { max: 1 });
  try {
    const [identity] = await database<{ is_superuser: string }[]>`
      SELECT current_setting('is_superuser') AS is_superuser
    `;
    if (identity?.is_superuser !== "on") {
      throw new Error(
        "Provisioning runtime test logins requires a superuser setup connection.",
      );
    }
    // One transaction for every login: PostgreSQL DDL is transactional, so a
    // mid-loop failure rolls back all REVOKE/ALTER/GRANT work instead of
    // leaving half-stripped memberships. SET LOCAL binds the log suppression
    // to the transaction's pinned connection — the ALTER/CREATE ROLE
    // statements carry the plaintext test password, and 'panic' keeps
    // statement text out of the server log even on failure.
    await database.begin(async (tx) => {
      await tx.unsafe("SET LOCAL log_statement = 'none'");
      await tx.unsafe("SET LOCAL log_min_duration_statement = -1");
      await tx.unsafe("SET LOCAL log_min_error_statement = 'panic'");
      for (const login of logins) {
        const { name, password } = login;
        const variable = ROLE_DATABASE_VARIABLES[login.role];
        const [existing] = await tx<PgRolePrivilegeFlags[]>`
          SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
          FROM pg_roles
          WHERE rolname = ${name}
        `;
        assertLoginNotPrivileged(existing, name, variable);
        // Defense in depth: unreachable via the migrate path (the
        // pre-migration /^ent/ prefix check already rejects every ob_ name),
        // kept so provisioning stays safe if it is ever called with
        // unvalidated names.
        if (ENTERPRISE_CAPABILITY_ROLES.has(name)) {
          throw new Error(
            `${variable} must not name the NOLOGIN capability role "${name}"`,
          );
        }
        try {
          const operation = existing ? "ALTER ROLE" : "CREATE ROLE";
          // Revoke EVERY membership, not just the known capabilities: the
          // runtime capability verifier demands exactly one membership, so a
          // foreign grant on a shared database must be stripped here, not
          // discovered later as an opaque verifier failure.
          if (existing) {
            const memberships = await tx<{ rolname: string }[]>`
              SELECT parent.rolname
              FROM pg_auth_members membership
              JOIN pg_roles parent ON parent.oid = membership.roleid
              JOIN pg_roles member ON member.oid = membership.member
              WHERE member.rolname = ${name}
            `;
            for (const { rolname } of memberships) {
              // pg_auth_members names can legally contain double quotes; a
              // hostile CREATEROLE peer could use one to break out of the
              // quoted identifier, and this connection is superuser.
              await tx.unsafe(`REVOKE ${ident(rolname)} FROM ${ident(name)}`);
            }
          }
          await tx.unsafe(
            `${operation} ${ident(name)} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${literal(password)}`,
          );
          await tx.unsafe(`GRANT ${ident(login.capability)} TO ${ident(name)}`);
        } catch (error) {
          const code = (error as { code?: unknown }).code;
          const detail = reasonWithoutStatement(error);
          throw new Error(
            `Failed to ${existing ? "alter" : "create"} test login "${name}"${typeof code === "string" ? ` (postgres ${code})` : ""}: ${detail}`,
          );
        }
      }
    });
  } finally {
    // A failing close must not mask the error that unwound us.
    await database.end({ timeout: 5 }).catch(() => {});
  }
}

async function precheckRuntimeTestLoginRoles(
  url: string,
  logins: ParsedRuntimeTestLogin[],
) {
  const database = postgres(url, { max: 1 });
  try {
    for (const { name, role } of logins) {
      const [existing] = await database<PgRolePrivilegeFlags[]>`
        SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
        FROM pg_roles
        WHERE rolname = ${name}
      `;
      assertLoginNotPrivileged(existing, name, ROLE_DATABASE_VARIABLES[role]);
    }
  } finally {
    // A failing close must not mask the error that unwound us.
    await database.end({ timeout: 5 }).catch(() => {});
  }
}

async function assertFreshSetupDatabase(
  url: string,
  setupUrlVariable: string,
): Promise<SetupDatabaseIdentity> {
  const database = createDatabase(url, { max: 1 });
  try {
    const [identity] = (await database.execute(sql`
      SELECT current_database() AS database_name,
        current_user AS current_user,
        session_user AS session_user,
        actor.rolsuper AS setup_is_superuser,
        actor.rolsuper OR actor.rolbypassrls AS setup_has_bypass,
        NOT EXISTS (
          SELECT 1
          FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        ) AS public_schema_is_empty
      FROM pg_roles actor
      WHERE actor.rolname = current_user
    `)) as unknown as Array<SetupDatabaseIdentity>;
    assertFreshSetupDatabaseIdentity(
      identity,
      enterpriseTestDatabaseNameFrom(url, setupUrlVariable),
    );
    return identity;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Refusing migration:")
    )
      throw error;
    throw new Error(
      "Unable to verify the reserved empty enterprise test database.",
    );
  } finally {
    await database.$client.close();
  }
}
