/*
 * T02.15 (#537, the M3 reconciliation slice of the original task P25) — the
 * verify-directory tool, checked against the real backfilled directory on the
 * isolated BA_TEST_* island database (interfaces §1/§2/§3.3/§5.3, design
 * §13.2 "M3 校验").
 *
 * What this file pins, and why each part is a database fact rather than a
 * code convention:
 *
 * - `legacy_authority_keeps_existing_tenancy_green` (Brief-named): before any
 *   backfill — the expand stack applied, the BA directory empty, the seeded
 *   (M1, legacy, v0) row — the legacy writer's request through the write gate
 *   is still 200 and the BA writer's is still 503 closed: the M3 tool's world
 *   must not make legacy depend on a migration it has not reached.
 * - `m3_reconciliation_matches_backfilled_directory`: after the real M2
 *   stop-write apply imports the fixture companies, the M3 verify reconciles
 *   every mapped aspect — organizations/members/teams/bindings/team members
 *   (sets and stable keys), roles, persistent versions (clocks against the
 *   import command's change keys), receipts, foreign keys, payer bindings,
 *   owners, external attribution, and the §5.3 authorization sources — with
 *   canSwitch true for the verified scope, and it writes nothing: the full
 *   before/after row dump is byte-identical and the authority row is the
 *   same (M2, paused) one the pause CAS produced. Unscoped, the same island
 *   honestly reports the shared baseline's not-backfilled tenants and keeps
 *   canSwitch closed.
 * - `missing_clock_or_new_schema_mapping_blocks_m3` (Brief-named): a deleted
 *   eligibility clock or a public.auth_* table outside the mapping manifest
 *   blocks M3 — expect(canSwitch).toBe(false) — because the M3→M4 switch
 *   must never be vouched for over a directory whose versions or schema the
 *   reconciliation does not know.
 * - `reconciliation_reports_set_key_role_and_version_drift`: the drifts the
 *   tool exists to catch — a deleted member (set/key), a rewritten role, a
 *   ghost organization, a bumped clock epoch, a deleted payer binding, an
 *   SSO provider bound to an organization — each produces its aspect's
 *   mismatch and closes canSwitch; undoing the drift reopens it.
 * - `verify_authority_matrix_covers_legacy_paused_and_ba`: the authority
 *   matrix (T02.10's support fixture, extended by this task with the M0–M3
 *   migration states) runs the same inputs — the legacy and BA writers'
 *   requireWrite at the scenario's version, then the tool itself — under
 *   every persisted state: legacy (M0/M1) refuses the switch readout,
 *   paused accepts it at BOTH M2 and M3 (the verify window is a phase, not
 *   just a mode), ba refuses it as already switched; the tool never touches
 *   the row.
 * - `m3_verify_is_read_only_with_stable_digest_and_entry_contract`: the entry
 *   contract of interfaces §1 — schemaVersion/generatedAt/digest, the digest
 *   excluding generatedAt and stable across runs.
 * - `verify_cli_contract_is_explicit_and_read_only`: an explicit target URL,
 *   --tenant scoping, phases owned by other tools refused by name, and no
 *   apply or writer path at all — the M4 switch is T08.01's transaction, not
 *   an argument away (工具不切 M4).
 *
 * Boundaries this suite deliberately does not claim (later slices own them):
 * the M4 cutover and its authority CAS (T08.01), the old-capability
 * revocation DML (T08.02/T08.03 — the M3 report records the per-grant/key
 * disposition and writes nothing to access_grants or gateway_virtual_keys),
 * and the runtime wiring of read gates (T02.11). Real production targets are
 * not authorized in this slice.
 *
 * The island carries the enterprise baseline (30 tenants of shared fixture
 * data with their own inventory blockers), so every clean-scope assertion is
 * scoped to this suite's `t0215-` fixture subjects; the baseline tenants'
 * not-backfilled outcomes are the tool's honest report, not this suite's
 * verdict. The five BA_TEST_* URLs are all required (presence and
 * same-instance shape); a missing one is a blocked suite, never a silent
 * fallback. No DSN is ever printed — refusals name the variable.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import {
  createDirectoryAuthority,
  isAuthorityRefusal,
} from "../../src/auth/directory/authority";
import type { DirectoryTx } from "../../src/auth/directory/contracts";
import { createDatabase } from "../../src/db/client";
import {
  MIGRATION_STATE_SCENARIOS,
  withAuthorityMatrix,
} from "./support/authority-matrix";

const DATABASE_VARIABLE = "BA_TEST_DATABASE_URL";
const WRITER_VARIABLE = "BA_TEST_AUTH_WRITER_DATABASE_URL";
const BA_URL_VARIABLES = [
  DATABASE_VARIABLE,
  "BA_TEST_DIRECTORY_DATABASE_URL",
  "BA_TEST_DATA_DATABASE_URL",
  "BA_TEST_OPERATOR_DATABASE_URL",
  WRITER_VARIABLE,
] as const;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function shapeOf(variable: string, raw: string): { endpoint: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${variable} must be a PostgreSQL URL.`);
  }
  if (!/^postgres(?:ql)?:$/.test(url.protocol)) {
    throw new Error(`${variable} must be a PostgreSQL URL.`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname) || !url.pathname.slice(1)) {
    throw new Error(
      `${variable} must be a loopback PostgreSQL URL naming a database.`,
    );
  }
  const host =
    url.hostname === "localhost" || url.hostname === "[::1]"
      ? "127.0.0.1"
      : url.hostname;
  return { endpoint: `${host}:${url.port || "5432"}` };
}

function readBaUrls(): string {
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
  const reference = [...shapes.entries()].find(
    ([variable]) => variable === DATABASE_VARIABLE,
  )![1];
  for (const [variable, endpoint] of shapes) {
    if (endpoint !== reference) {
      throw new Error(
        `${variable} must name the same PostgreSQL instance as ${DATABASE_VARIABLE}.`,
      );
    }
  }
  return process.env[DATABASE_VARIABLE]!.trim();
}

function writerUrl(): string {
  const raw = process.env[WRITER_VARIABLE]?.trim();
  if (!raw) {
    throw new Error(
      `${WRITER_VARIABLE} is required: the M2 backfill writes through the restricted ob_ent_auth_writer capability; a missing URL is blocked, not a fallback.`,
    );
  }
  return raw;
}

/*
 * The verified expand stack the tool sits on, applied by this suite and
 * removed again at cleanup — the same discipline every schema suite on the
 * island follows (the shared database carries the enterprise baseline only).
 */
