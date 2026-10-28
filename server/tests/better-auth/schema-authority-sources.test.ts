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

/*
 * T02.04 (#526, P03) — the source generations of the long-lived authorities
 * and the personal model credentials, checked against the real migration on
 * the isolated BA_TEST_* stack (design §4.2 "凭据授权来源"/"个人模型授权与
 * Key"/"指定团队管理授权"/"Provisioning 规则", §4.4, §5.3, §5.4, §6.4;
 * interfaces §3, §5.3).
 *
 * What this file pins, and why each part is a database fact rather than a code
 * convention:
 *
 * - `expand_preserves_payer_key_and_grant_references`: the expand migration
 *   adds source-generation columns and the two new authority models without
 *   rewriting a single existing grant, key, credential or finance row — the
 *   payer/customer mapping, grant references and history are byte-identical
 *   after apply and replay (design §5.3: 原 payer 及历史费用不改).
 * - `missing_generation_is_not_filled_from_active`: rows that predate this
 *   migration keep NULL generation columns. A missing version is never filled
 *   from the current active state — "cannot compare" stays missing until a
 *   controlled re-verification writes it (design §4.4/§5.3/§5.4).
 * - `authority_source_generation_columns_are_safe_integer_bounded`: every new
 *   generation column is a Version (0..9007199254740991) bounded by CHECK —
 *   wrapped and negative values are refused by SQLSTATE 23514, the boundary
 *   itself is legal.
 * - `team_management_grant_is_a_closed_new_authority_model`: the team
 *   management Grant (§6.4) is its own model — a closed nonempty deduped
 *   action subset, the grantee's identity/company/team generations, the
 *   grant's own generation, and composite foreign keys that make a
 *   cross-company grant structurally impossible.
 * - `provisioning_rule_keeps_stable_identity_and_closed_domain`: one rule row
 *   per (binding, external group) with a stable id (NULL group means
 *   binding-wide company admission — still one row per binding), nonempty
 *   fixed workspace ids, closed status and a safe-integer revision.
 * - `typed_schema_matches_applied_migration`: the Drizzle projection and the
 *   SQL every environment runs cannot drift.
 * - `migration_replays_from_clean_state_without_touching_legacy` and
 *   `schema_file_is_registered_in_barrel_generator_and_journal` complete the
 *   expand-migration proofs (apply/replay, journal monotonic).
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
const MIGRATION_TAG = "0224_better_auth_authority_sources";
const MIGRATION_PATH = join(
  import.meta.dirname,
  `../../drizzle/${MIGRATION_TAG}.sql`,
);
/**
 * The directory tables (auth_organizations/auth_teams/auth_team_bindings) this
 * suite's new models reference structurally. The BA island's shared database
 * carries the enterprise baseline only — every task's suite applies its own
 * migrations and reverts them (T02.01/T02.02/T02.03 did the same), so this
 * suite applies its verified prerequisite and removes it again in cleanup.
 */
const PREREQUISITE_TAG = "0221_better_auth_directory";
const PREREQUISITE_PATH = join(
  import.meta.dirname,
  `../../drizzle/${PREREQUISITE_TAG}.sql`,
);
const TEAM_GRANT_TABLE = "auth_team_management_grants";
const RULE_TABLE = "auth_provisioning_rules";
const DIRECTORY_TABLES = [
  "auth_members",
  "auth_team_members",
  "auth_invitations",
  "auth_team_bindings",
  "auth_teams",
  "auth_organizations",
] as const;
/** Number.MAX_SAFE_INTEGER: the Version domain's inclusive upper bound. */
const SAFE_MAX = 9007199254740991;
const TENANT = "t0204-tenant-a";
const TENANT_B = "t0204-tenant-b";
const WORKSPACE = "ws-t0204";
const WORKSPACE_B_ONLY = "ws-t0204-b-only";
const TEAM = "t0204-team";
const TEAM_B = "t0204-team-b";
const USER = "t0204-user-grantee";
const USER_GRANTOR = "t0204-user-grantor";
const USER_KEY = "t0204-user-key";
const USER_FOREIGN = "t0204-user-foreign";
const PRINCIPAL = "t0204-principal-grantee";
const PRINCIPAL_GRANTOR = "t0204-principal-grantor";
const PRINCIPAL_KEY = "t0204-principal-key";
const PRINCIPAL_FOREIGN = "t0204-principal-foreign";
const BOT = "t0204-bot";
const CUSTOMER = "t0204-customer";
const GRANT_LEGACY = "t0204-grant-legacy";
const KEY_LEGACY = "t0204-key-legacy";
const CREDENTIAL = "t0204-credential";

/**
 * Every column this suite's migration adds to an existing table, so the
 * legacy fingerprint can exclude exactly them (and the leak probe can demand
 * they are gone again after cleanup).
 */
const ADDED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  enterprise_credentials: [
    "owner_identity_generation",
    "owner_company_generation",
  ],
  enterprise_credential_actions: [
    "identity_generation",
    "company_generation",
    "source_team_generation",
  ],
  billing_company_finance_grants: ["identity_generation", "company_generation"],
  access_grants: ["principal_id", "identity_generation"],
  gateway_virtual_keys: ["source_identity_generation"],
};

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
      `${MIGRATION_TAG}.sql does not exist: the expand migration this suite pins (the two new authority-source tables and the nullable source-generation columns on enterprise_credential_actions/enterprise_credentials/billing_company_finance_grants/access_grants/gateway_virtual_keys) is the T02.04 target behavior, not an environment problem.`,
    );
  }
  return readFileSync(MIGRATION_PATH, "utf8");
}

interface HistorySnapshot {
  grants: Record<string, unknown>[];
  keys: Record<string, unknown>[];
  credentials: Record<string, unknown>[];
  actions: Record<string, unknown>[];
  financeGrants: Record<string, unknown>[];
  fingerprint: string;
}

interface Harness {
  sql: postgres.Sql;
  baselineTableCount: number;
  firstApplyTableCount: number;
  replayTableCount: number;
  historyBefore: HistorySnapshot;
  historyAfter: HistorySnapshot;
  close(): Promise<void>;
}

