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
 * T02.03 (#525, P03) — the command-finalization, authority and outbox
 * persistent model, checked against the real migration on the isolated
 * BA_TEST_* stack (design §4.2 "事件与幂等", §5.2.1, §13.2; interfaces §2, §3.3).
 *
 * What this file pins, and why each part is a database fact rather than a
 * code convention:
 *
 * - `expand_keeps_legacy_authority_and_closed_release`: the expand migration
 *   seeds the one AuthorityState row as legacy authority with the multi-tenant
 *   release still closed, and the two gates stay independent columns — flipping
 *   the release does not touch the directory authority and vice versa
 *   (interfaces §3.3, design §13.2: M5/M6 only change the release gate).
 * - `conflicting_receipt_payload_is_refused`: the receipt's idempotency (变更)
 *   key is unique per company/identity domain target. The same key with a
 *   different payload hash under the same unique domain is refused — SQLSTATE
 *   23505, the idempotency conflict interfaces §4 maps to HTTP 409. A replay
 *   compares the hash in the executor (T02.08); the database only guarantees
 *   one receipt per key per domain target.
 * - `receipt_domains_targets_and_actor_are_pinned`: company receipts target a
 *   tenant, identity receipts target a user, never both and never neither; the
 *   actor kind domain is closed (no impersonation kind exists to accept); and
 *   `finalized` exists exactly when its timestamp does.
 * - `change_keys_carry_versions_and_per_key_finalization`: every affected
 *   relationship key a command registers carries the before/after versions
 *   (nullable before = the relationship did not exist) and its own finalization
 *   flag, so the commit fence (T02.06) can prove each registered key was
 *   finalized inside the command (design §5.2.1).
 * - `outbox_rows_share_the_command_transaction`: receipts, change keys and
 *   outbox rows written in one transaction all disappear on rollback — the
 *   "same transaction" contract is the table's, not the caller's discipline.
 * - `authority_state_domains_and_consistency_are_enforced`: phase M0..M7 and
 *   directoryAuthority legacy/paused/ba are closed domains, the two are
 *   consistent per the migration state machine (M0/M1 legacy, M2/M3 paused,
 *   M4..M7 ba), the version is a safe-integer bigint, and exactly one row can
 *   exist — a missing state is never guessed as legacy by the gates (T02.10).
 * - `typed_schema_matches_applied_migration` and
 *   `migration_replays_from_clean_state_without_touching_legacy` and
 *   `schema_file_is_registered_in_barrel_generator_and_journal` complete the
 *   expand-migration proofs (typed parity, apply/replay, legacy untouched,
 *   journal monotonic). The migration grants nothing and revokes nothing, so
 *   legacy authority keeps working; roles/RLS/controlled functions are T02.06.
 *
 * The five BA_TEST_* URLs are all required (presence and same-instance shape);
 * a missing one is a blocked suite, never a silent fallback to the shared, MT
 * or job-level database. No DSN is ever printed — refusals name the variable.
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
const MIGRATION_TAG = "0223_better_auth_command_authority";
const MIGRATION_PATH = join(
  import.meta.dirname,
  `../../drizzle/${MIGRATION_TAG}.sql`,
);
const RECEIPT_TABLE = "auth_command_receipts";
const CHANGE_KEY_TABLE = "auth_command_change_keys";
const OUTBOX_TABLE = "auth_command_outbox";
const AUTHORITY_TABLE = "auth_authority_states";
/** The migration's own tables, excluded from the legacy column fingerprint. */
const MIGRATION_TABLES = [
  RECEIPT_TABLE,
  CHANGE_KEY_TABLE,
  OUTBOX_TABLE,
  AUTHORITY_TABLE,
];
/** Number.MAX_SAFE_INTEGER: the Version domain's inclusive upper bound. */
const SAFE_MAX = 9007199254740991;
const TENANT = "t0203-tenant";
const TENANT_B = "t0203-tenant-b";
const WORKSPACE = "ws-t0203";
const USER_A = "t0203-user";
const USER_B = "t0203-user-b";
const PRINCIPAL = "t0203-principal";

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
 * The HTTP status a refused directory write maps to: the idempotency/version
 * competition conflict of interfaces §4 (unique violation → 409), anything
 * else stays an infrastructure-shaped 500 so a wrapped CHECK can never read
 * as a clean conflict.
 */
function conflictStatusOf(error: unknown): number {
  return sqlStateOf(error) === "23505" ? 409 : 500;
}

/**
 * Read lazily, so a worktree without the expand migration still collects (and
 * fails) every case with a message naming the missing target behavior instead
 * of dying at import time as a zero-case collection error.
 */
function loadMigrationSql(): string {
  if (!existsSync(MIGRATION_PATH)) {
    throw new Error(
      `${MIGRATION_TAG}.sql does not exist: the expand migration this suite pins (the ${RECEIPT_TABLE}/${CHANGE_KEY_TABLE}/${OUTBOX_TABLE}/${AUTHORITY_TABLE} model) is the T02.03 target behavior, not an environment problem.`,
    );
  }
  return readFileSync(MIGRATION_PATH, "utf8");
}

interface AuthorityRow {
  phase: string;
  directory_authority: string;
  authority_version: string | number;
  multi_tenant_released: boolean;
}

interface LegacySnapshot {
  tenants: unknown[];
  users: unknown[];
  principals: unknown[];
  fingerprint: string;
}

interface Harness {
  sql: postgres.Sql;
  baselineTableCount: number;
  firstApplyTableCount: number;
  replayTableCount: number;
  legacyBefore: LegacySnapshot;
  legacyAfter: LegacySnapshot;
  readAuthority(): Promise<AuthorityRow | undefined>;
  close(): Promise<void>;
}

/**
 * Returns the island to the pre-T02.03 shape: this suite's tables gone and its
 * seeded rows gone. Every statement is a no-op on a pristine baseline, and it
 * also recovers a crashed earlier run that left any of them behind.
 */
async function cleanupFixture(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`DROP TABLE IF EXISTS ${OUTBOX_TABLE} CASCADE`);
  await sql.unsafe(`DROP TABLE IF EXISTS ${CHANGE_KEY_TABLE} CASCADE`);
  await sql.unsafe(`DROP TABLE IF EXISTS ${RECEIPT_TABLE} CASCADE`);
  await sql.unsafe(`DROP TABLE IF EXISTS ${AUTHORITY_TABLE} CASCADE`);
  await sql`DELETE FROM enterprise_tenants WHERE id LIKE 't0203-%'`;
  await sql`DELETE FROM users WHERE id LIKE 't0203-%'`;
}

