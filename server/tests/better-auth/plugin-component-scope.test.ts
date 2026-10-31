import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { TASKS } from "../../scripts/multitenancy/migrate-test";
import { createClosedCompanyAssurance } from "../../src/auth/company-assurance";
import { createDirectoryAuthority } from "../../src/auth/directory/authority";
import { createDatabase } from "../../src/db/client";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  type DataDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyOperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import { createMarketplaceInstallService } from "../../src/enterprise/tenancy/marketplace-install";
import {
  createPluginCatalogAdminService,
  createPluginCatalogDecisionService,
  type SecretVault,
} from "../../src/enterprise/tenancy/plugin-catalog";
import { createSkillComponentService } from "../../src/enterprise/tenancy/skills-components";
import { createBaScopeResolver } from "../../src/enterprise/tenancy/store";

/*
 * T06.05 (#577, original task P14) — the marketplace's global templates stay
 * separate from the installed company/team-private instances, and a component
 * execution authorizes every declared dependency item by item.
 *
 * What this suite pins, against the real services on the isolated BA_TEST_*
 * island (real RLS, real restricted roles, real server-issued scopes):
 *
 * - `global_template_does_not_reveal_private_install`: the template view of a
 *   global catalog entry is allowed for any company's member, and the private
 *   install of that template — another company's, or the viewer's own company's
 *   other team's — never appears in it (privateInstance is null).
 * - the positive control: a member of the team that installed the entry does
 *   see that team's own install through the same view, so the separation is
 *   scope-based, not a blanket null.
 * - `allowed_component_cannot_load_cross_company_dependency`: a caller allowed
 *   on a team-published component still gets the canonical deny — and the
 *   module's own onExecute probe never fires — when the component's declared
 *   dependency is another company's install/connection or a component that
 *   only exists there. Same-company other-team dependencies deny the same way.
 * - the marketplace layer: the global catalog projection is identical for
 *   every company, and install receipts stay scoped to the caller's own team
 *   (a same-company other-team receipt is not auto-readable).
 *
 * Fixture discipline (the better-auth island's standing recipe, T06.01): the
 * five BA_TEST_* role URLs are required and must name one loopback
 * openbot_enterprise_* database; a missing URL is a blocked suite, never a
 * fallback, and no DSN is ever printed. The suite applies the real 0221–0226
 * BA migrations, the MT031 plugin RLS/grant step and the restricted-role
 * grants its services read — all taken from
 * server/scripts/multitenancy/migrate-test.ts, the migration's single source
 * of truth, never re-typed here — and restores the island baseline exactly
 * (rows, policies, RLS flags, grants) at cleanup.
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

const MIGRATION_TAGS = [
  "0221_better_auth_directory",
  "0222_better_auth_clocks",
  "0223_better_auth_command_authority",
  "0224_better_auth_authority_sources",
  "0225_better_auth_assurance",
  "0226_better_auth_schema_roles",
] as const;

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

const TENANT_A = "t0605-tenant-a";
const TENANT_B = "t0605-tenant-b";
const WORKSPACE_A = "t0605-ws-a";
const WORKSPACE_A2 = "t0605-ws-a2";
const WORKSPACE_B = "t0605-ws-b";
const TEAM_A = "t0605-team-a";
const TEAM_A2 = "t0605-team-a2";
const TEAM_B = "t0605-team-b";
const USER_A = "t0605-user-a";
const USER_A2 = "t0605-user-a2";
const USER_B = "t0605-user-b";
const PRINCIPAL_A = "t0605-principal-a";
const PRINCIPAL_A2 = "t0605-principal-a2";
const PRINCIPAL_B = "t0605-principal-b";
const CATALOG_ID = "t0605-catalog-global";
// A second global entry installed by team A1 only — the fixture for the named
// no-leak case, whose viewer team genuinely did not install it.
const CATALOG_A1_ONLY = "t0605-catalog-a1-only";
const COMPONENT_NAME = "t0605-chart-renderer";
const COMPONENT_B_ONLY = "t0605-b-only-component";
const IDENTITY_GENERATION = 4;

const BA_AUTHORITY = {
  authorityVersion: 11,
  phase: "M4",
  directoryAuthority: "ba",
  multiTenantReleased: true,
} as const;

function shapeOf(variable: string, raw: string): string {
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
  return `${host}:${url.port || "5432"}/${database}`;
}

function readBaUrls(): string {
  let reference: string | undefined;
  for (const variable of BA_URL_VARIABLES) {
    const raw = process.env[variable]?.trim();
    if (!raw) {
      throw new Error(
        `${variable} is required: this suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
      );
    }
    const shape = shapeOf(variable, raw);
    reference ??= shape;
    if (shape !== reference) {
      throw new Error(
        `${variable} must name the same PostgreSQL instance and database as ${DATABASE_VARIABLE}.`,
      );
    }
  }
  return process.env[DATABASE_VARIABLE]!.trim();
}

function loadMigrationSql(tag: string): string {
  const path = join(import.meta.dirname, `../../drizzle/${tag}.sql`);
  if (!existsSync(path)) {
    throw new Error(
      `${tag}.sql does not exist: the stack this suite pins is the integrated target behavior, not an environment problem.`,
    );
  }
  return readFileSync(path, "utf8");
}

/** The MT task statements this suite needs, read from the single source. */
function statementsFromTasks(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const task of TASKS.values()) {
    for (const step of task.steps) {
      for (const statement of step.statements) {
        if (pattern.test(statement) && !found.includes(statement)) {
          found.push(statement);
        }
      }
    }
  }
  return found;
}