const MIGRATION_TAGS = [
  "0209_better_auth_directory",
  "0210_better_auth_clocks",
  "0211_better_auth_command_authority",
  "0212_better_auth_authority_sources",
  "0213_better_auth_assurance",
  "0214_better_auth_schema_roles",
] as const;
const MIGRATION_PATHS = MIGRATION_TAGS.map((tag) =>
  join(import.meta.dirname, `../../drizzle/${tag}.sql`),
);
/** Every BA table the applied stack creates, dropped again at cleanup. */
const BA_TABLES = [
  "auth_company_session_assurances",
  "auth_company_auth_challenges",
  "auth_team_management_grants",
  "auth_provisioning_rules",
  "auth_command_outbox",
  "auth_command_change_keys",
  "auth_command_receipts",
  "auth_authority_states",
  "auth_eligibility_clocks",
  "auth_invitations",
  "auth_team_members",
  "auth_members",
  "auth_team_bindings",
  "auth_teams",
  "auth_organizations",
] as const;

/*
 * The fixture: three clean companies for the reconciliation — clean (owner,
 * member, auditor, one suspended member, one two-member team, payer binding),
 * collide (a younger tenant whose name normalizes to clean's slug), and
 * empty (a name that normalizes to nothing, for the digest fallback) — plus
 * one verified and one unattributed personal grant/key for the §5.3
 * disposition assertions. Every id carries the t0215- prefix so cleanup and
 * the leak probe stay surgical on the shared island.
 */
const FIXTURE = {
  users: {
    owner: "t0215-owner",
    member: "t0215-member",
    auditor: "t0215-auditor",
    suspended: "t0215-suspended",
  },
  tenants: {
    clean: "t0215-tenant-clean",
    collide: "t0215-tenant-collide",
    empty: "t0215-tenant-empty",
  },
  principals: {
    owner: "t0215-principal-owner",
    member: "t0215-principal-member",
    auditor: "t0215-principal-auditor",
    suspended: "t0215-principal-suspended",
  },
  workspaces: {
    clean: "t0215-ws-clean",
    collide: "t0215-ws-collide",
  },
  grants: {
    verified: "t0215-grant-verified",
    unattributed: "t0215-grant-unattributed",
  },
  keys: {
    verified: "t0215-key-verified",
    missingGeneration: "t0215-key-missing-generation",
  },
} as const;

const FIXTURE_TENANTS = [
  FIXTURE.tenants.clean,
  FIXTURE.tenants.collide,
  FIXTURE.tenants.empty,
] as const;

async function seedFixture(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO users (id, email) VALUES
      (${FIXTURE.users.owner}, 't0215-owner@example.test'),
      (${FIXTURE.users.member}, 't0215-member@example.test'),
      (${FIXTURE.users.auditor}, 't0215-auditor@example.test'),
      (${FIXTURE.users.suspended}, 't0215-suspended@example.test')`;
  // Explicit created_at values fix the §2 collision order deterministically:
  // clean is the oldest, so clean keeps the base slug and collide takes -2.
  await sql`
    INSERT INTO enterprise_tenants (id, name, created_at) VALUES
      (${FIXTURE.tenants.clean}, 'T0215 Clean Zqx Company', now() - interval '3 seconds'),
      (${FIXTURE.tenants.empty}, '  !!!  ', now() - interval '2 seconds'),
      (${FIXTURE.tenants.collide}, 't0215  CLEAN  zqx  COMPANY', now() - interval '1 second')`;
  await sql`
    INSERT INTO enterprise_principals (id, user_id, status, identity_generation) VALUES
      (${FIXTURE.principals.owner}, ${FIXTURE.users.owner}, 'active', 1),
      (${FIXTURE.principals.member}, ${FIXTURE.users.member}, 'active', 1),
      (${FIXTURE.principals.auditor}, ${FIXTURE.users.auditor}, 'active', 1),
      (${FIXTURE.principals.suspended}, ${FIXTURE.users.suspended}, 'active', 1)`;
  await sql`
    INSERT INTO enterprise_memberships (tenant_id, principal_id, role, status, epoch) VALUES
      (${FIXTURE.tenants.clean}, ${FIXTURE.principals.owner}, 'tenant_admin', 'active', 1),
      (${FIXTURE.tenants.clean}, ${FIXTURE.principals.member}, 'member', 'active', 1),
      (${FIXTURE.tenants.clean}, ${FIXTURE.principals.auditor}, 'auditor', 'active', 1),
      (${FIXTURE.tenants.clean}, ${FIXTURE.principals.suspended}, 'member', 'suspended', 3),
      (${FIXTURE.tenants.collide}, ${FIXTURE.principals.owner}, 'tenant_admin', 'active', 1),
      (${FIXTURE.tenants.empty}, ${FIXTURE.principals.owner}, 'tenant_admin', 'active', 1)`;
  await sql`
    INSERT INTO enterprise_workspaces (tenant_id, id, name) VALUES
      (${FIXTURE.tenants.clean}, ${FIXTURE.workspaces.clean}, 'T0215 Clean Team'),
      (${FIXTURE.tenants.collide}, ${FIXTURE.workspaces.collide}, 'T0215 Collide Team')`;
  await sql`
    INSERT INTO enterprise_workspace_memberships (tenant_id, workspace_id, principal_id, status, epoch) VALUES
      (${FIXTURE.tenants.clean}, ${FIXTURE.workspaces.clean}, ${FIXTURE.principals.member}, 'active', 1),
      (${FIXTURE.tenants.clean}, ${FIXTURE.workspaces.clean}, ${FIXTURE.principals.auditor}, 'active', 1),
      (${FIXTURE.tenants.collide}, ${FIXTURE.workspaces.collide}, ${FIXTURE.principals.owner}, 'active', 1)`;
  for (const tenant of FIXTURE_TENANTS) {
    await sql`
      INSERT INTO billing_customers (external_id, name)
      VALUES (${`t0215-billing-${tenant}`}, ${`T0215 ${tenant}`})`;
    await sql`
      INSERT INTO billing_customer_mappings (tenant_id, external_customer_id)
      VALUES (${tenant}, ${`t0215-billing-${tenant}`})`;
  }
  await sql`
    INSERT INTO bot_services (bot_id, display_name, kind, capabilities) VALUES
      ('t0215-bot', 'T0215 Migration Bot', 'external', ARRAY['chat'])`;
  await sql`
    INSERT INTO access_grants (grant_id, user_id, principal_id, identity_generation, bot_id, external_identity, scope, status) VALUES
      (${FIXTURE.grants.verified}, ${FIXTURE.users.member}, ${FIXTURE.principals.member}, 1, 't0215-bot', 'openbot:t0215-member', 'model-access', 'active'),
      (${FIXTURE.grants.unattributed}, ${FIXTURE.users.auditor}, NULL, NULL, 't0215-bot', 'openbot:t0215-auditor', 'model-access', 'active')`;
  await sql`
    INSERT INTO gateway_virtual_keys (id, grant_id, bot_id, gateway_customer_id, gateway_virtual_key_id, value_hash, credential_version, source_identity_generation) VALUES
      (${FIXTURE.keys.verified}, ${FIXTURE.grants.verified}, 't0215-bot', 't0215-gateway-customer', 't0215-gateway-key-verified', ${`t0215-${"f".repeat(60)}`}, 1, 1),
      (${FIXTURE.keys.missingGeneration}, ${FIXTURE.grants.unattributed}, 't0215-bot', 't0215-gateway-customer', 't0215-gateway-key-missing', ${`t0215-${"e".repeat(60)}`}, 1, NULL)`;
}

async function cleanupFixture(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(
    `DROP TABLE IF EXISTS ${BA_TABLES.map((name) => `"${name}"`).join(", ")} CASCADE`,
  );
  // The clock/authority prerequisites ALTER existing enterprise tables, so a
  // crashed earlier run can leave their columns behind — the same
  // normalization the sibling schema suites perform.
  await sql.unsafe(
    `ALTER TABLE "enterprise_principals" DROP COLUMN IF EXISTS "identity_generation"`,
  );
  for (const [table, constraint] of [
    ["enterprise_credentials", "enterprise_credential_owner_generation_pair"],
    [
      "enterprise_credentials",
      "enterprise_credential_owner_identity_generation_safe_integer",
    ],
    [
      "enterprise_credentials",
      "enterprise_credential_owner_company_generation_safe_integer",
    ],
    [
      "enterprise_credential_actions",
      "enterprise_credential_action_generation_pair",
    ],
    [
      "enterprise_credential_actions",
      "enterprise_credential_action_identity_generation_safe_integer",
    ],
    [
      "billing_company_finance_grants",
      "billing_company_finance_grant_generation_pair",
    ],
    [
      "billing_company_finance_grants",
      "billing_company_finance_grant_identity_generation_safe_integer",
    ],
    ["enterprise_principals", "enterprise_principal_identity_generation_pair"],
    [
      "enterprise_principals",
      "enterprise_principal_identity_generation_safe_integer",
    ],
    ["access_grants", "access_grants_principal_generation_pair"],
    ["access_grants", "access_grants_identity_generation_safe_integer"],
    ["access_grants", "access_grants_principal_fk"],
  ] as const) {
    await sql.unsafe(
      `ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${constraint}"`,
    );
  }
  for (const [table, column] of [
    ["enterprise_credentials", "owner_identity_generation"],
    ["enterprise_credentials", "owner_company_generation"],
    ["enterprise_credential_actions", "source_identity_generation"],
    ["enterprise_credential_actions", "identity_generation"],
    ["enterprise_credential_actions", "company_generation"],
    ["enterprise_credential_actions", "source_team_generation"],
    ["billing_company_finance_grants", "identity_generation"],
    ["billing_company_finance_grants", "company_generation"],
    ["access_grants", "principal_id"],
    ["access_grants", "identity_generation"],
    ["gateway_virtual_keys", "source_identity_generation"],
  ] as const) {
    await sql.unsafe(
      `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "${column}"`,
    );
  }
  // This suite's own fixture rows, in FK-safe order (constraints dropped
  // above, but the order stays explicit so it also holds under them).
  await sql`DELETE FROM sso_providers WHERE id LIKE 't0215-%'`;
  await sql`DELETE FROM gateway_virtual_keys WHERE id LIKE 't0215-%'`;
  await sql`DELETE FROM access_grants WHERE grant_id LIKE 't0215-%'`;
  await sql`DELETE FROM payer_accounts WHERE id LIKE 't0215-%' OR payer_id LIKE 't0215-%'`;
  await sql`DELETE FROM billing_customers WHERE external_id LIKE 't0215-%'`;
  await sql`DELETE FROM enterprise_tenants WHERE id LIKE 't0215-%'`;
  await sql`DELETE FROM enterprise_principals WHERE id LIKE 't0215-%'`;
  await sql`DELETE FROM bot_services WHERE bot_id LIKE 't0215-%'`;
  await sql`DELETE FROM users WHERE id LIKE 't0215-%'`;
}

