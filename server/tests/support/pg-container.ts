import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import postgres from "postgres";

/*
 * The shared test-Postgres container helper (R2-10, ME06 #478): ONE copy of
 * the `docker exec psql` plumbing and the disposable-database + restricted-
 * role bootstrap the ME01/ME03/ME05 fixtures each used to hand-copy.
 *
 * Everything here talks ONLY to the local test Postgres named by
 * ME01_TEST_PG_CONTAINER (default `openbot-test-pg`) on host port
 * ME01_TEST_PG_PORT (default 5433) — or, when ME01_TEST_PG_ADMIN_DSN is set,
 * to whatever superuser DSN that names over the wire. The dev DATABASE_URL is
 * never read and no .env is consulted — connection targets come only from what
 * this module bootstraps.
 */

const run = promisify(execFile);

/** CI has no docker socket and no named container: statements go over the wire. */
function adminDsn(): string | null {
  return process.env.ME01_TEST_PG_ADMIN_DSN?.trim() || null;
}

/** The admin DSN retargeted at one database (CREATE DATABASE runs on `postgres`). */
function dsnFor(database: string): string {
  const url = new URL(adminDsn()!);
  url.pathname = `/${database}`;
  return url.toString();
}

/*
 * `-tAc` semantics for the fixtures' scalar probes: first column of the first
 * row as text, empty string when there is no row. Multi-statement strings use
 * the simple protocol (no parameters), so ON_ERROR_STOP-like behavior is just
 * "the first error throws".
 */
async function wireStatement(database: string, statement: string): Promise<string> {
  const client = postgres(dsnFor(database), { max: 1 });
  try {
    const rows = (await client.unsafe(statement)) as Record<string, unknown>[];
    if (rows.length === 0) return "";
    const first = rows[0]!;
    return String(first[Object.keys(first)[0]!]);
  } finally {
    await client.end();
  }
}

/** The local test Postgres container every fixture shares. */
export function testPgContainer(): string {
  return process.env.ME01_TEST_PG_CONTAINER ?? "openbot-test-pg";
}

/** The container's host port (the same knob every fixture already read). */
export function testPgPort(): string {
  return process.env.ME01_TEST_PG_PORT ?? "5433";
}

/**
 * Run one psql statement against one database inside the test container and
 * return the trimmed stdout (`-tAc`: tuples only, unaligned). 30s timeout, no
 * shell: execFile passes argv verbatim, so dollar-quoting inside `sql` is
 * safe the same way it was in every fixture this replaces.
 */
export function psql(database: string, sql: string): Promise<string> {
  if (adminDsn()) return wireStatement(database, sql);
  return run(
    "docker",
    [
      "exec",
      testPgContainer(),
      "psql",
      "-U",
      "postgres",
      "-d",
      database,
      "-tAc",
      sql,
    ],
    { timeout: 30_000 },
  ).then((result) => result.stdout.trim());
}

/** One statement run with ON_ERROR_STOP, for multi-statement migration files. */
export async function psqlStrict(
  database: string,
  statement: string,
): Promise<void> {
  if (adminDsn()) {
    await wireStatement(database, statement);
    return;
  }
  await run(
    "docker",
    [
      "exec",
      testPgContainer(),
      "psql",
      "-U",
      "postgres",
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      statement,
    ],
    { timeout: 30_000 },
  );
}

/** Best-effort drop of one database (and optionally a role) in the container. */
export async function dropDatabaseAndRole(
  dbName: string,
  roleName?: string,
): Promise<void> {
  // Swallowing is deliberate (a drop() must not mask the caller's assertion
  // error), but silent swallowing hides accumulating leftovers in the shared
  // test container — make each failed DROP visible.
  await psql(
    "postgres",
    `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`,
  ).catch((error) =>
    console.warn(
      `dropDatabaseAndRole: DROP DATABASE ${dbName} failed: ${String(error)}`,
    ),
  );
  if (roleName) {
    await psql("postgres", `DROP ROLE IF EXISTS "${roleName}"`).catch((error) =>
      console.warn(
        `dropDatabaseAndRole: DROP ROLE ${roleName} failed: ${String(error)}`,
      ),
    );
  }
}

export interface DisposableDatabase {
  runtimeUrl: string;
  dbName: string;
  roleName: string;
  drop(): Promise<void>;
}

/**
 * A disposable database plus a restricted login role (NOSUPERUSER,
 * NOBYPASSRLS) that only owns objects it creates in the public schema — the
 * shared shape of the ME01 and ME05 bootstraps. The runtime role gets CONNECT
 * on its database and USAGE+CREATE on the public schema and nothing else; the
 * store under test connects ONLY with this role, so ungranted access fails
 * loudly instead of silently running as a superuser.
 *
 * `afterGrants` (the ME05 shape) runs INSIDE the try block, after the base
 * grants: any failure there triggers the same per-create cleanup that a
 * bootstrap failure gets, because the caller never sees the handle and its
 * drop() would never run.
 */
export async function createDisposableDatabase(options: {
  /** Name fragment for the database and role; also the credential prefix. */
  label: string;
  afterGrants?: (dbName: string, roleName: string) => Promise<void>;
}): Promise<DisposableDatabase> {
  // The label lands inside quoted SQL identifiers, a dollar-quoted password and
  // the runtime URL: only identifier-safe characters may pass.
  if (!/^[A-Za-z0-9_]+$/.test(options.label)) {
    throw new Error(
      `createDisposableDatabase: label must match [A-Za-z0-9_]+, got ${JSON.stringify(options.label)}`,
    );
  }
  const dbName = `openbot_${options.label}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const roleName = `${options.label}_rt_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const password = `${options.label}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  // After CREATE DATABASE succeeds, any later failure (container hiccup,
  // permission error) must clean up what was already created — the caller
  // never sees the handle, so its drop() would never run and the shared
  // test container would accumulate a database + role per failed bootstrap.
  try {
    await psql("postgres", `CREATE DATABASE "${dbName}"`);
    await psql(
      "postgres",
      // Dollar-quoting keeps the password out of single-quote SQL string
      // rules: the password is UUID-hex derived today (no quotes/backslashes),
      // but psql -c has no parameter binding, so the quoting style is the only
      // thing standing between a password-scheme change and a broken CREATE
      // ROLE. execFile passes argv without shell expansion, so `$$` is safe.
      `CREATE ROLE "${roleName}" LOGIN PASSWORD $$${password}$$ NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    await psql(
      "postgres",
      `GRANT CONNECT ON DATABASE "${dbName}" TO "${roleName}"`,
    );
    await psql(dbName, `GRANT USAGE, CREATE ON SCHEMA public TO "${roleName}"`);
    await options.afterGrants?.(dbName, roleName);
  } catch (error) {
    await dropDatabaseAndRole(dbName, roleName);
    throw error;
  }
  const runtimeUrl = `postgresql://${roleName}:${encodeURIComponent(password)}@127.0.0.1:${testPgPort()}/${dbName}`;
  return {
    runtimeUrl,
    dbName,
    roleName,
    async drop() {
      // Per-DROP capture: a failed DROP DATABASE (docker exec timeout) must
      // not skip DROP ROLE and leave the role accumulating in the shared
      // test container — and a drop() throwing from a test's finally would
      // mask the original assertion error.
      await dropDatabaseAndRole(dbName, roleName);
    },
  };
}
