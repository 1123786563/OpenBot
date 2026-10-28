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
  AUTHORITY_TRANSITION_REFUSED,
  AUTHORITY_VERSION_CONFLICT,
  createDirectoryAuthority,
  createDirectoryMigrationAuthority,
  DIRECTORY_MIGRATION_PAUSED,
  isAuthorityRefusal,
} from "../../src/auth/directory/authority";
import type { DirectoryTx } from "../../src/auth/directory/contracts";
import { createDatabase } from "../../src/db/client";
import { withAuthorityMatrix } from "./support/authority-matrix";

/*
 * T02.14 (#536, the M1 expand + M2 stop-write backfill slice of the original
 * task P25) — the migrate-directory tool, checked against the real expand
 * stack on the isolated BA_TEST_* island database (interfaces §1/§2/§3.3,
 * design §13.2, root Spec "M1 expand 只读展开、M2 停写回填、authority 与
 * release 分开").
 *
 * What this file pins, and why each part is a database fact rather than a
 * code convention:
 *
 * - `m1_verify_is_read_only_and_pins_the_expand_state`: the M1 phase writes
 *   nothing (a full before/after row dump of every in-scope table is
 *   byte-identical) and pins the expand stack the M2 backfill depends on —
 *   the BA tables, the six DML-guard triggers, the four deferred fences, the
 *   controlled functions, the AuthorityState row seeded at (M1, legacy), and
 *   the legacy writer's still-intact enterprise DML (M1 keeps it; M4
 *   collects it).
 * - `paused_authority_rejects_all_directory_writers` (Brief-named): the M2
 *   apply drives the real stop-write CAS (M1/legacy → M2/paused,
 *   authorityVersion+1) and then every directory-writer entry through the
 *   authority write gate — legacy and ba alike — refuses 503
 *   DIRECTORY_MIGRATION_PAUSED; a stale expected version refuses 503
 *   AUTHORITY_VERSION_CONFLICT before the branch; reads still work.
 * - `repeated_backfill_preserves_ids_and_versions` (Brief-named): a re-run
 *   replays every committed tenant (stable command id + tenant-keyed
 *   idempotency key), so the full BA row set — organizations, teams,
 *   bindings, members, team members, clocks, receipts, change keys — is
 *   byte-identical, and the legacy tables (memberships, payer mappings,
 *   grants, keys) stay byte-identical to before the first apply: the
 *   backfill imports the legacy directory, it never rewrites it.
 * - `legacy_tenants_receive_deterministic_unique_slugs` (Brief-named): each
 *   backfilled tenant gets the interfaces §2 slug — normalized name, the
 *   tenant-<digest> fallback for a name that normalizes empty, the
 *   deterministic -2 suffix in (created_at, tenant_id) order — and a replay
 *   derives nothing (the persisted tenant_id-keyed mapping wins). A BA
 *   unique-constraint violation — a second migration actor's org row holding
 *   the planned slug between plan and apply — blocks the run
 *   (backfillBlocked), rolls the tenant's transaction back, and never
 *   silently re-derives the slug.
 * - `blocked_preconditions_refuse_to_pause_or_import`: a non-empty
 *   sso_providers.organization_id blocks the whole backfill before the pause
 *   (the authority row stays M1/legacy); a user with two principals is an
 *   ambiguous mapping that blocks that user's tenants; a memberless tenant
 *   carries the inventory's unknown-owner/unknown-payer blockers — while the
 *   clean fixture tenants still import (per-tenant gating).
 * - `pause_transition_matrix_covers_legacy_paused_and_ba`: the migration
 *   pause seam under every authority matrix scenario — legacy (M1) pauses
 *   with a version+1 CAS; paused (M2) and ba (M4) refuse
 *   AUTHORITY_TRANSITION_REFUSED, never re-planning against a state the
 *   transition does not own.
 * - `migration_cli_contract_is_explicit_and_dry_run_by_default`: the CLI
 *   takes an explicit target URL (never an inherited TEST_DATABASE_URL),
 *   defaults to the read-only M1 verify, plans M2 as a dry-run, requires
 *   --apply together with the writer URL for the pause/backfill, refuses
 *   --apply on the read-only M1, and refuses the phases owned by other tools
 *   (M0: inventory.ts; M3+: verify-directory/cutover).
 *
 * Boundaries this suite deliberately does not claim (later slices own them):
 * the M3 reconciliation (T02.15's verify-directory), the M4 cutover and the
 * old-capability revocation DML (T08.01/T08.02 — the M2 report records the
 * per-grant/key disposition and writes nothing to access_grants or
 * gateway_virtual_keys), and the runtime wiring of the legacy routes' 503
 * (the writers' disposal phases; the authority gate this suite pins is the
 * enforcement point every writer entry consults). Real production targets are
 * not authorized in this slice.
 *
 * The island carries the enterprise baseline (30 tenants of shared fixture
 * data with their own inventory blockers), so every assertion is scoped to
 * this suite's `t0214-` fixture subjects; the baseline tenants' blocked
 * outcomes are the tool's honest report, not this suite's verdict. The five
 * BA_TEST_* URLs are all required (presence and same-instance shape); a
 * missing one is a blocked suite, never a silent fallback. No DSN is ever
 * printed — refusals name the variable.
 */

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
  "0221_better_auth_directory",
  "0222_better_auth_clocks",
  "0223_better_auth_command_authority",
  "0224_better_auth_authority_sources",
  "0225_better_auth_assurance",
  "0226_better_auth_schema_roles",
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
/** The controlled functions the stack installs, with signatures. */
const CONTROLLED_FUNCTIONS = [
  "auth_directory_begin_command(text,text,text,text,text,text,text,text,text)",
  "auth_directory_finalize_command(text)",
  "auth_command_append_outbox(text,text,text,text)",
  "auth_principals_register(text,text,text)",
  "auth_project_company_membership(text,text,text,text,integer,text)",
  "auth_advance_eligibility_clock(text,text,text,text,bigint,bigint,boolean,text)",
  "auth_read_eligibility_clocks(text,text)",
  "auth_read_session_assurances(text,text)",
  "auth_directory_dml_guard()",
  "auth_directory_commit_fence()",
  "auth_directory_guard_principal(text)",
] as const;
/** The guard/fence triggers, dropped by (table, name) at cleanup. */
const MIGRATION_TRIGGERS = [
  ["auth_members", "auth_directory_dml_guard"],
  ["auth_team_members", "auth_directory_dml_guard"],
  ["auth_team_bindings", "auth_directory_dml_guard"],
  ["auth_organizations", "auth_directory_dml_guard"],
  ["auth_teams", "auth_directory_dml_guard"],
  ["auth_invitations", "auth_directory_dml_guard"],
  ["auth_command_receipts", "auth_command_receipt_fence"],
  ["auth_command_change_keys", "auth_change_key_fence"],
  ["auth_team_members", "auth_team_member_orphan_fence"],
  ["auth_members", "auth_member_orphan_fence"],
] as const;

