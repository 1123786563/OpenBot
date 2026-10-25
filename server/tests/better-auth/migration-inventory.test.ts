import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import type {
  InventoryReport,
  LegacyDirectoryWriter,
} from "../../scripts/better-auth/inventory";

/*
 * T02.13 (#535, the M0 slice of the original task P25) — the read-only
 * directory and authority-source inventory, checked against the real expand
 * stack on the isolated BA_TEST_* island database (interfaces §1/§2/§3.3,
 * plan Task 25, root Spec "M0 只读盘点").
 *
 * What this file pins, and why each part is a database fact rather than a
 * code convention:
 *
 * - `m0_inventory_is_read_only_and_keeps_ids`: the inventory run leaves every
 *   in-scope table byte-identical (a full before/after row dump), because
 *   every statement it runs sits inside one `SET TRANSACTION READ ONLY`
 *   transaction — PostgreSQL refuses an accidental write (25006), the CLI
 *   does not merely promise not to. The stable ids are kept, never
 *   re-invented: user→principal pairs, tenant ids, and the
 *   (tenant_id, workspace_id) team keys come back exactly as they were
 *   seeded.
 * - `unknown_owner_or_generation_blocks_migration`: a company without a
 *   tenant_admin membership and a principal with a NULL identity_generation
 *   both block — the inventory reports the unknown and never designates the
 *   first member as owner, and unverified history is never treated as a
 *   valid generation (interfaces §2: 历史回填只能采用经核实的版本).
 * - `legacy_writer_static_list_covers_non_route_writers`: the static list
 *   names every legacy directory writer the source scan finds — including
 *   the three non-route writers (deletion-semantics.ts, root-backfill.ts,
 *   enterprise-runtime-seed.ts) — each with its disposal phase, and a
 *   writer found outside the list is a missing (blocking) writer.
 * - `m0_clean_company_resolves_owner_payer_and_team_binding`: the positive
 *   control — a company with an owner, a billing customer mapping and a
 *   payer account carries no blockers for its own subjects.
 * - `slug_backfill_plan_follows_interfaces_s2_rules`: the §2 rules are
 *   recorded as data, the planned slug is a pure function of name and id,
 *   collisions take deterministic -2 suffixes in (created_at, tenantId)
 *   order, and re-running the inventory derives the same slugs again.
 * - `personal_grants_and_keys_record_source_or_gap`: every access grant and
 *   gateway key is recorded with its verifiable principal/generation source,
 *   or with the recorded gap — never stamped from the current active state.
 * - `revocation_high_watermark_reads_durable_facts`: the watermark is
 *   derived from the security-event trail and the membership epochs, the
 *   durable facts a later phase can replay.
 * - `inventory_cli_contract_is_dry_run_with_explicit_url_and_phase`: the CLI
 *   defaults to dry-run, requires an explicit target URL (never an inherited
 *   TEST_DATABASE_URL), accepts only phase M0 in this slice, and has no
 *   apply mode to parse.
 *
 * Boundaries this suite deliberately does not claim (later slices own them):
 * the M1–M3 migrate-directory/verify-directory tools (later P25 slices), any
 * production run (真实生产运行不在本任务授权内), and the authority switch
 * itself (P22). The island's shared baseline rows belong to other suites;
 * every assertion here is scoped to this suite's `t0213-` fixture subjects.
 *
 * The five BA_TEST_* URLs are all required (presence and same-instance
 * shape); a missing one is a blocked suite, never a silent fallback to the
 * shared, MT or job-level database. No DSN is ever printed — refusals name
 * the variable.
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

/*
 * The verified expand stack the inventory reads, applied by this suite and
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
    DO $t0213_cleanup$
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
    $t0213_cleanup$`);
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
  await sql`DELETE FROM gateway_virtual_keys WHERE id LIKE 't0213-%'`;
  await sql`DELETE FROM access_grants WHERE grant_id LIKE 't0213-%'`;
  await sql`DELETE FROM payer_accounts WHERE id LIKE 't0213-%' OR payer_id LIKE 't0213-%'`;
  await sql`DELETE FROM billing_customers WHERE external_id LIKE 't0213-%'`;
  await sql`DELETE FROM enterprise_tenants WHERE id LIKE 't0213-%'`;
  await sql`DELETE FROM enterprise_principals WHERE id LIKE 't0213-%'`;
  await sql`DELETE FROM bot_services WHERE bot_id LIKE 't0213-%'`;
  await sql`DELETE FROM users WHERE id LIKE 't0213-%'`;
}

/*
 * The fixture: one clean company (owner, member, team, payer binding,
 * verified grant/key) and the two blocker shapes the counterexample case
 * needs — a company with no owner (and no payer binding) whose only member
 * is a principal with a NULL identity_generation. The collide tenant's name
 * normalizes to the clean tenant's slug, so the §2 collision rule is
 * exercised on real rows. Every id carries the t0213- prefix so cleanup and
 * the leak probe stay surgical on the shared island.
 */