/**
 * Returns the island to the pre-T02.04 shape: this suite's rows gone, its two
 * tables gone, its added columns and their pair checks gone. Every statement
 * is a no-op on a pristine baseline, and it also recovers a crashed earlier
 * run that left any of them behind.
 */
async function cleanupFixture(sql: postgres.Sql): Promise<void> {
  // The suite's tables (and the prerequisite directory tables it applied) go
  // first, CASCADE: their rows leave with them, and the DELETEs below never
  // touch a table a pristine baseline does not have.
  await sql.unsafe(`DROP TABLE IF EXISTS ${TEAM_GRANT_TABLE} CASCADE`);
  await sql.unsafe(`DROP TABLE IF EXISTS ${RULE_TABLE} CASCADE`);
  await sql.unsafe(
    `DROP TABLE IF EXISTS ${DIRECTORY_TABLES.map((name) => `"${name}"`).join(", ")} CASCADE`,
  );
  await sql`DELETE FROM gateway_virtual_keys WHERE id LIKE 't0204-%'`;
  await sql`DELETE FROM access_grants WHERE grant_id LIKE 't0204-%'`;
  await sql`DELETE FROM billing_company_finance_grants WHERE tenant_id LIKE 't0204-%'`;
  await sql`DELETE FROM enterprise_credential_actions WHERE tenant_id LIKE 't0204-%'`;
  await sql`DELETE FROM enterprise_credentials WHERE tenant_id LIKE 't0204-%'`;
  await sql`DELETE FROM enterprise_workspace_memberships WHERE tenant_id LIKE 't0204-%'`;
  await sql`DELETE FROM enterprise_memberships WHERE tenant_id LIKE 't0204-%'`;
  await sql`DELETE FROM enterprise_workspaces WHERE tenant_id LIKE 't0204-%'`;
  await sql`DELETE FROM enterprise_principals WHERE id LIKE 't0204-%'`;
  await sql`DELETE FROM users WHERE id LIKE 't0204-%'`;
  await sql`DELETE FROM bot_services WHERE bot_id LIKE 't0204-%'`;
  await sql`DELETE FROM enterprise_tenants WHERE id LIKE 't0204-%'`;
  await sql.unsafe(
    `ALTER TABLE "enterprise_credentials" DROP CONSTRAINT IF EXISTS "enterprise_credential_owner_generation_pair"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_credential_actions" DROP CONSTRAINT IF EXISTS "enterprise_credential_action_generation_pair"`,
  );
  await sql.unsafe(
    `ALTER TABLE "billing_company_finance_grants" DROP CONSTRAINT IF EXISTS "billing_company_finance_grant_generation_pair"`,
  );
  await sql.unsafe(
    `ALTER TABLE "access_grants" DROP CONSTRAINT IF EXISTS "access_grants_principal_generation_pair"`,
  );
  await sql.unsafe(
    `ALTER TABLE "access_grants" DROP CONSTRAINT IF EXISTS "access_grants_identity_generation_safe_integer"`,
  );
  await sql.unsafe(
    `ALTER TABLE "access_grants" DROP CONSTRAINT IF EXISTS "access_grants_principal_fk"`,
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

/** Only the artifacts the migration adds — used between the two applies, where the seeded legacy rows must survive. */
async function revertMigrationArtifacts(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`DROP TABLE IF EXISTS ${TEAM_GRANT_TABLE} CASCADE`);
  await sql.unsafe(`DROP TABLE IF EXISTS ${RULE_TABLE} CASCADE`);
  await sql.unsafe(
    `ALTER TABLE "enterprise_credentials" DROP CONSTRAINT IF EXISTS "enterprise_credential_owner_generation_pair"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_credential_actions" DROP CONSTRAINT IF EXISTS "enterprise_credential_action_generation_pair"`,
  );
  await sql.unsafe(
    `ALTER TABLE "billing_company_finance_grants" DROP CONSTRAINT IF EXISTS "billing_company_finance_grant_generation_pair"`,
  );
  await sql.unsafe(
    `ALTER TABLE "access_grants" DROP CONSTRAINT IF EXISTS "access_grants_principal_generation_pair"`,
  );
  await sql.unsafe(
    `ALTER TABLE "access_grants" DROP CONSTRAINT IF EXISTS "access_grants_identity_generation_safe_integer"`,
  );
  await sql.unsafe(
    `ALTER TABLE "access_grants" DROP CONSTRAINT IF EXISTS "access_grants_principal_fk"`,
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

/**
 * The legacy rows this suite pins: a personal model grant and its key (the
 * payer/customer mapping of §5.3), a personal credential with its use action,
 * and a company finance grant — all created BEFORE the migration applies, so
 * they are exactly the rows whose generations must stay missing and whose
 * payer/history bytes must not move.
 */
async function seedLegacyFixture(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO enterprise_tenants (id, name) VALUES
      (${TENANT}, 'T02.04 company A'),
      (${TENANT_B}, 'T02.04 company B')`;
  await sql`
    INSERT INTO users (id, email) VALUES
      (${USER}, 't0204-user-grantee@example.test'),
      (${USER_GRANTOR}, 't0204-user-grantor@example.test'),
      (${USER_KEY}, 't0204-user-key@example.test'),
      (${USER_FOREIGN}, 't0204-user-foreign@example.test')`;
  await sql`
    INSERT INTO enterprise_principals (id, user_id) VALUES
      (${PRINCIPAL}, ${USER}),
      (${PRINCIPAL_GRANTOR}, ${USER_GRANTOR}),
      (${PRINCIPAL_KEY}, ${USER_KEY}),
      (${PRINCIPAL_FOREIGN}, ${USER_FOREIGN})`;
  await sql`
    INSERT INTO enterprise_workspaces (tenant_id, id, name) VALUES
      (${TENANT}, ${WORKSPACE}, 'T02.04 workspace'),
      (${TENANT_B}, ${WORKSPACE}, 'Same workspace id in company B'),
      (${TENANT_B}, ${WORKSPACE_B_ONLY}, 'A workspace only company B has')`;
  await sql`
    INSERT INTO enterprise_memberships (tenant_id, principal_id, role, epoch) VALUES
      (${TENANT}, ${PRINCIPAL}, 'member', 1),
      (${TENANT}, ${PRINCIPAL_GRANTOR}, 'tenant_admin', 1),
      (${TENANT_B}, ${PRINCIPAL_FOREIGN}, 'member', 1)`;
  await sql`
    INSERT INTO enterprise_workspace_memberships
      (tenant_id, workspace_id, principal_id, epoch)
    VALUES (${TENANT}, ${WORKSPACE}, ${PRINCIPAL}, 1)`;
  await sql`
    INSERT INTO auth_organizations (id, name, slug) VALUES
      (${TENANT}, 'T02.04 org A', 't0204-org-a'),
      (${TENANT_B}, 'T02.04 org B', 't0204-org-b')`;
  await sql`
    INSERT INTO auth_teams (id, organization_id, name) VALUES
      (${TEAM}, ${TENANT}, 'T02.04 team A'),
      (${TEAM_B}, ${TENANT_B}, 'T02.04 team B')`;
  await sql`
    INSERT INTO auth_team_bindings (tenant_id, workspace_id, team_id) VALUES
      (${TENANT}, ${WORKSPACE}, ${TEAM})`;
  await sql`
    INSERT INTO bot_services (bot_id, display_name, kind, capabilities)
    VALUES (${BOT}, 'T02.04 bot', 'external', ARRAY['chat']::text[])`;
  await sql`
    INSERT INTO access_grants
      (grant_id, user_id, bot_id, external_identity, scope)
    VALUES
      (${GRANT_LEGACY}, ${USER_KEY}, ${BOT}, 'openbot:t0204-user-key', 'model-access')`;
  await sql`
    INSERT INTO gateway_virtual_keys
      (id, grant_id, bot_id, gateway_customer_id, gateway_virtual_key_id,
       value_hash, credential_version, status, expires_at)
    VALUES
      (${KEY_LEGACY}, ${GRANT_LEGACY}, ${BOT}, ${CUSTOMER}, 't0204-remote-1',
       ${"a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3"},
       1, 'active', now() + interval '1 hour')`;
  await sql`
    INSERT INTO enterprise_credentials
      (tenant_id, id, kind, classification, owner_principal_id, target, display, envelope)
    VALUES
      (${TENANT}, ${CREDENTIAL}, 'connection', 'personal', ${PRINCIPAL},
       'https://model.example', '{"label":"Legacy"}'::jsonb, 'sealed-legacy')`;
  await sql`
    INSERT INTO enterprise_credential_actions
      (tenant_id, credential_id, principal_id, action, granted_by)
    VALUES
      (${TENANT}, ${CREDENTIAL}, ${PRINCIPAL}, 'use', ${PRINCIPAL_GRANTOR})`;
  await sql`
    INSERT INTO billing_company_finance_grants (tenant_id, principal_id, granted_by)
    VALUES (${TENANT}, ${PRINCIPAL}, ${PRINCIPAL_GRANTOR})`;
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
 * changed about an existing column would show — which is the point: the
 * migration may only add, never rewrite.
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
       AND NOT (table_name = ${TEAM_GRANT_TABLE})
       AND NOT (table_name = ${RULE_TABLE})
       AND NOT (
         (table_name, column_name) IN (
           ('enterprise_credentials', 'owner_identity_generation'),
           ('enterprise_credentials', 'owner_company_generation'),
           ('enterprise_credential_actions', 'identity_generation'),
           ('enterprise_credential_actions', 'company_generation'),
           ('enterprise_credential_actions', 'source_team_generation'),
           ('billing_company_finance_grants', 'identity_generation'),
           ('billing_company_finance_grants', 'company_generation'),
           ('access_grants', 'principal_id'),
           ('access_grants', 'identity_generation'),
           ('gateway_virtual_keys', 'source_identity_generation')
         )
       )
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

async function historySnapshot(sql: postgres.Sql): Promise<HistorySnapshot> {
  const grants = await sql`
    SELECT grant_id, user_id, bot_id, external_identity, scope, source, status,
           created_at, revoked_at
      FROM access_grants WHERE grant_id LIKE 't0204-%' ORDER BY grant_id`;
  const keys = await sql`
    SELECT id, grant_id, bot_id, gateway_customer_id, gateway_virtual_key_id,
           value_hash, credential_version, status, expires_at, created_at
      FROM gateway_virtual_keys WHERE id LIKE 't0204-%' ORDER BY id`;
  const credentials = await sql`
    SELECT tenant_id, id, kind, classification, workspace_id,
           owner_principal_id, target, display, envelope, status
      FROM enterprise_credentials WHERE tenant_id LIKE 't0204-%'
     ORDER BY tenant_id, id`;
  const actions = await sql`
    SELECT tenant_id, credential_id, principal_id, action, granted_by, created_at
      FROM enterprise_credential_actions WHERE tenant_id LIKE 't0204-%'
     ORDER BY tenant_id, credential_id, principal_id, action`;
  const financeGrants = await sql`
    SELECT tenant_id, principal_id, granted_by, created_at
      FROM billing_company_finance_grants WHERE tenant_id LIKE 't0204-%'
     ORDER BY tenant_id, principal_id`;
  return {
    grants: [...grants] as unknown as Record<string, unknown>[],
    keys: [...keys] as unknown as Record<string, unknown>[],
    credentials: [...credentials] as unknown as Record<string, unknown>[],
    actions: [...actions] as unknown as Record<string, unknown>[],
    financeGrants: [...financeGrants] as unknown as Record<string, unknown>[],
    fingerprint: await publicColumnFingerprint(sql),
  };
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

    await sql.unsafe(readFileSync(PREREQUISITE_PATH, "utf8"));
    await seedLegacyFixture(sql);
    const historyBefore = await historySnapshot(sql);
    const baselineTableCount = await countPublicTables(sql);

    const migrationSql = loadMigrationSql();
    await sql.unsafe(migrationSql);
    const firstApplyTableCount = await countPublicTables(sql);
    await revertMigrationArtifacts(sql);
    await sql.unsafe(migrationSql);
    const replayTableCount = await countPublicTables(sql);
    const historyAfter = await historySnapshot(sql);

    return {
      sql,
      baselineTableCount,
      firstApplyTableCount,
      replayTableCount,
      historyBefore,
      historyAfter,
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

describe("T02.04 authority source generations for long-lived grants and keys", () => {
  afterAll(async () => {
    const created = await harnessPromise?.catch(() => undefined);
    if (created) await created.close();
    // A fresh probe, so the leak check sees the cleaned database rather than the
    // harness's released pool: no table this suite adds, no column it adds, and
    // none of its rows.
    const { setup } = readBaUrls();
    const probe = postgres(setup, { max: 1 });
    try {
      const tables = await probe<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = ANY(${[
             TEAM_GRANT_TABLE,
             RULE_TABLE,
             ...DIRECTORY_TABLES,
           ]}::text[])`;
      expect([...tables]).toEqual([]);
      const leaked = await probe<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND (
           (table_name, column_name) IN (
             ('enterprise_credentials', 'owner_identity_generation'),
             ('enterprise_credentials', 'owner_company_generation'),
             ('enterprise_credential_actions', 'identity_generation'),
             ('enterprise_credential_actions', 'company_generation'),
             ('enterprise_credential_actions', 'source_team_generation'),
             ('billing_company_finance_grants', 'identity_generation'),
             ('billing_company_finance_grants', 'company_generation'),
             ('access_grants', 'principal_id'),
             ('access_grants', 'identity_generation'),
             ('gateway_virtual_keys', 'source_identity_generation')
           )
         )`;
      expect([...leaked]).toEqual([]);
      const residue = await probe`
        SELECT id FROM enterprise_tenants WHERE id LIKE 't0204-%'`;
      expect([...residue]).toEqual([]);
      const users = await probe`
        SELECT id FROM users WHERE id LIKE 't0204-%'`;
      expect([...users]).toEqual([]);
      const grants = await probe`
        SELECT grant_id FROM access_grants WHERE grant_id LIKE 't0204-%'`;
      expect([...grants]).toEqual([]);
    } finally {
      await probe.end({ timeout: 5 }).catch(() => {});
    }
  });

  test("expand_preserves_payer_key_and_grant_references", async () => {
    const harness = await loadHarness();

    // Guard against a vacuous equality: the "before" must actually be the
    // legacy personal-key chain — grant, key, payer customer, credential,
    // action and finance grant — each with its references intact.
    expect(harness.historyBefore.grants).toHaveLength(1);
    expect(harness.historyBefore.grants[0]?.grant_id).toBe(GRANT_LEGACY);
    expect(harness.historyBefore.keys).toHaveLength(1);
    expect(harness.historyBefore.keys[0]?.gateway_customer_id).toBe(CUSTOMER);
    expect(harness.historyBefore.keys[0]?.grant_id).toBe(GRANT_LEGACY);
    expect(harness.historyBefore.credentials).toHaveLength(1);
    expect(harness.historyBefore.actions).toHaveLength(1);
    expect(harness.historyBefore.financeGrants).toHaveLength(1);

    const historyBefore = harness.historyBefore;
    const historyAfter = harness.historyAfter;
    // The named assertion of the Brief: apply and replay leave the payer
    // mapping, the grant references and every history row untouched.
    expect(historyAfter).toEqual(historyBefore);
  });

  test("missing_generation_is_not_filled_from_active", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    // The legacy grant is ACTIVE, and that must not matter: its source
    // generations stay missing rather than being stamped with the current
    // state. "Cannot compare" is the stored fact (design §4.4/§5.3).
    const [legacyGrant] = await sql<
      {
        status: string;
        principal_id: string | null;
        identity_generation: string | null;
      }[]
    >`
      SELECT status, principal_id, identity_generation FROM access_grants
       WHERE grant_id = ${GRANT_LEGACY}`;
    expect(legacyGrant?.status).toBe("active");
    expect(legacyGrant?.principal_id).toBeNull();
    expect(legacyGrant?.identity_generation).toBeNull();

    const [legacyKey] = await sql<
      { source_identity_generation: string | null }[]
    >`
      SELECT source_identity_generation FROM gateway_virtual_keys
       WHERE id = ${KEY_LEGACY}`;
    expect(legacyKey?.source_identity_generation).toBeNull();

    const [legacyCredential] = await sql<
      {
        owner_identity_generation: string | null;
        owner_company_generation: string | null;
      }[]
    >`
      SELECT owner_identity_generation, owner_company_generation
        FROM enterprise_credentials WHERE id = ${CREDENTIAL}`;
    expect(legacyCredential?.owner_identity_generation).toBeNull();
    expect(legacyCredential?.owner_company_generation).toBeNull();

    const [legacyAction] = await sql<
      {
        identity_generation: string | null;
        company_generation: string | null;
        source_team_generation: string | null;
      }[]
    >`
      SELECT identity_generation, company_generation, source_team_generation
        FROM enterprise_credential_actions
       WHERE credential_id = ${CREDENTIAL}`;
    expect(legacyAction?.identity_generation).toBeNull();
    expect(legacyAction?.company_generation).toBeNull();
    expect(legacyAction?.source_team_generation).toBeNull();

    const [legacyFinance] = await sql<
      {
        identity_generation: string | null;
        company_generation: string | null;
      }[]
    >`
      SELECT identity_generation, company_generation
        FROM billing_company_finance_grants
       WHERE principal_id = ${PRINCIPAL}`;
    expect(legacyFinance?.identity_generation).toBeNull();
    expect(legacyFinance?.company_generation).toBeNull();

    // A NEW row carries its generations: the columns exist to be written by the
    // controlled writers, and what they store is a plain safe integer. A
    // distinct external identity, because the legacy grant is still active and
    // one active grant per (user, Bot, external identity) remains the law.
    await sql`
      INSERT INTO access_grants
        (grant_id, user_id, bot_id, external_identity, scope,
         principal_id, identity_generation)
      VALUES
        ('t0204-grant-current', ${USER_KEY}, ${BOT}, 'ext:t0204-second', 'model-access',
         ${PRINCIPAL_KEY}, 1)`;
    await sql`
      INSERT INTO gateway_virtual_keys
        (id, grant_id, bot_id, gateway_customer_id, gateway_virtual_key_id,
         value_hash, credential_version, status, source_identity_generation)
      VALUES
        ('t0204-key-current', 't0204-grant-current', ${BOT}, ${CUSTOMER},
         't0204-remote-2',
         ${"b17ef6d19c7a5b1e91bcb0ebbd3e6b9c0e0f0e0a1d2c3b4a5f6e7d8c9b0a1f2"},
         1, 'active', 1)`;
    const [currentGrant] = await sql<{ identity_generation: string }[]>`
      SELECT identity_generation FROM access_grants
       WHERE grant_id = 't0204-grant-current'`;
    expect(Number(currentGrant?.identity_generation)).toBe(1);
    const [currentKey] = await sql<{ source_identity_generation: string }[]>`
      SELECT source_identity_generation FROM gateway_virtual_keys
       WHERE id = 't0204-key-current'`;
    expect(Number(currentKey?.source_identity_generation)).toBe(1);
  });

  test("authority_source_generation_columns_are_safe_integer_bounded", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    // A well-formed team grant row first, so the refusals below are the
    // column's CHECK, not a missing prerequisite.
    const validGrant = sql`
      INSERT INTO ${sql(TEAM_GRANT_TABLE)}
        (grant_id, tenant_id, workspace_id, team_id, principal_id, actions,
         generation, identity_generation, company_generation, team_generation, granted_by)
      VALUES
        ('t0204-tmg-wrap', ${TENANT}, ${WORKSPACE}, ${TEAM}, ${PRINCIPAL},
         ARRAY['team.member.add']::text[], 1, 1, 1, 1, ${PRINCIPAL_GRANTOR})`;
    await validGrant;

    const refuse = async (statement: postgres.PendingQuery<unknown>) => {
      let inserted = true;
      try {
        await statement;
      } catch (error) {
        inserted = false;
        expect(sqlStateOf(error)).toBe("23514");
      }
      expect(inserted).toBe(false);
    };

    // Wrapped (MAX_SAFE_INTEGER + 1) on each authority-source generation
    // column: the grant's own and the grantee's three.
    await refuse(sql`
      UPDATE ${sql(TEAM_GRANT_TABLE)} SET generation = ${SAFE_MAX + 1}
       WHERE grant_id = 't0204-tmg-wrap'`);
    await refuse(sql`
      UPDATE ${sql(TEAM_GRANT_TABLE)} SET identity_generation = ${SAFE_MAX + 1}
       WHERE grant_id = 't0204-tmg-wrap'`);
    await refuse(sql`
      UPDATE ${sql(TEAM_GRANT_TABLE)} SET company_generation = ${SAFE_MAX + 1}
       WHERE grant_id = 't0204-tmg-wrap'`);
    await refuse(sql`
      UPDATE ${sql(TEAM_GRANT_TABLE)} SET team_generation = ${SAFE_MAX + 1}
       WHERE grant_id = 't0204-tmg-wrap'`);

    // Negative is not a Version either.
    await refuse(sql`
      UPDATE ${sql(TEAM_GRANT_TABLE)} SET company_generation = -1
       WHERE grant_id = 't0204-tmg-wrap'`);

    // The credential action and finance-grant source generations.
    await refuse(sql`
      UPDATE enterprise_credential_actions SET identity_generation = ${SAFE_MAX + 1}
       WHERE credential_id = ${CREDENTIAL}`);
    await refuse(sql`
      UPDATE billing_company_finance_grants SET company_generation = ${SAFE_MAX + 1}
       WHERE principal_id = ${PRINCIPAL}`);

    // The provisioning rule revision.
    await refuse(sql`
      INSERT INTO ${sql(RULE_TABLE)}
        (rule_id, tenant_id, binding_id, external_group, workspace_ids, revision)
      VALUES
        ('t0204-rule-wrap', ${TENANT}, 't0204-binding', 'eng',
         ARRAY[${WORKSPACE}]::text[], ${SAFE_MAX + 1})`);

    // The boundary itself is legal and inclusive: the ceiling is a Version.
    await sql`
      UPDATE ${sql(TEAM_GRANT_TABLE)} SET generation = ${SAFE_MAX}
       WHERE grant_id = 't0204-tmg-wrap'`;
    const [boundary] = await sql<{ generation: string }[]>`
      SELECT generation FROM ${sql(TEAM_GRANT_TABLE)}
       WHERE grant_id = 't0204-tmg-wrap'`;
    expect(Number(boundary?.generation)).toBe(SAFE_MAX);

    await sql`DELETE FROM ${sql(TEAM_GRANT_TABLE)} WHERE grant_id LIKE 't0204-%'`;
    await sql`DELETE FROM ${sql(RULE_TABLE)} WHERE rule_id LIKE 't0204-%'`;
  });

  test("team_management_grant_is_a_closed_new_authority_model", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    // The valid shape: one active grant of both member-management actions,
    // pinned to the grantee's current identity/company/team generations, with
    // the grant's own generation and the grantor's membership both provable in
    // the database.
    await sql`
      INSERT INTO ${sql(TEAM_GRANT_TABLE)}
        (grant_id, tenant_id, workspace_id, team_id, principal_id, actions,
         generation, identity_generation, company_generation, team_generation, granted_by)
      VALUES
        ('t0204-tmg-1', ${TENANT}, ${WORKSPACE}, ${TEAM}, ${PRINCIPAL},
         ARRAY['team.member.add','team.member.remove']::text[],
         1, 4, 2, 3, ${PRINCIPAL_GRANTOR})`;
    const [stored] = await sql<
      {
        actions: string[];
        generation: string;
        identity_generation: string;
        company_generation: string;
        team_generation: string;
        status: string;
        revoked_at: string | null;
      }[]
    >`
      SELECT actions, generation, identity_generation, company_generation,
             team_generation, status, revoked_at
        FROM ${sql(TEAM_GRANT_TABLE)} WHERE grant_id = 't0204-tmg-1'`;
    expect([...(stored?.actions ?? [])].sort()).toEqual([
      "team.member.add",
      "team.member.remove",
    ]);
    expect(Number(stored?.generation)).toBe(1);
    expect(Number(stored?.identity_generation)).toBe(4);
    expect(Number(stored?.company_generation)).toBe(2);
    expect(Number(stored?.team_generation)).toBe(3);
    expect(stored?.status).toBe("active");
    expect(stored?.revoked_at).toBeNull();

    const refuseWith = async (
      expected: string,
      statement: postgres.PendingQuery<unknown>,
    ) => {
      let inserted = true;
      try {
        await statement;
      } catch (error) {
        inserted = false;
        expect(sqlStateOf(error)).toBe(expected);
      }
      expect(inserted).toBe(false);
    };

    // The action set is closed, nonempty and deduplicated: a duplicate of one
    // action does not sneak past as a "subset".
    await refuseWith(
      "23514",
      sql`
        INSERT INTO ${sql(TEAM_GRANT_TABLE)}
          (grant_id, tenant_id, workspace_id, team_id, principal_id, actions,
           generation, identity_generation, company_generation, team_generation, granted_by)
        VALUES
          ('t0204-tmg-dup', ${TENANT}, ${WORKSPACE}, ${TEAM}, ${PRINCIPAL},
           ARRAY['team.member.add','team.member.add']::text[],
           1, 1, 1, 1, ${PRINCIPAL_GRANTOR})`,
    );
    await refuseWith(
      "23514",
      sql`
        INSERT INTO ${sql(TEAM_GRANT_TABLE)}
          (grant_id, tenant_id, workspace_id, team_id, principal_id, actions,
           generation, identity_generation, company_generation, team_generation, granted_by)
        VALUES
          ('t0204-tmg-empty', ${TENANT}, ${WORKSPACE}, ${TEAM}, ${PRINCIPAL},
           ARRAY[]::text[], 1, 1, 1, 1, ${PRINCIPAL_GRANTOR})`,
    );
    await refuseWith(
      "23514",
      sql`
        INSERT INTO ${sql(TEAM_GRANT_TABLE)}
          (grant_id, tenant_id, workspace_id, team_id, principal_id, actions,
           generation, identity_generation, company_generation, team_generation, granted_by)
        VALUES
          ('t0204-tmg-unknown', ${TENANT}, ${WORKSPACE}, ${TEAM}, ${PRINCIPAL},
           ARRAY['team.member.create']::text[], 1, 1, 1, 1, ${PRINCIPAL_GRANTOR})`,
    );

    // A cross-company team is structurally impossible: the composite FK proves
    // the team belongs to the grant's company.
    await refuseWith(
      "23503",
      sql`
        INSERT INTO ${sql(TEAM_GRANT_TABLE)}
          (grant_id, tenant_id, workspace_id, team_id, principal_id, actions,
           generation, identity_generation, company_generation, team_generation, granted_by)
        VALUES
          ('t0204-tmg-cross-team', ${TENANT}, ${WORKSPACE}, ${TEAM_B}, ${PRINCIPAL},
           ARRAY['team.member.add']::text[], 1, 1, 1, 1, ${PRINCIPAL_GRANTOR})`,
    );
    // And a workspace of another company, even one whose id also exists in
    // this company — the composite key (tenant, workspace) is what references.
    await refuseWith(
      "23503",
      sql`
        INSERT INTO ${sql(TEAM_GRANT_TABLE)}
          (grant_id, tenant_id, workspace_id, team_id, principal_id, actions,
           generation, identity_generation, company_generation, team_generation, granted_by)
        VALUES
          ('t0204-tmg-cross-ws', ${TENANT}, ${WORKSPACE_B_ONLY}, ${TEAM}, ${PRINCIPAL},
           ARRAY['team.member.add']::text[], 1, 1, 1, 1, ${PRINCIPAL_GRANTOR})`,
    );
    // A grantee who is not a member of the grant's company is refused the same
    // way, on both the grantee and the grantor sides.
    await refuseWith(
      "23503",
      sql`
        INSERT INTO ${sql(TEAM_GRANT_TABLE)}
          (grant_id, tenant_id, workspace_id, team_id, principal_id, actions,
           generation, identity_generation, company_generation, team_generation, granted_by)
        VALUES
          ('t0204-tmg-foreign', ${TENANT}, ${WORKSPACE}, ${TEAM}, ${PRINCIPAL_FOREIGN},
           ARRAY['team.member.add']::text[], 1, 1, 1, 1, ${PRINCIPAL})`,
    );
    await refuseWith(
      "23503",
      sql`
        INSERT INTO ${sql(TEAM_GRANT_TABLE)}
          (grant_id, tenant_id, workspace_id, team_id, principal_id, actions,
           generation, identity_generation, company_generation, team_generation, granted_by)
        VALUES
          ('t0204-tmg-foreign-grantor', ${TENANT}, ${WORKSPACE}, ${TEAM}, ${PRINCIPAL},
           ARRAY['team.member.add']::text[], 1, 1, 1, 1, ${PRINCIPAL_FOREIGN})`,
    );

    // Revocation is a status, never a deletion, and the pair must agree — the
    // access_grants discipline, applied to the team grant.
    await refuseWith(
      "23514",
      sql`
        UPDATE ${sql(TEAM_GRANT_TABLE)} SET revoked_at = now()
         WHERE grant_id = 't0204-tmg-1'`,
    );
    await sql`
      UPDATE ${sql(TEAM_GRANT_TABLE)}
         SET status = 'revoked', revoked_at = now()
       WHERE grant_id = 't0204-tmg-1'`;
    await refuseWith(
      "23514",
      sql`
        UPDATE ${sql(TEAM_GRANT_TABLE)} SET status = 'active'
         WHERE grant_id = 't0204-tmg-1'`,
    );
    await refuseWith(
      "23514",
      sql`
        UPDATE ${sql(TEAM_GRANT_TABLE)} SET status = 'pending'
         WHERE grant_id = 't0204-tmg-1'`,
    );

    await sql`DELETE FROM ${sql(TEAM_GRANT_TABLE)} WHERE grant_id LIKE 't0204-%'`;
  });

  test("provisioning_rule_keeps_stable_identity_and_closed_domain", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    // One rule per (binding, external group) — the stable identity of design
    // §3: a later approve of the same pair must UPDATE this row's revision,
    // not create a second authority beside it.
    await sql`
      INSERT INTO ${sql(RULE_TABLE)}
        (rule_id, tenant_id, binding_id, external_group, workspace_ids, revision)
      VALUES
        ('t0204-rule-1', ${TENANT}, 't0204-binding', 'eng',
         ARRAY[${WORKSPACE}]::text[], 1)`;
    const [stored] = await sql<
      {
        minimum_role: string;
        status: string;
        revision: string;
        revoked_at: string | null;
      }[]
    >`
      SELECT minimum_role, status, revision, revoked_at FROM ${sql(RULE_TABLE)}
       WHERE rule_id = 't0204-rule-1'`;
    // The fixed minimum role defaults to member, the rule starts approved, and
    // no revocation timestamp exists yet.
    expect(stored?.minimum_role).toBe("member");
    expect(stored?.status).toBe("approved");
    expect(Number(stored?.revision)).toBe(1);
    expect(stored?.revoked_at).toBeNull();

    const refuseWith = async (
      expected: string,
      statement: postgres.PendingQuery<unknown>,
    ) => {
      let inserted = true;
      try {
        await statement;
      } catch (error) {
        inserted = false;
        expect(sqlStateOf(error)).toBe(expected);
      }
      expect(inserted).toBe(false);
    };

    // The stable identity: the same (binding, external group) cannot hold a
    // second row, whatever rule id it carries.
    await refuseWith(
      "23505",
      sql`
        INSERT INTO ${sql(RULE_TABLE)}
          (rule_id, tenant_id, binding_id, external_group, workspace_ids, revision)
        VALUES
          ('t0204-rule-1b', ${TENANT}, 't0204-binding', 'eng',
           ARRAY[${WORKSPACE}]::text[], 2)`,
    );
    // A different group under the same binding is a different rule.
    await sql`
      INSERT INTO ${sql(RULE_TABLE)}
        (rule_id, tenant_id, binding_id, external_group, workspace_ids, revision)
      VALUES
        ('t0204-rule-2', ${TENANT}, 't0204-binding', 'ops',
         ARRAY[${WORKSPACE}]::text[], 1)`;

    // A NULL external group is the binding-wide company admission condition:
    // still one row per binding, and a second NULL-group rule for the same
    // binding is refused, while another binding may carry its own.
    await sql`
      INSERT INTO ${sql(RULE_TABLE)}
        (rule_id, tenant_id, binding_id, external_group, workspace_ids, revision)
      VALUES
        ('t0204-rule-wide', ${TENANT}, 't0204-binding', NULL,
         ARRAY[${WORKSPACE}]::text[], 1)`;
    await refuseWith(
      "23505",
      sql`
        INSERT INTO ${sql(RULE_TABLE)}
          (rule_id, tenant_id, binding_id, external_group, workspace_ids, revision)
        VALUES
          ('t0204-rule-wide-b', ${TENANT}, 't0204-binding', NULL,
           ARRAY[${WORKSPACE}]::text[], 2)`,
    );
    await sql`
      INSERT INTO ${sql(RULE_TABLE)}
        (rule_id, tenant_id, binding_id, external_group, workspace_ids, revision)
      VALUES
        ('t0204-rule-wide-other', ${TENANT}, 't0204-binding-2', NULL,
         ARRAY[${WORKSPACE}]::text[], 1)`;

    // The fixed targets are nonempty: a rule that admits to no team is not a
    // rule.
    await refuseWith(
      "23514",
      sql`
        INSERT INTO ${sql(RULE_TABLE)}
          (rule_id, tenant_id, binding_id, external_group, workspace_ids, revision)
        VALUES
          ('t0204-rule-empty', ${TENANT}, 't0204-binding-3', 'eng',
           ARRAY[]::text[], 1)`,
    );

    // The status domain is closed and paired with its timestamp, exactly like
    // every other revocable authority in this family.
    await refuseWith(
      "23514",
      sql`
        UPDATE ${sql(RULE_TABLE)} SET status = 'pending'
         WHERE rule_id = 't0204-rule-1'`,
    );
    await refuseWith(
      "23514",
      sql`
        UPDATE ${sql(RULE_TABLE)} SET revoked_at = now()
         WHERE rule_id = 't0204-rule-1'`,
    );
    await sql`
      UPDATE ${sql(RULE_TABLE)}
         SET status = 'revoked', revoked_at = now(), revision = 2
       WHERE rule_id = 't0204-rule-1'`;
    const [revoked] = await sql<{ status: string; revision: string }[]>`
      SELECT status, revision FROM ${sql(RULE_TABLE)}
       WHERE rule_id = 't0204-rule-1'`;
    expect(revoked?.status).toBe("revoked");
    expect(Number(revoked?.revision)).toBe(2);

    // The minimum role domain is closed too.
    await refuseWith(
      "23514",
      sql`
        UPDATE ${sql(RULE_TABLE)} SET minimum_role = 'bogus'
         WHERE rule_id = 't0204-rule-2'`,
    );

    await sql`DELETE FROM ${sql(RULE_TABLE)} WHERE rule_id LIKE 't0204-%'`;
  });

  test("typed_schema_matches_applied_migration", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    // The barrel carries the two new models: a schema table that exists but is
    // not exported is invisible to every consumer of the barrel.
    const tables = schema as unknown as Record<string, unknown>;
    const teamGrantTable = tables.authTeamManagementGrants;
    expect(
      teamGrantTable,
      "schema barrel exports authTeamManagementGrants",
    ).toBeDefined();
    const ruleTable = tables.authProvisioningRules;
    expect(
      ruleTable,
      "schema barrel exports authProvisioningRules",
    ).toBeDefined();

    const columnNames = (table: unknown) =>
      getTableConfig(table as Parameters<typeof getTableConfig>[0])
        .columns.map((column) => column.name)
        .sort();
    expect(columnNames(teamGrantTable)).toEqual([
      "actions",
      "company_generation",
      "created_at",
      "generation",
      "grant_id",
      "granted_by",
      "identity_generation",
      "principal_id",
      "revoked_at",
      "status",
      "team_generation",
      "team_id",
      "tenant_id",
      "workspace_id",
    ]);
    expect(columnNames(ruleTable)).toEqual([
      "binding_id",
      "created_at",
      "external_group",
      "minimum_role",
      "revision",
      "revoked_at",
      "rule_id",
      "status",
      "tenant_id",
      "updated_at",
      "workspace_ids",
    ]);

    // The applied database agrees with the typed projection, column for
    // column, type for type — including that every new version column is
    // bigint and every expand column on an existing table stayed nullable.
    const dbColumns = await sql<
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
         AND (table_name IN (${TEAM_GRANT_TABLE}, ${RULE_TABLE})
              OR ((table_name, column_name) IN (
                   ('enterprise_credentials', 'owner_identity_generation'),
                   ('enterprise_credentials', 'owner_company_generation'),
                   ('enterprise_credential_actions', 'identity_generation'),
                   ('enterprise_credential_actions', 'company_generation'),
                   ('enterprise_credential_actions', 'source_team_generation'),
                   ('billing_company_finance_grants', 'identity_generation'),
                   ('billing_company_finance_grants', 'company_generation'),
                   ('access_grants', 'principal_id'),
                   ('access_grants', 'identity_generation'),
                   ('gateway_virtual_keys', 'source_identity_generation')
                 )))
       ORDER BY table_name, column_name`;
    const observed = new Map(
      [...dbColumns].map((row) => [
        `${row.table_name}.${row.column_name}`,
        row,
      ]),
    );
    expect(observed.size).toBe(
      14 + 11 + Object.values(ADDED_COLUMNS).flat().length,
    );
    const textColumns = new Set([
      `${TEAM_GRANT_TABLE}.grant_id`,
      `${TEAM_GRANT_TABLE}.tenant_id`,
      `${TEAM_GRANT_TABLE}.workspace_id`,
      `${TEAM_GRANT_TABLE}.team_id`,
      `${TEAM_GRANT_TABLE}.principal_id`,
      `${TEAM_GRANT_TABLE}.granted_by`,
      `${TEAM_GRANT_TABLE}.status`,
      `${RULE_TABLE}.rule_id`,
      `${RULE_TABLE}.tenant_id`,
      `${RULE_TABLE}.binding_id`,
      `${RULE_TABLE}.external_group`,
      `${RULE_TABLE}.minimum_role`,
      `${RULE_TABLE}.status`,
      "access_grants.principal_id",
    ]);
    const arrayColumns = new Set([
      `${TEAM_GRANT_TABLE}.actions`,
      `${RULE_TABLE}.workspace_ids`,
    ]);
    const timestampColumns = new Set([
      `${TEAM_GRANT_TABLE}.revoked_at`,
      `${TEAM_GRANT_TABLE}.created_at`,
      `${RULE_TABLE}.revoked_at`,
      `${RULE_TABLE}.created_at`,
      `${RULE_TABLE}.updated_at`,
    ]);
    for (const [key, row] of observed) {
      if (textColumns.has(key)) {
        expect([key, row.data_type]).toEqual([key, "text"]);
      } else if (arrayColumns.has(key)) {
        expect([key, row.data_type]).toEqual([key, "ARRAY"]);
      } else if (timestampColumns.has(key)) {
        expect([key, row.data_type]).toEqual([key, "timestamp with time zone"]);
      } else {
        expect([key, row.data_type]).toEqual([key, "bigint"]);
      }
      if (
        row.table_name !== TEAM_GRANT_TABLE &&
        row.table_name !== RULE_TABLE
      ) {
        expect([key, row.is_nullable]).toEqual([key, "YES"]);
      }
    }
  });

  test("migration_replays_from_clean_state_without_touching_legacy", async () => {
    const harness = await loadHarness();

    // Exactly the two new tables, on the first apply and on the replay after a
    // full revert — and nothing else appears or disappears.
    expect(harness.firstApplyTableCount).toBe(harness.baselineTableCount + 2);
    expect(harness.replayTableCount).toBe(harness.baselineTableCount + 2);
  });

  test("schema_file_is_registered_in_barrel_generator_and_journal", () => {
    // The journal carries this migration, appended after T02.03's 0211 and
    // still monotonic and gapless.
    const journal = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../../drizzle/meta/_journal.json"),
        "utf8",
      ),
    ) as { entries: { idx: number; tag: string }[] };
    const entry = journal.entries.find(
      (candidate) => candidate.tag === `${MIGRATION_TAG}`,
    );
    expect(
      entry,
      `the drizzle journal registers ${MIGRATION_TAG}`,
    ).toBeDefined();
    expect(entry?.idx).toBe(212);
    for (let index = 1; index < journal.entries.length; index += 1) {
      expect(journal.entries[index].idx).toBe(
        journal.entries[index - 1].idx + 1,
      );
    }

    // Every schema file this task touched is listed in the generator's source
    // list — a file missing there is invisible to the next generated
    // migration, which could then emit destructive DDL against these tables.
    const config = readFileSync(
      join(import.meta.dirname, "../../drizzle.config.ts"),
      "utf8",
    );
    for (const file of [
      "auth-directory.ts",
      "enterprise-credentials.ts",
      "company-finance.ts",
      "access-grants.ts",
      "gateway.ts",
    ]) {
      expect(
        config.includes(`./src/db/schema/${file}`),
        `drizzle.config.ts lists ${file}`,
      ).toBe(true);
    }
  });
});