async function cleanupFixture(sql: postgres.Sql): Promise<void> {
  const triggerPairs = MIGRATION_TRIGGERS.map(
    ([table, trigger]) => `('${table}', '${trigger}')`,
  ).join(", ");
  const functions = CONTROLLED_FUNCTIONS.map(
    (signature) => `('${signature}')`,
  ).join(", ");
  const tables = BA_TABLES.map((name) => `('${name}')`).join(", ");
  await sql.unsafe(`
    DO $t0214_cleanup$
    DECLARE
      target record;
    BEGIN
      FOR target IN SELECT * FROM (VALUES ${triggerPairs}) AS triggers(table_name, trigger_name) LOOP
        IF to_regclass('public.' || target.table_name) IS NOT NULL THEN
          EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', target.trigger_name, target.table_name);
        END IF;
      END LOOP;
      FOR target IN SELECT * FROM (VALUES ${functions}) AS functions(signature) LOOP
        EXECUTE format('DROP FUNCTION IF EXISTS public.%s', target.signature);
      END LOOP;
      FOR target IN SELECT * FROM (VALUES ${tables}) AS tables(table_name) LOOP
        IF to_regclass('public.' || target.table_name) IS NOT NULL THEN
          EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator, ob_ent_auth_writer', target.table_name);
        END IF;
      END LOOP;
    END
    $t0214_cleanup$`);
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
      "enterprise_credential_actions",
      "enterprise_credential_action_generation_pair",
    ],
    [
      "billing_company_finance_grants",
      "billing_company_finance_grant_generation_pair",
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
  await sql`DELETE FROM sso_providers WHERE id LIKE 't0214-%'`;
  await sql`DELETE FROM gateway_virtual_keys WHERE id LIKE 't0214-%'`;
  await sql`DELETE FROM access_grants WHERE grant_id LIKE 't0214-%'`;
  await sql`DELETE FROM payer_accounts WHERE id LIKE 't0214-%' OR payer_id LIKE 't0214-%'`;
  await sql`DELETE FROM billing_customers WHERE external_id LIKE 't0214-%'`;
  await sql`DELETE FROM enterprise_tenants WHERE id LIKE 't0214-%'`;
  await sql`DELETE FROM enterprise_principals WHERE id LIKE 't0214-%'`;
  await sql`DELETE FROM bot_services WHERE bot_id LIKE 't0214-%'`;
  await sql`DELETE FROM users WHERE id LIKE 't0214-%'`;
}

/*
 * The fixture: three clean companies for the main flows — clean (owner,
 * member, auditor, one suspended member, one two-member team, payer binding),
 * collide (a younger tenant whose name normalizes to clean's slug), and
 * empty (a name that normalizes to nothing, for the digest fallback) — plus
 * one verified and one unattributed personal grant/key for the disposition
 * assertions. Every id carries the t0214- prefix so cleanup and the leak
 * probe stay surgical on the shared island.
 */
