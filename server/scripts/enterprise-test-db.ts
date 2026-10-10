import { testDatabaseUrl } from "../tests/support/database";

/*
 * The isolated migration entry for the enterprise tenancy work, per plan 02 §5 T1-B step 3.
 *
 * `db:generate` / `db:migrate` in package.json load the repository root `.env` — the developer's
 * application database — so this entry never uses them. The URL comes from TEST_DATABASE_URL
 * through the same validator the integration suite uses: missing variable, non-postgres protocol,
 * empty database name or the live `openbot` database are all hard errors, and the child drizzle-kit
 * process receives an environment containing ONLY PATH, HOME and the one DATABASE_URL derived
 * here — no implicit `.env` can leak in (`--no-env-file` on the child too) and `--no-install`
 * forbids downloading anything outside the lockfile.
 *
 * The command is chosen by matching the argument against a fixed set; each child command is a
 * fully spelled-out constant list and the argument itself never reaches the child. Bun.spawn
 * takes an argument list and runs no shell.
 *
 * This helper is for the dedicated test database only. Production migrations are injected by an
 * approved release job and never routed through a test helper.
 */
const url = testDatabaseUrl();

/*
 * The enterprise capability roles and the restricted test logins, per plan 02 §5 T1-B's role
 * contract and roles.sql. roles.sql itself is the DBA's file for a production instance; a
 * THROWAWAY test database (CI service container, or a developer's local test instance) needs the
 * same roles before the migrations run — 0056's GRANTs name ob_ent_* and fail outright when the
 * roles are absent — so this sub-command creates them idempotently through the migration owner
 * connection.
 *
 * The LOGIN users are not invented here: each is read from its own ENTERPRISE_TEST_* URL's
 * userinfo, so the credentials live only in the environment (never in this file) and the URL the
 * tests will dial is exactly the one provisioned. Role names are validated against a plain
 * identifier pattern and the password is single-quote-escaped before it ever appears in a
 * statement; neither is a channel for arbitrary SQL.
 *
 * PostgreSQL roles are INSTANCE-scoped, not database-scoped: running this against a second database
 * on an instance that already holds the roles will ALTER the shared logins' passwords to whatever
 * the new environment's URLs carry (observed: a throwaway probe database on the shared test
 * instance silently repointed every ent_* login). CI is safe — its service container owns the whole
 * instance — but a developer with several test databases on one instance must point every
 * ENTERPRISE_TEST_* URL at the database they are about to test, or provision a dedicated instance.
 */
const CAPABILITY_ROLES = [
  "ob_ent_directory",
  "ob_ent_data",
  "ob_ent_operator",
  "ob_ent_identity_operator",
  "ob_ent_identity",
] as const;

const ROLE_ATTRIBUTES =
  "nosuperuser nobypassrls nocreatedb nocreaterole nologin";

const RESTRICTED_LOGINS = [
  {
    variable: "ENTERPRISE_TEST_DIRECTORY_DATABASE_URL",
    memberOf: "ob_ent_directory",
  },
  { variable: "ENTERPRISE_TEST_DATA_DATABASE_URL", memberOf: "ob_ent_data" },
  {
    variable: "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
    memberOf: "ob_ent_operator",
  },
  {
    variable: "ENTERPRISE_TEST_IDENTITY_OPERATOR_DATABASE_URL",
    memberOf: "ob_ent_identity_operator",
  },
  {
    variable: "ENTERPRISE_TEST_AUTH_DATABASE_URL",
    memberOf: "ob_ent_identity",
  },
] as const;

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/** One PostgreSQL string literal, quotes doubled — the only interpolation this file ever does. */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function isDuplicateObject(error: unknown): boolean {
  const candidate = error as { code?: unknown; errno?: unknown } | null;
  return (
    [candidate?.code, candidate?.errno].includes("42710") ||
    String((error as Error)?.message ?? "").includes("already exists")
  );
}

async function provisionEnterpriseRoles(): Promise<void> {
  const { SQL } = await import("bun");
  const sql = new SQL(url);
  try {
    for (const role of CAPABILITY_ROLES) {
      try {
        await sql.unsafe(`create role ${role} ${ROLE_ATTRIBUTES}`);
      } catch (error) {
        if (!isDuplicateObject(error)) throw error;
      }
    }
    await sql.unsafe(
      `grant usage on schema public to ${CAPABILITY_ROLES.join(", ")}`,
    );

    for (const login of RESTRICTED_LOGINS) {
      const raw = process.env[login.variable];
      if (!raw) {
        throw new Error(
          `${login.variable} must name the restricted test login this sub-command provisions`,
        );
      }
      const parsed = new URL(raw);
      const username = decodeURIComponent(parsed.username);
      const password = decodeURIComponent(parsed.password ?? "");
      if (!IDENTIFIER.test(username)) {
        throw new Error(
          `${login.variable} must carry a plain lowercase role name as its userinfo`,
        );
      }
      if (!password) {
        throw new Error(
          `${login.variable} must carry the test login's password in its userinfo`,
        );
      }

      const existing = await sql.unsafe(
        `select 1 from pg_roles where rolname = ${literal(username)}`,
      );
      if (existing.length > 0) {
        await sql.unsafe(
          `alter role ${username} with login password ${literal(password)} nosuperuser nobypassrls nocreatedb nocreaterole`,
        );
      } else {
        await sql.unsafe(
          `create role ${username} login password ${literal(password)} nosuperuser nobypassrls nocreatedb nocreaterole`,
        );
      }
      await sql.unsafe(`grant ${login.memberOf} to ${username}`);
    }
  } finally {
    await sql.close();
  }
}

function spawnDrizzleKit(args: ReadonlyArray<string>) {
  return Bun.spawn(
    ["bun", "--no-env-file", "x", "--no-install", "drizzle-kit", ...args],
    {
      cwd: new URL("../", import.meta.url).pathname,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DATABASE_URL: url,
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
}

if (process.argv[2] === "roles") {
  await provisionEnterpriseRoles();
} else {
  let child: Bun.Subprocess;
  switch (process.argv[2]) {
    case "generate":
      child = spawnDrizzleKit(["generate", "--config=drizzle.config.ts"]);
      break;
    case "migrate":
      child = spawnDrizzleKit(["migrate", "--config=drizzle.config.ts"]);
      break;
    case "custom":
      /*
       * Which custom migration to scaffold, keyed by argv and nothing else: each branch below is a
       * fully spelled-out constant argument list, in the same shape as every other case here, so no
       * command-line text is ever interpolated into what the child runs. An unknown key gets the
       * original tenancy RLS scaffold, which is what "custom" meant before it grew a second name.
       */
      if (process.argv[3] === "identity_grants") {
        child = spawnDrizzleKit([
          "generate",
          "--custom",
          "--name=enterprise_identity_grants",
          "--config=drizzle.config.ts",
        ]);
      } else {
        child = spawnDrizzleKit([
          "generate",
          "--custom",
          "--name=enterprise_tenancy_rls",
          "--config=drizzle.config.ts",
        ]);
      }
      break;
    default:
      throw new Error("Use generate, migrate, custom or roles");
  }
  process.exit(await child.exited);
}