/** Every table the tool reads, dumped as ordered JSON row texts. */
const SNAPSHOT_TABLES: ReadonlyArray<readonly [string, string]> = [
  ["users", "id"],
  ["enterprise_tenants", "id"],
  ["enterprise_principals", "id"],
  ["enterprise_memberships", "tenant_id, principal_id"],
  ["enterprise_workspaces", "tenant_id, id"],
  ["enterprise_workspace_memberships", "tenant_id, workspace_id, principal_id"],
  ["billing_customers", "external_id"],
  ["billing_customer_mappings", "tenant_id"],
  ["payer_accounts", "id"],
  ["bot_services", "bot_id"],
  ["access_grants", "grant_id"],
  ["gateway_virtual_keys", "id"],
  ["sso_providers", "id"],
  ["auth_organizations", "id"],
  ["auth_teams", "id"],
  ["auth_team_bindings", "tenant_id, workspace_id"],
  ["auth_members", "id"],
  ["auth_team_members", "id"],
  ["auth_eligibility_clocks", "tenant_id, principal_id, kind, scope_id"],
  ["auth_command_receipts", "command_id"],
  [
    "auth_command_change_keys",
    "command_id, tenant_id, principal_id, kind, scope_id",
  ],
  ["auth_command_outbox", "id"],
  ["auth_authority_states", "id"],
  ["auth_team_management_grants", "grant_id"],
] as const;

async function snapshotDatabase(
  sql: postgres.Sql,
): Promise<Record<string, string[]>> {
  const dump: Record<string, string[]> = {};
  for (const [table, order] of SNAPSHOT_TABLES) {
    const rows = await sql.unsafe(
      `SELECT row_to_json(t.*)::text AS row FROM ${table} t ORDER BY ${order}`,
    );
    dump[table] = rows.map((row) => String((row as { row: string }).row));
  }
  return dump;
}