/** One migration step's statements by slug (the single source, never re-typed). */
function stepStatements(slug: string): string[] {
  for (const task of TASKS.values()) {
    const step = task.steps.find((entry) => entry.slug === slug);
    if (step) return step.statements;
  }
  throw new Error(
    `the migrate-test single source no longer carries the "${slug}" step: update this suite's extraction before running it.`,
  );
}

/** The PKG05 connection-generation column the island baseline predates. */
const PLUGIN_CONNECTION_GENERATION = stepStatements(
  "plugin_connection_generation",
);

/** The MT031 plugin RLS/policies/grants step (tables + composite FKs already exist on the island). */
const PLUGIN_RLS_STATEMENTS = (() => {
  const task = TASKS.get("MT031");
  if (!task) throw new Error("MT031 missing from migrate-test TASKS");
  const step = task.steps.find((entry) => entry.slug === "plugin_rls_policies");
  if (!step) {
    throw new Error(
      "MT031 no longer carries the plugin_rls_policies step: update this suite's extraction before running it, never re-type the SQL here.",
    );
  }
  return step.statements;
})();

/** The policy names the step creates — dropped again at cleanup by name. */
const PLUGIN_POLICY_NAMES = PLUGIN_RLS_STATEMENTS.flatMap((statement) => [
  ...statement.matchAll(/CREATE POLICY "([^"]+)" ON/g),
]).map((match) => match[1]);

const PLUGIN_TABLES = [
  "enterprise_plugin_catalog",
  "enterprise_plugin_installs",
  "enterprise_plugin_connections",
] as const;

const WORKSPACE_MEMBERSHIP_GRANT = statementsFromTasks(
  /^GRANT SELECT ON TABLE "enterprise_workspace_memberships" TO /,
);
const BOT_OWNERSHIP_GRANT = statementsFromTasks(
  /^GRANT SELECT ON TABLE "enterprise_bot_ownership" TO /,
);
const VISIBILITY_UPDATE_GRANT = statementsFromTasks(
  /^GRANT UPDATE \("visibility"\) ON TABLE "enterprise_resources" TO /,
);

for (const [name, list] of [
  ["workspace-membership grants", WORKSPACE_MEMBERSHIP_GRANT],
  ["bot-ownership grants", BOT_OWNERSHIP_GRANT],
  ["visibility update grant", VISIBILITY_UPDATE_GRANT],
  ["plugin RLS statements", PLUGIN_RLS_STATEMENTS],
] as const) {
  if (list.length < 1) {
    throw new Error(
      `the migrate-test single source no longer carries the ${name}: update this suite's extraction before running it, never re-type the SQL here.`,
    );
  }
}
if (PLUGIN_POLICY_NAMES.length < 10) {
  throw new Error(
    `the MT031 step no longer creates the plugin policies (${PLUGIN_POLICY_NAMES.length} found): update this suite's extraction, never re-type the names.`,
  );
}