/** Only the artifacts the migration adds — used between the two applies, where the seeded legacy rows must survive. */
async function revertMigrationArtifacts(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`DROP TABLE IF EXISTS ${OUTBOX_TABLE} CASCADE`);
  await sql.unsafe(`DROP TABLE IF EXISTS ${CHANGE_KEY_TABLE} CASCADE`);
  await sql.unsafe(`DROP TABLE IF EXISTS ${RECEIPT_TABLE} CASCADE`);
  await sql.unsafe(`DROP TABLE IF EXISTS ${AUTHORITY_TABLE} CASCADE`);
}

async function seedLegacyFixture(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO enterprise_tenants (id, name) VALUES
      (${TENANT}, 'T02.03 company'),
      (${TENANT_B}, 'T02.03 company B')`;
  await sql`
    INSERT INTO users (id, email) VALUES
      (${USER_A}, 't0203-user@example.test'),
      (${USER_B}, 't0203-user-b@example.test')`;
  await sql`
    INSERT INTO enterprise_principals (id, user_id) VALUES
      (${PRINCIPAL}, ${USER_A})`;
  await sql`
    INSERT INTO enterprise_workspaces (tenant_id, id, name) VALUES
      (${TENANT}, ${WORKSPACE}, 'T02.03 workspace')`;
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
 * Every public column except this suite's own tables. The fingerprint is taken
 * before the first apply and after the replay, so anything the migration
 * changed about an existing column would show — which is the point: this
 * migration touches no existing table, not even a constraint.
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
       AND table_name NOT IN (${MIGRATION_TABLES[0]}, ${MIGRATION_TABLES[1]}, ${MIGRATION_TABLES[2]}, ${MIGRATION_TABLES[3]})
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
      FROM enterprise_tenants WHERE id LIKE 't0203-%' ORDER BY id`;
  const users = await sql`
    SELECT id, email FROM users WHERE id LIKE 't0203-%' ORDER BY id`;
  const principals = await sql`
    SELECT id, user_id, status
      FROM enterprise_principals WHERE id LIKE 't0203-%' ORDER BY id`;
  return {
    tenants: [...tenants],
    users: [...users],
    principals: [...principals],
    fingerprint: await publicColumnFingerprint(sql),
  };
}

async function readAuthority(
  sql: postgres.Sql,
): Promise<AuthorityRow | undefined> {
  const [row] = await sql<AuthorityRow[]>`
    SELECT phase, directory_authority, authority_version, multi_tenant_released
      FROM ${sql(AUTHORITY_TABLE)} WHERE id = 1`;
  return row;
}