interface Harness {
  sql: postgres.Sql;
  /** The drizzle handle over the same setup URL: real DirectoryTx instances. */
  inTransaction<T>(work: (tx: DirectoryTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const REPO_ROOT = join(import.meta.dirname, "../../..");

async function createHarness(): Promise<Harness> {
  const setupUrl = readBaUrls();
  const sql = postgres(setupUrl, {
    max: 1,
    idle_timeout: 5,
    onnotice: () => {},
  });
  let db: Awaited<ReturnType<typeof createDatabase>> | undefined;
  try {
    await cleanupFixture(sql);
    for (const path of MIGRATION_PATHS) {
      if (!existsSync(path)) {
        throw new Error(
          `${path} does not exist: the verify-directory tool sits on the verified T02.01–T02.06 stack, and a missing prerequisite is a workspace problem, not a target behavior.`,
        );
      }
      await sql.unsafe(readFileSync(path, "utf8"));
    }
    await seedFixture(sql);
    db = createDatabase(setupUrl, { max: 2 });
    return {
      sql,
      inTransaction: <T>(work: (tx: DirectoryTx) => Promise<T>) =>
        db!.transaction(work),
      close: async () => {
        try {
          await cleanupFixture(sql);
        } finally {
          await db?.$client.close?.();
          await sql.end({ timeout: 5 }).catch(() => {});
        }
      },
    };
  } catch (error) {
    await cleanupFixture(sql).catch(() => {});
    await db?.$client.close?.();
    await sql.end({ timeout: 5 }).catch(() => {});
    throw error;
  }
}

let harness: Harness | undefined;

function currentHarness(): Harness {
  if (!harness) throw new Error("fixture harness missing");
  return harness;
}

beforeAll(async () => {
  harness = await createHarness();
}, 120_000);

afterAll(async () => {
  if (!harness) return;
  await harness.close();
  // The same after-close check the sibling suites run, on a fresh
  // short-lived connection: a future change that strands a BA object or a
  // t0215- row on the shared island fails here instead of piling up.
  const sql = postgres(readBaUrls(), {
    max: 1,
    idle_timeout: 5,
    onnotice: () => {},
  });
  try {
    const leaked = await sql`
      SELECT 'users:' || id FROM users WHERE id LIKE 't0215-%'
      UNION ALL
      SELECT 'tenants:' || id FROM enterprise_tenants WHERE id LIKE 't0215-%'
      UNION ALL
      SELECT 'principals:' || id FROM enterprise_principals WHERE id LIKE 't0215-%'
      UNION ALL
      SELECT 'memberships:' || tenant_id FROM enterprise_memberships WHERE tenant_id LIKE 't0215-%'
      UNION ALL
      SELECT 'workspaces:' || tenant_id FROM enterprise_workspaces WHERE tenant_id LIKE 't0215-%'
      UNION ALL
      SELECT 'ws_memberships:' || tenant_id FROM enterprise_workspace_memberships WHERE tenant_id LIKE 't0215-%'
      UNION ALL
      SELECT 'billing_customers:' || external_id FROM billing_customers WHERE external_id LIKE 't0215-%'
      UNION ALL
      SELECT 'mappings:' || tenant_id FROM billing_customer_mappings WHERE tenant_id LIKE 't0215-%'
      UNION ALL
      SELECT 'payer_accounts:' || id FROM payer_accounts WHERE id LIKE 't0215-%' OR payer_id LIKE 't0215-%'
      UNION ALL
      SELECT 'bots:' || bot_id FROM bot_services WHERE bot_id LIKE 't0215-%'
      UNION ALL
      SELECT 'grants:' || grant_id FROM access_grants WHERE grant_id LIKE 't0215-%'
      UNION ALL
      SELECT 'keys:' || id FROM gateway_virtual_keys WHERE id LIKE 't0215-%'
      UNION ALL
      SELECT 'sso:' || id FROM sso_providers WHERE id LIKE 't0215-%'
      UNION ALL
      SELECT 'ba_table:' || table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY(${[...BA_TABLES]}::text[])`;
    expect(leaked).toEqual([]);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}, 120_000);

/*
 * The two tools under test, loaded lazily so a broken import surfaces as the
 * suite's own refusal with the target named, never as a collection error.
 */
let verifyPromise:
  | Promise<typeof import("../../scripts/better-auth/verify-directory")>
  | undefined;
function loadVerify(): Promise<
  typeof import("../../scripts/better-auth/verify-directory")
> {
  verifyPromise ??= import("../../scripts/better-auth/verify-directory").catch(
    (error: unknown) => {
      throw new Error(
        `server/scripts/better-auth/verify-directory.ts is not loadable — ${error instanceof Error ? error.message : String(error)}: the M3 reconciliation tool this suite pins is the T02.15 target behavior, not an environment problem.`,
      );
    },
  );
  return verifyPromise;
}

let migratePromise:
  | Promise<typeof import("../../scripts/better-auth/migrate-directory")>
  | undefined;
function loadMigrate(): Promise<
  typeof import("../../scripts/better-auth/migrate-directory")
> {
  migratePromise ??= import(
    "../../scripts/better-auth/migrate-directory"
  ).catch((error: unknown) => {
    throw new Error(
      `server/scripts/better-auth/migrate-directory.ts is not loadable — ${error instanceof Error ? error.message : String(error)}: the M2 backfill that produces this suite's directory is the T02.14 prerequisite, not an environment problem.`,
    );
  });
  return migratePromise;
}

/** The report fields this suite asserts (the tool owns the full shape). */
interface AspectView {
  aspect: string;
  legacy: number;
  ba: number;
  missing: string[];
  extra: string[];
  mismatched: string[];
  clean: boolean;
}

interface VerifyReportView {
  schemaVersion: number;
  generatedAt: string;
  digest: string;
  phase: string;
  mode: string;
  scope: { mode: string; tenants: string[] };
  target: { endpoint: string; database: string; expandedSchema: boolean };
  authority: {
    before: {
      authorityVersion: number;
      phase: string;
      directoryAuthority: string;
      multiTenantReleased: boolean;
    } | null;
    after: unknown;
    unchanged: boolean;
  };
  schema: {
    manifestTables: number;
    presentTables: number;
    unmappedTables: string[];
    missingTables: string[];
  };
  reconciliation: {
    aspects: AspectView[];
    tenants: Array<{ tenantId: string; outcome: string }>;
  } | null;
  inventory: { digest: string; canMigrate: boolean } | null;
  authorizationSources: {
    personalGrants: Array<{ grantId: string; disposition: string }>;
    gatewayKeys: Array<{ keyId: string; disposition: string }>;
  } | null;
  blockers: Array<{ kind: string; subject: string; detail: string }>;
  canSwitch: boolean;
}

async function runVerify(
  tenants?: readonly string[],
): Promise<VerifyReportView> {
  const verify = await loadVerify();
  return verify.runVerifyDirectory({
    url: readBaUrls(),
    repositoryRoot: REPO_ROOT,
    ...(tenants ? { tenants } : {}),
  }) as Promise<VerifyReportView>;
}

function aspectOf(report: VerifyReportView, aspect: string): AspectView {
  const found = report.reconciliation?.aspects.find(
    (entry) => entry.aspect === aspect,
  );
  if (!found) {
    throw new Error(
      `the M3 report has no "${aspect}" aspect: ${JSON.stringify(
        report.reconciliation?.aspects.map((entry) => entry.aspect) ?? [],
      )}`,
    );
  }
  return found;
}

/** Disable the named directory guard/fence triggers, restore them after. */
async function withGuardsDisabled(
  sql: postgres.Sql,
  triggers: ReadonlyArray<readonly [string, string]>,
  work: () => Promise<void>,
): Promise<void> {
  for (const [table, trigger] of triggers) {
    await sql.unsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
  }
  try {
    await work();
  } finally {
    for (const [table, trigger] of triggers) {
      await sql
        .unsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`)
        .catch(() => {});
    }
  }
}

test("legacy_authority_keeps_existing_tenancy_green", async () => {
  const { inTransaction, sql } = currentHarness();
  // BA未填: the expand stack is applied but nothing was backfilled yet, and
  // the persisted row is the one the migrations seed — (M1, legacy, v0).
  const emptyDirectory = await sql`
    SELECT (SELECT count(*)::int FROM auth_organizations) AS orgs,
           (SELECT count(*)::int FROM auth_members) AS members`;
  expect(emptyDirectory[0]).toEqual({ orgs: 0, members: 0 });
  const outcome = await inTransaction(async (tx) => {
    const authority = createDirectoryAuthority();
    const state = await authority.read(tx);
    const answer = async (
      writer: "legacy" | "ba",
    ): Promise<{ status: number; code: string | null }> => {
      try {
        await authority.requireWrite(tx, state.authorityVersion, writer);
        return { status: 200, code: null };
      } catch (error) {
        if (isAuthorityRefusal(error)) {
          return { status: error.status, code: error.code };
        }
        throw error;
      }
    };
    return {
      state,
      legacy: await answer("legacy"),
      ba: await answer("ba"),
    };
  });
  // The old request: the legacy writer's path through the write gate is
  // still 200 — no BA dependency was retrofitted onto it.
  expect(outcome.legacy.status).toBe(200);
  expect(outcome.state).toEqual({
    authorityVersion: 0,
    phase: "M1",
    directoryAuthority: "legacy",
    multiTenantReleased: false,
  });
  // The BA writer stays closed before M4 — the legacy branch is preserved,
  // not widened.
  expect(outcome.ba.status).toBe(503);
  expect(outcome.ba.code).toBe("DIRECTORY_WRITE_AUTHORITY_CLOSED");
  // A read/write gate performs no DML: the persisted row is untouched.
  const persisted = await sql`
    SELECT authority_version::int AS "authorityVersion", phase,
           directory_authority AS "directoryAuthority",
           multi_tenant_released AS "multiTenantReleased"
      FROM auth_authority_states WHERE id = 1`;
  expect(persisted[0]).toEqual({
    authorityVersion: 0,
    phase: "M1",
    directoryAuthority: "legacy",
    multiTenantReleased: false,
  });
}, 120_000);

test("m3_reconciliation_matches_backfilled_directory", async () => {
  const { sql } = currentHarness();
  const migrate = await loadMigrate();
  const apply = await migrate.runMigrateDirectory({
    phase: "M2",
    apply: true,
    url: readBaUrls(),
    writerUrl: writerUrl(),
    repositoryRoot: REPO_ROOT,
  });
  expect(apply.authority.paused).toBe(true);
  expect(apply.authority.after).toEqual({
    authorityVersion: 1,
    phase: "M2",
    directoryAuthority: "paused",
    multiTenantReleased: false,
  });
  for (const tenant of FIXTURE_TENANTS) {
    expect(
      apply.backfill?.imports.find((entry) => entry.tenantId === tenant)
        ?.outcome,
    ).toBe("imported");
  }

  const before = await snapshotDatabase(sql);
  const report = await runVerify(FIXTURE_TENANTS);
  const after = await snapshotDatabase(sql);
  // Read-only (shadow 比较但不双主写): the M3 verify leaves every in-scope
  // table byte-identical.
  expect(after).toEqual(before);

  expect(report.schemaVersion).toBe(1);
  expect(report.phase).toBe("M3");
  expect(report.mode).toBe("verify");
  expect(report.scope).toEqual({
    mode: "selected",
    tenants: [...FIXTURE_TENANTS],
  });
  expect(report.target.expandedSchema).toBe(true);
  expect(report.digest).toMatch(/^[0-9a-f]{64}$/);
  // The authority row is exactly the one the pause CAS produced, still
  // untouched — the tool never switches anything, M4 included.
  expect(report.authority.before).toEqual({
    authorityVersion: 1,
    phase: "M2",
    directoryAuthority: "paused",
    multiTenantReleased: false,
  });
  expect(report.authority.after).toEqual(report.authority.before);
  expect(report.authority.unchanged).toBe(true);
  // The mapping manifest covers the whole applied stack and nothing outside
  // it: 15 known auth_* tables, all present, none unmapped.
  expect(report.schema).toEqual({
    manifestTables: 15,
    presentTables: 15,
    unmappedTables: [],
    missingTables: [],
  });

  // 集合与键: every mapped aspect is clean with the fixture's counts.
  expect(aspectOf(report, "organizations")).toMatchObject({
    legacy: 3,
    ba: 3,
    clean: true,
    missing: [],
    extra: [],
  });
  expect(aspectOf(report, "members")).toMatchObject({
    legacy: 6,
    ba: 6,
    clean: true,
  });
  expect(aspectOf(report, "teams")).toMatchObject({
    legacy: 2,
    ba: 2,
    clean: true,
  });
  expect(aspectOf(report, "team-bindings")).toMatchObject({
    legacy: 2,
    ba: 2,
    clean: true,
  });
  expect(aspectOf(report, "team-members")).toMatchObject({
    legacy: 3,
    ba: 3,
    clean: true,
  });
  // 角色: tenant_admin→owner, member→member, auditor→auditor.
  expect(aspectOf(report, "roles").clean).toBe(true);
  // 版本: every expected clock exists and equals its import command's change
  // keys (company 6 + team 3), no tombstones on live members.
  expect(aspectOf(report, "versions")).toMatchObject({
    legacy: 9,
    ba: 9,
    clean: true,
  });
  expect(aspectOf(report, "receipts")).toMatchObject({
    legacy: 3,
    ba: 3,
    clean: true,
  });
  expect(aspectOf(report, "foreign-keys").clean).toBe(true);
  // payer: every imported company kept its billing binding and the external
  // customer it points at.
  expect(aspectOf(report, "payer")).toMatchObject({
    legacy: 3,
    ba: 3,
    clean: true,
  });
  // owner: every organization carried its tenant_admin across as an owner.
  expect(aspectOf(report, "owner")).toMatchObject({
    legacy: 3,
    ba: 3,
    clean: true,
  });
  // 外部归属: no SSO provider is bound to an organization.
  expect(aspectOf(report, "external-attribution").clean).toBe(true);
  // Every fixture tenant reconciled whole.
  expect(report.reconciliation?.tenants).toEqual(
    FIXTURE_TENANTS.map((tenantId) => ({
      tenantId,
      outcome: "reconciled",
    })),
  );
  // The M0 inventory provenance is carried (digest + writer scan verdict).
  expect(report.inventory?.digest).toMatch(/^[0-9a-f]{64}$/);
  // 授权来源 (§5.3): the dispositions are recorded per item — the verified
  // principal/generation source is carried, the missing one is recorded as
  // requiring re-authorization. Report-only: M3 writes nothing to the old
  // tables and the revocation belongs to T08.02/T08.03.
  const grants = new Map(
    (report.authorizationSources?.personalGrants ?? []).map((grant) => [
      grant.grantId,
      grant.disposition,
    ]),
  );
  expect(grants.get(FIXTURE.grants.verified)).toBe("verified-principal");
  expect(grants.get(FIXTURE.grants.unattributed)).toBe(
    "re-authorization-required",
  );
  const keys = new Map(
    (report.authorizationSources?.gatewayKeys ?? []).map((key) => [
      key.keyId,
      key.disposition,
    ]),
  );
  expect(keys.get(FIXTURE.keys.verified)).toBe("verified-generation");
  expect(keys.get(FIXTURE.keys.missingGeneration)).toBe(
    "re-authorization-required",
  );
  // The verified scope is switch-ready: zero blockers, canSwitch open.
  expect(report.blockers).toEqual([]);
  expect(report.canSwitch).toBe(true);

  // Unscoped (the production default — every tenant): a legacy tenant that
  // appeared after the backfill window (directory writes are paused, so
  // nothing could have imported it) is reported as not-backfilled, and the
  // same tool keeps canSwitch closed instead of vouching for a directory it
  // did not verify. The late tenant makes the honesty deterministic — the
  // shared baseline tenants' own outcomes are whatever the M0 inventory
  // honestly says about them, not this suite's fixture.
  await sql`
    INSERT INTO enterprise_tenants (id, name, created_at)
    VALUES ('t0215-tenant-late', 'T0215 Late Arrival', now())`;
  try {
    const unscoped = await runVerify();
    expect(unscoped.scope.mode).toBe("all-tenants");
    expect(unscoped.canSwitch).toBe(false);
    expect(
      unscoped.blockers.find(
        (blocker) =>
          blocker.kind === "tenant-not-backfilled" &&
          blocker.subject === "t0215-tenant-late",
      ),
    ).toBeDefined();
    for (const blocker of unscoped.blockers) {
      if (blocker.kind === "tenant-not-backfilled") {
        expect(blocker.subject).not.toBe(FIXTURE.tenants.clean);
        expect(blocker.subject).not.toBe(FIXTURE.tenants.collide);
        expect(blocker.subject).not.toBe(FIXTURE.tenants.empty);
      }
    }
  } finally {
    await sql`DELETE FROM enterprise_tenants WHERE id = 't0215-tenant-late'`;
  }
}, 240_000);

test("missing_clock_or_new_schema_mapping_blocks_m3", async () => {
  const { sql } = currentHarness();
  // Precondition: the backfilled fixture scope is switch-ready.
  const clean = await runVerify(FIXTURE_TENANTS);
  expect(clean.canSwitch).toBe(true);

  // (a) A deleted eligibility clock: the persistent version of a backfilled
  // member is gone, so the M3→M4 switch must not be vouched for.
  const clock = await sql`
    SELECT epoch, generation, tombstone, last_command_id, created_at
      FROM auth_eligibility_clocks
     WHERE tenant_id = ${FIXTURE.tenants.clean}
       AND principal_id = ${FIXTURE.principals.owner}
       AND kind = 'company'`;
  expect(clock.length).toBe(1);
  await sql`
    DELETE FROM auth_eligibility_clocks
     WHERE tenant_id = ${FIXTURE.tenants.clean}
       AND principal_id = ${FIXTURE.principals.owner}
       AND kind = 'company'`;
  try {
    const missing = await runVerify(FIXTURE_TENANTS);
    expect(missing.canSwitch).toBe(false);
    const clockBlocker = missing.blockers.find(
      (blocker) => blocker.kind === "eligibility-clock-missing",
    );
    expect(clockBlocker).toBeDefined();
    expect(clockBlocker?.subject).toContain(FIXTURE.tenants.clean);
    expect(clockBlocker?.subject).toContain(FIXTURE.principals.owner);
  } finally {
    const row = clock[0] as {
      epoch: string | number;
      generation: string | number;
      tombstone: boolean;
      last_command_id: string;
      created_at: string;
    };
    await sql`
      INSERT INTO auth_eligibility_clocks
        (tenant_id, principal_id, kind, scope_id, epoch, generation,
         tombstone, last_command_id, created_at)
      VALUES (${FIXTURE.tenants.clean}, ${FIXTURE.principals.owner}, 'company',
              ${FIXTURE.tenants.clean}, ${row.epoch}, ${row.generation},
              ${row.tombstone}, ${row.last_command_id}, ${row.created_at})`;
  }

  // (b) A public.auth_* table outside the mapping manifest: schema the
  // reconciliation does not know blocks M3 — 新增 schema 必须先扩充映射
  // manifest, never a silent pass.
  await sql.unsafe(
    `CREATE TABLE "auth_t0215_future_widget" (id text PRIMARY KEY NOT NULL)`,
  );
  try {
    const unmapped = await runVerify(FIXTURE_TENANTS);
    expect(unmapped.canSwitch).toBe(false);
    expect(unmapped.schema.unmappedTables).toEqual([
      "auth_t0215_future_widget",
    ]);
    expect(
      unmapped.blockers.find(
        (blocker) =>
          blocker.kind === "schema-outside-mapping-manifest" &&
          blocker.subject === "auth_t0215_future_widget",
      ),
    ).toBeDefined();
  } finally {
    await sql.unsafe(`DROP TABLE IF EXISTS "auth_t0215_future_widget"`);
  }

  // The restore is proven: the same scope is switch-ready again.
  const restored = await runVerify(FIXTURE_TENANTS);
  expect(restored.canSwitch).toBe(true);
}, 240_000);

test("reconciliation_reports_set_key_role_and_version_drift", async () => {
  const { sql } = currentHarness();

  // (a) A deleted member: the set/key drift the tool exists to catch. The
  // guards are disabled only to simulate the drifted DML a racing writer
  // would have had to bypass anyway.
  const member = await sql`
    SELECT id, organization_id, user_id, role, created_at
      FROM auth_members
     WHERE organization_id = ${FIXTURE.tenants.clean}
       AND user_id = ${FIXTURE.users.owner}`;
  expect(member.length).toBe(1);
  await withGuardsDisabled(
    sql,
    [
      ["auth_members", "auth_directory_dml_guard"],
      ["auth_members", "auth_member_orphan_fence"],
    ],
    async () => {
      await sql`
        DELETE FROM auth_members WHERE id = ${String(member[0]!.id)}`;
    },
  );
  try {
    const drift = await runVerify(FIXTURE_TENANTS);
    expect(drift.canSwitch).toBe(false);
    const members = drift.reconciliation?.aspects.find(
      (aspect) => aspect.aspect === "members",
    );
    expect(members?.missing.join(" ")).toContain(FIXTURE.tenants.clean);
    expect(members?.missing.join(" ")).toContain(FIXTURE.users.owner);
    expect(
      drift.blockers.find(
        (blocker) =>
          blocker.kind === "reconciliation-mismatch" &&
          blocker.subject === "members",
      ),
    ).toBeDefined();
  } finally {
    const row = member[0] as {
      id: string;
      organization_id: string;
      user_id: string;
      role: string;
      created_at: string;
    };
    await withGuardsDisabled(
      sql,
      [
        ["auth_members", "auth_directory_dml_guard"],
        ["auth_members", "auth_member_orphan_fence"],
      ],
      async () => {
        await sql`
          INSERT INTO auth_members (id, organization_id, user_id, role, created_at)
          VALUES (${row.id}, ${row.organization_id}, ${row.user_id}, ${row.role}, ${row.created_at})`;
      },
    );
  }

  // (b) A rewritten role: tenant_admin must reconcile as owner.
  await withGuardsDisabled(
    sql,
    [["auth_members", "auth_directory_dml_guard"]],
    async () => {
      await sql`
        UPDATE auth_members SET role = 'member'
         WHERE organization_id = ${FIXTURE.tenants.clean}
           AND user_id = ${FIXTURE.users.owner}`;
    },
  );
  try {
    const drift = await runVerify(FIXTURE_TENANTS);
    expect(drift.canSwitch).toBe(false);
    expect(
      drift.blockers.find(
        (blocker) =>
          blocker.kind === "reconciliation-mismatch" &&
          blocker.subject === "roles",
      ),
    ).toBeDefined();
  } finally {
    await withGuardsDisabled(
      sql,
      [["auth_members", "auth_directory_dml_guard"]],
      async () => {
        await sql`
          UPDATE auth_members SET role = 'owner'
           WHERE organization_id = ${FIXTURE.tenants.clean}
             AND user_id = ${FIXTURE.users.owner}`;
      },
    );
  }

  // (c) A ghost organization: an auth_organizations row no migration
  // receipt stands behind. The racing writer claims a late tenant's id — a
  // legacy tenant that appeared after the paused backfill window, so the
  // tenant FK is satisfied and nothing legitimate imported it.
  await sql`
    INSERT INTO enterprise_tenants (id, name, created_at)
    VALUES ('t0215-tenant-late2', 'T0215 Late Ghost', now())`;
  const ghostTenant = "t0215-tenant-late2";
  await withGuardsDisabled(
    sql,
    [["auth_organizations", "auth_directory_dml_guard"]],
    async () => {
      await sql`
        INSERT INTO auth_organizations (id, name, slug)
        VALUES (${ghostTenant}, 'Ghost', ${`t0215-ghost-${ghostTenant}`})`;
    },
  );
  try {
    const drift = await runVerify(FIXTURE_TENANTS);
    expect(drift.canSwitch).toBe(false);
    expect(
      drift.reconciliation?.aspects
        .find((aspect) => aspect.aspect === "organizations")
        ?.mismatched.join(" "),
    ).toContain(`${ghostTenant}:no-receipt`);
  } finally {
    await withGuardsDisabled(
      sql,
      [["auth_organizations", "auth_directory_dml_guard"]],
      async () => {
        await sql`DELETE FROM auth_organizations WHERE id = ${ghostTenant}`;
      },
    );
    await sql`DELETE FROM enterprise_tenants WHERE id = 't0215-tenant-late2'`;
  }

  // (d) A bumped clock epoch: the clock no longer matches its import
  // command's change keys.
  await sql`
    UPDATE auth_eligibility_clocks SET epoch = epoch + 5
     WHERE tenant_id = ${FIXTURE.tenants.clean}
       AND principal_id = ${FIXTURE.principals.owner}
       AND kind = 'company'`;
  try {
    const drift = await runVerify(FIXTURE_TENANTS);
    expect(drift.canSwitch).toBe(false);
    expect(
      drift.blockers.find(
        (blocker) =>
          blocker.kind === "reconciliation-mismatch" &&
          blocker.subject === "versions",
      ),
    ).toBeDefined();
  } finally {
    await sql`
      UPDATE auth_eligibility_clocks SET epoch = epoch - 5
       WHERE tenant_id = ${FIXTURE.tenants.clean}
         AND principal_id = ${FIXTURE.principals.owner}
         AND kind = 'company'`;
  }

  // (e) A deleted payer binding: the historical payer must survive the
  // migration untouched.
  await sql`
    DELETE FROM billing_customer_mappings
     WHERE tenant_id = ${FIXTURE.tenants.clean}`;
  try {
    const drift = await runVerify(FIXTURE_TENANTS);
    expect(drift.canSwitch).toBe(false);
    expect(
      drift.blockers.find(
        (blocker) =>
          blocker.kind === "payer-binding-missing" &&
          blocker.subject === FIXTURE.tenants.clean,
      ),
    ).toBeDefined();
  } finally {
    await sql`
      INSERT INTO billing_customer_mappings (tenant_id, external_customer_id)
      VALUES (${FIXTURE.tenants.clean}, ${`t0215-billing-${FIXTURE.tenants.clean}`})`;
  }

  // (f) An SSO provider bound to an organization after the M2 gate: the
  // external-attribution precondition no longer holds.
  await sql`
    INSERT INTO sso_providers (id, issuer, provider_id, organization_id, domain)
    VALUES ('t0215-sso', 'https://t0215-idp.example.test', 't0215-idp',
            ${FIXTURE.tenants.clean}, 't0215.example.test')`;
  try {
    const drift = await runVerify(FIXTURE_TENANTS);
    expect(drift.canSwitch).toBe(false);
    expect(
      drift.blockers.find(
        (blocker) =>
          blocker.kind === "sso-provider-organization" &&
          blocker.subject === FIXTURE.tenants.clean,
      ),
    ).toBeDefined();
  } finally {
    await sql`DELETE FROM sso_providers WHERE id = 't0215-sso'`;
  }

  // Every drift was undone: the scope is switch-ready again.
  const restored = await runVerify(FIXTURE_TENANTS);
  expect(restored.canSwitch).toBe(true);
  expect(restored.blockers).toEqual([]);
}, 300_000);

test("verify_authority_matrix_covers_legacy_paused_and_ba", async () => {
  const { sql, inTransaction } = currentHarness();
  const observed: string[] = [];
  // The authority matrix, extended by this task with the M0–M3 migration
  // states: the SAME inputs asserted under every real persisted state the
  // tools sit between — the legacy/ba writers' requireWrite at the
  // scenario's version (旧请求与新 gate 相同输入), then the tool itself.
  await withAuthorityMatrix(
    {
      setAuthorityState: async (state) => {
        await sql`
          UPDATE auth_authority_states
             SET authority_version = ${state.authorityVersion},
                 phase = ${state.phase},
                 directory_authority = ${state.directoryAuthority},
                 multi_tenant_released = ${state.multiTenantReleased}
           WHERE id = 1`;
      },
      inDirectoryTransaction: (work) => inTransaction(work),
    },
    async ({ authority, state, scenario, tx }) => {
      observed.push(`${scenario.name}@${state.phase}`);
      const answer = async (writer: "legacy" | "ba"): Promise<number> => {
        try {
          await authority.requireWrite(tx, state.authorityVersion, writer);
          return 200;
        } catch (error) {
          if (isAuthorityRefusal(error)) return error.status;
          throw error;
        }
      };
      const legacy = await answer("legacy");
      const ba = await answer("ba");
      if (scenario.expectedWriter === "legacy") {
        expect(legacy, `${scenario.name}@${state.phase} keeps legacy`).toBe(
          200,
        );
        expect(ba).toBe(503);
      } else if (scenario.expectedWriter === null) {
        expect(legacy).toBe(503);
        expect(ba).toBe(503);
      } else {
        expect(ba).toBe(200);
        expect(legacy).toBe(503);
      }
      // The tool under the same persisted state (its own connection reads
      // the committed scenario row).
      const report = await runVerify(FIXTURE_TENANTS);
      expect(report.authority.before?.phase).toBe(state.phase);
      expect(report.authority.before?.directoryAuthority).toBe(
        scenario.directoryAuthority,
      );
      if (scenario.directoryAuthority === "paused") {
        // M2 AND M3 are both the verify window: the reconciled scope is
        // switch-ready under either phase.
        expect(
          report.canSwitch,
          `paused@${state.phase} serves the M3 window`,
        ).toBe(true);
        expect(report.blockers).toEqual([]);
      } else if (scenario.directoryAuthority === "legacy") {
        // The M3 readout refuses to vouch for a directory whose writes were
        // never paused — the backfill has not happened.
        expect(report.canSwitch).toBe(false);
        expect(
          report.blockers.some(
            (blocker) => blocker.kind === "authority-not-paused",
          ),
        ).toBe(true);
      } else {
        // Already switched: the reconciliation of a pre-switch state is
        // refused, and the tool never performs or undoes the switch.
        expect(report.canSwitch).toBe(false);
        expect(
          report.blockers.some(
            (blocker) => blocker.kind === "authority-already-switched",
          ),
        ).toBe(true);
      }
      // The tool performs no authority DML under any scenario.
      expect(report.authority.unchanged).toBe(true);
    },
    MIGRATION_STATE_SCENARIOS,
  );
  // No scenario silently skipped: the matrix covered M0–M3 plus the M4 the
  // tools must refuse to perform, across all three authority modes.
  expect(observed).toEqual([
    "legacy@M0",
    "legacy@M1",
    "paused@M2",
    "paused@M3",
    "ba@M4",
  ]);
  // The matrix leaves the row at its last scenario (ba); restore the
  // post-backfill state the later tests sit on.
  await sql`
    UPDATE auth_authority_states
       SET authority_version = 1, phase = 'M2', directory_authority = 'paused',
           multi_tenant_released = false
     WHERE id = 1`;
}, 300_000);

test("m3_verify_is_read_only_with_stable_digest_and_entry_contract", async () => {
  const { sql } = currentHarness();
  const before = await snapshotDatabase(sql);
  const first = await runVerify(FIXTURE_TENANTS);
  const second = await runVerify(FIXTURE_TENANTS);
  const after = await snapshotDatabase(sql);
  expect(after).toEqual(before);
  expect(first.schemaVersion).toBe(1);
  expect(first.phase).toBe("M3");
  expect(first.scope).toEqual({
    mode: "selected",
    tenants: [...FIXTURE_TENANTS],
  });
  expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
  // The entry contract (interfaces §1): stable output shape, the digest
  // excluding generatedAt and identical across runs of the same directory.
  expect(second).toEqual({ ...first, generatedAt: second.generatedAt });
  expect(second.digest).toBe(first.digest);
  expect(first.target.endpoint).toMatch(/^127\.0\.0\.1:\d+$/);
  expect(first.target.database).toBeTruthy();
}, 240_000);

test("verify_cli_contract_is_explicit_and_read_only", async () => {
  const verify = await loadVerify();
  const url = readBaUrls();
  // No URL: refused — the target is explicit, never inherited, and the
  // refusal never echoes the DSN.
  const missingUrl = verify.parseVerifyDirectoryArgs([]);
  expect(missingUrl.ok).toBe(false);
  if (!missingUrl.ok) {
    expect(missingUrl.refusal).toContain("url");
    expect(missingUrl.refusal).not.toContain(url);
  }
  // URL alone: the all-tenants M3 verification by default.
  const all = verify.parseVerifyDirectoryArgs(["--url", url]);
  expect(all.ok).toBe(true);
  if (all.ok) {
    expect(all.plan.phase).toBe("M3");
    expect(all.plan.mode).toBe("verify");
    expect(all.plan.tenants).toEqual([]);
  }
  // --tenant scopes the reconciliation; repeatable.
  const scoped = verify.parseVerifyDirectoryArgs([
    "--url",
    url,
    "--tenant",
    FIXTURE.tenants.clean,
    "--tenant",
    FIXTURE.tenants.collide,
  ]);
  expect(scoped.ok).toBe(true);
  if (scoped.ok) {
    expect(scoped.plan.tenants).toEqual([
      FIXTURE.tenants.clean,
      FIXTURE.tenants.collide,
    ]);
  }
  // --tenant requires a value.
  const tenantValue = verify.parseVerifyDirectoryArgs([
    "--url",
    url,
    "--tenant",
  ]);
  expect(tenantValue.ok).toBe(false);
  // The phases owned by other tools are refused by name: M0 is the
  // inventory, M1/M2 the migrate-directory tool.
  for (const phase of ["M0", "M1", "M2"]) {
    const other = verify.parseVerifyDirectoryArgs([
      "--url",
      url,
      "--phase",
      phase,
    ]);
    expect(other.ok, `phase ${phase} must be refused`).toBe(false);
    if (!other.ok) {
      expect(other.refusal).toContain("verify-directory");
      expect(other.refusal).toContain(phase);
    }
  }
  // M4 and later are the cutover's phases: this tool never switches M4, so
  // asking it to verify them is refused outright.
  for (const phase of ["M4", "M5", "M7"]) {
    const cutover = verify.parseVerifyDirectoryArgs([
      "--url",
      url,
      "--phase",
      phase,
    ]);
    expect(cutover.ok, `phase ${phase} must be refused`).toBe(false);
    if (!cutover.ok) {
      expect(cutover.refusal).toContain("M4");
    }
  }
  // M3 is accepted explicitly (the default phase).
  const explicit = verify.parseVerifyDirectoryArgs([
    "--url",
    url,
    "--phase",
    "M3",
  ]);
  expect(explicit.ok).toBe(true);
  // The M3 verification is read-only: there is no apply, and no writer URL
  // is ever used.
  const apply = verify.parseVerifyDirectoryArgs(["--url", url, "--apply"]);
  expect(apply.ok).toBe(false);
  if (!apply.ok) {
    expect(apply.refusal).toContain("read-only");
  }
  const writer = verify.parseVerifyDirectoryArgs([
    "--url",
    url,
    "--writer-url",
    writerUrl(),
  ]);
  expect(writer.ok).toBe(false);
  if (!writer.ok) {
    expect(writer.refusal).toContain("writer");
  }
  // Unknown arguments are refused.
  const unknown = verify.parseVerifyDirectoryArgs(["--url", url, "--nonsense"]);
  expect(unknown.ok).toBe(false);
}, 120_000);