const FIXTURE = {
  users: {
    owner: "t0213-owner",
    member: "t0213-member",
    orphan: "t0213-orphan",
  },
  tenants: {
    clean: "t0213-tenant-clean",
    noowner: "t0213-tenant-noowner",
    collide: "t0213-tenant-collide",
  },
  principals: {
    owner: "t0213-principal-owner",
    member: "t0213-principal-member",
    orphan: "t0213-principal-orphan",
  },
  workspaces: {
    clean: "t0213-ws-clean",
    noowner: "t0213-ws-noowner",
  },
  billing: {
    customer: "t0213-billing-customer",
    payerAccount: "t0213-payer-account",
  },
  grants: {
    verified: "t0213-grant-verified",
    unattributed: "t0213-grant-unattributed",
  },
  keys: {
    verified: "t0213-key-verified",
    missingGeneration: "t0213-key-missing-generation",
  },
} as const;

async function seedFixture(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO users (id, email) VALUES
      (${FIXTURE.users.owner}, 't0213-owner@example.test'),
      (${FIXTURE.users.member}, 't0213-member@example.test'),
      (${FIXTURE.users.orphan}, 't0213-orphan@example.test')`;
  // Explicit created_at values fix the §2 collision order deterministically:
  // clean is older than collide, so clean keeps the base slug.
  await sql`
    INSERT INTO enterprise_tenants (id, name, created_at) VALUES
      (${FIXTURE.tenants.clean}, 'T0213 Clean Zqx Company', now() - interval '3 seconds'),
      (${FIXTURE.tenants.noowner}, 'T0213 No Owner Zqx Company', now() - interval '2 seconds'),
      (${FIXTURE.tenants.collide}, 't0213  CLEAN  zqx  COMPANY', now() - interval '1 second')`;
  await sql`
    INSERT INTO enterprise_principals (id, user_id, status, identity_generation) VALUES
      (${FIXTURE.principals.owner}, ${FIXTURE.users.owner}, 'active', 1),
      (${FIXTURE.principals.member}, ${FIXTURE.users.member}, 'active', 1),
      (${FIXTURE.principals.orphan}, ${FIXTURE.users.orphan}, 'active', NULL)`;
  await sql`
    INSERT INTO enterprise_memberships (tenant_id, principal_id, role, status, epoch) VALUES
      (${FIXTURE.tenants.clean}, ${FIXTURE.principals.owner}, 'tenant_admin', 'active', 1),
      (${FIXTURE.tenants.clean}, ${FIXTURE.principals.member}, 'member', 'active', 1),
      (${FIXTURE.tenants.noowner}, ${FIXTURE.principals.orphan}, 'member', 'suspended', 3)`;
  await sql`
    INSERT INTO enterprise_workspaces (tenant_id, id, name) VALUES
      (${FIXTURE.tenants.clean}, ${FIXTURE.workspaces.clean}, 'T0213 Clean Team'),
      (${FIXTURE.tenants.noowner}, ${FIXTURE.workspaces.noowner}, 'T0213 No Owner Team')`;
  await sql`
    INSERT INTO enterprise_workspace_memberships (tenant_id, workspace_id, principal_id, status, epoch) VALUES
      (${FIXTURE.tenants.clean}, ${FIXTURE.workspaces.clean}, ${FIXTURE.principals.member}, 'active', 1)`;
  await sql`
    INSERT INTO enterprise_security_events (tenant_id, id, operation_id, actor_id, event_type, details) VALUES
      (${FIXTURE.tenants.clean}, 't0213-evt-1', 't0213-op-1', ${FIXTURE.users.owner}, 'company_member.suspended', '{"epoch": 3}'::jsonb)`;
  await sql`
    INSERT INTO billing_customers (external_id, name) VALUES
      (${FIXTURE.billing.customer}, 'T0213 Clean Customer')`;
  await sql`
    INSERT INTO billing_customer_mappings (tenant_id, external_customer_id) VALUES
      (${FIXTURE.tenants.clean}, ${FIXTURE.billing.customer})`;
  await sql`
    INSERT INTO payer_accounts (id, kind, payer_id, external_customer_id) VALUES
      (${FIXTURE.billing.payerAccount}, 'company', ${FIXTURE.tenants.clean}, ${FIXTURE.billing.customer})`;
  await sql`
    INSERT INTO bot_services (bot_id, display_name, kind, capabilities) VALUES
      ('t0213-bot', 'T0213 Inventory Bot', 'external', ARRAY['chat'])`;
  await sql`
    INSERT INTO access_grants (grant_id, user_id, principal_id, identity_generation, bot_id, external_identity, scope, status) VALUES
      (${FIXTURE.grants.verified}, ${FIXTURE.users.member}, ${FIXTURE.principals.member}, 1, 't0213-bot', 'openbot:t0213-member', 'model-access', 'active'),
      (${FIXTURE.grants.unattributed}, ${FIXTURE.users.orphan}, NULL, NULL, 't0213-bot', 'openbot:t0213-orphan', 'model-access', 'active')`;
  await sql`
    INSERT INTO gateway_virtual_keys (id, grant_id, bot_id, gateway_customer_id, gateway_virtual_key_id, value_hash, credential_version, source_identity_generation) VALUES
      (${FIXTURE.keys.verified}, ${FIXTURE.grants.verified}, 't0213-bot', 't0213-gateway-customer', 't0213-gateway-key-verified', ${`t0213-${"f".repeat(60)}`}, 1, 1),
      (${FIXTURE.keys.missingGeneration}, ${FIXTURE.grants.unattributed}, 't0213-bot', 't0213-gateway-customer', 't0213-gateway-key-missing', ${`t0213-${"e".repeat(60)}`}, 1, NULL)`;
}

/** Every table the inventory reads, dumped as ordered JSON row texts. */
const SNAPSHOT_TABLES: ReadonlyArray<readonly [string, string]> = [
  ["users", "id"],
  ["enterprise_tenants", "id"],
  ["enterprise_principals", "id"],
  ["enterprise_memberships", "tenant_id, principal_id"],
  ["enterprise_workspaces", "tenant_id, id"],
  ["enterprise_workspace_memberships", "tenant_id, workspace_id, principal_id"],
  ["enterprise_security_events", "tenant_id, id"],
  ["billing_customers", "external_id"],
  ["billing_customer_mappings", "tenant_id"],
  ["payer_accounts", "id"],
  ["bot_services", "bot_id"],
  ["access_grants", "grant_id"],
  ["gateway_virtual_keys", "id"],
  ["auth_organizations", "id"],
  ["auth_teams", "id"],
  ["auth_team_bindings", "tenant_id, workspace_id"],
  ["auth_members", "id"],
  ["auth_team_members", "id"],
  ["auth_eligibility_clocks", "tenant_id, principal_id, kind, scope_id"],
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

interface Harness {
  sql: postgres.Sql;
  /** A fresh setup connection for the after-close leak probe. */
  probe(): postgres.Sql;
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
  try {
    await cleanupFixture(sql);
    for (const path of MIGRATION_PATHS) {
      if (!existsSync(path)) {
        throw new Error(
          `${path} does not exist: the M0 inventory sits on the verified T02.01–T02.06 stack, and a missing prerequisite is a workspace problem, not a target behavior.`,
        );
      }
      await sql.unsafe(readFileSync(path, "utf8"));
    }
    await seedFixture(sql);
    return {
      sql,
      probe: () =>
        postgres(setupUrl, { max: 1, idle_timeout: 5, onnotice: () => {} }),
      close: async () => {
        try {
          await cleanupFixture(sql);
        } finally {
          await sql.end({ timeout: 5 }).catch(() => {});
        }
      },
    };
  } catch (error) {
    await cleanupFixture(sql).catch(() => {});
    await sql.end({ timeout: 5 }).catch(() => {});
    throw error;
  }
}

let harness: Harness | undefined;

beforeAll(async () => {
  harness = await createHarness();
}, 120_000);

afterAll(async () => {
  if (!harness) return;
  await harness.close();
  // The same after-close check the sibling suites run, on a fresh
  // short-lived connection: a future change that strands a BA object or a
  // t0213- row on the shared island fails here instead of piling up.
  const sql = harness.probe();
  try {
    const leaked = await sql`
      SELECT 'users:' || id FROM users WHERE id LIKE 't0213-%'
      UNION ALL
      SELECT 'tenants:' || id FROM enterprise_tenants WHERE id LIKE 't0213-%'
      UNION ALL
      SELECT 'principals:' || id FROM enterprise_principals WHERE id LIKE 't0213-%'
      UNION ALL
      SELECT 'memberships:' || tenant_id FROM enterprise_memberships WHERE tenant_id LIKE 't0213-%'
      UNION ALL
      SELECT 'workspaces:' || tenant_id FROM enterprise_workspaces WHERE tenant_id LIKE 't0213-%'
      UNION ALL
      SELECT 'ws_memberships:' || tenant_id FROM enterprise_workspace_memberships WHERE tenant_id LIKE 't0213-%'
      UNION ALL
      SELECT 'events:' || id FROM enterprise_security_events WHERE tenant_id LIKE 't0213-%' OR id LIKE 't0213-%'
      UNION ALL
      SELECT 'billing_customers:' || external_id FROM billing_customers WHERE external_id LIKE 't0213-%'
      UNION ALL
      SELECT 'mappings:' || tenant_id FROM billing_customer_mappings WHERE tenant_id LIKE 't0213-%'
      UNION ALL
      SELECT 'payer_accounts:' || id FROM payer_accounts WHERE id LIKE 't0213-%' OR payer_id LIKE 't0213-%'
      UNION ALL
      SELECT 'bots:' || bot_id FROM bot_services WHERE bot_id LIKE 't0213-%'
      UNION ALL
      SELECT 'grants:' || grant_id FROM access_grants WHERE grant_id LIKE 't0213-%'
      UNION ALL
      SELECT 'keys:' || id FROM gateway_virtual_keys WHERE id LIKE 't0213-%'
      UNION ALL
      SELECT 'ba_table:' || table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY(${[...BA_TABLES]}::text[])`;
    expect(leaked).toEqual([]);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
});

/*
 * The T02.13 target module, loaded lazily so a worktree without it still
 * collects (and fails) every case with a message naming the missing target
 * behavior instead of dying at import time as a zero-case collection error.
 */
type InventoryModule = typeof import("../../scripts/better-auth/inventory");
let inventoryPromise: Promise<InventoryModule> | undefined;
function loadInventory(): Promise<InventoryModule> {
  inventoryPromise ??= import("../../scripts/better-auth/inventory").catch(
    (error: unknown) => {
      throw new Error(
        `server/scripts/better-auth/inventory.ts is not loadable — ${error instanceof Error ? error.message : String(error)}: the M0 read-only directory and authority-source inventory this suite pins is the T02.13 target behavior, not an environment problem.`,
      );
    },
  );
  return inventoryPromise;
}

/** The shared inventory run; the read-only case runs its own copy around its snapshots. */
let reportPromise: Promise<InventoryReport> | undefined;
function inventoryReport(): Promise<InventoryReport> {
  reportPromise ??= (async () => {
    const inventory = await loadInventory();
    return inventory.runM0Inventory({
      url: readBaUrls(),
      phase: "M0",
      repositoryRoot: REPO_ROOT,
    });
  })();
  return reportPromise;
}

function blockersAbout(
  report: InventoryReport,
  subjects: readonly string[],
): InventoryReport["blockers"] {
  return report.blockers.filter((blocker) =>
    subjects.includes(blocker.subject),
  );
}

const NON_ROUTE_WRITER_FILES = [
  "server/src/enterprise/tenancy/deletion-semantics.ts",
  "server/src/enterprise/tenancy/root-backfill.ts",
  "server/scripts/enterprise-runtime-seed.ts",
] as const;

test("m0_inventory_is_read_only_and_keeps_ids", async () => {
  if (!harness) throw new Error("fixture harness missing");
  const inventory = await loadInventory();
  const before = await snapshotDatabase(harness.sql);
  // The read-only proof wraps this suite's own run, not the memoized one,
  // so the before/after snapshots always bracket a real inventory pass.
  const report = await inventory.runM0Inventory({
    url: readBaUrls(),
    phase: "M0",
    repositoryRoot: REPO_ROOT,
  });
  const after = await snapshotDatabase(harness.sql);
  expect(after).toEqual(before);
  expect(report.phase).toBe("M0");
  expect(report.mode).toBe("dry-run");
  // Keeps ids: the mapping reports the seeded stable ids verbatim and
  // invents none — no BA organization/team rows exist yet, so those stay
  // null rather than being pre-minted.
  const usersById = new Map(
    report.mappings.users.map((user) => [user.userId, user]),
  );
  expect(usersById.get(FIXTURE.users.owner)).toEqual({
    userId: FIXTURE.users.owner,
    principalId: FIXTURE.principals.owner,
    identityGeneration: 1,
  });
  expect(usersById.get(FIXTURE.users.member)).toEqual({
    userId: FIXTURE.users.member,
    principalId: FIXTURE.principals.member,
    identityGeneration: 1,
  });
  const clean = report.mappings.companies.find(
    (company) => company.tenantId === FIXTURE.tenants.clean,
  );
  expect(clean?.name).toBe("T0213 Clean Zqx Company");
  expect(clean?.organizationId).toBe(null);
  expect(clean?.ownerPrincipalIds).toEqual([FIXTURE.principals.owner]);
  const cleanTeam = report.mappings.teams.find(
    (team) =>
      team.tenantId === FIXTURE.tenants.clean &&
      team.workspaceId === FIXTURE.workspaces.clean,
  );
  expect(cleanTeam?.teamId).toBe(null);
  expect(report.mappings.memberships).toContainEqual({
    tenantId: FIXTURE.tenants.clean,
    principalId: FIXTURE.principals.owner,
    userId: FIXTURE.users.owner,
    role: "tenant_admin",
    status: "active",
    epoch: 1,
  });
  // No secret columns are read: the recorded read set contains no
  // credential/token/hash-bearing column and no user email.
  const secretColumn =
    /(secret|token|password|hash|credential|payload|value|email)/i;
  for (const [table, columns] of Object.entries(report.readColumns)) {
    for (const column of columns) {
      expect(
        secretColumn.test(`${table}.${column}`),
        `${table}.${column} must not be read by the M0 inventory`,
      ).toBe(false);
    }
  }
}, 120_000);

test("unknown_owner_or_generation_blocks_migration", async () => {
  const report = await inventoryReport();
  expect(report.canMigrate).toBe(false);
  // The blocker is causal, not incidental: the fixture's ownerless company
  // and NULL-generation principal are named as blockers.
  const blockers = blockersAbout(report, [
    FIXTURE.tenants.noowner,
    FIXTURE.principals.orphan,
  ]);
  expect(
    blockers.some(
      (blocker) =>
        blocker.kind === "unknown-owner" &&
        blocker.subject === FIXTURE.tenants.noowner,
    ),
  ).toBe(true);
  expect(
    blockers.some(
      (blocker) =>
        blocker.kind === "unknown-generation" &&
        blocker.subject === FIXTURE.principals.orphan,
    ),
  ).toBe(true);
  // The unknown payer is reported the same way — never auto-designated.
  expect(
    blockers.some(
      (blocker) =>
        blocker.kind === "unknown-payer" &&
        blocker.subject === FIXTURE.tenants.noowner,
    ),
  ).toBe(true);
}, 120_000);

test("legacy_writer_static_list_covers_non_route_writers", async () => {
  const inventory = await loadInventory();
  const byFile = new Map(
    inventory.LEGACY_DIRECTORY_WRITERS.map((writer: LegacyDirectoryWriter) => [
      writer.file,
      writer,
    ]),
  );
  // The three non-route writers the plan names are in the list, classified
  // as non-route, each with a disposal phase.
  for (const file of NON_ROUTE_WRITER_FILES) {
    const writer = byFile.get(file);
    expect(
      writer,
      `${file} must be in the legacy writer static list`,
    ).toBeTruthy();
    expect(writer?.route).toBe(false);
    expect(writer?.disposalPhase.length ?? 0).toBeGreaterThan(0);
  }
  // Every family the plan names is declared — including jit, which has no
  // legacy writer in the corpus today.
  const families = new Set(
    inventory.LEGACY_DIRECTORY_WRITERS.map((writer) => writer.family),
  );
  for (const family of [
    "ui-api",
    "cli",
    "scim",
    "jit",
    "startup",
    "non-route",
  ] as const) {
    expect(families.has(family), `family ${family} must be declared`).toBe(
      true,
    );
  }
  // The scan over the real repository finds writers, and none is missing
  // from the list: an unclassified writer would block the inventory.
  const scan = inventory.scanLegacyDirectoryWriters(REPO_ROOT);
  expect(scan.writers.length).toBeGreaterThan(0);
  for (const file of [
    ...NON_ROUTE_WRITER_FILES,
    "server/src/enterprise/tenancy/provision.ts",
    "server/src/enterprise/tenancy/workspace-admin.ts",
    "server/src/enterprise/tenancy/people-lifecycle.ts",
    "server/src/enterprise/tenancy/scim-directory.ts",
  ]) {
    expect(
      scan.writers.some((writer) => writer.file === file),
      `the scan must find ${file}`,
    ).toBe(true);
  }
  expect(scan.missing).toEqual([]);
  // The report carries the same verdict.
  const report = await inventoryReport();
  expect(report.legacyWriters.scan.missing).toEqual([]);
}, 120_000);

test("m0_clean_company_resolves_owner_payer_and_team_binding", async () => {
  const report = await inventoryReport();
  const clean = report.mappings.companies.find(
    (company) => company.tenantId === FIXTURE.tenants.clean,
  );
  expect(clean).toBeTruthy();
  expect(clean?.payer.externalCustomerId).toBe(FIXTURE.billing.customer);
  expect(clean?.payer.payerAccountId).toBe(FIXTURE.billing.payerAccount);
  expect(clean?.memberPrincipalIds).toEqual([
    FIXTURE.principals.member,
    FIXTURE.principals.owner,
  ]);
  const teamMembership = report.mappings.teamMemberships.find(
    (membership) =>
      membership.tenantId === FIXTURE.tenants.clean &&
      membership.workspaceId === FIXTURE.workspaces.clean,
  );
  expect(teamMembership).toEqual({
    tenantId: FIXTURE.tenants.clean,
    workspaceId: FIXTURE.workspaces.clean,
    principalId: FIXTURE.principals.member,
    userId: FIXTURE.users.member,
    status: "active",
    epoch: 1,
  });
  // Positive control: no blocker is about the clean company or its people.
  expect(
    blockersAbout(report, [
      FIXTURE.tenants.clean,
      FIXTURE.principals.owner,
      FIXTURE.principals.member,
      FIXTURE.users.owner,
      FIXTURE.users.member,
    ]),
  ).toEqual([]);
}, 120_000);

test("slug_backfill_plan_follows_interfaces_s2_rules", async () => {
  const inventory = await loadInventory();
  const report = await inventoryReport();
  // The §2 rules are recorded as data in the pre-migration inventory.
  expect(report.slugBackfill.rules.normalization.length).toBeGreaterThan(0);
  expect(report.slugBackfill.rules.emptyFallback.length).toBeGreaterThan(0);
  expect(report.slugBackfill.rules.collision.length).toBeGreaterThan(0);
  expect(report.slugBackfill.rules.idempotency.length).toBeGreaterThan(0);
  expect(report.slugBackfill.rules.uniqueConflict.length).toBeGreaterThan(0);
  // Derivation: normalize, and the empty name falls back to the digest.
  expect(inventory.planOrganizationSlug("  Acme & Co!  ", "t")).toBe("acme-co");
  expect(inventory.planOrganizationSlug("  !!!  ", "t0213-tenant")).toMatch(
    /^tenant-[0-9a-f]+$/,
  );
  // The planned slugs for the fixture: clean keeps the base, collide takes
  // the deterministic -2 (it is younger), noowner gets its own base.
  const planned = new Map(
    report.slugBackfill.plannedSlugs.map((slug) => [slug.tenantId, slug]),
  );
  expect(planned.get(FIXTURE.tenants.clean)).toMatchObject({
    tenantId: FIXTURE.tenants.clean,
    plannedSlug: "t0213-clean-zqx-company",
    collisionSuffix: null,
    existingSlug: null,
  });
  expect(planned.get(FIXTURE.tenants.collide)).toMatchObject({
    tenantId: FIXTURE.tenants.collide,
    plannedSlug: "t0213-clean-zqx-company-2",
    collisionSuffix: 2,
    existingSlug: null,
  });
  expect(planned.get(FIXTURE.tenants.noowner)?.plannedSlug).toBe(
    "t0213-no-owner-zqx-company",
  );
  // Idempotent: a second run derives the same slugs (重跑必得同一 slug)
  // and the same digest — the report is a pure function of the state.
  const second = await inventory.runM0Inventory({
    url: readBaUrls(),
    phase: "M0",
    repositoryRoot: REPO_ROOT,
  });
  expect(second.slugBackfill.plannedSlugs).toEqual(
    report.slugBackfill.plannedSlugs,
  );
  expect(second.digest).toBe(report.digest);
}, 120_000);

test("personal_grants_and_keys_record_source_or_gap", async () => {
  const report = await inventoryReport();
  const grants = new Map(
    report.authorizationSources.personalGrants.map((grant) => [
      grant.grantId,
      grant,
    ]),
  );
  expect(grants.get(FIXTURE.grants.verified)).toEqual({
    grantId: FIXTURE.grants.verified,
    userId: FIXTURE.users.member,
    principalId: FIXTURE.principals.member,
    identityGeneration: 1,
    status: "active",
    source: "verified-principal",
  });
  // The gap is recorded item by item — never stamped from current state.
  expect(grants.get(FIXTURE.grants.unattributed)).toEqual({
    grantId: FIXTURE.grants.unattributed,
    userId: FIXTURE.users.orphan,
    principalId: null,
    identityGeneration: null,
    status: "active",
    source: "missing",
  });
  const keys = new Map(
    report.authorizationSources.gatewayKeys.map((key) => [key.keyId, key]),
  );
  expect(keys.get(FIXTURE.keys.verified)).toEqual({
    keyId: FIXTURE.keys.verified,
    grantId: FIXTURE.grants.verified,
    sourceIdentityGeneration: 1,
    status: "active",
    source: "verified-generation",
  });
  expect(keys.get(FIXTURE.keys.missingGeneration)).toEqual({
    keyId: FIXTURE.keys.missingGeneration,
    grantId: FIXTURE.grants.unattributed,
    sourceIdentityGeneration: null,
    status: "active",
    source: "missing",
  });
}, 120_000);

test("revocation_high_watermark_reads_durable_facts", async () => {
  const report = await inventoryReport();
  const watermark = report.revocationHighWatermark;
  // The security-event trail is the durable revocation evidence the
  // watermark is cut from; the fixture's event is inside it.
  expect(watermark.securityEvents.count).toBeGreaterThanOrEqual(1);
  expect(watermark.securityEvents.latestAt).toBeTruthy();
  // The suspended membership and its epoch are durable facts too.
  expect(watermark.suspendedMemberships).toBeGreaterThanOrEqual(1);
  expect(watermark.maxMembershipEpoch).toBeGreaterThanOrEqual(3);
  expect(watermark.suspendedTeamMemberships).toBeGreaterThanOrEqual(0);
}, 120_000);

test("inventory_cli_contract_is_dry_run_with_explicit_url_and_phase", async () => {
  const inventory = await loadInventory();
  const url = readBaUrls();
  // No URL: refused — the target is explicit, never inherited.
  const missingUrl = inventory.parseInventoryArgs([]);
  expect(missingUrl.ok).toBe(false);
  if (!missingUrl.ok) {
    expect(missingUrl.refusal).toContain("url");
    expect(missingUrl.refusal).not.toContain(url);
  }
  // URL alone: dry-run M0 by default.
  const plan = inventory.parseInventoryArgs(["--url", url]);
  expect(plan.ok).toBe(true);
  if (plan.ok) {
    expect(plan.plan.mode).toBe("dry-run");
    expect(plan.plan.phase).toBe("M0");
    expect(plan.plan.url).toBe(url);
  }
  // A later phase is this slice's refusal, not a silent fall-back.
  const laterPhase = inventory.parseInventoryArgs([
    "--url",
    url,
    "--phase",
    "M2",
  ]);
  expect(laterPhase.ok).toBe(false);
  if (!laterPhase.ok) {
    expect(laterPhase.refusal).toContain("M0");
  }
  // There is no apply mode to parse: M0 is read-only by construction.
  const apply = inventory.parseInventoryArgs(["--url", url, "--apply"]);
  expect(apply.ok).toBe(false);
}, 120_000);
