import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { TASKS } from "../../scripts/multitenancy/migrate-test";
import type { AgentProfileStore } from "../../src/agents/profile-store";
import type {
  AgentProfile,
  CreateAgentInput,
} from "../../src/agents/profile-types";
import { createAgentRoutes } from "../../src/agents/routes";
import { createClosedCompanyAssurance } from "../../src/auth/company-assurance";
import { createDirectoryAuthority } from "../../src/auth/directory/authority";
import type { AppVariables } from "../../src/auth/public";
import { createDatabase } from "../../src/db/client";
import {
  type DataDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyOperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import { createAgentsBotResourceActions } from "../../src/enterprise/tenancy/public-bot-usage";
import { createBaWorkspaceGate } from "../../src/enterprise/tenancy/scope-gate";
import { createBaScopeResolver } from "../../src/enterprise/tenancy/store";

/*
 * T06.01 (#565 lineage, original task P14) — the actual agents routes consume
 * the real resource-action decisions for Bot detail, edit, publish, and the
 * team-public run.
 *
 * What this suite pins, through the real HTTP surface (Hono app + the real
 * middleware chain) against the real services on the isolated BA_TEST_* island:
 *
 * - `same_team_private_bot_remains_private`: a same-team member — and a
 *   company admin with no team — gets the canonical 404 for another member's
 *   private Bot. The decision is the enterprise's (policy registry +
 *   ownership), taken BEFORE the profile store is consulted; the store stub
 *   below is deliberately permissive so the 404 can only come from the gate.
 * - `published_bot_can_run_without_disclosing_owner_connection`: the team run
 *   surface answers 200 with the runner's own conversation binding and
 *   credential selection, and carries none of the owner's connection
 *   material (endpoint, auth, callback token, owner principal).
 * - edit/publish/unpublish through the same PATCH route: owner keeps them,
 *   same-team members do not; unpublishing closes the team run path on the
 *   next request.
 * - the legacy and paused authority branches: with the port wired, the same
 *   two assertions stay green — the non-ba branches keep the original
 *   revalidation, byte for byte (T03.01's matrix applied to this surface).
 * - a suspended team membership denies the next request in real time.
 *
 * Fixture discipline (the better-auth island's standing recipe): the five
 * BA_TEST_* role URLs are required and must name one loopback
 * openbot_enterprise_* database; a missing URL is a blocked suite, never a
 * fallback to the shared/MT database, and no DSN is ever printed. The suite
 * applies the real 0221–0226 BA migrations plus the enterprise deltas its
 * services read (the MT009 dependency table and the restricted-role grants,
 * both taken from server/scripts/multitenancy/migrate-test.ts — the
 * migration's single source of truth, never re-typed here) and removes
 * exactly what it created.
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

const TENANT = "t0601-tenant";
const WORKSPACE = "t0601-workspace";
const TEAM = "t0601-team";
const OWNER_USER = "t0601-owner";
const MEMBER_USER = "t0601-member";
const ADMIN_USER = "t0601-admin";
const OWNER_PRINCIPAL = "t0601-principal-owner";
const MEMBER_PRINCIPAL = "t0601-principal-member";
const ADMIN_PRINCIPAL = "t0601-principal-admin";
const PRIVATE_BOT = "t0601-bot-private";
const PUBLISHED_BOT = "t0601-bot-published";
const FRESH_BOT = "t0601-bot-fresh";
const IDENTITY_GENERATION = 4;

const BA_AUTHORITY = {
  authorityVersion: 11,
  phase: "M4",
  directoryAuthority: "ba",
  multiTenantReleased: true,
} as const;
const LEGACY_AUTHORITY = {
  authorityVersion: 3,
  phase: "M1",
  directoryAuthority: "legacy",
  multiTenantReleased: false,
} as const;
const PAUSED_AUTHORITY = {
  authorityVersion: 7,
  phase: "M2",
  directoryAuthority: "paused",
  multiTenantReleased: false,
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

/** The enterprise deltas the island baseline predates; removed again at cleanup. */
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
] as const) {
  if (list.length !== 1) {
    throw new Error(
      `the migrate-test single source no longer carries exactly one ${name} statement (${list.length} found): update this suite's extraction before running it, never re-type the SQL here.`,
    );
  }
}