/** Deterministic test vault: envelopes carry the plaintext verbatim. */
const vault: SecretVault = {
  seal: async (plaintext) => `t0605-sealed:${plaintext}`,
  open: async (envelope) => envelope.slice("t0605-sealed:".length),
};

const cleanupSql = async (sql: postgres.Sql): Promise<void> => {
  await sql.unsafe(
    `DROP TABLE IF EXISTS ${BA_TABLES.map((name) => `"${name}"`).join(", ")} CASCADE`,
  );
  await sql`DELETE FROM enterprise_plugin_connections WHERE tenant_id LIKE 't0605-%'`;
  await sql`DELETE FROM enterprise_plugin_installs WHERE tenant_id LIKE 't0605-%'`;
  await sql`DELETE FROM enterprise_plugin_catalog WHERE id LIKE 't0605-%'`;
  await sql`DELETE FROM enterprise_bot_ownership WHERE tenant_id LIKE 't0605-%'`;
  await sql`DELETE FROM enterprise_resources WHERE tenant_id LIKE 't0605-%'`;
  await sql`DELETE FROM enterprise_workspace_memberships WHERE tenant_id LIKE 't0605-%'`;
  await sql`DELETE FROM enterprise_memberships WHERE tenant_id LIKE 't0605-%'`;
  await sql`DELETE FROM enterprise_principals WHERE id LIKE 't0605-%'`;
  await sql`DELETE FROM enterprise_workspaces WHERE tenant_id LIKE 't0605-%'`;
  await sql`DELETE FROM enterprise_tenants WHERE id LIKE 't0605-%'`;
  await sql`DELETE FROM users WHERE id LIKE 't0605-%'`;
  // The MT031 plugin RLS/grant step this suite applies, restored by name/flag.
  for (const policy of PLUGIN_POLICY_NAMES) {
    for (const table of PLUGIN_TABLES) {
      await sql.unsafe(`DROP POLICY IF EXISTS "${policy}" ON "${table}"`);
    }
  }
  for (const table of PLUGIN_TABLES) {
    await sql.unsafe(`ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY`);
    await sql.unsafe(`ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`);
  }
  await sql.unsafe(
    `ALTER TABLE "enterprise_plugin_connections" DROP CONSTRAINT IF EXISTS "enterprise_plugin_connection_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_plugin_connections" DROP COLUMN IF EXISTS "generation"`,
  );
  await sql.unsafe(
    `REVOKE ALL PRIVILEGES ON TABLE "enterprise_plugin_catalog", "enterprise_plugin_installs", "enterprise_plugin_connections" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator`,
  );
  // The restricted-role grants the baseline predates (measured on the island).
  await sql.unsafe(
    `REVOKE SELECT ON TABLE "enterprise_workspace_memberships" FROM ob_ent_directory, ob_ent_data, ob_ent_operator`,
  );
  await sql.unsafe(
    `REVOKE SELECT ON TABLE "enterprise_bot_ownership" FROM ob_ent_data, ob_ent_operator`,
  );
  await sql.unsafe(
    `REVOKE UPDATE ("visibility") ON TABLE "enterprise_resources" FROM ob_ent_operator`,
  );
  // The pre-T02.02 baseline the BA migrations re-establish on top of.
  await sql.unsafe(
    `ALTER TABLE "enterprise_principals" DROP COLUMN IF EXISTS "identity_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_tenants" DROP CONSTRAINT IF EXISTS "enterprise_tenant_status"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_tenants" ADD CONSTRAINT "enterprise_tenant_status" CHECK ("status" in ('active','suspended'))`,
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
};

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

async function seedFixture(sql: postgres.Sql): Promise<void> {
  // Two companies; company A runs a second team (ws-a2) the ws-a member does
  // not belong to — the same-company cross-team face of the separation.
  await sql`
    INSERT INTO enterprise_tenants (id, name, policy_revision) VALUES
      (${TENANT_A}, 'T06.05 company A', 'workspace-v1'),
      (${TENANT_B}, 'T06.05 company B', 'workspace-v1')`;
  await sql`
    INSERT INTO users (id, email) VALUES
      (${USER_A}, 't0605-a@example.test'),
      (${USER_A2}, 't0605-a2@example.test'),
      (${USER_B}, 't0605-b@example.test')`;
  await sql`
    INSERT INTO enterprise_principals (id, user_id, identity_generation) VALUES
      (${PRINCIPAL_A}, ${USER_A}, ${IDENTITY_GENERATION}),
      (${PRINCIPAL_A2}, ${USER_A2}, ${IDENTITY_GENERATION}),
      (${PRINCIPAL_B}, ${USER_B}, ${IDENTITY_GENERATION})`;
  await sql`
    INSERT INTO enterprise_workspaces (tenant_id, id, name) VALUES
      (${TENANT_A}, ${WORKSPACE_A}, 'T06.05 team A1'),
      (${TENANT_A}, ${WORKSPACE_A2}, 'T06.05 team A2'),
      (${TENANT_B}, ${WORKSPACE_B}, 'T06.05 team B')`;
  await sql`
    INSERT INTO enterprise_memberships (tenant_id, principal_id, role, epoch) VALUES
      (${TENANT_A}, ${PRINCIPAL_A}, 'member', 1),
      (${TENANT_A}, ${PRINCIPAL_A2}, 'member', 1),
      (${TENANT_B}, ${PRINCIPAL_B}, 'member', 1)`;
  await sql`
    INSERT INTO enterprise_workspace_memberships
      (tenant_id, workspace_id, principal_id, epoch)
    VALUES
      (${TENANT_A}, ${WORKSPACE_A}, ${PRINCIPAL_A}, 1),
      (${TENANT_A}, ${WORKSPACE_A2}, ${PRINCIPAL_A2}, 1),
      (${TENANT_B}, ${WORKSPACE_B}, ${PRINCIPAL_B}, 1)`;
  await withGuardsDisabled(
    sql,
    [
      ["auth_organizations", "auth_directory_dml_guard"],
      ["auth_teams", "auth_directory_dml_guard"],
      ["auth_team_bindings", "auth_directory_dml_guard"],
      ["auth_members", "auth_directory_dml_guard"],
      ["auth_team_members", "auth_directory_dml_guard"],
    ],
    async () => {
      await sql`
        INSERT INTO auth_organizations (id, name, slug) VALUES
          (${TENANT_A}, 'T06.05 company A', 't0605-company-a'),
          (${TENANT_B}, 'T06.05 company B', 't0605-company-b')`;
      await sql`
        INSERT INTO auth_teams (id, organization_id, name) VALUES
          (${TEAM_A}, ${TENANT_A}, 'T06.05 team A1'),
          (${TEAM_A2}, ${TENANT_A}, 'T06.05 team A2'),
          (${TEAM_B}, ${TENANT_B}, 'T06.05 team B')`;
      await sql`
        INSERT INTO auth_team_bindings (tenant_id, workspace_id, team_id) VALUES
          (${TENANT_A}, ${WORKSPACE_A}, ${TEAM_A}),
          (${TENANT_A}, ${WORKSPACE_A2}, ${TEAM_A2}),
          (${TENANT_B}, ${WORKSPACE_B}, ${TEAM_B})`;
      await sql`
        INSERT INTO auth_members (id, organization_id, user_id, role) VALUES
          ('t0605-ba-a', ${TENANT_A}, ${USER_A}, 'member'),
          ('t0605-ba-a2', ${TENANT_A}, ${USER_A2}, 'member'),
          ('t0605-ba-b', ${TENANT_B}, ${USER_B}, 'member')`;
      await sql`
        INSERT INTO auth_team_members (id, team_id, user_id) VALUES
          ('t0605-bat-a', ${TEAM_A}, ${USER_A}),
          ('t0605-bat-a2', ${TEAM_A2}, ${USER_A2}),
          ('t0605-bat-b', ${TEAM_B}, ${USER_B})`;
    },
  );
  await sql`
    INSERT INTO auth_eligibility_clocks
      (tenant_id, principal_id, kind, scope_id, epoch, generation, tombstone, last_command_id)
    VALUES
      (${TENANT_A}, ${PRINCIPAL_A}, 'company', ${TENANT_A}, 1, 1, false, 't0605-c0'),
      (${TENANT_A}, ${PRINCIPAL_A}, 'team', ${WORKSPACE_A}, 1, 1, false, 't0605-c0'),
      (${TENANT_A}, ${PRINCIPAL_A2}, 'company', ${TENANT_A}, 1, 1, false, 't0605-c0'),
      (${TENANT_A}, ${PRINCIPAL_A2}, 'team', ${WORKSPACE_A2}, 1, 1, false, 't0605-c0'),
      (${TENANT_B}, ${PRINCIPAL_B}, 'company', ${TENANT_B}, 1, 1, false, 't0605-c0'),
      (${TENANT_B}, ${PRINCIPAL_B}, 'team', ${WORKSPACE_B}, 1, 1, false, 't0605-c0')`;
  // The deployment-curated global catalog entry (curation is a deployment-level
  // act outside the business channels; superuser seeding is the disclosed
  // stand-in, the MT031 fixture's same aid).
  await sql.unsafe(
    `INSERT INTO enterprise_plugin_catalog (id, kind, title, vendor, source, metadata)
     VALUES ($1, 'mcp', 'T06.05 global template', 't0605-vendor', 'first-party', $2::jsonb)`,
    [CATALOG_ID, { summary: "T06.05 global template summary" }],
  );
  await sql.unsafe(
    `INSERT INTO enterprise_plugin_catalog (id, kind, title, vendor, source, metadata)
     VALUES ($1, 'mcp', 'T06.05 A1-only template', 't0605-vendor', 'first-party', $2::jsonb)`,
    [CATALOG_A1_ONLY, { summary: "T06.05 A1-only template summary" }],
  );
  // Marketplace receipts (read-path fixture, direct rows): company A team A1,
  // company A team A2, company B — the receipt visibility subject.
  await sql`
    INSERT INTO enterprise_bot_ownership
      (tenant_id, agent_id, workspace_id, owner_principal_id, display_name, default_config, revision)
    VALUES
      (${TENANT_A}, 't0605-mkt-a', ${WORKSPACE_A}, ${PRINCIPAL_A}, 'T06.05 expert', '{}', 1),
      (${TENANT_A}, 't0605-mkt-a2', ${WORKSPACE_A2}, ${PRINCIPAL_A2}, 'T06.05 expert', '{}', 1),
      (${TENANT_B}, 't0605-mkt-b', ${WORKSPACE_B}, ${PRINCIPAL_B}, 'T06.05 expert', '{}', 1)`;
  await sql`
    INSERT INTO enterprise_resources
      (tenant_id, id, workspace_id, kind, display_name, revision, visibility)
    VALUES
      (${TENANT_A}, 't0605-mkt-a', ${WORKSPACE_A}, 'marketplace-install', 'marketplace:t0605-expert', 1, 'workspace'),
      (${TENANT_A}, 't0605-mkt-a2', ${WORKSPACE_A2}, 'marketplace-install', 'marketplace:t0605-expert', 1, 'workspace'),
      (${TENANT_B}, 't0605-mkt-b', ${WORKSPACE_B}, 'marketplace-install', 'marketplace:t0605-expert', 1, 'workspace')`;
}

interface InstallFact {
  readonly installId: string;
}

interface Harness {
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
  readonly pluginDecisions: ReturnType<
    typeof createPluginCatalogDecisionService
  >;
  readonly marketplace: ReturnType<typeof createMarketplaceInstallService>;
  readonly installA: InstallFact;
  readonly installA2: InstallFact;
  readonly installA1Only: InstallFact;
  readonly installB: InstallFact;
  readonly connectionB: { readonly connectionId: string };
  scopeFor(actor: {
    readonly user: string;
    readonly tenant: string;
    readonly workspace: string;
  }): Promise<PlatformScope>;
  close(): Promise<void>;
}

let state: Harness | undefined;

async function createHarness(): Promise<Harness> {
  const setupUrl = readBaUrls();
  const sql = postgres(setupUrl, {
    max: 1,
    idle_timeout: 5,
    onnotice: () => {},
  });
  try {
    await cleanupSql(sql);
    for (const tag of MIGRATION_TAGS) {
      await sql.unsafe(loadMigrationSql(tag));
    }
    for (const statement of [
      ...PLUGIN_RLS_STATEMENTS,
      ...PLUGIN_CONNECTION_GENERATION,
      ...WORKSPACE_MEMBERSHIP_GRANT,
      ...BOT_OWNERSHIP_GRANT,
      ...VISIBILITY_UPDATE_GRANT,
    ]) {
      await sql.unsafe(statement);
    }
    await seedFixture(sql);
    await sql`
      UPDATE auth_authority_states
         SET authority_version = ${BA_AUTHORITY.authorityVersion},
             phase = ${BA_AUTHORITY.phase},
             directory_authority = ${BA_AUTHORITY.directoryAuthority},
             multi_tenant_released = ${BA_AUTHORITY.multiTenantReleased},
             updated_at = now()
       WHERE id = 1`;

    const db = createDatabase(setupUrl, { max: 3 });
    // The island's role URLs carry the login only; the verified capabilities
    // need the role-scoped connection (T06.01's recipe).
    const dataRoleUrl = new URL(process.env.BA_TEST_DATA_DATABASE_URL!.trim());
    dataRoleUrl.searchParams.set("options", "-c role=ob_ent_data");
    const operatorRoleUrl = new URL(
      process.env.BA_TEST_OPERATOR_DATABASE_URL!.trim(),
    );
    operatorRoleUrl.searchParams.set("options", "-c role=ob_ent_operator");
    const data = (await verifyDataDatabase(
      createDatabase(dataRoleUrl.href, { max: 2 }),
    )) as DataDatabase;
    const operator = (await verifyOperatorDatabase(
      createDatabase(operatorRoleUrl.href, { max: 2 }),
    )) as OperatorDatabase;

    const authority = createDirectoryAuthority();
    const assurance = createClosedCompanyAssurance({
      policy: { requiresProof: async () => false },
    });
    const resolver = createBaScopeResolver(db, {
      authenticate: (request) => {
        const actorId = request.headers.get("x-test-user");
        return Promise.resolve(
          actorId ? { actorId, entrypoint: "web" as const } : null,
        );
      },
      selectTenant: (request) => request.headers.get("x-openbot-tenant"),
      selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
      data: db,
      authority,
      assurance,
    });
    const scopeFor = async (actor: {
      user: string;
      tenant: string;
      workspace: string;
    }): Promise<PlatformScope> =>
      resolver.resolve(
        new Request("https://openbot.test/api/enterprise/scope", {
          headers: {
            "x-test-user": actor.user,
            "x-openbot-tenant": actor.tenant,
            "x-openbot-workspace": actor.workspace,
          },
        }),
      );

    // The installs and the connection go through the real admin service on the
    // restricted operator channel — the same surface production installs ride.
    const admin = createPluginCatalogAdminService(operator, vault);
    const installA = await admin.install({
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
      installedBy: PRINCIPAL_A,
      catalogId: CATALOG_ID,
      config: { region: "eu" },
    });
    const installA2 = await admin.install({
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A2,
      installedBy: PRINCIPAL_A2,
      catalogId: CATALOG_ID,
    });
    const installA1Only = await admin.install({
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
      installedBy: PRINCIPAL_A,
      catalogId: CATALOG_A1_ONLY,
    });
    const installB = await admin.install({
      tenantId: TENANT_B,
      workspaceId: WORKSPACE_B,
      installedBy: PRINCIPAL_B,
      catalogId: CATALOG_ID,
      secret: "t0605-company-b-secret",
    });
    const connectionB = await admin.bindConnection({
      tenantId: TENANT_B,
      installId: installB.installId,
      boundBy: PRINCIPAL_B,
      vendorRef: "t0605-vendor-b",
    });

    // The team-public components, published through the real service.
    const publisher = createSkillComponentService({ data, operator });
    const publishA = await publisher.publishComponent(
      await scopeFor({
        user: USER_A,
        tenant: TENANT_A,
        workspace: WORKSPACE_A,
      }),
      { name: COMPONENT_NAME },
    );
    if (publishA.outcome !== "allow") {
      throw new Error(`fixture publish failed: ${publishA.outcome}`);
    }
    const publishB = await publisher.publishComponent(
      await scopeFor({
        user: USER_B,
        tenant: TENANT_B,
        workspace: WORKSPACE_B,
      }),
      { name: COMPONENT_B_ONLY },
    );
    if (publishB.outcome !== "allow") {
      throw new Error(`fixture publish failed: ${publishB.outcome}`);
    }

    const marketplace = createMarketplaceInstallService({
      data,
      operator,
      catalog: {
        entries: [
          {
            slug: "t0605-expert",
            kind: "expert",
            name: "T06.05 expert",
            version: 2,
            defaultConfig: {},
          },
        ],
      },
    });

    const close = async () => {
      try {
        await cleanupSql(sql);
      } finally {
        await db.$client.close?.();
        await data.$client.close?.();
        await operator.$client.close?.();
        await sql.end({ timeout: 5 }).catch(() => {});
      }
    };
    return {
      data,
      operator,
      pluginDecisions: createPluginCatalogDecisionService(data),
      marketplace,
      installA,
      installA2,
      installA1Only,
      installB,
      connectionB,
      scopeFor,
      close,
    };
  } catch (error) {
    await cleanupSql(sql).catch(() => {});
    await sql.end({ timeout: 5 }).catch(() => {});
    throw error;
  }
}

function harness(): Harness {
  if (!state)
    throw new Error("plugin-component-scope harness is not initialized");
  return state;
}

const scopeA = () =>
  harness().scopeFor({
    user: USER_A,
    tenant: TENANT_A,
    workspace: WORKSPACE_A,
  });
const scopeA2 = () =>
  harness().scopeFor({
    user: USER_A2,
    tenant: TENANT_A,
    workspace: WORKSPACE_A2,
  });
const scopeB = () =>
  harness().scopeFor({
    user: USER_B,
    tenant: TENANT_B,
    workspace: WORKSPACE_B,
  });

describe("T06.05 plugin catalog template scope and component dependencies", () => {
  beforeAll(async () => {
    state = await createHarness();
  });
  afterAll(async () => {
    await state?.close();
    state = undefined;
  });

  test("global_template_does_not_reveal_private_install", async () => {
    // A company-A member of a team that did NOT install the A1-only entry:
    // the template itself is globally visible, the private installs — company
    // B's, and company A's own other team's — must not appear in the view.
    const view = await harness().pluginDecisions.describeTemplate(
      await scopeA2(),
      CATALOG_A1_ONLY,
    );
    expect(view.outcome).toBe("allow");
    const privateInstance =
      view.outcome === "allow" ? view.privateInstance : "unexpected";
    expect(privateInstance).toBeNull();
    // The null is scope-based, not entry-based: the team that DID install
    // this same entry sees its own install through the identical view.
    const viewA1 = await harness().pluginDecisions.describeTemplate(
      await scopeA(),
      CATALOG_A1_ONLY,
    );
    expect(viewA1.outcome).toBe("allow");
    if (viewA1.outcome !== "allow") return;
    expect(viewA1.privateInstance?.installId).toBe(
      harness().installA1Only.installId,
    );
    // Unknown template ids deny canonically (no existence signal).
    await expect(
      harness().pluginDecisions.describeTemplate(await scopeA2(), "t0605-none"),
    ).resolves.toEqual({ outcome: "deny", code: "RESOURCE_NOT_FOUND" });
  });

  test("entitled_team_sees_own_private_instance_on_template_view", async () => {
    const view = await harness().pluginDecisions.describeTemplate(
      await scopeA(),
      CATALOG_ID,
    );
    expect(view.outcome).toBe("allow");
    if (view.outcome !== "allow") return;
    expect(view.template.catalogId).toBe(CATALOG_ID);
    expect(view.privateInstance?.installId).toBe(harness().installA.installId);
    expect(view.privateInstance?.tenantId).toBe(TENANT_A);
    expect(view.privateInstance?.hasSecret).toBe(false);
    // Regression guard: the company-earliest install belongs to team A1, yet
    // team A2 — which installed later — still retrieves its own install, not
    // a null. Entitlement is evaluated per viewer team, not on the
    // company-earliest row.
    const viewA2 = await harness().pluginDecisions.describeTemplate(
      await scopeA2(),
      CATALOG_ID,
    );
    expect(viewA2.outcome).toBe("allow");
    if (viewA2.outcome !== "allow") return;
    expect(viewA2.privateInstance?.installId).toBe(
      harness().installA2.installId,
    );
    // Company B's own view answers with B's own install, never A's.
    const viewB = await harness().pluginDecisions.describeTemplate(
      await scopeB(),
      CATALOG_ID,
    );
    expect(viewB.outcome).toBe("allow");
    if (viewB.outcome !== "allow") return;
    expect(viewB.privateInstance?.installId).toBe(harness().installB.installId);
  });

  test("allowed_component_cannot_load_cross_company_dependency", async () => {
    let executed = false;
    const service = createSkillComponentService(
      { data: harness().data, operator: harness().operator },
      {
        onExecute: () => {
          executed = true;
        },
      },
    );
    const verdict = await service.invokeComponentFunction(await scopeA(), {
      name: COMPONENT_NAME,
      functionName: "render",
      dependencies: [
        { kind: "plugin-install", installId: harness().installB.installId },
      ],
    });
    expect(verdict.outcome).toBe("deny");
    expect(executed).toBe(false);
  });

  test("component_execution_loads_own_team_dependency", async () => {
    let executed = false;
    const service = createSkillComponentService(
      { data: harness().data, operator: harness().operator },
      {
        onExecute: () => {
          executed = true;
        },
      },
    );
    const verdict = await service.invokeComponentFunction(await scopeA(), {
      name: COMPONENT_NAME,
      functionName: "render",
      dependencies: [
        { kind: "plugin-install", installId: harness().installA.installId },
      ],
    });
    expect(verdict.outcome).toBe("allow");
    expect(executed).toBe(true);
  });

  test("component_execution_without_dependencies_still_allows", async () => {
    let executed = false;
    const service = createSkillComponentService(
      { data: harness().data, operator: harness().operator },
      {
        onExecute: () => {
          executed = true;
        },
      },
    );
    const verdict = await service.invokeComponentFunction(await scopeA(), {
      name: COMPONENT_NAME,
      functionName: "render",
    });
    expect(verdict.outcome).toBe("allow");
    expect(executed).toBe(true);
  });

  test("same_company_other_team_dependency_denies", async () => {
    const service = createSkillComponentService({
      data: harness().data,
      operator: harness().operator,
    });
    const verdict = await service.invokeComponentFunction(await scopeA(), {
      name: COMPONENT_NAME,
      functionName: "render",
      dependencies: [
        { kind: "plugin-install", installId: harness().installA2.installId },
      ],
    });
    expect(verdict).toEqual({ outcome: "deny", code: "RESOURCE_NOT_FOUND" });
  });

  test("cross_company_connection_and_component_dependencies_deny", async () => {
    const service = createSkillComponentService({
      data: harness().data,
      operator: harness().operator,
    });
    const byConnection = await service.invokeComponentFunction(await scopeA(), {
      name: COMPONENT_NAME,
      functionName: "render",
      dependencies: [
        {
          kind: "plugin-connection",
          connectionId: harness().connectionB.connectionId,
        },
      ],
    });
    expect(byConnection).toEqual({
      outcome: "deny",
      code: "RESOURCE_NOT_FOUND",
    });
    const byComponent = await service.invokeComponentFunction(await scopeA(), {
      name: COMPONENT_NAME,
      functionName: "render",
      dependencies: [{ kind: "component", name: COMPONENT_B_ONLY }],
    });
    expect(byComponent).toEqual({
      outcome: "deny",
      code: "RESOURCE_NOT_FOUND",
    });
  });

  test("marketplace_global_catalog_is_identical_for_every_company", async () => {
    const forA = await harness().marketplace.readCatalog(await scopeA());
    const forB = await harness().marketplace.readCatalog(await scopeB());
    expect(forA).toEqual(forB);
    expect(forA).toHaveLength(1);
    expect(Object.keys(forA[0]).sort()).toEqual([
      "kind",
      "name",
      "slug",
      "version",
    ]);
  });

  test("marketplace_receipts_stay_scoped_to_own_team", async () => {
    const receipts = await harness().marketplace.listInstalls(await scopeA());
    expect(receipts.map((receipt) => receipt.agentId)).toEqual(["t0605-mkt-a"]);
    const receiptsB = await harness().marketplace.listInstalls(await scopeB());
    expect(receiptsB.map((receipt) => receipt.agentId)).toEqual([
      "t0605-mkt-b",
    ]);
  });
});