/** The seed state the migration establishes; restoring it keeps the shared row stable across cases. */
async function restoreAuthoritySeed(sql: postgres.Sql): Promise<void> {
  await sql`
    UPDATE auth_authority_states
       SET authority_version = 0, phase = 'M1', directory_authority = 'legacy',
           multi_tenant_released = false, updated_at = now()
     WHERE id = 1`;
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
      readAuthority: () => readAuthority(sql),
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

/**
 * The canonical company-domain receipt this suite's cases start from: a member
 * add keyed by its idempotency (变更) key, the actor the session authenticated,
 * finalized at insert time the way the executor's finalizer does.
 */
async function insertCompanyReceipt(
  sql: postgres.Sql,
  {
    commandId,
    tenantId = TENANT,
    idempotencyKey,
    payloadHash,
    finalized = true,
  }: {
    commandId: string;
    tenantId?: string;
    idempotencyKey: string;
    payloadHash: string;
    finalized?: boolean;
  },
): Promise<void> {
  await sql`
    INSERT INTO auth_command_receipts
      (command_id, domain, operation, tenant_id, idempotency_key, payload_hash,
       actor_user_id, actor_principal_id, actor_session_id, actor_kind,
       resource_id, finalized, finalized_at)
    VALUES
      (${commandId}, 'company', 'member.role.set', ${tenantId},
       ${idempotencyKey}, ${payloadHash},
       ${USER_A}, ${PRINCIPAL}, 'sess-t0203', 'session',
       ${PRINCIPAL}, ${finalized}, ${finalized ? sql`now()` : sql`null`})`;
}

describe("T02.03 command finalization, authority and outbox persistent model", () => {
  afterAll(async () => {
    const created = await harnessPromise?.catch(() => undefined);
    if (created) await created.close();
    // A fresh probe, so the leak check sees the cleaned database rather than
    // the harness's released pool: none of this suite's tables and none of its
    // seeded rows survive the run.
    const { setup } = readBaUrls();
    const probe = postgres(setup, { max: 1 });
    try {
      for (const table of MIGRATION_TABLES) {
        const tables = await probe<{ table_name: string }[]>`
          SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = ${table}`;
        expect(tables, `${table} must be gone`).toHaveLength(0);
      }
      const tenants = await probe`
        SELECT id FROM enterprise_tenants WHERE id LIKE 't0203-%'`;
      expect([...tenants]).toEqual([]);
      const users = await probe`
        SELECT id FROM users WHERE id LIKE 't0203-%'`;
      expect([...users]).toEqual([]);
    } finally {
      await probe.end({ timeout: 5 }).catch(() => {});
    }
  });

  test("expand_keeps_legacy_authority_and_closed_release", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    const row = await harness.readAuthority();
    expect(
      row,
      "the expand migration seeds exactly the one AuthorityState",
    ).toBeDefined();
    const authority = {
      phase: row?.phase,
      directoryAuthority: row?.directory_authority,
      authorityVersion: Number(row?.authority_version),
      released: row?.multi_tenant_released,
    };
    expect(authority).toMatchObject({
      directoryAuthority: "legacy",
      released: false,
    });
    // The expand milestone itself: schema appended, authority still the old
    // one, the version counter at its固化 baseline of 0 (design §13.2).
    expect(authority.phase).toBe("M1");
    expect(authority.authorityVersion).toBe(0);

    // Exactly one row exists: the write gate reads a fact, never a default.
    const [{ count: authorityRows }] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM auth_authority_states`;
    expect(Number(authorityRows)).toBe(1);

    // The directory write gate and the multi-tenant release gate are
    // independent columns (interfaces §3.3, design §13.2: M5/M6 only change
    // the release): flipping the release leaves the authority untouched.
    await sql`
      UPDATE auth_authority_states SET multi_tenant_released = true,
        updated_at = now() WHERE id = 1`;
    const released = await harness.readAuthority();
    expect(released?.multi_tenant_released).toBe(true);
    expect(released?.directory_authority).toBe("legacy");
    expect(released?.phase).toBe("M1");

    await restoreAuthoritySeed(sql);
  });

  test("conflicting_receipt_payload_is_refused", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    await insertCompanyReceipt(sql, {
      commandId: "cmd-t0203-company-a",
      idempotencyKey: "invite-key-1",
      payloadHash: "a1b2c3d4e5f6a7b8",
    });

    // Same unique domain (company, tenant, key) with a DIFFERENT payload hash:
    // a conflicting command, refused — unique violation, mapped to the
    // idempotency conflict 409 of interfaces §4.
    let conflictRefused = false;
    let conflictStatus = 0;
    try {
      await insertCompanyReceipt(sql, {
        commandId: "cmd-t0203-company-conflict",
        idempotencyKey: "invite-key-1",
        payloadHash: "ffffffffffffffff",
      });
    } catch (error) {
      conflictRefused = true;
      conflictStatus = conflictStatusOf(error);
    }
    expect(conflictRefused).toBe(true);
    expect(conflictStatus).toBe(409);

    // An exact replay hits the same fence: the database holds one receipt per
    // key per domain target; deciding replay-vs-conflict from the stored hash
    // is the executor's read (T02.08), not a second row.
    let replayRefused = false;
    try {
      await insertCompanyReceipt(sql, {
        commandId: "cmd-t0203-company-replay",
        idempotencyKey: "invite-key-1",
        payloadHash: "a1b2c3d4e5f6a7b8",
      });
    } catch (error) {
      replayRefused = true;
      expect(sqlStateOf(error)).toBe("23505");
    }
    expect(replayRefused).toBe(true);

    // The unique domain carries the target: the same key in another company is
    // a different command, not a conflict.
    await insertCompanyReceipt(sql, {
      commandId: "cmd-t0203-company-b",
      tenantId: TENANT_B,
      idempotencyKey: "invite-key-1",
      payloadHash: "a1b2c3d4e5f6a7b8",
    });

    // The identity domain targets the user (§5.6): same user, same key,
    // different hash is refused with the same conflict.
    await sql`
      INSERT INTO auth_command_receipts
        (command_id, domain, operation, target_user_id, idempotency_key,
         payload_hash, actor_kind, finalized, finalized_at)
      VALUES
        ('cmd-t0203-identity-a', 'identity', 'identity.password.reset',
         ${USER_B}, 'reset-key-1', '0123456789abcdef',
         'recovery', true, now())`;
    let identityConflict = false;
    let identityStatus = 0;
    try {
      await sql`
        INSERT INTO auth_command_receipts
          (command_id, domain, operation, target_user_id, idempotency_key,
           payload_hash, actor_kind, finalized, finalized_at)
        VALUES
          ('cmd-t0203-identity-conflict', 'identity', 'identity.password.reset',
           ${USER_B}, 'reset-key-1', 'fedcba9876543210',
           'recovery', true, now())`;
    } catch (error) {
      identityConflict = true;
      identityStatus = conflictStatusOf(error);
    }
    expect(identityConflict).toBe(true);
    expect(identityStatus).toBe(409);

    // Domains do not collide: the same key under the identity domain's own
    // target inserts cleanly beside the company receipt.
    await sql`
      INSERT INTO auth_command_receipts
        (command_id, domain, operation, target_user_id, idempotency_key,
         payload_hash, actor_kind, finalized, finalized_at)
      VALUES
        ('cmd-t0203-identity-b', 'identity', 'identity.session.revoke',
         ${USER_A}, 'invite-key-1', 'a1b2c3d4e5f6a7b8',
         'session', true, now())`;

    await sql`DELETE FROM ${sql(RECEIPT_TABLE)} WHERE command_id LIKE 'cmd-t0203-%'`;
  });

  test("receipt_domains_targets_and_actor_are_pinned", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    // A full, legal company receipt first: the shape every refusal is measured
    // against, including the actor the session authenticated and the result
    // identity fields of a DirectoryResult (interfaces §2).
    await sql`
      INSERT INTO auth_command_receipts
        (command_id, domain, operation, tenant_id, idempotency_key, payload_hash,
         actor_user_id, actor_principal_id, actor_session_id, actor_kind,
         actor_binding_id, actor_provisioning,
         workspace_id, resource_id, grant_id, grant_generation,
         finalized, finalized_at)
      VALUES
        ('cmd-t0203-shape', 'company', 'team.create', ${TENANT},
         'shape-key-1', 'a1b2c3d4e5f6a7b8',
         ${USER_A}, ${PRINCIPAL}, 'sess-t0203-shape', 'session',
         null, null,
         ${WORKSPACE}, 'team-t0203', null, null,
         true, now())`;
    const [shape] = await sql<
      {
        finalized: boolean;
        finalized_at: string | null;
        grant_generation: string | null;
      }[]
    >`
      SELECT finalized, finalized_at, grant_generation
        FROM auth_command_receipts WHERE command_id = 'cmd-t0203-shape'`;
    expect(shape?.finalized).toBe(true);
    expect(shape?.finalized_at).not.toBeNull();
    expect(shape?.grant_generation).toBeNull();

    // Unfinalized is the default a mid-command reader sees before the
    // finalizer runs — the flag, not a missing row.
    await insertCompanyReceipt(sql, {
      commandId: "cmd-t0203-open",
      idempotencyKey: "open-key-1",
      payloadHash: "1111111111111111",
      finalized: false,
    });
    const [open] = await sql<
      { finalized: boolean; finalized_at: string | null }[]
    >`
      SELECT finalized, finalized_at FROM auth_command_receipts
       WHERE command_id = 'cmd-t0203-open'`;
    expect(open?.finalized).toBe(false);
    expect(open?.finalized_at).toBeNull();

    const expectCheckRefused = async (statement: () => Promise<unknown>) => {
      let refused = false;
      try {
        await statement();
      } catch (error) {
        refused = true;
        expect(sqlStateOf(error)).toBe("23514");
      }
      expect(refused).toBe(true);
    };

    // The domain is closed: company and identity are the only receipt domains.
    await expectCheckRefused(
      () =>
        sql`
        INSERT INTO auth_command_receipts
          (command_id, domain, operation, tenant_id, idempotency_key,
           payload_hash, actor_kind, finalized, finalized_at)
        VALUES
          ('cmd-t0203-x1', 'global', 'member.remove', ${TENANT},
           'x-key-1', 'x', 'session', true, now())`,
    );

    // A company receipt targets its tenant: neither a missing tenant nor an
    // identity target on the side is a storable shape.
    await expectCheckRefused(
      () =>
        sql`
        INSERT INTO auth_command_receipts
          (command_id, domain, operation, idempotency_key,
           payload_hash, actor_kind, finalized, finalized_at)
        VALUES
          ('cmd-t0203-x2', 'company', 'member.remove', 'x-key-2',
           'x', 'session', true, now())`,
    );
    await expectCheckRefused(
      () =>
        sql`
        INSERT INTO auth_command_receipts
          (command_id, domain, operation, tenant_id, target_user_id,
           idempotency_key, payload_hash, actor_kind, finalized, finalized_at)
        VALUES
          ('cmd-t0203-x3', 'company', 'member.remove', ${TENANT}, ${USER_A},
           'x-key-3', 'x', 'session', true, now())`,
    );

    // An identity receipt targets its user — no tenant is forged on a global
    // identity change (§5.6), and the target is never absent.
    await expectCheckRefused(
      () =>
        sql`
        INSERT INTO auth_command_receipts
          (command_id, domain, operation, idempotency_key,
           payload_hash, actor_kind, finalized, finalized_at)
        VALUES
          ('cmd-t0203-x4', 'identity', 'identity.disable', 'x-key-4',
           'x', 'platform', true, now())`,
    );
    await expectCheckRefused(
      () =>
        sql`
        INSERT INTO auth_command_receipts
          (command_id, domain, operation, tenant_id, target_user_id,
           idempotency_key, payload_hash, actor_kind, finalized, finalized_at)
        VALUES
          ('cmd-t0203-x5', 'identity', 'identity.disable', ${TENANT}, ${USER_B},
           'x-key-5', 'x', 'platform', true, now())`,
    );

    // The actor kind domain is closed — there is no impersonation kind to
    // accept (design §6.3: no模拟登录), and an unknown kind is refused.
    await expectCheckRefused(
      () =>
        sql`
        INSERT INTO auth_command_receipts
          (command_id, domain, operation, tenant_id, idempotency_key,
           payload_hash, actor_kind, finalized, finalized_at)
        VALUES
          ('cmd-t0203-x6', 'company', 'member.remove', ${TENANT},
           'x-key-6', 'x', 'impersonation', true, now())`,
    );

    // Finalization is exactly the flag with its timestamp: neither a timestamp
    // on an open receipt nor a finalized receipt without one survives.
    await expectCheckRefused(
      () =>
        sql`
        INSERT INTO auth_command_receipts
          (command_id, domain, operation, tenant_id, idempotency_key,
           payload_hash, actor_kind, finalized, finalized_at)
        VALUES
          ('cmd-t0203-x7', 'company', 'member.remove', ${TENANT},
           'x-key-7', 'x', 'session', false, now())`,
    );
    await expectCheckRefused(
      () =>
        sql`
        INSERT INTO auth_command_receipts
          (command_id, domain, operation, tenant_id, idempotency_key,
           payload_hash, actor_kind, finalized, finalized_at)
        VALUES
          ('cmd-t0203-x8', 'company', 'member.remove', ${TENANT},
           'x-key-8', 'x', 'session', true, null)`,
    );

    // A grant generation is a Version or absent, never a wrapped counter.
    await expectCheckRefused(
      () =>
        sql`
        INSERT INTO auth_command_receipts
          (command_id, domain, operation, tenant_id, idempotency_key,
           payload_hash, actor_kind, grant_generation, finalized, finalized_at)
        VALUES
          ('cmd-t0203-x9', 'company', 'team.management.grant', ${TENANT},
           'x-key-9', 'x', 'session', ${SAFE_MAX + 1}, true, now())`,
    );

    await sql`DELETE FROM ${sql(RECEIPT_TABLE)} WHERE command_id LIKE 'cmd-t0203-%'`;
  });

  test("change_keys_carry_versions_and_per_key_finalization", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    await insertCompanyReceipt(sql, {
      commandId: "cmd-t0203-keys",
      idempotencyKey: "keys-key-1",
      payloadHash: "2222222222222222",
      finalized: false,
    });

    // The company relationship is new (before is absent), the team
    // relationship moves from a revoked generation: both registered keys carry
    // their own before/after versions and their own finalization flag.
    await sql`
      INSERT INTO auth_command_change_keys
        (command_id, tenant_id, principal_id, kind, scope_id,
         epoch_before, generation_before, epoch_after, generation_after, finalized)
      VALUES
        ('cmd-t0203-keys', ${TENANT}, ${PRINCIPAL}, 'company', ${TENANT},
         null, null, 1, 1, false),
        ('cmd-t0203-keys', ${TENANT}, ${PRINCIPAL}, 'team', ${WORKSPACE},
         2, 4, 3, 5, true)`;
    const keys = await sql<
      {
        kind: string;
        scope_id: string;
        epoch_before: string | null;
        generation_before: string | null;
        epoch_after: string;
        generation_after: string;
        finalized: boolean;
      }[]
    >`
      SELECT kind, scope_id, epoch_before, generation_before, epoch_after,
             generation_after, finalized
        FROM auth_command_change_keys
       WHERE command_id = 'cmd-t0203-keys' ORDER BY kind`;
    expect(keys).toHaveLength(2);
    expect(keys[0]?.kind).toBe("company");
    expect(keys[0]?.epoch_before).toBeNull();
    expect(Number(keys[0]?.epoch_after)).toBe(1);
    expect(keys[0]?.finalized).toBe(false);
    expect(keys[1]?.kind).toBe("team");
    expect(Number(keys[1]?.generation_before)).toBe(4);
    expect(Number(keys[1]?.generation_after)).toBe(5);
    expect(keys[1]?.finalized).toBe(true);

    // One registry row per affected key per command.
    let duplicateKey = false;
    try {
      await sql`
        INSERT INTO auth_command_change_keys
          (command_id, tenant_id, principal_id, kind, scope_id,
           epoch_after, generation_after)
        VALUES
          ('cmd-t0203-keys', ${TENANT}, ${PRINCIPAL}, 'company', ${TENANT},
           2, 2)`;
    } catch (error) {
      duplicateKey = true;
      expect(sqlStateOf(error)).toBe("23505");
    }
    expect(duplicateKey).toBe(true);

    // The key domains are the eligibility domains, and a company key's scope
    // is the company itself — the same convention the clocks pin.
    let unknownKind = false;
    try {
      await sql`
        INSERT INTO auth_command_change_keys
          (command_id, tenant_id, principal_id, kind, scope_id,
           epoch_after, generation_after)
        VALUES
          ('cmd-t0203-keys', ${TENANT}, ${PRINCIPAL}, 'workspace', ${WORKSPACE},
           1, 1)`;
    } catch (error) {
      unknownKind = true;
      expect(sqlStateOf(error)).toBe("23514");
    }
    expect(unknownKind).toBe(true);
    let mismatchedScope = false;
    try {
      await sql`
        INSERT INTO auth_command_change_keys
          (command_id, tenant_id, principal_id, kind, scope_id,
           epoch_after, generation_after)
        VALUES
          ('cmd-t0203-keys', ${TENANT}, ${PRINCIPAL}, 'company', ${WORKSPACE},
           1, 1)`;
    } catch (error) {
      mismatchedScope = true;
      expect(sqlStateOf(error)).toBe("23514");
    }
    expect(mismatchedScope).toBe(true);

    // Versions are safe integers or absent — before and after alike.
    let wrappedBefore = false;
    try {
      await sql`
        INSERT INTO auth_command_change_keys
          (command_id, tenant_id, principal_id, kind, scope_id,
           epoch_before, epoch_after, generation_after)
        VALUES
          ('cmd-t0203-keys', ${TENANT}, ${PRINCIPAL}, 'team', 'ws-other',
           ${SAFE_MAX + 1}, 1, 1)`;
    } catch (error) {
      wrappedBefore = true;
      expect(sqlStateOf(error)).toBe("23514");
    }
    expect(wrappedBefore).toBe(true);
    let negativeAfter = false;
    try {
      await sql`
        INSERT INTO auth_command_change_keys
          (command_id, tenant_id, principal_id, kind, scope_id,
           epoch_after, generation_after)
        VALUES
          ('cmd-t0203-keys', ${TENANT}, ${PRINCIPAL}, 'team', 'ws-other',
           -1, 1)`;
    } catch (error) {
      negativeAfter = true;
      expect(sqlStateOf(error)).toBe("23514");
    }
    expect(negativeAfter).toBe(true);

    // The ceiling is inclusive: the boundary is a storable final version.
    await sql`
      INSERT INTO auth_command_change_keys
        (command_id, tenant_id, principal_id, kind, scope_id,
         epoch_after, generation_after, finalized)
      VALUES
        ('cmd-t0203-keys', ${TENANT}, ${PRINCIPAL}, 'team', 'ws-boundary',
         ${SAFE_MAX}, ${SAFE_MAX}, true)`;

    // A registered key names a real principal: the registry cannot point at a
    // fabricated identity the command never touched.
    let unknownPrincipal = false;
    try {
      await sql`
        INSERT INTO auth_command_change_keys
          (command_id, tenant_id, principal_id, kind, scope_id,
           epoch_after, generation_after)
        VALUES
          ('cmd-t0203-keys', ${TENANT}, 't0203-principal-ghost', 'team',
           'ws-ghost', 1, 1)`;
    } catch (error) {
      unknownPrincipal = true;
      expect(sqlStateOf(error)).toBe("23503");
    }
    expect(unknownPrincipal).toBe(true);

    await sql`DELETE FROM ${sql(RECEIPT_TABLE)} WHERE command_id LIKE 'cmd-t0203-%'`;
  });

  test("outbox_rows_share_the_command_transaction", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    // A notification intent written beside its command, both rolled back
    // together: the same-transaction contract is the model's, not the writer's
    // discipline (Global Constraints: clocks/审计/outbox 同事务).
    let rolledBack = false;
    try {
      await sql.begin(async (tx) => {
        await insertCompanyReceipt(tx, {
          commandId: "cmd-t0203-tx",
          idempotencyKey: "tx-key-1",
          payloadHash: "3333333333333333",
          finalized: false,
        });
        await tx`
          INSERT INTO auth_command_change_keys
            (command_id, tenant_id, principal_id, kind, scope_id,
             epoch_after, generation_after)
          VALUES
            ('cmd-t0203-tx', ${TENANT}, ${PRINCIPAL}, 'company', ${TENANT}, 1, 1)`;
        await tx`
          INSERT INTO auth_command_outbox
            (id, command_id, kind, status, payload)
          VALUES
            ('obx-t0203-tx', 'cmd-t0203-tx', 'notification.email', 'pending',
             'encrypted-intent')`;
        throw new Error("finalizer fault: projection incomplete");
      });
    } catch {
      rolledBack = true;
    }
    expect(rolledBack).toBe(true);
    const [afterRollback] = await sql<
      { receipts: number; keys: number; outbox: number }[]
    >`
      SELECT
        (SELECT count(*) FROM auth_command_receipts
          WHERE command_id LIKE 'cmd-t0203-%')::int AS receipts,
        (SELECT count(*) FROM auth_command_change_keys
          WHERE command_id LIKE 'cmd-t0203-%')::int AS keys,
        (SELECT count(*) FROM auth_command_outbox
          WHERE id LIKE 'obx-t0203-%')::int AS outbox`;
    expect(Number(afterRollback?.receipts)).toBe(0);
    expect(Number(afterRollback?.keys)).toBe(0);
    expect(Number(afterRollback?.outbox)).toBe(0);

    // The committed shape: a finalized receipt, its registry keys finalized,
    // the outbox intent delivered with its timestamp.
    await sql.begin(async (tx) => {
      await insertCompanyReceipt(tx, {
        commandId: "cmd-t0203-tx-ok",
        idempotencyKey: "tx-key-2",
        payloadHash: "4444444444444444",
      });
      await tx`
        INSERT INTO auth_command_change_keys
          (command_id, tenant_id, principal_id, kind, scope_id,
           epoch_after, generation_after, finalized)
        VALUES
          ('cmd-t0203-tx-ok', ${TENANT}, ${PRINCIPAL}, 'company', ${TENANT},
           1, 1, true)`;
      await tx`
        INSERT INTO auth_command_outbox
          (id, command_id, kind, status, payload, delivered_at)
        VALUES
          ('obx-t0203-tx-ok', 'cmd-t0203-tx-ok', 'notification.email',
           'delivered', 'encrypted-intent', now())`;
    });
    const [committed] = await sql<
      {
        finalized: boolean;
        key_finalized: boolean;
        outbox_status: string;
        delivered_at: string | null;
      }[]
    >`
      SELECT r.finalized,
             (SELECT ck.finalized FROM auth_command_change_keys ck
               WHERE ck.command_id = r.command_id LIMIT 1) AS key_finalized,
             (SELECT o.status FROM auth_command_outbox o
               WHERE o.command_id = r.command_id LIMIT 1) AS outbox_status,
             (SELECT o.delivered_at FROM auth_command_outbox o
               WHERE o.command_id = r.command_id LIMIT 1) AS delivered_at
        FROM auth_command_receipts r WHERE r.command_id = 'cmd-t0203-tx-ok'`;
    expect(committed?.finalized).toBe(true);
    expect(committed?.key_finalized).toBe(true);
    expect(committed?.outbox_status).toBe("delivered");
    expect(committed?.delivered_at).not.toBeNull();

    // The delivery status domain is closed, and delivered means its timestamp.
    let unknownStatus = false;
    try {
      await sql`
        INSERT INTO auth_command_outbox (id, command_id, kind, status, payload)
        VALUES ('obx-t0203-x1', 'cmd-t0203-tx-ok', 'notification.email',
                'sent', 'x')`;
    } catch (error) {
      unknownStatus = true;
      expect(sqlStateOf(error)).toBe("23514");
    }
    expect(unknownStatus).toBe(true);
    let deliveredWithoutTime = false;
    try {
      await sql`
        INSERT INTO auth_command_outbox (id, command_id, kind, status, payload)
        VALUES ('obx-t0203-x2', 'cmd-t0203-tx-ok', 'notification.email',
                'delivered', 'x')`;
    } catch (error) {
      deliveredWithoutTime = true;
      expect(sqlStateOf(error)).toBe("23514");
    }
    expect(deliveredWithoutTime).toBe(true);
    let pendingWithTime = false;
    try {
      await sql`
        INSERT INTO auth_command_outbox
          (id, command_id, kind, status, payload, delivered_at)
        VALUES ('obx-t0203-x3', 'cmd-t0203-tx-ok', 'notification.email',
                'pending', 'x', now())`;
    } catch (error) {
      pendingWithTime = true;
      expect(sqlStateOf(error)).toBe("23514");
    }
    expect(pendingWithTime).toBe(true);

    // An outbox row belongs to exactly one command: no orphan intents.
    let orphanOutbox = false;
    try {
      await sql`
        INSERT INTO auth_command_outbox (id, command_id, kind, status, payload)
        VALUES ('obx-t0203-x4', 'cmd-t0203-ghost', 'notification.email',
                'pending', 'x')`;
    } catch (error) {
      orphanOutbox = true;
      expect(sqlStateOf(error)).toBe("23503");
    }
    expect(orphanOutbox).toBe(true);

    await sql`DELETE FROM ${sql(RECEIPT_TABLE)} WHERE command_id LIKE 'cmd-t0203-%'`;
  });

  test("authority_state_domains_and_consistency_are_enforced", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    const expectCheckRefused = async (statement: () => Promise<unknown>) => {
      let refused = false;
      try {
        await statement();
      } catch (error) {
        refused = true;
        expect(sqlStateOf(error)).toBe("23514");
      }
      expect(refused).toBe(true);
    };

    // The phase domain is closed: M0..M7 are the migration state machine's
    // only states (interfaces §3.3).
    await expectCheckRefused(
      () => sql`UPDATE auth_authority_states SET phase = 'M8' WHERE id = 1`,
    );
    // So is the authority domain.
    await expectCheckRefused(
      () =>
        sql`UPDATE auth_authority_states SET directory_authority = 'hybrid' WHERE id = 1`,
    );

    // Phase and authority are consistent per the state machine: pausing the
    // directory writes is M2/M3, switching to BA is M4 — never the other mixes.
    await expectCheckRefused(
      () => sql`UPDATE auth_authority_states SET phase = 'M2' WHERE id = 1`,
    );
    await expectCheckRefused(
      () => sql`UPDATE auth_authority_states SET phase = 'M4' WHERE id = 1`,
    );
    await expectCheckRefused(
      () =>
        sql`UPDATE auth_authority_states SET directory_authority = 'paused' WHERE id = 1`,
    );
    await expectCheckRefused(
      () =>
        sql`UPDATE auth_authority_states SET directory_authority = 'ba' WHERE id = 1`,
    );

    // The legal transitions the later tools drive (T02.14 M2, T08.01 M4) are
    // storable exactly as pairs.
    await sql`
      UPDATE auth_authority_states SET phase = 'M2',
        directory_authority = 'paused', authority_version = 1,
        updated_at = now() WHERE id = 1`;
    let paused = await harness.readAuthority();
    expect(paused?.phase).toBe("M2");
    expect(paused?.directory_authority).toBe("paused");
    await restoreAuthoritySeed(sql);
    await sql`
      UPDATE auth_authority_states SET phase = 'M4',
        directory_authority = 'ba', authority_version = 2,
        updated_at = now() WHERE id = 1`;
    paused = await harness.readAuthority();
    expect(paused?.phase).toBe("M4");
    expect(paused?.directory_authority).toBe("ba");
    await restoreAuthoritySeed(sql);

    // The version is a safe integer: neither negative nor wrapped.
    await expectCheckRefused(
      () =>
        sql`UPDATE auth_authority_states SET authority_version = -1 WHERE id = 1`,
    );
    await expectCheckRefused(
      () =>
        sql`UPDATE auth_authority_states SET authority_version = ${SAFE_MAX + 1} WHERE id = 1`,
    );
    await sql`
      UPDATE auth_authority_states SET authority_version = ${SAFE_MAX},
        updated_at = now() WHERE id = 1`;
    const [ceiling] = await sql<{ authority_version: string }[]>`
      SELECT authority_version FROM auth_authority_states WHERE id = 1`;
    expect(Number(ceiling?.authority_version)).toBe(SAFE_MAX);
    await restoreAuthoritySeed(sql);

    // Exactly one row can ever exist: the primary key refuses the same id and
    // the singleton CHECK refuses any other.
    let duplicateSingleton = false;
    try {
      await sql`
        INSERT INTO auth_authority_states
          (id, authority_version, phase, directory_authority,
           multi_tenant_released)
        VALUES (1, 5, 'M1', 'legacy', true)`;
    } catch (error) {
      duplicateSingleton = true;
      expect(sqlStateOf(error)).toBe("23505");
    }
    expect(duplicateSingleton).toBe(true);
    let secondRow = false;
    try {
      await sql`
        INSERT INTO auth_authority_states
          (id, authority_version, phase, directory_authority,
           multi_tenant_released)
        VALUES (2, 5, 'M1', 'legacy', true)`;
    } catch (error) {
      secondRow = true;
      expect(sqlStateOf(error)).toBe("23514");
    }
    expect(secondRow).toBe(true);

    await restoreAuthoritySeed(sql);
  });

  test("typed_schema_matches_applied_migration", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    const tables = schema as unknown as Record<string, unknown>;
    const receiptTable = tables.authCommandReceipts;
    const changeKeyTable = tables.authCommandChangeKeys;
    const outboxTable = tables.authCommandOutbox;
    const authorityTable = tables.authAuthorityStates;
    expect(
      receiptTable,
      "schema barrel exports authCommandReceipts",
    ).toBeDefined();
    expect(
      changeKeyTable,
      "schema barrel exports authCommandChangeKeys",
    ).toBeDefined();
    expect(
      outboxTable,
      "schema barrel exports authCommandOutbox",
    ).toBeDefined();
    expect(
      authorityTable,
      "schema barrel exports authAuthorityStates",
    ).toBeDefined();

    for (const [table, name] of [
      [receiptTable, RECEIPT_TABLE],
      [changeKeyTable, CHANGE_KEY_TABLE],
      [outboxTable, OUTBOX_TABLE],
      [authorityTable, AUTHORITY_TABLE],
    ] as const) {
      const columns = await sql<
        { column_name: string; data_type: string; is_nullable: string }[]
      >`
        SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = ${name}`;
      const typed = getTableConfig(
        table as Parameters<typeof getTableConfig>[0],
      );
      expect(
        columns.map((row) => row.column_name).sort(),
        `${name} columns`,
      ).toEqual(typed.columns.map((column) => column.name).sort());
      for (const column of typed.columns) {
        const found = columns.find((row) => row.column_name === column.name);
        expect(found, `${name}.${column.name} exists`).toBeDefined();
        expect(
          found?.is_nullable === "NO",
          `${name}.${column.name} nullability`,
        ).toBe(column.notNull);
      }
    }

    // The version-carrying columns are bigint safe-integer counters, matching
    // the interfaces §2 column-type contract for every NEW version column.
    const versionColumns = await sql<
      { table_name: string; column_name: string; data_type: string }[]
    >`
      SELECT table_name, column_name, data_type
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND ((table_name = ${RECEIPT_TABLE} AND column_name = 'grant_generation')
           OR (table_name = ${CHANGE_KEY_TABLE}
               AND column_name IN ('epoch_before','generation_before','epoch_after','generation_after'))
           OR (table_name = ${AUTHORITY_TABLE} AND column_name = 'authority_version'))`;
    expect(versionColumns).toHaveLength(6);
    expect(
      versionColumns.map((row) => row.data_type),
      "new version columns are bigint",
    ).toEqual(Array(6).fill("bigint"));

    // Every named constraint of the model exists on the applied tables.
    const expectedConstraints: Readonly<Record<string, readonly string[]>> = {
      [RECEIPT_TABLE]: [
        "auth_command_receipt_pk",
        "auth_command_receipt_domain",
        "auth_command_receipt_company_target",
        "auth_command_receipt_identity_target",
        "auth_command_receipt_actor_kind",
        "auth_command_receipt_finalized_with_time",
        "auth_command_receipt_grant_generation_safe_integer",
        "auth_command_receipt_tenant_fk",
        "auth_command_receipt_user_fk",
      ],
      [CHANGE_KEY_TABLE]: [
        "auth_command_change_key_pk",
        "auth_command_change_key_kind",
        "auth_command_change_key_scope_matches_kind",
        "auth_command_change_key_epoch_before_safe_integer",
        "auth_command_change_key_generation_before_safe_integer",
        "auth_command_change_key_epoch_after_safe_integer",
        "auth_command_change_key_generation_after_safe_integer",
        "auth_command_change_key_command_fk",
        "auth_command_change_key_tenant_fk",
        "auth_command_change_key_principal_fk",
      ],
      [OUTBOX_TABLE]: [
        "auth_command_outbox_pk",
        "auth_command_outbox_status",
        "auth_command_outbox_delivered_with_time",
        "auth_command_outbox_command_fk",
      ],
      [AUTHORITY_TABLE]: [
        "auth_authority_state_pk",
        "auth_authority_state_singleton",
        "auth_authority_state_phase",
        "auth_authority_state_directory_authority",
        "auth_authority_state_phase_matches_authority",
        "auth_authority_state_version_safe_integer",
      ],
    };
    for (const [table, names] of Object.entries(expectedConstraints)) {
      const rows = await sql<{ conname: string }[]>`
        SELECT con.conname
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = rel.relnamespace
         WHERE n.nspname = 'public' AND rel.relname = ${table}`;
      const present = new Set(rows.map((row) => row.conname));
      for (const name of names) {
        expect(present.has(name), `${table}: ${name}`).toBe(true);
      }
    }

    // The two idempotency fences are partial unique indexes on the applied
    // table: one per domain, each carrying its WHERE domain predicate.
    const indexes = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = ${RECEIPT_TABLE}`;
    const companyFence = indexes.find(
      (row) => row.indexname === "auth_command_receipt_company_idempotency_uq",
    );
    expect(companyFence).toBeDefined();
    expect(companyFence?.indexdef).toContain("UNIQUE");
    expect(companyFence?.indexdef).toContain("WHERE");
    expect(companyFence?.indexdef).toContain("'company'");
    const identityFence = indexes.find(
      (row) => row.indexname === "auth_command_receipt_identity_idempotency_uq",
    );
    expect(identityFence).toBeDefined();
    expect(identityFence?.indexdef).toContain("UNIQUE");
    expect(identityFence?.indexdef).toContain("WHERE");
    expect(identityFence?.indexdef).toContain("'identity'");

    // The dispatcher's pull side of the outbox is indexed.
    const outboxIndexes = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = ${OUTBOX_TABLE}`;
    expect(outboxIndexes.map((row) => row.indexname)).toContain(
      "auth_command_outbox_status_idx",
    );

    // The typed principal table still carries the generation T02.02 added —
    // this task's model composes with, not over, its predecessor's.
    const typedPrincipals = getTableConfig(enterprisePrincipals);
    expect(typedPrincipals.columns.map((column) => column.name)).toContain(
      "identity_generation",
    );
  });

  test("migration_replays_from_clean_state_without_touching_legacy", async () => {
    const harness = await loadHarness();
    // The baseline plus exactly the four model tables, both on the first apply
    // and on a replay from the reverted state.
    expect(harness.baselineTableCount).toBeGreaterThanOrEqual(251);
    expect(harness.firstApplyTableCount).toBe(harness.baselineTableCount + 4);
    expect(harness.replayTableCount).toBe(harness.firstApplyTableCount);

    // Legacy rows and every existing public column (minus this suite's own
    // tables) are untouched by the expand migration, and the seeded authority
    // row is exactly the initial state again after the replay.
    expect(harness.legacyAfter).toEqual(harness.legacyBefore);
    expect(harness.legacyBefore.tenants).toHaveLength(2);
    expect(harness.legacyBefore.users).toHaveLength(2);
    expect(harness.legacyBefore.principals).toEqual([
      { id: PRINCIPAL, user_id: USER_A, status: "active" },
    ]);
    const authority = await harness.readAuthority();
    expect(authority?.directory_authority).toBe("legacy");
    expect(authority?.multi_tenant_released).toBe(false);
  });

  test("schema_file_is_registered_in_barrel_generator_and_journal", () => {
    const barrel = readFileSync(
      join(import.meta.dirname, "../../src/db/schema/index.ts"),
      "utf8",
    );
    expect(barrel).toContain('export * from "./auth-directory";');

    const config = readFileSync(
      join(import.meta.dirname, "../../drizzle.config.ts"),
      "utf8",
    );
    expect(config).toContain('"./src/db/schema/auth-directory.ts"');

    const journal = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../../drizzle/meta/_journal.json"),
        "utf8",
      ),
    ) as { entries: { idx: number; tag: string }[] };
    const entry = journal.entries.find(
      (candidate) => candidate.tag === MIGRATION_TAG,
    );
    expect(entry?.idx).toBe(211);
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