const cleanupSql = async (sql: postgres.Sql): Promise<void> => {
  await sql.unsafe(
    `DROP TABLE IF EXISTS ${BA_TABLES.map((name) => `"${name}"`).join(", ")} CASCADE`,
  );
  await sql`DELETE FROM enterprise_conversations WHERE tenant_id LIKE 't0601-%'`;
  await sql`DELETE FROM enterprise_bot_ownership WHERE tenant_id LIKE 't0601-%'`;
  await sql`DELETE FROM enterprise_resources WHERE tenant_id LIKE 't0601-%'`;
  await sql`DELETE FROM enterprise_workspace_memberships WHERE tenant_id LIKE 't0601-%'`;
  await sql`DELETE FROM enterprise_memberships WHERE tenant_id LIKE 't0601-%'`;
  await sql`DELETE FROM enterprise_principals WHERE id LIKE 't0601-%'`;
  await sql`DELETE FROM enterprise_workspaces WHERE tenant_id LIKE 't0601-%'`;
  await sql`DELETE FROM enterprise_tenants WHERE id LIKE 't0601-%'`;
  await sql`DELETE FROM users WHERE id LIKE 't0601-%'`;
  // The island's enterprise baseline predates the MT009 dependency table
  // (its rows cascade from the resources above).
  await sql.unsafe(`DROP TABLE IF EXISTS "enterprise_resource_dependencies"`);
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

async function setAuthority(
  sql: postgres.Sql,
  row: {
    authorityVersion: number;
    phase: string;
    directoryAuthority: string;
    multiTenantReleased: boolean;
  },
): Promise<void> {
  await sql`
    UPDATE auth_authority_states
       SET authority_version = ${row.authorityVersion},
           phase = ${row.phase},
           directory_authority = ${row.directoryAuthority},
           multi_tenant_released = ${row.multiTenantReleased},
           updated_at = now()
     WHERE id = 1`;
}

async function seedFixture(sql: postgres.Sql): Promise<void> {
  // One company, one team; the tenant runs the workspace-v1 policy so the
  // team-public read/run path exists for published Bots (MT011/MT017 recipe).
  await sql`
    INSERT INTO enterprise_tenants (id, name, policy_revision) VALUES
      (${TENANT}, 'T06.01 company', 'workspace-v1')`;
  await sql`
    INSERT INTO users (id, email) VALUES
      (${OWNER_USER}, 't0601-owner@example.test'),
      (${MEMBER_USER}, 't0601-member@example.test'),
      (${ADMIN_USER}, 't0601-admin@example.test')`;
  await sql`
    INSERT INTO enterprise_principals (id, user_id, identity_generation) VALUES
      (${OWNER_PRINCIPAL}, ${OWNER_USER}, ${IDENTITY_GENERATION}),
      (${MEMBER_PRINCIPAL}, ${MEMBER_USER}, ${IDENTITY_GENERATION}),
      (${ADMIN_PRINCIPAL}, ${ADMIN_USER}, ${IDENTITY_GENERATION})`;
  await sql`
    INSERT INTO enterprise_workspaces (tenant_id, id, name) VALUES
      (${TENANT}, ${WORKSPACE}, 'T06.01 team')`;
  await sql`
    INSERT INTO enterprise_memberships (tenant_id, principal_id, role, epoch) VALUES
      (${TENANT}, ${OWNER_PRINCIPAL}, 'member', 1),
      (${TENANT}, ${MEMBER_PRINCIPAL}, 'member', 1),
      (${TENANT}, ${ADMIN_PRINCIPAL}, 'tenant_admin', 1)`;
  await sql`
    INSERT INTO enterprise_workspace_memberships
      (tenant_id, workspace_id, principal_id, epoch)
    VALUES
      (${TENANT}, ${WORKSPACE}, ${OWNER_PRINCIPAL}, 1),
      (${TENANT}, ${WORKSPACE}, ${MEMBER_PRINCIPAL}, 1)`;
  // The BA directory facts of the ba branch. The company admin joins the
  // organization but no team: management identity, never content access.
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
        INSERT INTO auth_organizations (id, name, slug)
        VALUES (${TENANT}, 'T06.01 company', 't0601-company')`;
      await sql`
        INSERT INTO auth_teams (id, organization_id, name)
        VALUES (${TEAM}, ${TENANT}, 'T06.01 team')`;
      await sql`
        INSERT INTO auth_team_bindings (tenant_id, workspace_id, team_id)
        VALUES (${TENANT}, ${WORKSPACE}, ${TEAM})`;
      await sql`
        INSERT INTO auth_members (id, organization_id, user_id, role) VALUES
          ('t0601-ba-owner', ${TENANT}, ${OWNER_USER}, 'member'),
          ('t0601-ba-member', ${TENANT}, ${MEMBER_USER}, 'member'),
          ('t0601-ba-admin', ${TENANT}, ${ADMIN_USER}, 'admin')`;
      await sql`
        INSERT INTO auth_team_members (id, team_id, user_id) VALUES
          ('t0601-ba-team-owner', ${TEAM}, ${OWNER_USER}),
          ('t0601-ba-team-member', ${TEAM}, ${MEMBER_USER})`;
    },
  );
  // The durable two-layer clocks for both team members, at 1/1.
  await sql`
    INSERT INTO auth_eligibility_clocks
      (tenant_id, principal_id, kind, scope_id, epoch, generation, tombstone, last_command_id)
    VALUES
      (${TENANT}, ${OWNER_PRINCIPAL}, 'company', ${TENANT}, 1, 1, false, 't0601-c0'),
      (${TENANT}, ${OWNER_PRINCIPAL}, 'team', ${WORKSPACE}, 1, 1, false, 't0601-c0'),
      (${TENANT}, ${MEMBER_PRINCIPAL}, 'company', ${TENANT}, 1, 1, false, 't0601-c0'),
      (${TENANT}, ${MEMBER_PRINCIPAL}, 'team', ${WORKSPACE}, 1, 1, false, 't0601-c0')`;
  // Three Bots owned by the owner in the team: one private, one published to
  // the team, one not yet published (the publish flow's subject).
  await sql`
    INSERT INTO enterprise_bot_ownership
      (tenant_id, agent_id, workspace_id, owner_principal_id, display_name, default_config)
    VALUES
      (${TENANT}, ${PRIVATE_BOT}, ${WORKSPACE}, ${OWNER_PRINCIPAL}, 'T06.01 private Bot', '{}'),
      (${TENANT}, ${PUBLISHED_BOT}, ${WORKSPACE}, ${OWNER_PRINCIPAL}, 'T06.01 published Bot', '{}'),
      (${TENANT}, ${FRESH_BOT}, ${WORKSPACE}, ${OWNER_PRINCIPAL}, 'T06.01 fresh Bot', '{}')`;
  await sql`
    INSERT INTO enterprise_resources (tenant_id, id, workspace_id, kind, display_name, visibility)
    VALUES
      (${TENANT}, ${PRIVATE_BOT}, ${WORKSPACE}, 'bot', 'T06.01 private Bot', 'private'),
      (${TENANT}, ${PUBLISHED_BOT}, ${WORKSPACE}, 'bot', 'T06.01 published Bot', 'workspace')`;
}

interface Harness {
  readonly sql: postgres.Sql;
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
  readonly resolver: ReturnType<typeof createBaScopeResolver>;
  readonly gate: ReturnType<typeof createBaWorkspaceGate>;
  setAuthority(
    row: Parameters<typeof setAuthority>[1],
  ): ReturnType<typeof setAuthority>;
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
    // The MT009 dependency table (the run gate and the run entry read it),
    // applied from the migration's single source of truth.
    const dependencyTask = TASKS.get("MT009");
    if (!dependencyTask)
      throw new Error("MT009 missing from migrate-test TASKS");
    for (const step of dependencyTask.steps) {
      for (const statement of step.statements) {
        await sql.unsafe(statement);
      }
    }
    // The restricted-role grants the island's enterprise baseline predates.
    for (const statement of [
      ...WORKSPACE_MEMBERSHIP_GRANT,
      ...BOT_OWNERSHIP_GRANT,
      ...VISIBILITY_UPDATE_GRANT,
    ]) {
      await sql.unsafe(statement);
    }
    await seedFixture(sql);
    await setAuthority(sql, BA_AUTHORITY);

    const db = createDatabase(setupUrl, { max: 3 });
    // The island's role URLs carry the login only; the verified capabilities
    // need the role-scoped connection — the shape the island's auth-writer
    // URL spells with its options parameter (scoped-team-admin's recipe).
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
      createDatabase(operatorRoleUrl.href, {
        max: 2,
      }),
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
    const gate = createBaWorkspaceGate(db, { authority, assurance });
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
      sql,
      data,
      operator,
      resolver,
      gate,
      setAuthority: (row) => setAuthority(sql, row),
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
    throw new Error("bot-resource-actions harness is not initialized");
  return state;
}

// ---------------------------------------------------------------------------
// The HTTP surface: the real routes factory with a permissive profile store.
// ---------------------------------------------------------------------------

const actors = {
  [OWNER_USER]: {
    id: OWNER_USER,
    email: "t0601-owner@example.test",
    role: "user",
  },
  [MEMBER_USER]: {
    id: MEMBER_USER,
    email: "t0601-member@example.test",
    role: "user",
  },
  [ADMIN_USER]: {
    id: ADMIN_USER,
    email: "t0601-admin@example.test",
    role: "user",
  },
} as const;

function profile(id: string): AgentProfile {
  return {
    id,
    name: "T06.01 Bot",
    title: "T06.01 Bot",
    roleDescription: "The T06.01 fixture Bot.",
    avatarSeed: "t0601",
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    visibility: "private",
    ownerUserId: OWNER_USER,
    systemOwned: false,
    hidden: false,
    pinned: false,
    deletedAt: null,
  };
}

/**
 * The shared profile store, deliberately permissive: it returns any Bot to
 * any caller. Visibility on this surface is the enterprise decision's job —
 * a permissive store is what makes "the gate returned the 404" the only way
 * the private-Bot cases can pass, instead of the store's own filter.
 */
const store: AgentProfileStore = {
  async list() {
    return [profile(PRIVATE_BOT)];
  },
  async listAll() {
    return [profile(PRIVATE_BOT)];
  },
  async get(_actor, id) {
    return profile(id);
  },
  async getWithin(_executor, _actor, id) {
    return profile(id);
  },
  async create(actor, _input) {
    return profile(actor.id);
  },
  async update(_actor, id, input) {
    return { ...profile(id), ...input };
  },
  async duplicate(_actor, id) {
    return profile(`${id}-copy`);
  },
  async setHidden() {},
  async setPinned() {},
  async softDelete() {},
  async issueCallbackToken() {
    return "not-issued-in-this-suite";
  },
  async revokeCallbackToken() {},
  async hardDelete() {},
  async enumerateOwner() {
    return [];
  },
  async agentForCallbackToken() {
    return null;
  },
};

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  const who = context.req.header("x-test-user") ?? OWNER_USER;
  context.set(
    "actor",
    actors[who as keyof typeof actors] ?? {
      id: who,
      email: `${who}@example.test`,
      role: "user",
    },
  );
  await next();
};

const patchInput = (visibility: string): CreateAgentInput => ({
  name: "T06.01 Bot",
  title: "T06.01 Bot",
  roleDescription: "The T06.01 fixture Bot.",
  visibility: visibility as CreateAgentInput["visibility"],
});

/** The keys no run answer may carry: the owner's connection material. */
const SECRET_KEYS = new Set([
  "endpoint",
  "auth",
  "authHeader",
  "authValue",
  "hasAuth",
  "token",
  "callbackToken",
  "envelope",
  "secret",
  "key",
  "ownerPrincipalId",
  "ownerUserId",
  "credentialSecret",
]);

function secretFieldsIn(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => secretFieldsIn(item, prefix));
  }
  if (value !== null && typeof value === "object") {
    const fields: string[] = [];
    for (const [key, nested] of Object.entries(value)) {
      const name = prefix ? `${prefix}.${key}` : key;
      if (SECRET_KEYS.has(key)) fields.push(name);
      fields.push(...secretFieldsIn(nested, name));
    }
    return fields;
  }
  return [];
}

// ---------------------------------------------------------------------------
// The wired surface: the production port from the tenancy side, the same
// object the deployment's assembly hands the routes factory.
// ---------------------------------------------------------------------------

async function wiredApp(): Promise<Hono<{ Variables: AppVariables }>> {
  const { resolver, gate, data, operator } = harness();
  const actions = createAgentsBotResourceActions({
    data,
    operator,
    resolveScope: resolver,
    gate,
  });
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createAgentRoutes(
      store,
      requireUser,
      false,
      undefined,
      new Set(),
      undefined,
      false,
      undefined,
      undefined,
      // The enterprise action port: absent, this factory is exactly the
      // legacy surface (the existing suites pin that default).
      actions,
    ),
  );
  return app;
}

async function callAs(
  app: Hono<{ Variables: AppVariables }>,
  userId: string,
  path: string,
  init?: { readonly method?: string; readonly body?: unknown },
): Promise<Response> {
  return app.request(path, {
    method: init?.method ?? "GET",
    headers: {
      "x-test-user": userId,
      "x-openbot-tenant": TENANT,
      "x-openbot-workspace": WORKSPACE,
      ...(init?.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

describe("T06.01 bot resource actions (agents routes on real decisions)", () => {
  beforeAll(async () => {
    state = await createHarness();
  });

  afterAll(async () => {
    const current = state;
    state = undefined;
    await current?.close();
  });

  test("same_team_private_bot_remains_private", async () => {
    const app = await wiredApp();
    const otherMemberStatus = (
      await callAs(app, MEMBER_USER, `/${PRIVATE_BOT}`)
    ).status;
    expect(otherMemberStatus).toBe(404);
  });

  test("published_bot_can_run_without_disclosing_owner_connection", async () => {
    const app = await wiredApp();
    const response = await callAs(app, MEMBER_USER, `/${PUBLISHED_BOT}/run`, {
      method: "POST",
      body: { threadKey: "named-case" },
    });
    const runStatus = response.status;
    const payload = (await response.json()) as unknown;
    const secretFields = secretFieldsIn(payload);
    expect(runStatus).toBe(200);
    expect(secretFields).toEqual([]);
    // The conversation binding is the runner's own, never the owner's.
    const run = (payload as { run?: { threadId?: string } }).run;
    expect(run?.threadId).toContain(MEMBER_PRINCIPAL);
  });

  test("same_team_member_cannot_edit_or_publish_a_private_bot", async () => {
    const app = await wiredApp();
    const edit = await callAs(app, MEMBER_USER, `/${PRIVATE_BOT}`, {
      method: "PATCH",
      body: patchInput("private"),
    });
    expect(edit.status).toBe(404);
    const publishAttempt = await callAs(app, MEMBER_USER, `/${PRIVATE_BOT}`, {
      method: "PATCH",
      body: patchInput("public"),
    });
    expect(publishAttempt.status).toBe(404);
  });

  test("same_team_member_cannot_edit_a_published_bot", async () => {
    const app = await wiredApp();
    const response = await callAs(app, MEMBER_USER, `/${PUBLISHED_BOT}`, {
      method: "PATCH",
      body: patchInput("private"),
    });
    expect(response.status).toBe(403);
  });

  test("company_admin_role_is_not_content_management", async () => {
    const app = await wiredApp();
    const read = (await callAs(app, ADMIN_USER, `/${PRIVATE_BOT}`)).status;
    expect(read).toBe(404);
    const edit = await callAs(app, ADMIN_USER, `/${PRIVATE_BOT}`, {
      method: "PATCH",
      body: patchInput("private"),
    });
    expect(edit.status).toBe(404);
  });

  test("owner_publishes_and_unpublishes_through_the_route", async () => {
    const app = await wiredApp();
    // Owner edit of their own unpublished Bot keeps working, DTO unchanged.
    const edit = await callAs(app, OWNER_USER, `/${FRESH_BOT}`, {
      method: "PATCH",
      body: patchInput("private"),
    });
    expect(edit.status).toBe(200);
    const edited = (await edit.json()) as { agent?: { id?: string } };
    expect(edited.agent?.id).toBe(FRESH_BOT);
    // Publishing rides the same edit: the team can then run it.
    const publish = await callAs(app, OWNER_USER, `/${FRESH_BOT}`, {
      method: "PATCH",
      body: patchInput("public"),
    });
    expect(publish.status).toBe(200);
    const runAfterPublish = await callAs(
      app,
      MEMBER_USER,
      `/${FRESH_BOT}/run`,
      {
        method: "POST",
        body: { threadKey: "after-publish" },
      },
    );
    expect(runAfterPublish.status).toBe(200);
    // Unpublishing closes the team run path on the next request.
    const unpublish = await callAs(app, OWNER_USER, `/${FRESH_BOT}`, {
      method: "PATCH",
      body: patchInput("private"),
    });
    expect(unpublish.status).toBe(200);
    const runAfterUnpublish = await callAs(
      app,
      MEMBER_USER,
      `/${FRESH_BOT}/run`,
      { method: "POST", body: { threadKey: "after-unpublish" } },
    );
    expect(runAfterUnpublish.status).toBe(404);
  });

  test("legacy_and_paused_authority_keep_the_family_green", async () => {
    const app = await wiredApp();
    for (const scenario of [LEGACY_AUTHORITY, PAUSED_AUTHORITY]) {
      await harness().setAuthority(scenario);
      const privateRead = (await callAs(app, MEMBER_USER, `/${PRIVATE_BOT}`))
        .status;
      expect(privateRead).toBe(404);
      const run = await callAs(app, MEMBER_USER, `/${PUBLISHED_BOT}/run`, {
        method: "POST",
        body: { threadKey: `matrix-${scenario.phase}` },
      });
      expect(run.status).toBe(200);
    }
    await harness().setAuthority(BA_AUTHORITY);
  });

  test("suspended_team_membership_denies_the_next_request", async () => {
    const app = await wiredApp();
    await harness().sql`
      UPDATE enterprise_workspace_memberships SET status = 'suspended'
       WHERE tenant_id = ${TENANT} AND workspace_id = ${WORKSPACE}
         AND principal_id = ${MEMBER_PRINCIPAL}`;
    try {
      const run = await callAs(app, MEMBER_USER, `/${PUBLISHED_BOT}/run`, {
        method: "POST",
        body: { threadKey: "suspended" },
      });
      expect(run.status).toBe(404);
    } finally {
      await harness().sql`
        UPDATE enterprise_workspace_memberships SET status = 'active'
         WHERE tenant_id = ${TENANT} AND workspace_id = ${WORKSPACE}
           AND principal_id = ${MEMBER_PRINCIPAL}`;
    }
  });
});
