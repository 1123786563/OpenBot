import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import postgres from "postgres";
import {
  afterAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import type { DirectoryTx } from "../../src/auth/directory/contracts";
import {
  ensurePrincipal,
  PRINCIPAL_REGISTRY_INPUT_REQUIRED,
  PRINCIPAL_REGISTRY_UNKNOWN_USER,
  PRINCIPAL_REGISTRY_UNVERIFIED_IDENTITY_HISTORY,
  PrincipalRegistryRefusal,
} from "../../src/auth/directory/principal-registry";
import * as schema from "../../src/db/schema";

/*
 * T02.07 (#529, P04) — PrincipalRegistry.ensure, the company-independent
 * principal of one User (design §4.2/§4.2.1, interfaces §2.1).
 *
 * What this file pins, against the real expand migration on the isolated
 * BA_TEST_* database:
 *
 * - `new_user_gets_generation_one_without_a_company`: the first ensure of a
 *   genuinely new user creates exactly one principal with the server-generated
 *   id and identityGeneration 1, and creates no tenant and no membership — a
 *   principal is not a company prerequisite.
 * - `ensure_reuses_the_existing_principal_of_a_user`: a second ensure, for a
 *   user who already has a principal, reuses its id, status and generation
 *   instead of creating a second subject or bumping the generation.
 * - `concurrent_first_membership_creates_one_principal`: two transactions that
 *   both started before either called ensure converge on the same principal;
 *   the `enterprise_principal_user` unique index is the last line, the principal
 *   lock is what makes both callers succeed with one row
 *   (expect(principals).toHaveLength(1)).
 * - `ensure_cannot_restore_disabled_or_missing_history`: a suspended principal
 *   is returned as it stands (status and generation untouched — ensure never
 *   restores a disabled identity), and a principal that predates the generation
 *   column is refused instead of being backfilled with a guessed 1 or replaced
 *   by a fresh subject (expect(principalAfter).toEqual(principalBefore)).
 * - `ensure_refuses_an_unknown_user_without_writing`: a user row that does not
 *   exist is a named refusal, not a foreign-key accident and not a principal.
 * - `ensure_refuses_a_blank_user_id`: an empty target is refused before any
 *   lock or read.
 * - `ensure_leaves_no_orphan_principal_when_the_caller_rolls_back`: the create
 *   belongs to the caller's transaction; a failed command leaves no principal
 *   behind (the finalizer's "no orphan subject" proof, at the registry seam).
 *
 * The five BA_TEST_* URLs are all required (presence and same-instance shape); a
 * missing one is a blocked suite, never a silent fallback to the shared, MT or
 * job-level database. No DSN is ever printed — refusals name the variable.
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

/** The expand migration that adds enterprise_principals.identity_generation. */
const MIGRATION_TAG = "0210_better_auth_clocks";
const MIGRATION_PATH = join(
  import.meta.dirname,
  `../../drizzle/${MIGRATION_TAG}.sql`,
);
const CLOCK_TABLE = "auth_eligibility_clocks";

const PREFIX = "t0207";
const USER_NEW = `${PREFIX}-user-new`;
const USER_EXISTING = `${PREFIX}-user-existing`;
const USER_DISABLED = `${PREFIX}-user-disabled`;
const USER_LEGACY = `${PREFIX}-user-legacy`;
const USER_RACE = `${PREFIX}-user-race`;
const USER_MISSING = `${PREFIX}-user-missing`;
const USER_ROLLBACK = `${PREFIX}-user-rollback`;
const PRINCIPAL_EXISTING = `${PREFIX}-principal-existing`;
const PRINCIPAL_DISABLED = `${PREFIX}-principal-disabled`;
const PRINCIPAL_LEGACY = `${PREFIX}-principal-legacy`;

const EXISTING_GENERATION = 3;
const DISABLED_GENERATION = 7;

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

function readBaUrls(): { setup: string } {
  const signatures = new Map<string, string>();
  for (const variable of BA_URL_VARIABLES) {
    const raw = process.env[variable]?.trim();
    if (!raw) {
      throw new Error(
        `${variable} is required: a better-auth DB suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
      );
    }
    const { endpoint, database } = shapeOf(variable, raw);
    signatures.set(variable, `${endpoint}/${database}`);
  }
  const reference = signatures.get(DATABASE_VARIABLE);
  for (const variable of BA_URL_VARIABLES) {
    if (signatures.get(variable) !== reference) {
      throw new Error(
        `${variable} must name the same PostgreSQL instance and database as ${DATABASE_VARIABLE}.`,
      );
    }
  }
  return { setup: process.env[DATABASE_VARIABLE]!.trim() };
}

/** Read lazily, so a missing expand migration fails each case by name, not as zero cases. */
function loadMigrationSql(): string {
  if (!existsSync(MIGRATION_PATH)) {
    throw new Error(
      `${MIGRATION_TAG}.sql does not exist: the expand migration that adds enterprise_principals.identity_generation is the T02.07 prerequisite (T02.02), not an environment problem.`,
    );
  }
  return readFileSync(MIGRATION_PATH, "utf8");
}

/** The drizzle handle over the same database: real transactions, real tx types. */
function clientFor(url: URL) {
  return new SQL({
    adapter: "postgres" as const,
    hostname:
      url.hostname === "localhost" || url.hostname === "[::1]"
        ? "127.0.0.1"
        : url.hostname,
    port: Number(url.port || 5432),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    max: 4,
    idleTimeout: 5,
    connectionTimeout: 10_000,
    onnotice: () => {},
  });
}

interface PrincipalRow {
  id: string;
  user_id: string;
  status: string;
  identity_generation: unknown;
  created_at: Date;
}

interface Harness {
  sql: postgres.Sql;
  inTransaction<T>(run: (tx: DirectoryTx) => Promise<T>): Promise<T>;
  principalRowsFor(userId: string): Promise<PrincipalRow[]>;
  tenantCount(): Promise<number>;
  membershipCount(): Promise<number>;
  close(): Promise<void>;
}

/**
 * Returns the island to its pre-suite shape: this suite's rows gone, the
 * expand migration's column and table gone, the tenant status domain back to
 * active/suspended. Every statement is a no-op on a pristine baseline, and it
 * also recovers a crashed earlier run that left any of them behind.
 */
async function cleanupFixture(sql: postgres.Sql): Promise<void> {
  await sql`DELETE FROM enterprise_memberships WHERE tenant_id LIKE ${`${PREFIX}-%`}`;
  await sql`DELETE FROM enterprise_tenants WHERE id LIKE ${`${PREFIX}-%`}`;
  await sql`DELETE FROM enterprise_principals WHERE id LIKE ${`${PREFIX}-%`} OR user_id LIKE ${`${PREFIX}-%`}`;
  await sql`DELETE FROM users WHERE id LIKE ${`${PREFIX}-%`}`;
  await sql.unsafe(`DROP TABLE IF EXISTS ${CLOCK_TABLE} CASCADE`);
  await sql.unsafe(
    `ALTER TABLE "enterprise_principals" DROP COLUMN IF EXISTS "identity_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_tenants" DROP CONSTRAINT IF EXISTS "enterprise_tenant_status"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_tenants" ADD CONSTRAINT "enterprise_tenant_status" CHECK ("status" in ('active','suspended'))`,
  );
}

/**
 * The pre-column population: users plus the principal that predates the
 * generation column. It is seeded BEFORE the expand migration applies, so its
 * NULL identity_generation is legacy state the suite pins, not a value the test
 * wrote.
 */
async function seedLegacyPopulation(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO users (id, email) VALUES
      (${USER_NEW}, 't0207-user-new@example.test'),
      (${USER_EXISTING}, 't0207-user-existing@example.test'),
      (${USER_DISABLED}, 't0207-user-disabled@example.test'),
      (${USER_LEGACY}, 't0207-user-legacy@example.test'),
      (${USER_RACE}, 't0207-user-race@example.test'),
      (${USER_ROLLBACK}, 't0207-user-rollback@example.test')`;
  await sql`
    INSERT INTO enterprise_principals (id, user_id) VALUES
      (${PRINCIPAL_LEGACY}, ${USER_LEGACY})`;
}

/** Versions only exist once the expand migration has applied. */
async function seedGenerationPopulation(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO enterprise_principals (id, user_id, status, identity_generation) VALUES
      (${PRINCIPAL_EXISTING}, ${USER_EXISTING}, 'active', ${EXISTING_GENERATION}),
      (${PRINCIPAL_DISABLED}, ${USER_DISABLED}, 'suspended', ${DISABLED_GENERATION})`;
}

async function countRows(sql: postgres.Sql, table: string): Promise<number> {
  const [row] = await sql.unsafe<{ count: number }[]>(
    `SELECT count(*)::int AS count FROM "${table}"`,
  );
  return Number(row?.count ?? 0);
}

async function createHarness(): Promise<Harness> {
  const { setup } = readBaUrls();
  const sql = postgres(setup, {
    max: 1,
    idle_timeout: 5,
    onnotice: () => {},
  });
  const client = clientFor(new URL(setup));
  const db = drizzle({ client: client as never, schema });

  try {
    await cleanupFixture(sql);
    await seedLegacyPopulation(sql);
    await sql.unsafe(loadMigrationSql());
    await seedGenerationPopulation(sql);

    return {
      sql,
      inTransaction: (run) =>
        db.transaction((trx) => run(trx as never as DirectoryTx)),
      principalRowsFor: async (userId) => [
        ...(await sql<PrincipalRow[]>`
          SELECT id, user_id, status, identity_generation, created_at
            FROM enterprise_principals
           WHERE user_id = ${userId}
           ORDER BY created_at, id`),
      ],
      tenantCount: () => countRows(sql, "enterprise_tenants"),
      membershipCount: () => countRows(sql, "enterprise_memberships"),
      close: async () => {
        try {
          await cleanupFixture(sql);
        } finally {
          await client.close().catch(() => {});
          await sql.end({ timeout: 5 }).catch(() => {});
        }
      },
    };
  } catch (error) {
    await cleanupFixture(sql).catch(() => {});
    await client.close().catch(() => {});
    await sql.end({ timeout: 5 }).catch(() => {});
    throw error;
  }
}

let harnessPromise: Promise<Harness> | undefined;

/** One harness per process; a setup failure is this suite's failure, not a skip. */
function loadHarness(): Promise<Harness> {
  harnessPromise ??= createHarness();
  return harnessPromise;
}

function generationOf(row: PrincipalRow | undefined): number | null {
  if (row?.identity_generation === null || row === undefined) return null;
  return Number(row.identity_generation);
}

describe("T02.07 company-independent principal registry", () => {
  afterAll(async () => {
    const created = await harnessPromise?.catch(() => undefined);
    if (created) await created.close();
    // A fresh probe, so the leak check sees the cleaned database rather than the
    // harness's released pools.
    const { setup } = readBaUrls();
    const probe = postgres(setup, { max: 1, onnotice: () => {} });
    try {
      const principals = await probe<{ id: string }[]>`
        SELECT id FROM enterprise_principals
         WHERE id LIKE ${`${PREFIX}-%`} OR user_id LIKE ${`${PREFIX}-%`}`;
      expect([...principals]).toEqual([]);
      const users = await probe<{ id: string }[]>`
        SELECT id FROM users WHERE id LIKE ${`${PREFIX}-%`}`;
      expect([...users]).toEqual([]);
      const clocks = await probe<{ table: string | null }[]>`
        SELECT to_regclass(${`public.${CLOCK_TABLE}`})::text AS table`;
      expect(clocks[0]?.table ?? null).toBeNull();
      const columns = await probe<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'enterprise_principals'
           AND column_name = 'identity_generation'`;
      expect([...columns]).toEqual([]);
    } finally {
      await probe.end({ timeout: 5 }).catch(() => {});
    }
  });

  test("new_user_gets_generation_one_without_a_company", async () => {
    const harness = await loadHarness();
    const tenantsBefore = await harness.tenantCount();
    const membershipsBefore = await harness.membershipCount();

    const ref = await harness.inTransaction((tx) =>
      ensurePrincipal(tx, USER_NEW),
    );

    expect(ref.userId).toBe(USER_NEW);
    expect(ref.identityGeneration).toBe(1);
    expect(ref.principalId.length).toBeGreaterThan(0);
    expect(ref.principalId).not.toBe(USER_NEW);

    const principals = await harness.principalRowsFor(USER_NEW);
    expect(principals).toHaveLength(1);
    expect(principals[0]?.id).toBe(ref.principalId);
    expect(principals[0]?.status).toBe("active");
    expect(generationOf(principals[0])).toBe(1);

    // A principal is not a company prerequisite: the personal flow creates no
    // tenant and no membership.
    expect(await harness.tenantCount()).toBe(tenantsBefore);
    expect(await harness.membershipCount()).toBe(membershipsBefore);
  });

  test("ensure_reuses_the_existing_principal_of_a_user", async () => {
    const harness = await loadHarness();

    // Seeded with a verified generation: ensure hands it back untouched.
    const before = await harness.principalRowsFor(USER_EXISTING);
    expect(before).toHaveLength(1);
    const first = await harness.inTransaction((tx) =>
      ensurePrincipal(tx, USER_EXISTING),
    );
    expect(first.principalId).toBe(PRINCIPAL_EXISTING);
    expect(first.identityGeneration).toBe(EXISTING_GENERATION);
    expect(await harness.principalRowsFor(USER_EXISTING)).toEqual(before);

    // And the principal it just created is reused the same way: one subject,
    // one generation, no second row.
    const created = await harness.inTransaction((tx) =>
      ensurePrincipal(tx, USER_NEW),
    );
    const again = await harness.inTransaction((tx) =>
      ensurePrincipal(tx, USER_NEW),
    );
    expect(again).toEqual(created);
    expect(await harness.principalRowsFor(USER_NEW)).toHaveLength(1);
  });

  test("concurrent_first_membership_creates_one_principal", async () => {
    const harness = await loadHarness();

    // Both transactions are open before either calls ensure, so this is a real
    // first-create race and not two sequential calls.
    const start = Promise.withResolvers<void>();
    let arrived = 0;
    const arrive = () => {
      arrived += 1;
      if (arrived === 2) start.resolve();
    };
    const attempt = () =>
      harness.inTransaction(async (tx) => {
        arrive();
        await start.promise;
        return ensurePrincipal(tx, USER_RACE);
      });

    const [first, second] = await Promise.all([attempt(), attempt()]);
    expect(first).toEqual(second);

    const principals = await harness.principalRowsFor(USER_RACE);
    expect(principals).toHaveLength(1);
    expect(principals[0]?.id).toBe(first.principalId);
    expect(generationOf(principals[0])).toBe(1);
  });

  test("ensure_cannot_restore_disabled_or_missing_history", async () => {
    const harness = await loadHarness();

    // A suspended principal is reused, never restored: ensure hands the ref back
    // and leaves status and generation exactly as they were.
    const principalBefore = await harness.principalRowsFor(USER_DISABLED);
    expect(principalBefore).toHaveLength(1);
    expect(principalBefore[0]?.status).toBe("suspended");
    const disabledRef = await harness.inTransaction((tx) =>
      ensurePrincipal(tx, USER_DISABLED),
    );
    expect(disabledRef.principalId).toBe(PRINCIPAL_DISABLED);
    expect(disabledRef.identityGeneration).toBe(DISABLED_GENERATION);
    const principalAfter = await harness.principalRowsFor(USER_DISABLED);
    expect(principalAfter).toEqual(principalBefore);

    // A principal that predates the generation column has a history whose
    // version cannot be verified: it is refused, never backfilled with 1 and
    // never replaced by a new subject.
    const legacyBefore = await harness.principalRowsFor(USER_LEGACY);
    expect(legacyBefore).toHaveLength(1);
    expect(generationOf(legacyBefore[0])).toBeNull();
    await expect(
      harness.inTransaction((tx) => ensurePrincipal(tx, USER_LEGACY)),
    ).rejects.toMatchObject({
      code: PRINCIPAL_REGISTRY_UNVERIFIED_IDENTITY_HISTORY,
    });
    const legacyAfter = await harness.principalRowsFor(USER_LEGACY);
    expect(legacyAfter).toEqual(legacyBefore);
    expect(legacyAfter).toHaveLength(1);
  });

  test("ensure_refuses_an_unknown_user_without_writing", async () => {
    const harness = await loadHarness();

    await expect(
      harness.inTransaction((tx) => ensurePrincipal(tx, USER_MISSING)),
    ).rejects.toBeInstanceOf(PrincipalRegistryRefusal);
    await expect(
      harness.inTransaction((tx) => ensurePrincipal(tx, USER_MISSING)),
    ).rejects.toMatchObject({ code: PRINCIPAL_REGISTRY_UNKNOWN_USER });
    expect(await harness.principalRowsFor(USER_MISSING)).toHaveLength(0);
  });

  test("ensure_refuses_a_blank_user_id", async () => {
    const harness = await loadHarness();

    await expect(
      harness.inTransaction((tx) => ensurePrincipal(tx, "  ")),
    ).rejects.toMatchObject({ code: PRINCIPAL_REGISTRY_INPUT_REQUIRED });
  });

  test("ensure_leaves_no_orphan_principal_when_the_caller_rolls_back", async () => {
    const harness = await loadHarness();

    await expect(
      harness.inTransaction(async (tx) => {
        await ensurePrincipal(tx, USER_ROLLBACK);
        throw new Error("command failed after the principal was ensured");
      }),
    ).rejects.toThrow("command failed after the principal was ensured");
    expect(await harness.principalRowsFor(USER_ROLLBACK)).toHaveLength(0);
  });
});
