import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import postgres from "postgres";
import {
  afterAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import * as schema from "../../src/db/schema";
import { enterprisePrincipals } from "../../src/db/schema/enterprise-tenancy";

/*
 * T02.02 (#524, P03) — the Principal identity generation and the durable
 * eligibility clocks, checked against the real migration on the isolated
 * BA_TEST_* stack (design §4.2/§4.2.1/§4.4, interfaces §2).
 *
 * What this file pins, and why each part is a database fact rather than a code
 * convention:
 *
 * - `projection_rebuild_does_not_reset_tombstone`: `auth_eligibility_clocks` is
 *   an independent revocation-version fact, not a projection. Deleting and
 *   rebuilding the membership projection rows a removal leaves behind must not
 *   touch the clock's key, epoch, generation or tombstone (design §4.4).
 * - `unsafe_or_wrapped_version_is_rejected`: a Version is 0..9007199254740991.
 *   Wrapped (MAX_SAFE_INTEGER + 1) and negative writes are refused by CHECK
 *   constraints on the new bigint columns — "exitCode not 0" is the rejected
 *   statement's exit, asserted here as SQLSTATE 23514. Write-path monotonicity
 *   (no regression below the current version) belongs to the controlled command
 *   functions (T02.03/T02.06), not to expand DDL.
 * - `legacy_rows_are_not_backfilled_with_a_generation`: principals that predate
 *   the migration keep NULL `identity_generation`. A missing version is never
 *   filled with a guessed 1; only PrincipalRegistry (T02.07) writes 1 for a
 *   genuinely new user.
 * - `clock_key_and_scope_constraints_are_refused`: the stable four-column key
 *   (tenant, principal, kind, scope) is unique, the kind domain is closed, and a
 *   company clock's scope IS its tenant. The same workspace id in two companies
 *   is two team clocks, not a collision.
 * - `tenant_status_accepts_provisioning_state`: the widened status domain keeps
 *   active/suspended and admits provisioning (T03.03's platform provisioning
 *   state) while staying a closed domain.
 * - `typed_schema_matches_applied_migration`: the Drizzle projection and the SQL
 *   every environment runs cannot drift; and the existing membership epoch
 *   columns stay integer — only the new version columns are bigint.
 * - `migration_replays_from_clean_state_without_touching_legacy` and
 *   `schema_file_is_registered_in_barrel_generator_and_journal` complete the
 *   expand-migration proofs (apply/replay, legacy untouched, journal monotonic).
 *
 * The five BA_TEST_* URLs are all required (presence and same-instance shape);
 * a missing one is a blocked suite, never a silent fallback to the shared, MT or
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
const MIGRATION_TAG = "0222_better_auth_clocks";
const MIGRATION_PATH = join(
  import.meta.dirname,
  `../../drizzle/${MIGRATION_TAG}.sql`,
);
const CLOCK_TABLE = "auth_eligibility_clocks";
/** Number.MAX_SAFE_INTEGER: the Version domain's inclusive upper bound. */
const SAFE_MAX = 9007199254740991;
const TENANT = "t0202-tenant";
const TENANT_B = "t0202-tenant-b";
const WORKSPACE = "ws-t0202";
const USER = "t0202-user";
const PRINCIPAL = "t0202-principal";
const PRINCIPAL_LEGACY = "t0202-principal-legacy";

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

function readBaUrls(): { setup: string; shapes: Map<string, string> } {
  const shapes = new Map<string, string>();
  for (const variable of BA_URL_VARIABLES) {
    const raw = process.env[variable]?.trim();
    if (!raw) {
      throw new Error(
        `${variable} is required: a better-auth DB suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
      );
    }
    shapes.set(variable, shapeOf(variable, raw).endpoint);
  }
  const signature = (variable: string) => {
    const { endpoint, database } = shapeOf(
      variable,
      process.env[variable]!.trim(),
    );
    return `${endpoint}/${database}`;
  };
  const reference = signature(DATABASE_VARIABLE);
  for (const variable of BA_URL_VARIABLES) {
    if (signature(variable) !== reference) {
      throw new Error(
        `${variable} must name the same PostgreSQL instance and database as ${DATABASE_VARIABLE}.`,
      );
    }
  }
  return { setup: process.env[DATABASE_VARIABLE]!.trim(), shapes };
}

function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const record = current as { code?: unknown; errno?: unknown };
    for (const code of [record.code, record.errno]) {
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Read lazily, so a worktree without the expand migration still collects (and
 * fails) every case with a message naming the missing target behavior instead
 * of dying at import time as a zero-case collection error.
 */
function loadMigrationSql(): string {
  if (!existsSync(MIGRATION_PATH)) {
    throw new Error(
      `${MIGRATION_TAG}.sql does not exist: the expand migration this suite pins (enterprise_principals.identity_generation + ${CLOCK_TABLE}) is the T02.02 target behavior, not an environment problem.`,
    );
  }
  return readFileSync(MIGRATION_PATH, "utf8");
}

interface ClockRow {
  tenant_id: string;
  principal_id: string;
  kind: string;
  scope_id: string;
  epoch: string | number;
  generation: string | number;
  tombstone: boolean;
  last_command_id: string;
}

interface LegacySnapshot {
  tenants: unknown[];
  principals: unknown[];
  workspaces: unknown[];
  memberships: unknown[];
  workspaceMemberships: unknown[];
  fingerprint: string;
}

interface Harness {
  sql: postgres.Sql;
  baselineTableCount: number;
  firstApplyTableCount: number;
  replayTableCount: number;
  legacyBefore: LegacySnapshot;
  legacyAfter: LegacySnapshot;
  readClocks(): Promise<ClockRow[]>;
  close(): Promise<void>;
}

/**
 * Returns the island to the pre-T02.02 shape: this suite's rows gone, its table
 * gone, its column gone, the tenant status domain back to active/suspended.
 * Every statement is a no-op on a pristine baseline, and it also recovers a
 * crashed earlier run that left any of them behind.
 */
async function cleanupFixture(sql: postgres.Sql): Promise<void> {
  await sql`DELETE FROM enterprise_tenants WHERE id LIKE 't0202-%'`;
  await sql`DELETE FROM users WHERE id LIKE 't0202-%'`;
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

/** Only the artifacts the migration adds — used between the two applies, where the seeded legacy rows must survive. */
async function revertMigrationArtifacts(sql: postgres.Sql): Promise<void> {
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

async function seedLegacyFixture(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO enterprise_tenants (id, name) VALUES
      (${TENANT}, 'T02.02 company'),
      (${TENANT_B}, 'T02.02 company B')`;
  await sql`
    INSERT INTO users (id, email) VALUES
      (${USER}, 't0202-user@example.test'),
      ('t0202-user-legacy', 't0202-user-legacy@example.test')`;
  // Seeded BEFORE the migration applies: both principals are "legacy" rows for
  // the no-backfill proof.
  await sql`
    INSERT INTO enterprise_principals (id, user_id) VALUES
      (${PRINCIPAL}, ${USER}),
      (${PRINCIPAL_LEGACY}, 't0202-user-legacy')`;
  await sql`
    INSERT INTO enterprise_workspaces (tenant_id, id, name) VALUES
      (${TENANT}, ${WORKSPACE}, 'T02.02 workspace'),
      (${TENANT_B}, ${WORKSPACE}, 'Same workspace id in company B')`;
  await sql`
    INSERT INTO enterprise_memberships (tenant_id, principal_id, role, epoch) VALUES
      (${TENANT}, ${PRINCIPAL}, 'member', 3)`;
  await sql`
    INSERT INTO enterprise_workspace_memberships
      (tenant_id, workspace_id, principal_id, epoch)
    VALUES (${TENANT}, ${WORKSPACE}, ${PRINCIPAL}, 2)`;
}

async function countPublicTables(sql: postgres.Sql): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
  `;
  return Number(row?.count ?? 0);
}

/**
 * Every public column except this suite's own additions. The fingerprint is
 * taken before the first apply and after the replay, so anything the migration
 * changed about an existing column would show — which is the point: only the
 * tenant status CHECK (a constraint, invisible here) changes and the new
 * principals column/table are excluded by name.
 */
async function publicColumnFingerprint(sql: postgres.Sql): Promise<string> {
  const rows = await sql<
    {
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }[]
  >`
    SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND NOT (table_name = ${CLOCK_TABLE})
       AND NOT (table_name = 'enterprise_principals'
                AND column_name = 'identity_generation')
     ORDER BY table_name, ordinal_position
  `;
  const hasher = new Bun.CryptoHasher("sha256");
  for (const row of rows) {
    hasher.update(
      `${row.table_name}.${row.column_name}:${row.data_type}:${row.is_nullable}:${row.column_default ?? ""}\n`,
    );
  }
  return hasher.digest("hex");
}

async function legacySnapshot(sql: postgres.Sql): Promise<LegacySnapshot> {
  const tenants = await sql`
    SELECT id, name, status, policy_revision
      FROM enterprise_tenants WHERE id LIKE 't0202-%' ORDER BY id`;
  const principals = await sql`
    SELECT id, user_id, status
      FROM enterprise_principals WHERE id LIKE 't0202-%' ORDER BY id`;
  const workspaces = await sql`
    SELECT tenant_id, id, name
      FROM enterprise_workspaces WHERE tenant_id LIKE 't0202-%'
     ORDER BY tenant_id, id`;
  const memberships = await sql`
    SELECT tenant_id, principal_id, role, status, epoch
      FROM enterprise_memberships WHERE tenant_id LIKE 't0202-%'
     ORDER BY tenant_id, principal_id`;
  const workspaceMemberships = await sql`
    SELECT tenant_id, workspace_id, principal_id, status, epoch
      FROM enterprise_workspace_memberships WHERE tenant_id LIKE 't0202-%'
     ORDER BY tenant_id, workspace_id, principal_id`;
  return {
    tenants: [...tenants],
    principals: [...principals],
    workspaces: [...workspaces],
    memberships: [...memberships],
    workspaceMemberships: [...workspaceMemberships],
    fingerprint: await publicColumnFingerprint(sql),
  };
}

async function readClocks(sql: postgres.Sql): Promise<ClockRow[]> {
  const rows = await sql<ClockRow[]>`
    SELECT tenant_id, principal_id, kind, scope_id, epoch, generation,
           tombstone, last_command_id
      FROM auth_eligibility_clocks
     WHERE tenant_id LIKE 't0202-%'
     ORDER BY tenant_id, principal_id, kind, scope_id`;
  return [...rows];
}

async function createHarness(): Promise<Harness> {
  const { setup } = readBaUrls();
  const sql = postgres(setup, {
    max: 1,
    idle_timeout: 5,
    onnotice: () => {},
  });

  try {
    await cleanupFixture(sql);

    await seedLegacyFixture(sql);
    const legacyBefore = await legacySnapshot(sql);
    const baselineTableCount = await countPublicTables(sql);

    const migrationSql = loadMigrationSql();
    await sql.unsafe(migrationSql);
    const firstApplyTableCount = await countPublicTables(sql);
    await revertMigrationArtifacts(sql);
    await sql.unsafe(migrationSql);
    const replayTableCount = await countPublicTables(sql);
    const legacyAfter = await legacySnapshot(sql);

    return {
      sql,
      baselineTableCount,
      firstApplyTableCount,
      replayTableCount,
      legacyBefore,
      legacyAfter,
      readClocks: () => readClocks(sql),
      close: async () => {
        try {
          await cleanupFixture(sql);
        } finally {
          await sql.end({ timeout: 5 }).catch(() => {});
        }
      },
    };
  } catch (error) {
    // Never leave the shared BA database holding this suite's rows/columns when
    // setup itself fails.
    await cleanupFixture(sql).catch(() => {});
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

describe("T02.02 principal identity generation and durable eligibility clocks", () => {
  afterAll(async () => {
    const created = await harnessPromise?.catch(() => undefined);
    if (created) await created.close();
    // A fresh probe, so the leak check sees the cleaned database rather than the
    // harness's released pool: no table, no column, the original status domain,
    // and none of this suite's rows.
    const { setup } = readBaUrls();
    const probe = postgres(setup, { max: 1 });
    try {
      const tables = await probe<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ${CLOCK_TABLE}`;
      expect(tables).toHaveLength(0);
      const columns = await probe<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'enterprise_principals'
           AND column_name = 'identity_generation'`;
      expect(columns).toHaveLength(0);
      const [statusCheck] = await probe<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition
          FROM pg_constraint WHERE conname = 'enterprise_tenant_status'`;
      expect(statusCheck?.definition).not.toContain("provisioning");
      const tenants = await probe`
        SELECT id FROM enterprise_tenants WHERE id LIKE 't0202-%'`;
      expect([...tenants]).toEqual([]);
      const users = await probe`
        SELECT id FROM users WHERE id LIKE 't0202-%'`;
      expect([...users]).toEqual([]);
    } finally {
      await probe.end({ timeout: 5 }).catch(() => {});
    }
  });

  test("projection_rebuild_does_not_reset_tombstone", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    // Two revoked relationships: the company clock (scope = the tenant itself)
    // and a team clock (scope = the workspace), both tombstoned by a removal
    // command and already past their first generation.
    await sql`
      INSERT INTO auth_eligibility_clocks
        (tenant_id, principal_id, kind, scope_id, epoch, generation, tombstone, last_command_id)
      VALUES
        (${TENANT}, ${PRINCIPAL}, 'company', ${TENANT}, 3, 2, true, 'cmd-t0202-remove-01'),
        (${TENANT}, ${PRINCIPAL}, 'team', ${WORKSPACE}, 2, 4, true, 'cmd-t0202-team-remove-07')`;
    const beforeClock = await harness.readClocks();
    // Guard against a vacuous equality: the "before" must actually be two
    // tombstoned rows with advanced versions.
    expect(beforeClock).toHaveLength(2);
    expect(beforeClock.map((row) => row.tombstone)).toEqual([true, true]);
    expect(beforeClock.map((row) => Number(row.generation))).toEqual([2, 4]);

    // The physical removal: BA deletes the member and the team member, and the
    // derived projection rows go with them.
    await sql`
      DELETE FROM enterprise_workspace_memberships
       WHERE tenant_id = ${TENANT} AND principal_id = ${PRINCIPAL}`;
    await sql`
      DELETE FROM enterprise_memberships
       WHERE tenant_id = ${TENANT} AND principal_id = ${PRINCIPAL}`;

    // The rebuild: projection rows are re-derived from the current directory —
    // fresh epochs, same stable business identity. The clock is not an input
    // the rebuild may rewrite.
    await sql`
      INSERT INTO enterprise_memberships (tenant_id, principal_id, role, epoch)
      VALUES (${TENANT}, ${PRINCIPAL}, 'member', 4)`;
    await sql`
      INSERT INTO enterprise_workspace_memberships
        (tenant_id, workspace_id, principal_id, epoch)
      VALUES (${TENANT}, ${WORKSPACE}, ${PRINCIPAL}, 3)`;

    const afterClock = await harness.readClocks();
    expect(afterClock).toEqual(beforeClock);

    // The suite's cases share one database: each case removes the clock rows it
    // wrote, so the next one starts from the state the harness established
    // rather than from whatever the previous case happened to leave.
    await sql`DELETE FROM auth_eligibility_clocks WHERE tenant_id LIKE 't0202-%'`;
  });

  test("unsafe_or_wrapped_version_is_rejected", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    // Wrapped past the safe-integer ceiling on insert: MAX_SAFE_INTEGER + 1
    // fits a bigint column but is not a Version.
    let wrappedInserted = true;
    try {
      await sql`
        INSERT INTO auth_eligibility_clocks
          (tenant_id, principal_id, kind, scope_id, epoch, generation, tombstone, last_command_id)
        VALUES
          (${TENANT}, ${PRINCIPAL_LEGACY}, 'company', ${TENANT}, 1, ${SAFE_MAX + 1}, false, 'cmd-t0202-wrap')`;
    } catch (error) {
      wrappedInserted = false;
      expect(sqlStateOf(error)).toBe("23514");
    }
    expect(wrappedInserted).toBe(false);

    // Wrapped on the advance path: an UPDATE of a live row is bounded the same
    // way, so a caller cannot smuggle an unsafe version in after creation.
    await sql`
      INSERT INTO auth_eligibility_clocks
        (tenant_id, principal_id, kind, scope_id, epoch, generation, tombstone, last_command_id)
      VALUES
        (${TENANT}, ${PRINCIPAL_LEGACY}, 'company', ${TENANT}, 1, 1, false, 'cmd-t0202-create')`;
    let epochWrapped = true;
    try {
      await sql`
        UPDATE auth_eligibility_clocks SET epoch = ${SAFE_MAX + 1}
         WHERE tenant_id = ${TENANT} AND principal_id = ${PRINCIPAL_LEGACY}`;
    } catch (error) {
      epochWrapped = false;
      expect(sqlStateOf(error)).toBe("23514");
    }
    expect(epochWrapped).toBe(false);

    // Negative is not a Version either, in both columns.
    let negativeInserted = true;
    try {
      await sql`
        INSERT INTO auth_eligibility_clocks
          (tenant_id, principal_id, kind, scope_id, epoch, generation, tombstone, last_command_id)
        VALUES
          (${TENANT}, ${PRINCIPAL_LEGACY}, 'team', ${WORKSPACE}, -1, 1, false, 'cmd-t0202-negative')`;
    } catch (error) {
      negativeInserted = false;
      expect(sqlStateOf(error)).toBe("23514");
    }
    expect(negativeInserted).toBe(false);

    // The same ceiling bounds the Principal's identity generation.
    let identityWrapped = true;
    try {
      await sql`
        UPDATE enterprise_principals SET identity_generation = ${SAFE_MAX + 1}
         WHERE id = ${PRINCIPAL_LEGACY}`;
    } catch (error) {
      identityWrapped = false;
      expect(sqlStateOf(error)).toBe("23514");
    }
    expect(identityWrapped).toBe(false);

    // The boundary itself is legal and inclusive: the ceiling is a Version.
    await sql`
      INSERT INTO auth_eligibility_clocks
        (tenant_id, principal_id, kind, scope_id, epoch, generation, tombstone, last_command_id)
      VALUES
        (${TENANT_B}, ${PRINCIPAL_LEGACY}, 'company', ${TENANT_B}, ${SAFE_MAX}, ${SAFE_MAX}, false, 'cmd-t0202-boundary')`;
    const [boundary] = await sql<{ epoch: string; generation: string }[]>`
      SELECT epoch, generation FROM auth_eligibility_clocks
       WHERE last_command_id = 'cmd-t0202-boundary'`;
    expect(Number(boundary?.epoch)).toBe(SAFE_MAX);
    expect(Number(boundary?.generation)).toBe(SAFE_MAX);

    await sql`DELETE FROM auth_eligibility_clocks WHERE tenant_id LIKE 't0202-%'`;
  });

  test("legacy_rows_are_not_backfilled_with_a_generation", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    // Both principals were seeded before the migration applied and must still
    // carry NULL: a missing version stays missing, it is never guessed as 1.
    const legacy = await sql<
      { id: string; identity_generation: string | null }[]
    >`
      SELECT id, identity_generation FROM enterprise_principals
       WHERE id LIKE 't0202-%' ORDER BY id`;
    expect(legacy).toHaveLength(2);
    expect(legacy.map((row) => row.identity_generation)).toEqual([null, null]);

    // A genuinely new principal CAN carry generation 1 — written by the
    // registry (T02.07), stored here as a plain safe integer.
    await sql`
      INSERT INTO users (id, email) VALUES
        ('t0202-user-new', 't0202-user-new@example.test')`;
    await sql`
      INSERT INTO enterprise_principals (id, user_id, identity_generation)
      VALUES ('t0202-principal-new', 't0202-user-new', 1)`;
    const [created] = await sql<{ identity_generation: string }[]>`
      SELECT identity_generation FROM enterprise_principals
       WHERE id = 't0202-principal-new'`;
    expect(Number(created?.identity_generation)).toBe(1);
  });

  test("clock_key_and_scope_constraints_are_refused", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    await sql`
      INSERT INTO auth_eligibility_clocks
        (tenant_id, principal_id, kind, scope_id, epoch, generation, tombstone, last_command_id)
      VALUES
        (${TENANT}, ${PRINCIPAL}, 'company', ${TENANT}, 1, 1, false, 'cmd-t0202-key-a')`;

    // The stable key is the four columns together: the same principal, kind
    // and scope in another company is a different clock, not a collision.
    await sql`
      INSERT INTO auth_eligibility_clocks
        (tenant_id, principal_id, kind, scope_id, epoch, generation, tombstone, last_command_id)
      VALUES
        (${TENANT_B}, ${PRINCIPAL}, 'company', ${TENANT_B}, 1, 1, false, 'cmd-t0202-key-b')`;

    // One clock per (tenant, principal, kind, scope): the second row for the
    // same key is refused, whatever command id it carries.
    let duplicateKeyInserted = true;
    try {
      await sql`
        INSERT INTO auth_eligibility_clocks
          (tenant_id, principal_id, kind, scope_id, epoch, generation, tombstone, last_command_id)
        VALUES
          (${TENANT}, ${PRINCIPAL}, 'company', ${TENANT}, 2, 1, false, 'cmd-t0202-duplicate')`;
    } catch (error) {
      duplicateKeyInserted = false;
      expect(sqlStateOf(error)).toBe("23505");
    }
    expect(duplicateKeyInserted).toBe(false);

    // A company clock's scope IS its tenant: anything else is a malformed key,
    // refused by the CHECK rather than silently stored.
    let companyScopeMismatched = true;
    try {
      await sql`
        INSERT INTO auth_eligibility_clocks
          (tenant_id, principal_id, kind, scope_id, epoch, generation, tombstone, last_command_id)
        VALUES
          (${TENANT}, ${PRINCIPAL}, 'company', ${WORKSPACE}, 1, 1, false, 'cmd-t0202-scope')`;
    } catch (error) {
      companyScopeMismatched = false;
      expect(sqlStateOf(error)).toBe("23514");
    }
    expect(companyScopeMismatched).toBe(false);

    // The kind domain is closed: only company and team eligibility exist.
    let unknownKindInserted = true;
    try {
      await sql`
        INSERT INTO auth_eligibility_clocks
          (tenant_id, principal_id, kind, scope_id, epoch, generation, tombstone, last_command_id)
        VALUES
          (${TENANT}, ${PRINCIPAL}, 'workspace', ${WORKSPACE}, 1, 1, false, 'cmd-t0202-kind')`;
    } catch (error) {
      unknownKindInserted = false;
      expect(sqlStateOf(error)).toBe("23514");
    }
    expect(unknownKindInserted).toBe(false);

    await sql`DELETE FROM auth_eligibility_clocks WHERE tenant_id LIKE 't0202-%'`;
  });

  test("tenant_status_accepts_provisioning_state", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    // The widened domain admits T03.03's platform provisioning state — a
    // company created locally whose external initialization has not completed.
    await sql`
      INSERT INTO enterprise_tenants (id, name, status)
      VALUES ('t0202-tenant-prov', 'T02.02 provisioning company', 'provisioning')`;
    const [provisioning] = await sql<{ status: string }[]>`
      SELECT status FROM enterprise_tenants WHERE id = 't0202-tenant-prov'`;
    expect(provisioning?.status).toBe("provisioning");

    // Legacy states are still first-class.
    await sql`
      INSERT INTO enterprise_tenants (id, name, status)
      VALUES ('t0202-tenant-susp', 'T02.02 suspended company', 'suspended')`;

    // And the domain is still closed: an arbitrary string is refused exactly as
    // it was before the widening.
    let bogusInserted = true;
    try {
      await sql`
        INSERT INTO enterprise_tenants (id, name, status)
        VALUES ('t0202-tenant-bogus', 'T02.02 bogus company', 'bogus')`;
    } catch (error) {
      bogusInserted = false;
      expect(sqlStateOf(error)).toBe("23514");
    }
    expect(bogusInserted).toBe(false);
  });

  test("typed_schema_matches_applied_migration", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    // The barrel carries the clock table: a schema file that exists but is not
    // exported is invisible to every consumer of the barrel.
    const clockTable = (schema as unknown as Record<string, unknown>)
      .authEligibilityClocks;
    expect(
      clockTable,
      "schema barrel exports authEligibilityClocks",
    ).toBeDefined();

    const columns = await sql<
      {
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: string;
      }[]
    >`
      SELECT table_name, column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (table_name = ${CLOCK_TABLE}
              OR (table_name = 'enterprise_principals'
                  AND column_name = 'identity_generation')
              OR (table_name IN ('enterprise_memberships', 'enterprise_workspace_memberships')
                  AND column_name = 'epoch'))`;

    const clockColumns = columns.filter(
      (row) => row.table_name === CLOCK_TABLE,
    );
    const typed = getTableConfig(
      clockTable as Parameters<typeof getTableConfig>[0],
    );
    expect(
      clockColumns.map((row) => row.column_name).sort(),
      "auth_eligibility_clocks columns",
    ).toEqual(typed.columns.map((column) => column.name).sort());
    for (const column of typed.columns) {
      const found = clockColumns.find((row) => row.column_name === column.name);
      expect(found, `${CLOCK_TABLE}.${column.name} exists`).toBeDefined();
      expect(
        found?.is_nullable === "NO",
        `${CLOCK_TABLE}.${column.name} nullability`,
      ).toBe(column.notNull);
    }
    for (const name of ["epoch", "generation"]) {
      const found = clockColumns.find((row) => row.column_name === name);
      expect(found?.data_type, `${CLOCK_TABLE}.${name} is bigint`).toBe(
        "bigint",
      );
    }

    // The Principal's new column: bigint and nullable — expand adds it empty.
    const [identity] = columns.filter(
      (row) => row.column_name === "identity_generation",
    );
    expect(identity?.data_type).toBe("bigint");
    expect(identity?.is_nullable).toBe("YES");

    // The existing membership epochs stay integer: the migration does not
    // retype existing columns, and the mixed types are compared in the
    // application layer through Number.isSafeInteger, not by the database.
    const membershipEpochs = columns.filter(
      (row) => row.table_name !== CLOCK_TABLE && row.column_name === "epoch",
    );
    expect(membershipEpochs).toHaveLength(2);
    expect(membershipEpochs.map((row) => row.data_type)).toEqual([
      "integer",
      "integer",
    ]);

    // Every named constraint of the clock exists on the applied table, and the
    // safe-integer CHECKs actually carry the ceiling.
    const constraintDefs = await sql<{ conname: string; definition: string }[]>`
      SELECT con.conname, pg_get_constraintdef(con.oid) AS definition
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = rel.relnamespace
       WHERE n.nspname = 'public' AND rel.relname = ${CLOCK_TABLE}`;
    const constraints = new Map(
      constraintDefs.map((row) => [row.conname, row.definition]),
    );
    for (const name of [
      "auth_eligibility_clock_pk",
      "auth_eligibility_clock_kind",
      "auth_eligibility_clock_scope_matches_kind",
      "auth_eligibility_clock_epoch_safe_integer",
      "auth_eligibility_clock_generation_safe_integer",
      "auth_eligibility_clock_tenant_fk",
      "auth_eligibility_clock_principal_fk",
    ]) {
      expect(constraints.has(name), `${CLOCK_TABLE}: ${name}`).toBe(true);
    }
    expect(
      constraints.get("auth_eligibility_clock_epoch_safe_integer"),
    ).toContain(String(SAFE_MAX));
    expect(
      constraints.get("auth_eligibility_clock_generation_safe_integer"),
    ).toContain(String(SAFE_MAX));

    const [principalCheck] = await sql<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conname = 'enterprise_principal_identity_generation_safe_integer'`;
    expect(principalCheck?.definition).toContain(String(SAFE_MAX));

    const indexes = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = ${CLOCK_TABLE}`;
    expect(indexes.map((row) => row.indexname)).toContain(
      "auth_eligibility_clock_principal_idx",
    );

    // The typed principal table now carries the column the migration added.
    const typedPrincipals = getTableConfig(enterprisePrincipals);
    expect(typedPrincipals.columns.map((column) => column.name)).toContain(
      "identity_generation",
    );
  });

  test("migration_replays_from_clean_state_without_touching_legacy", async () => {
    const harness = await loadHarness();
    // The baseline plus exactly one new table, both on the first apply and on a
    // replay from the reverted state.
    expect(harness.baselineTableCount).toBeGreaterThanOrEqual(251);
    expect(harness.firstApplyTableCount).toBe(harness.baselineTableCount + 1);
    expect(harness.replayTableCount).toBe(harness.firstApplyTableCount);

    // Legacy rows and every existing public column (minus this suite's own
    // additions) are untouched by the expand migration, including the integer
    // membership epochs it deliberately did not retype.
    expect(harness.legacyAfter).toEqual(harness.legacyBefore);
    expect(harness.legacyBefore.tenants).toHaveLength(2);
    expect(harness.legacyBefore.principals).toHaveLength(2);
    expect(harness.legacyBefore.memberships).toEqual([
      {
        tenant_id: TENANT,
        principal_id: PRINCIPAL,
        role: "member",
        status: "active",
        epoch: 3,
      },
    ]);
    expect(harness.legacyBefore.workspaceMemberships).toEqual([
      {
        tenant_id: TENANT,
        workspace_id: WORKSPACE,
        principal_id: PRINCIPAL,
        status: "active",
        epoch: 2,
      },
    ]);
  });

  test("schema_file_is_registered_in_barrel_generator_and_journal", () => {
    const barrel = readFileSync(
      join(import.meta.dirname, "../../src/db/schema/index.ts"),
      "utf8",
    );
    expect(barrel).toContain('export * from "./auth-eligibility";');

    const config = readFileSync(
      join(import.meta.dirname, "../../drizzle.config.ts"),
      "utf8",
    );
    expect(config).toContain('"./src/db/schema/auth-eligibility.ts"');

    const journal = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../../drizzle/meta/_journal.json"),
        "utf8",
      ),
    ) as { entries: { idx: number; tag: string }[] };
    const entry = journal.entries.find(
      (candidate) => candidate.tag === MIGRATION_TAG,
    );
    expect(entry?.idx).toBe(210);
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    // The journal stays monotonic and gapless: a later task appends after this
    // entry, it never renumbers or reuses another ticket's serial.
    for (let index = 1; index < journal.entries.length; index += 1) {
      expect(journal.entries[index].idx).toBe(
        journal.entries[index - 1].idx + 1,
      );
    }
  });
});