const FIXTURE = {
  users: {
    owner: "t0214-owner",
    member: "t0214-member",
    auditor: "t0214-auditor",
    suspended: "t0214-suspended",
  },
  tenants: {
    clean: "t0214-tenant-clean",
    collide: "t0214-tenant-collide",
    empty: "t0214-tenant-empty",
  },
  principals: {
    owner: "t0214-principal-owner",
    member: "t0214-principal-member",
    auditor: "t0214-principal-auditor",
    suspended: "t0214-principal-suspended",
  },
  workspaces: {
    clean: "t0214-ws-clean",
    collide: "t0214-ws-collide",
  },
  grants: {
    verified: "t0214-grant-verified",
    unattributed: "t0214-grant-unattributed",
  },
  keys: {
    verified: "t0214-key-verified",
    missingGeneration: "t0214-key-missing-generation",
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
      (${FIXTURE.users.owner}, 't0214-owner@example.test'),
      (${FIXTURE.users.member}, 't0214-member@example.test'),
      (${FIXTURE.users.auditor}, 't0214-auditor@example.test'),
      (${FIXTURE.users.suspended}, 't0214-suspended@example.test')`;
  // Explicit created_at values fix the §2 collision order deterministically:
  // clean is the oldest, so clean keeps the base slug and collide takes -2.
  await sql`
    INSERT INTO enterprise_tenants (id, name, created_at) VALUES
      (${FIXTURE.tenants.clean}, 'T0214 Clean Zqx Company', now() - interval '3 seconds'),
      (${FIXTURE.tenants.empty}, '  !!!  ', now() - interval '2 seconds'),
      (${FIXTURE.tenants.collide}, 't0214  CLEAN  zqx  COMPANY', now() - interval '1 second')`;
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
      (${FIXTURE.tenants.clean}, ${FIXTURE.workspaces.clean}, 'T0214 Clean Team'),
      (${FIXTURE.tenants.collide}, ${FIXTURE.workspaces.collide}, 'T0214 Collide Team')`;
  await sql`
    INSERT INTO enterprise_workspace_memberships (tenant_id, workspace_id, principal_id, status, epoch) VALUES
      (${FIXTURE.tenants.clean}, ${FIXTURE.workspaces.clean}, ${FIXTURE.principals.member}, 'active', 1),
      (${FIXTURE.tenants.clean}, ${FIXTURE.workspaces.clean}, ${FIXTURE.principals.auditor}, 'active', 1),
      (${FIXTURE.tenants.collide}, ${FIXTURE.workspaces.collide}, ${FIXTURE.principals.owner}, 'active', 1)`;
  for (const tenant of FIXTURE_TENANTS) {
    await sql`
      INSERT INTO billing_customers (external_id, name)
      VALUES (${`t0214-billing-${tenant}`}, ${`T0214 ${tenant}`})`;
    await sql`
      INSERT INTO billing_customer_mappings (tenant_id, external_customer_id)
      VALUES (${tenant}, ${`t0214-billing-${tenant}`})`;
  }
  await sql`
    INSERT INTO bot_services (bot_id, display_name, kind, capabilities) VALUES
      ('t0214-bot', 'T0214 Migration Bot', 'external', ARRAY['chat'])`;
  await sql`
    INSERT INTO access_grants (grant_id, user_id, principal_id, identity_generation, bot_id, external_identity, scope, status) VALUES
      (${FIXTURE.grants.verified}, ${FIXTURE.users.member}, ${FIXTURE.principals.member}, 1, 't0214-bot', 'openbot:t0214-member', 'model-access', 'active'),
      (${FIXTURE.grants.unattributed}, ${FIXTURE.users.auditor}, NULL, NULL, 't0214-bot', 'openbot:t0214-auditor', 'model-access', 'active')`;
  await sql`
    INSERT INTO gateway_virtual_keys (id, grant_id, bot_id, gateway_customer_id, gateway_virtual_key_id, value_hash, credential_version, source_identity_generation) VALUES
      (${FIXTURE.keys.verified}, ${FIXTURE.grants.verified}, 't0214-bot', 't0214-gateway-customer', 't0214-gateway-key-verified', ${`t0214-${"f".repeat(60)}`}, 1, 1),
      (${FIXTURE.keys.missingGeneration}, ${FIXTURE.grants.unattributed}, 't0214-bot', 't0214-gateway-customer', 't0214-gateway-key-missing', ${`t0214-${"e".repeat(60)}`}, 1, NULL)`;
}

/** Every table the tool reads or writes, dumped as ordered JSON row texts. */
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
  ["auth_provisioning_rules", "rule_id"],
];

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

/** The legacy half of the snapshot: the backfill's input, never its output. */
const LEGACY_SNAPSHOT_TABLES = new Set([
  "users",
  "enterprise_tenants",
  "enterprise_principals",
  "enterprise_memberships",
  "enterprise_workspaces",
  "enterprise_workspace_memberships",
  "billing_customers",
  "billing_customer_mappings",
  "payer_accounts",
  "bot_services",
  "access_grants",
  "gateway_virtual_keys",
  "sso_providers",
]);

function legacyHalf(dump: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(dump).filter(([table]) => LEGACY_SNAPSHOT_TABLES.has(table)),
  );
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
    max: 2,
    idle_timeout: 5,
    onnotice: () => {},
  });
  let db: Awaited<ReturnType<typeof createDatabase>> | undefined;
  try {
    await cleanupFixture(sql);
    for (const path of MIGRATION_PATHS) {
      if (!existsSync(path)) {
        throw new Error(
          `${path} does not exist: the migrate-directory tool sits on the verified T02.01–T02.06 stack, and a missing prerequisite is a workspace problem, not a target behavior.`,
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
/** The legacy rows before the first apply: the historical FK/payer baseline. */
let legacyBaseline: Record<string, string[]> | undefined;

async function resetHarness(): Promise<Harness> {
  if (harness) await harness.close();
  harness = await createHarness();
  return harness;
}

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
  // t0214- row on the shared island fails here instead of piling up.
  const sql = postgres(readBaUrls(), {
    max: 1,
    idle_timeout: 5,
    onnotice: () => {},
  });
  try {
    const leaked = await sql`
      SELECT 'users:' || id FROM users WHERE id LIKE 't0214-%'
      UNION ALL
      SELECT 'tenants:' || id FROM enterprise_tenants WHERE id LIKE 't0214-%'
      UNION ALL
      SELECT 'principals:' || id FROM enterprise_principals WHERE id LIKE 't0214-%'
      UNION ALL
      SELECT 'memberships:' || tenant_id FROM enterprise_memberships WHERE tenant_id LIKE 't0214-%'
      UNION ALL
      SELECT 'workspaces:' || tenant_id FROM enterprise_workspaces WHERE tenant_id LIKE 't0214-%'
      UNION ALL
      SELECT 'ws_memberships:' || tenant_id FROM enterprise_workspace_memberships WHERE tenant_id LIKE 't0214-%'
      UNION ALL
      SELECT 'billing_customers:' || external_id FROM billing_customers WHERE external_id LIKE 't0214-%'
      UNION ALL
      SELECT 'mappings:' || tenant_id FROM billing_customer_mappings WHERE tenant_id LIKE 't0214-%'
      UNION ALL
      SELECT 'payer_accounts:' || id FROM payer_accounts WHERE id LIKE 't0214-%' OR payer_id LIKE 't0214-%'
      UNION ALL
      SELECT 'bots:' || bot_id FROM bot_services WHERE bot_id LIKE 't0214-%'
      UNION ALL
      SELECT 'grants:' || grant_id FROM access_grants WHERE grant_id LIKE 't0214-%'
      UNION ALL
      SELECT 'keys:' || id FROM gateway_virtual_keys WHERE id LIKE 't0214-%'
      UNION ALL
      SELECT 'sso:' || id FROM sso_providers WHERE id LIKE 't0214-%'
      UNION ALL
      SELECT 'ba_table:' || table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY(${[...BA_TABLES]}::text[])`;
    expect(leaked).toEqual([]);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
});

/*
 * The T02.14 target module, loaded lazily so a worktree without it still
 * collects (and fails) every case with a message naming the missing target
 * behavior instead of dying at import time as a zero-case collection error.
 */
type MigrateModule =
  typeof import("../../scripts/better-auth/migrate-directory");
let migratePromise: Promise<MigrateModule> | undefined;
function loadMigrate(): Promise<MigrateModule> {
  migratePromise ??= import(
    "../../scripts/better-auth/migrate-directory"
  ).catch((error: unknown) => {
    throw new Error(
      `server/scripts/better-auth/migrate-directory.ts is not loadable — ${error instanceof Error ? error.message : String(error)}: the M1 expand verification and M2 stop-write backfill tool this suite pins is the T02.14 target behavior, not an environment problem.`,
    );
  });
  return migratePromise;
}

function outcomesOf(
  imports: ReadonlyArray<{ tenantId: string; outcome: string }>,
): Map<string, { tenantId: string; outcome: string }> {
  return new Map(imports.map((entry) => [entry.tenantId, entry]));
}

/** A second migration actor's org row, written through the real guarded path. */
async function insertRacingOrganization(
  harnessRef: Harness,
  input: { tenantId: string; slug: string },
): Promise<void> {
  const racingWriter = postgres(writerUrl(), {
    max: 1,
    idle_timeout: 5,
    onnotice: () => {},
  });
  try {
    await racingWriter.begin(async (tx) => {
      await tx`SELECT set_config('auth.current_command', public.auth_directory_begin_command(
        't0214-race-command', 'company', 'company.provision', ${input.tenantId}, null,
        null, 'migration', 't0214-race-key', 't0214-race-hash'), true)`;
      await tx`INSERT INTO auth_organizations (id, name, slug)
        VALUES (${input.tenantId}, 'T0214 Racing Organization', ${input.slug})`;
      await tx`SELECT public.auth_directory_finalize_command('t0214-race-command')`;
      await tx`SELECT set_config('auth.current_command', '', true)`;
      await tx.unsafe(
        "SET CONSTRAINTS auth_command_receipt_fence, auth_change_key_fence, auth_team_member_orphan_fence, auth_member_orphan_fence IMMEDIATE",
      );
    });
  } finally {
    await racingWriter.end({ timeout: 5 }).catch(() => {});
    void harnessRef;
  }
}

test("m1_verify_is_read_only_and_pins_the_expand_state", async () => {
  const fixture = currentHarness();
  const migrate = await loadMigrate();
  const before = await snapshotDatabase(fixture.sql);
  const report = await migrate.runMigrateDirectory({
    phase: "M1",
    url: readBaUrls(),
    repositoryRoot: REPO_ROOT,
  });
  const after = await snapshotDatabase(fixture.sql);
  // Read-only: the M1 verify leaves every in-scope table byte-identical.
  expect(after).toEqual(before);
  expect(report.phase).toBe("M1");
  expect(report.mode).toBe("verify");
  expect(report.target.expandedSchema).toBe(true);
  // The expand stack the M2 backfill depends on, pinned as counts.
  expect(report.expand).toEqual({
    baTables: 9,
    guardTriggers: 6,
    fenceTriggers: 4,
    controlledFunctions: 3,
    legacyWriterIntact: true,
  });
  // The AuthorityState the migrations seed: (M1, legacy, version 0) — the
  // pause transition's only origin.
  expect(report.authority.before).toEqual({
    authorityVersion: 0,
    phase: "M1",
    directoryAuthority: "legacy",
    multiTenantReleased: false,
  });
  expect(report.authority.paused).toBe(false);
  expect(report.blockers).toEqual([]);
  // M1 does not compute the M2 decisions.
  expect(report.canImport).toBe(null);
  expect(report.backfill).toBe(null);
}, 120_000);

test("paused_authority_rejects_all_directory_writers", async () => {
  const fixture = currentHarness();
  const migrate = await loadMigrate();
  // The historical baseline: the legacy rows before any backfill touched BA.
  legacyBaseline = legacyHalf(await snapshotDatabase(fixture.sql));
  const report = await migrate.runMigrateDirectory({
    phase: "M2",
    apply: true,
    url: readBaUrls(),
    writerUrl: writerUrl(),
    repositoryRoot: REPO_ROOT,
  });
  expect(report.mode).toBe("apply");
  // The real stop-write CAS: M1/legacy → M2/paused, authorityVersion 0 → 1.
  expect(report.authority.paused).toBe(true);
  expect(report.authority.after).toEqual({
    authorityVersion: 1,
    phase: "M2",
    directoryAuthority: "paused",
    multiTenantReleased: false,
  });
  // Every fixture tenant imported; no fixture tenant blocked.
  const outcomes = outcomesOf(report.backfill?.imports ?? []);
  for (const tenant of FIXTURE_TENANTS) {
    expect(outcomes.get(tenant)?.outcome).toBe("imported");
  }
  // 每入口: every directory-writer entry through the write gate — the legacy
  // writer and the BA writer alike — is a 503 DIRECTORY_MIGRATION_PAUSED
  // refusal under the state this tool produced.
  const authority = createDirectoryAuthority();
  for (const writer of ["legacy", "ba"] as const) {
    let refusal: unknown;
    await fixture.inTransaction(async (tx) => {
      try {
        await authority.requireWrite(tx, 1, writer);
      } catch (error) {
        refusal = error;
      }
    });
    expect(
      isAuthorityRefusal(refusal),
      `writer ${writer} must be refused by an AuthorityRefusal under paused`,
    ).toBe(true);
    if (isAuthorityRefusal(refusal)) {
      expect(refusal.status).toBe(503);
      expect(refusal.code).toBe(DIRECTORY_MIGRATION_PAUSED);
    }
  }
  // The CAS discipline: a stale expected version refuses 503 CONFLICT
  // before any branch decision, and reads still work under the pause.
  let stale: unknown;
  await fixture.inTransaction(async (tx) => {
    try {
      await authority.requireWrite(tx, 0, "legacy");
    } catch (error) {
      stale = error;
    }
  });
  expect(isAuthorityRefusal(stale)).toBe(true);
  if (isAuthorityRefusal(stale)) {
    expect(stale.status).toBe(503);
    expect(stale.code).toBe(AUTHORITY_VERSION_CONFLICT);
  }
  let readState: unknown;
  await fixture.inTransaction(async (tx) => {
    readState = await authority.read(tx);
  });
  expect(readState).toEqual({
    authorityVersion: 1,
    phase: "M2",
    directoryAuthority: "paused",
    multiTenantReleased: false,
  });
}, 180_000);

test("repeated_backfill_preserves_ids_and_versions", async () => {
  const fixture = currentHarness();
  const migrate = await loadMigrate();
  const first = await snapshotDatabase(fixture.sql);
  const secondRun = await migrate.runMigrateDirectory({
    phase: "M2",
    apply: true,
    url: readBaUrls(),
    writerUrl: writerUrl(),
    repositoryRoot: REPO_ROOT,
  });
  const second = await snapshotDatabase(fixture.sql);
  // The replay changes nothing: same ids, same versions, no new receipts,
  // no new clocks — the whole BA row set is byte-identical.
  expect(second).toEqual(first);
  expect(secondRun.authority.paused).toBe(false);
  const outcomes = outcomesOf(secondRun.backfill?.imports ?? []);
  for (const tenant of FIXTURE_TENANTS) {
    expect(outcomes.get(tenant)?.outcome).toBe("replayed");
  }
  // The legacy directory — memberships, payer mappings, grants, keys — is
  // byte-identical to before the first apply: the backfill never rewrites
  // its own input (历史 FK/payer 保留).
  expect(legacyHalf(second)).toEqual(legacyBaseline);
  // Old capabilities: the verified source is carried, the missing one is
  // recorded as requiring re-authorization — never stamped from active.
  const grants = new Map(
    secondRun.authorizationSources?.personalGrants.map((grant) => [
      grant.grantId,
      grant,
    ]) ?? [],
  );
  expect(grants.get(FIXTURE.grants.verified)?.disposition).toBe(
    "verified-principal",
  );
  expect(grants.get(FIXTURE.grants.unattributed)?.disposition).toBe(
    "re-authorization-required",
  );
  const keys = new Map(
    secondRun.authorizationSources?.gatewayKeys.map((key) => [
      key.keyId,
      key,
    ]) ?? [],
  );
  expect(keys.get(FIXTURE.keys.verified)?.disposition).toBe(
    "verified-generation",
  );
  expect(keys.get(FIXTURE.keys.missingGeneration)?.disposition).toBe(
    "re-authorization-required",
  );
}, 180_000);

test("legacy_tenants_receive_deterministic_unique_slugs", async () => {
  const fixture = currentHarness();
  const migrate = await loadMigrate();
  const readSlugs = async (): Promise<Map<string, string>> => {
    const rows = await fixture.sql`
      SELECT id, slug FROM auth_organizations WHERE id LIKE 't0214-%' ORDER BY id`;
    return new Map(rows.map((row) => [String(row.id), String(row.slug)]));
  };
  const first = await readSlugs();
  // Normalized name, deterministic -2 collision suffix in (created_at,
  // tenant_id) order, and the tenant-<digest> fallback for an empty name.
  expect(first.get(FIXTURE.tenants.clean)).toBe("t0214-clean-zqx-company");
  expect(first.get(FIXTURE.tenants.collide)).toBe("t0214-clean-zqx-company-2");
  expect(first.get(FIXTURE.tenants.empty)).toMatch(/^tenant-[0-9a-f]{12}$/);
  // 幂等: a replay derives nothing — the persisted tenant_id-keyed mapping
  // wins, so the recheck is exactly the first run's slugs.
  await migrate.runMigrateDirectory({
    phase: "M2",
    apply: true,
    url: readBaUrls(),
    writerUrl: writerUrl(),
    repositoryRoot: REPO_ROOT,
  });
  expect(await readSlugs()).toEqual(first);
  // 唯一约束违例 blocks: a second migration actor claims the base slug
  // between this run's plan and its apply. The import of the tenant planned
  // for that slug hits the BA unique constraint, rolls back, blocks the run,
  // and never silently re-derives the slug (interfaces §2 uniqueConflict).
  await resetHarness();
  const plan = await migrate.planM2Backfill({
    url: readBaUrls(),
    repositoryRoot: REPO_ROOT,
  });
  expect(plan.imports.length).toBeGreaterThan(0);
  await insertRacingOrganization(currentHarness(), {
    tenantId: FIXTURE.tenants.collide,
    slug: "t0214-clean-zqx-company",
  });
  const applied = await migrate.applyM2Backfill({
    plan,
    url: readBaUrls(),
    writerUrl: writerUrl(),
  });
  expect(applied.backfillBlocked).toBe(true);
  const blocked = applied.imports.find(
    (entry) => entry.tenantId === FIXTURE.tenants.clean,
  );
  expect(blocked?.outcome).toBe("blocked");
  expect(blocked?.blockers[0]?.kind).toBe("slug-unique-conflict");
  // The blocked tenant's transaction rolled back: no organization row and no
  // receipt was committed for it.
  const orgRows = await currentHarness().sql`
    SELECT id FROM auth_organizations WHERE id = ${FIXTURE.tenants.clean}`;
  expect(orgRows.length).toBe(0);
  const receiptRows = await currentHarness().sql`
    SELECT command_id FROM auth_command_receipts
     WHERE tenant_id = ${FIXTURE.tenants.clean}`;
  expect(receiptRows.length).toBe(0);
}, 180_000);

test("blocked_preconditions_refuse_to_pause_or_import", async () => {
  await resetHarness();
  const fixture = currentHarness();
  const migrate = await loadMigrate();
  const apply = () =>
    migrate.runMigrateDirectory({
      phase: "M2",
      apply: true,
      url: readBaUrls(),
      writerUrl: writerUrl(),
      repositoryRoot: REPO_ROOT,
    });
  // (a) A non-empty sso_providers.organization_id blocks the whole backfill
  // BEFORE the pause: the authority row stays (M1, legacy).
  await fixture.sql`
    INSERT INTO sso_providers (id, issuer, provider_id, organization_id, domain)
    VALUES ('t0214-sso', 'https://t0214-idp.example.test', 't0214-idp',
            ${FIXTURE.tenants.clean}, 't0214.example.test')`;
  let report = await apply();
  expect(report.authority.paused).toBe(false);
  expect(report.authority.after?.phase).toBe("M1");
  expect(report.backfill?.backfillBlocked).toBe(true);
  expect(
    report.blockers.some(
      (blocker) =>
        blocker.kind === "sso-provider-organization" &&
        blocker.subject === FIXTURE.tenants.clean,
    ),
  ).toBe(true);
  expect(report.backfill?.imports).toEqual([]);
  await fixture.sql`DELETE FROM sso_providers WHERE id = 't0214-sso'`;
  // (b) A user with two principals is an ambiguous mapping: the pause still
  // happens (it is not a global blocker), but every tenant the user belongs
  // to is blocked, never imported against a guessed principal. The one
  // principal per user invariant is normally a unique index (0055); dropping
  // it simulates the drifted database the tool's defense exists for.
  await fixture.sql`DROP INDEX enterprise_principal_user`;
  await fixture.sql`
    INSERT INTO enterprise_principals (id, user_id, status, identity_generation)
    VALUES ('t0214-principal-owner-2', ${FIXTURE.users.owner}, 'active', 1)`;
  try {
    report = await apply();
    expect(report.authority.paused).toBe(true);
    const outcomes = outcomesOf(report.backfill?.imports ?? []);
    for (const tenant of FIXTURE_TENANTS) {
      const entry = outcomes.get(tenant);
      expect(entry?.outcome).toBe("blocked");
      expect(
        entry?.blockers.some(
          (blocker) => blocker.kind === "ambiguous-principal-mapping",
        ),
      ).toBe(true);
    }
  } finally {
    await fixture.sql`DELETE FROM enterprise_principals WHERE id = 't0214-principal-owner-2'`;
    await fixture.sql`CREATE UNIQUE INDEX IF NOT EXISTS enterprise_principal_user ON enterprise_principals (user_id)`;
  }
  // (c) A memberless tenant carries the inventory's unknown-owner and
  // unknown-payer blockers — per tenant: the clean fixture tenants still
  // import in the same run.
  await fixture.sql`
    INSERT INTO enterprise_tenants (id, name, created_at)
    VALUES ('t0214-tenant-noowner', 'T0214 No Owner', now() - interval '4 seconds')`;
  report = await apply();
  const outcomes = outcomesOf(report.backfill?.imports ?? []);
  const noowner = outcomes.get("t0214-tenant-noowner");
  expect(noowner?.outcome).toBe("blocked");
  expect(
    noowner?.blockers.some((blocker) => blocker.kind === "unknown-owner"),
  ).toBe(true);
  expect(
    noowner?.blockers.some((blocker) => blocker.kind === "unknown-payer"),
  ).toBe(true);
  for (const tenant of FIXTURE_TENANTS) {
    expect(outcomes.get(tenant)?.outcome).toBe("imported");
  }
  await fixture.sql`DELETE FROM enterprise_tenants WHERE id = 't0214-tenant-noowner'`;
}, 180_000);

test("pause_transition_matrix_covers_legacy_paused_and_ba", async () => {
  const fixture = currentHarness();
  const migrationAuthority = createDirectoryMigrationAuthority();
  const observed: string[] = [];
  // The authority matrix (T02.10's support fixture): the SAME pause seam
  // asserted under every real persisted migration state, not against a stub.
  await withAuthorityMatrix(
    {
      setAuthorityState: async (state) => {
        await fixture.sql`
          UPDATE auth_authority_states
             SET authority_version = ${state.authorityVersion},
                 phase = ${state.phase},
                 directory_authority = ${state.directoryAuthority},
                 multi_tenant_released = ${state.multiTenantReleased}
           WHERE id = 1`;
      },
      inDirectoryTransaction: (work) => fixture.inTransaction(work),
    },
    async ({ tx, state, scenario }) => {
      observed.push(scenario.name);
      if (scenario.name === "legacy") {
        // The only origin the transition owns: (M1, legacy, v) →
        // (M2, paused, v+1), release flag untouched.
        const next = await migrationAuthority.pauseForBackfill(
          tx,
          state.authorityVersion,
        );
        expect(next).toEqual({
          authorityVersion: state.authorityVersion + 1,
          phase: "M2",
          directoryAuthority: "paused",
          multiTenantReleased: state.multiTenantReleased,
        });
        return;
      }
      // paused (M2) and ba (M4) are not the transition's origin: a 503
      // AUTHORITY_TRANSITION_REFUSED, never a re-plan against a state the
      // pause does not own.
      let refusal: unknown;
      await fixture.inTransaction(async (tx) => {
        try {
          await migrationAuthority.pauseForBackfill(tx, state.authorityVersion);
        } catch (error) {
          refusal = error;
        }
      });
      expect(
        isAuthorityRefusal(refusal),
        `scenario ${scenario.name} must refuse the pause with an AuthorityRefusal`,
      ).toBe(true);
      if (isAuthorityRefusal(refusal)) {
        expect(refusal.status).toBe(503);
        expect(refusal.code).toBe(AUTHORITY_TRANSITION_REFUSED);
      }
    },
  );
  // No scenario silently skipped: the matrix covered all three branches.
  expect(observed).toEqual(["legacy", "paused", "ba"]);
}, 120_000);

test("migration_cli_contract_is_explicit_and_dry_run_by_default", async () => {
  const migrate = await loadMigrate();
  const url = readBaUrls();
  const writer = writerUrl();
  // No URL: refused — the target is explicit, never inherited, and the
  // refusal never echoes the DSN.
  const missingUrl = migrate.parseMigrateDirectoryArgs([]);
  expect(missingUrl.ok).toBe(false);
  if (!missingUrl.ok) {
    expect(missingUrl.refusal).toContain("url");
    expect(missingUrl.refusal).not.toContain(url);
  }
  // URL alone: the read-only M1 verify by default.
  const verify = migrate.parseMigrateDirectoryArgs(["--url", url]);
  expect(verify.ok).toBe(true);
  if (verify.ok) {
    expect(verify.plan.phase).toBe("M1");
    expect(verify.plan.mode).toBe("verify");
  }
  // M2 without --apply: a dry-run plan.
  const dryRun = migrate.parseMigrateDirectoryArgs([
    "--url",
    url,
    "--phase",
    "M2",
  ]);
  expect(dryRun.ok).toBe(true);
  if (dryRun.ok) {
    expect(dryRun.plan.phase).toBe("M2");
    expect(dryRun.plan.mode).toBe("dry-run");
    expect(dryRun.plan.writerUrl).toBeUndefined();
  }
  // M2 --apply requires the writer URL.
  const noWriter = migrate.parseMigrateDirectoryArgs([
    "--url",
    url,
    "--phase",
    "M2",
    "--apply",
  ]);
  expect(noWriter.ok).toBe(false);
  if (!noWriter.ok) {
    expect(noWriter.refusal).toContain("writer");
  }
  // M2 --apply with the writer URL: the real pause/backfill plan.
  const apply = migrate.parseMigrateDirectoryArgs([
    "--url",
    url,
    "--phase",
    "M2",
    "--apply",
    "--writer-url",
    writer,
  ]);
  expect(apply.ok).toBe(true);
  if (apply.ok) {
    expect(apply.plan.mode).toBe("apply");
    expect(apply.plan.writerUrl).toBe(writer);
  }
  // M1 is read-only: --apply is refused.
  const m1Apply = migrate.parseMigrateDirectoryArgs([
    "--url",
    url,
    "--phase",
    "M1",
    "--apply",
  ]);
  expect(m1Apply.ok).toBe(false);
  if (!m1Apply.ok) {
    expect(m1Apply.refusal).toContain("read-only");
  }
  // A stray writer URL on M1 is refused: the phase never uses it.
  const strayWriter = migrate.parseMigrateDirectoryArgs([
    "--url",
    url,
    "--writer-url",
    writer,
  ]);
  expect(strayWriter.ok).toBe(false);
  // The phases owned by other tools are refused, not silently accepted:
  // M0 belongs to inventory.ts; M3+ to the later slices.
  for (const phase of ["M0", "M3", "M4", "M7"]) {
    const other = migrate.parseMigrateDirectoryArgs([
      "--url",
      url,
      "--phase",
      phase,
    ]);
    expect(other.ok, `phase ${phase} must be refused`).toBe(false);
  }
  // Unknown arguments are refused.
  const unknown = migrate.parseMigrateDirectoryArgs([
    "--url",
    url,
    "--nonsense",
  ]);
  expect(unknown.ok).toBe(false);
}, 120_000);
