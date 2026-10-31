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
import type { AgentProfile } from "../../src/agents/profile-types";
import type { AgentActor } from "../../src/agents/public";
import { createClosedCompanyAssurance } from "../../src/auth/company-assurance";
import { createDirectoryAuthority } from "../../src/auth/directory/authority";
import type { AppVariables } from "../../src/auth/public";
import {
  createChannelRoutes,
  createChannelStore,
} from "../../src/channels/routes";
import { createThreadIdentity } from "../../src/channels/thread-identity";
import type { ThreadReader } from "../../src/channels/thread-routes";
import { createThreadRoutes } from "../../src/channels/thread-routes";
import { createDatabase } from "../../src/db/client";
import {
  type DataDatabase,
  verifyDataDatabase,
} from "../../src/enterprise/tenancy/connections";
import { createConversationScopeActions } from "../../src/enterprise/tenancy/conversation-actions";
import { createBaWorkspaceGate } from "../../src/enterprise/tenancy/scope-gate";
import { createBaScopeResolver } from "../../src/enterprise/tenancy/store";

/*
 * T06.02 (#574 lineage, original task P14) — the channel and thread surfaces
 * consume the real conversation-scope decisions: a channel's conversation is
 * judged by its stable root and its creator, and a child thread cannot reach
 * past its parent's company.
 *
 * What this suite pins, through the real HTTP surface (Hono app + the real
 * middleware chain) against the real services on the isolated BA_TEST_* island:
 *
 * - `same_team_private_conversation_remains_private`: a same-team member who
 *   was shared the channel through the legacy path (membership + mapping, no
 *   enterprise grant — the state a post-backfill legacy share leaves) gets the
 *   canonical 404 for the detail read, and the roster's filtered page shows
 *   nothing. The decision is the enterprise's (root + conversation creator +
 *   MT008 policy registry, consumed from T06.01), taken BEFORE the store is
 *   consulted; the store stub below is deliberately permissive so the 404 can
 *   only come from the gate.
 * - `child_thread_cannot_cross_parent_company`: the same person, scoped to
 *   their second company, asks the thread-status route about a thread whose
 *   parent root is anchored in the first company — the reader operation is
 *   never invoked (operationCalls === 0) and the answer is the canonical 404.
 * - the creator keeps the family green: their own detail read, rename, roster
 *   row, and thread-status check all answer as before, DTO unchanged.
 * - an ungoverned thread (no conversation row, no channel mapping — the
 *   scratch/foreign thread the route documents) keeps the legacy check: the
 *   reader IS consulted and answers 200. The port must not over-deny.
 *
 * Fixture discipline (the better-auth island's standing recipe): the five
 * BA_TEST_* role URLs are required and must name one loopback
 * openbot_enterprise_* database; a missing URL is a blocked suite, never a
 * fallback to the shared/MT database, and no DSN is ever printed. The suite
 * applies the real 0221–0226 BA migrations, the workspace-membership grant
 * from the migration's single source (migrate-test TASKS), and the
 * intelligence_channel_mappings column grant from 0057 (the enterprise
 * conversation service's own source for it) — never re-typed here — and
 * removes exactly what it created.
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

const TENANT_A = "t0602-tenant-a";
const TENANT_B = "t0602-tenant-b";
const WORKSPACE_A = "t0602-workspace-a";
const WORKSPACE_B = "t0602-workspace-b";
const TEAM_A = "t0602-team-a";
const TEAM_B = "t0602-team-b";
const OWNER_USER = "t0602-owner";
const MEMBER_USER = "t0602-member";
const OWNER_PRINCIPAL = "t0602-principal-owner";
const MEMBER_PRINCIPAL = "t0602-principal-member";
const BOT = "t0602-bot";
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
for (const [name, list] of [
  ["workspace-membership grants", WORKSPACE_MEMBERSHIP_GRANT],
] as const) {
  if (list.length !== 1) {
    throw new Error(
      `the migrate-test single source no longer carries exactly one ${name} statement (${list.length} found): update this suite's extraction before running it, never re-type the SQL here.`,
    );
  }
}

/*
 * The intelligence_channel_mappings column grant the conversation-scope port
 * reads under, extracted from 0057 — the same source the enterprise
 * conversation service's own reads rely on. Exactly one statement, or this
 * suite refuses rather than guessing.
 */
const MAPPING_GRANT_MATCHES =
  loadMigrationSql("0057_enterprise_conversations").match(
    /^GRANT SELECT \([^)]*\) ON TABLE "intelligence_channel_mappings" TO ob_ent_data;/gm,
  ) ?? [];
if (MAPPING_GRANT_MATCHES.length !== 1) {
  throw new Error(
    `0057 no longer carries exactly one intelligence_channel_mappings data-role grant (${MAPPING_GRANT_MATCHES.length} found): update this suite's extraction before running it, never re-type the SQL here.`,
  );
}
const MAPPING_GRANT = MAPPING_GRANT_MATCHES[0];
const MAPPING_GRANT_REVOKE =
  'REVOKE SELECT ("thread_id", "user_id", "channel_id", "created_at", "updated_at") ON TABLE "intelligence_channel_mappings" FROM ob_ent_data';

const cleanupSql = async (sql: postgres.Sql): Promise<void> => {
  await sql.unsafe(
    `DROP TABLE IF EXISTS ${BA_TABLES.map((name) => `"${name}"`).join(", ")} CASCADE`,
  );
  // The legacy channel tree this suite creates (channels cascades mappings,
  // memberships, channel agents, and attachments).
  await sql`DELETE FROM intelligence_channel_mappings WHERE user_id LIKE 't0602-%'`;
  await sql`DELETE FROM channels WHERE id IN (
    SELECT ca.channel_id FROM channel_agents ca
    JOIN agents a ON a.id = ca.agent_id WHERE a.id LIKE 't0602-%')`;
  await sql`DELETE FROM agent_profiles WHERE owner_user_id LIKE 't0602-%'`;
  await sql`DELETE FROM agents WHERE id LIKE 't0602-%'`;
  await sql`DELETE FROM enterprise_conversations WHERE tenant_id LIKE 't0602-%'`;
  await sql`DELETE FROM enterprise_resource_grants WHERE tenant_id LIKE 't0602-%'`;
  await sql`DELETE FROM enterprise_resources WHERE tenant_id LIKE 't0602-%'`;
  await sql`DELETE FROM enterprise_workspace_memberships WHERE tenant_id LIKE 't0602-%'`;
  await sql`DELETE FROM enterprise_memberships WHERE tenant_id LIKE 't0602-%'`;
  await sql`DELETE FROM enterprise_workspaces WHERE tenant_id LIKE 't0602-%'`;
  await sql`DELETE FROM enterprise_principals WHERE id LIKE 't0602-%'`;
  await sql`DELETE FROM enterprise_tenants WHERE id LIKE 't0602-%'`;
  await sql`DELETE FROM users WHERE id LIKE 't0602-%'`;
  // The restricted-role grants the baseline predates (measured on the island).
  await sql.unsafe(
    `REVOKE SELECT ON TABLE "enterprise_workspace_memberships" FROM ob_ent_directory, ob_ent_data, ob_ent_operator`,
  );
  await sql.unsafe(MAPPING_GRANT_REVOKE);
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
  row: typeof BA_AUTHORITY | typeof LEGACY_AUTHORITY | typeof PAUSED_AUTHORITY,
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
  // Two companies. The owner belongs to both — the cross-company case is the
  // same person scoped to their second company, which is exactly the caller
  // the legacy user-keyed surfaces cannot tell apart.
  await sql`
    INSERT INTO enterprise_tenants (id, name, policy_revision) VALUES
      (${TENANT_A}, 'T06.02 company A', 'workspace-v1'),
      (${TENANT_B}, 'T06.02 company B', 'workspace-v1')`;
  await sql`
    INSERT INTO users (id, email) VALUES
      (${OWNER_USER}, 't0602-owner@example.test'),
      (${MEMBER_USER}, 't0602-member@example.test')`;
  await sql`
    INSERT INTO enterprise_principals (id, user_id, identity_generation) VALUES
      (${OWNER_PRINCIPAL}, ${OWNER_USER}, ${IDENTITY_GENERATION}),
      (${MEMBER_PRINCIPAL}, ${MEMBER_USER}, ${IDENTITY_GENERATION})`;
  await sql`
    INSERT INTO enterprise_workspaces (tenant_id, id, name) VALUES
      (${TENANT_A}, ${WORKSPACE_A}, 'T06.02 team A'),
      (${TENANT_B}, ${WORKSPACE_B}, 'T06.02 team B')`;
  await sql`
    INSERT INTO enterprise_memberships (tenant_id, principal_id, role, epoch) VALUES
      (${TENANT_A}, ${OWNER_PRINCIPAL}, 'member', 1),
      (${TENANT_A}, ${MEMBER_PRINCIPAL}, 'member', 1),
      (${TENANT_B}, ${OWNER_PRINCIPAL}, 'member', 1)`;
  await sql`
    INSERT INTO enterprise_workspace_memberships
      (tenant_id, workspace_id, principal_id, epoch)
    VALUES
      (${TENANT_A}, ${WORKSPACE_A}, ${OWNER_PRINCIPAL}, 1),
      (${TENANT_A}, ${WORKSPACE_A}, ${MEMBER_PRINCIPAL}, 1),
      (${TENANT_B}, ${WORKSPACE_B}, ${OWNER_PRINCIPAL}, 1)`;
  // The BA directory facts of the ba branch, for both companies.
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
          (${TENANT_A}, 'T06.02 company A', 't0602-company-a'),
          (${TENANT_B}, 'T06.02 company B', 't0602-company-b')`;
      await sql`
        INSERT INTO auth_teams (id, organization_id, name) VALUES
          (${TEAM_A}, ${TENANT_A}, 'T06.02 team A'),
          (${TEAM_B}, ${TENANT_B}, 'T06.02 team B')`;
      await sql`
        INSERT INTO auth_team_bindings (tenant_id, workspace_id, team_id) VALUES
          (${TENANT_A}, ${WORKSPACE_A}, ${TEAM_A}),
          (${TENANT_B}, ${WORKSPACE_B}, ${TEAM_B})`;
      await sql`
        INSERT INTO auth_members (id, organization_id, user_id, role) VALUES
          ('t0602-ba-owner-a', ${TENANT_A}, ${OWNER_USER}, 'member'),
          ('t0602-ba-member-a', ${TENANT_A}, ${MEMBER_USER}, 'member'),
          ('t0602-ba-owner-b', ${TENANT_B}, ${OWNER_USER}, 'member')`;
      await sql`
        INSERT INTO auth_team_members (id, team_id, user_id) VALUES
          ('t0602-ba-team-owner-a', ${TEAM_A}, ${OWNER_USER}),
          ('t0602-ba-team-member-a', ${TEAM_A}, ${MEMBER_USER}),
          ('t0602-ba-team-owner-b', ${TEAM_B}, ${OWNER_USER})`;
    },
  );
  // The durable two-layer clocks, at 1/1, for every principal/company pair.
  await sql`
    INSERT INTO auth_eligibility_clocks
      (tenant_id, principal_id, kind, scope_id, epoch, generation, tombstone, last_command_id)
    VALUES
      (${TENANT_A}, ${OWNER_PRINCIPAL}, 'company', ${TENANT_A}, 1, 1, false, 't0602-c0'),
      (${TENANT_A}, ${OWNER_PRINCIPAL}, 'team', ${WORKSPACE_A}, 1, 1, false, 't0602-c0'),
      (${TENANT_A}, ${MEMBER_PRINCIPAL}, 'company', ${TENANT_A}, 1, 1, false, 't0602-c0'),
      (${TENANT_A}, ${MEMBER_PRINCIPAL}, 'team', ${WORKSPACE_A}, 1, 1, false, 't0602-c0'),
      (${TENANT_B}, ${OWNER_PRINCIPAL}, 'company', ${TENANT_B}, 1, 1, false, 't0602-c0'),
      (${TENANT_B}, ${OWNER_PRINCIPAL}, 'team', ${WORKSPACE_B}, 1, 1, false, 't0602-c0')`;
  // The Bot the channel roster holds: the agents row satisfies the roster's
  // FK, the profile row is what the channel store's reads join on.
  await sql`
    INSERT INTO agents (id, name, type, configuration) VALUES
      (${BOT}, 'T06.02 Bot', 'built_in', '{}')`;
  await sql`
    INSERT INTO agent_profiles
      (agent_id, owner_user_id, title, role_description, avatar_seed, visibility)
    VALUES
      (${BOT}, ${OWNER_USER}, 'T06.02 Bot', 'The T06.02 fixture Bot.', 't0602', 'private')`;
}

interface Harness {
  readonly sql: postgres.Sql;
  readonly db: ReturnType<typeof createDatabase>;
  readonly data: DataDatabase;
  readonly resolver: ReturnType<typeof createBaScopeResolver>;
  readonly gate: ReturnType<typeof createBaWorkspaceGate>;
  readonly identity: ReturnType<typeof createThreadIdentity>;
  readonly channelStore: ReturnType<typeof createChannelStore>;
  readonly ownerThreadId: string;
  readonly channelId: string;
  readonly memberThreadId: string;
  setAuthority(
    row:
      | typeof BA_AUTHORITY
      | typeof LEGACY_AUTHORITY
      | typeof PAUSED_AUTHORITY,
  ): Promise<void>;
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
    for (const statement of [...WORKSPACE_MEMBERSHIP_GRANT, MAPPING_GRANT]) {
      await sql.unsafe(statement);
    }
    await seedFixture(sql);
    await setAuthority(sql, BA_AUTHORITY);

    const db = createDatabase(setupUrl, { max: 3 });
    const identity = createThreadIdentity("t0602-deployment");
    const channelStore = createChannelStore(db, profileStore, identity);
    // The channel under test, created through the real store: channels row,
    // creator membership, channel agents, and the creator's thread mapping.
    const channel = await channelStore.create(ownerActor, [BOT]);
    // The enterprise world's facts for it: the stable root (private), the
    // creator's read grant, and the conversation root that names the creator.
    await sql`
      INSERT INTO enterprise_resources
        (tenant_id, id, workspace_id, kind, display_name, visibility)
      VALUES
        (${TENANT_A}, ${channel.id}, ${WORKSPACE_A}, 'channel', 'T06.02 private channel', 'private')`;
    await sql`
      INSERT INTO enterprise_resource_grants
        (tenant_id, resource_id, principal_id, action)
      VALUES
        (${TENANT_A}, ${channel.id}, ${OWNER_PRINCIPAL}, 'read')`;
    await sql`
      INSERT INTO enterprise_conversations
        (tenant_id, workspace_id, principal_id, thread_id, title, storage_backend)
      VALUES
        (${TENANT_A}, ${WORKSPACE_A}, ${OWNER_PRINCIPAL}, ${channel.threadId}, 'T06.02 owner conversation', 'platform')`;
    // The same-team member's legacy share: membership plus their own thread
    // mapping, exactly what the legacy path writes for a shared channel — and
    // no enterprise grant, the state a post-backfill legacy share leaves.
    const memberThreadId = identity.mint();
    await sql`
      INSERT INTO channel_memberships (channel_id, user_id)
      VALUES (${channel.id}, ${MEMBER_USER})`;
    await sql`
      INSERT INTO intelligence_channel_mappings (user_id, channel_id, thread_id)
      VALUES (${MEMBER_USER}, ${channel.id}, ${memberThreadId})`;

    // The island's role URLs carry the login only; the verified capabilities
    // need the role-scoped connection (scoped-team-admin's recipe).
    const dataRoleUrl = new URL(process.env.BA_TEST_DATA_DATABASE_URL!.trim());
    dataRoleUrl.searchParams.set("options", "-c role=ob_ent_data");
    const data = (await verifyDataDatabase(
      createDatabase(dataRoleUrl.href, { max: 2 }),
    )) as DataDatabase;
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
        await sql.end({ timeout: 5 }).catch(() => {});
      }
    };
    return {
      sql,
      db,
      data,
      resolver,
      gate,
      identity,
      channelStore,
      ownerThreadId: channel.threadId,
      channelId: channel.id,
      memberThreadId,
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
    throw new Error("conversation-scope-actions harness is not initialized");
  return state;
}

// ---------------------------------------------------------------------------
// The HTTP surface: the real route factories with a permissive profile store.
// ---------------------------------------------------------------------------

const ownerActor: AgentActor = {
  id: OWNER_USER,
  email: "t0602-owner@example.test",
  role: "user",
};

function profile(id: string): AgentProfile {
  return {
    id,
    name: "T06.02 Bot",
    title: "T06.02 Bot",
    roleDescription: "The T06.02 fixture Bot.",
    avatarSeed: "t0602",
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
 * the private cases can pass, instead of the store's own filter.
 */
const profileStore: AgentProfileStore = {
  async list() {
    return [profile(BOT)];
  },
  async listAll() {
    return [profile(BOT)];
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
    return { ...profile(id), ...input } as AgentProfile;
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
  context.set("actor", {
    id: who,
    email: `${who}@example.test`,
    role: "user",
  });
  await next();
};

async function channelApp(): Promise<Hono<{ Variables: AppVariables }>> {
  const { channelStore, data, resolver, gate } = harness();
  const actions = createConversationScopeActions({
    data,
    resolveScope: resolver,
    gate,
  });
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createChannelRoutes(
      channelStore,
      requireUser,
      undefined,
      undefined,
      // The enterprise action port: absent, this factory is exactly the
      // legacy surface (the existing suites pin that default).
      actions,
    ),
  );
  return app;
}

function countingReader(): { reader: ThreadReader; calls: () => number } {
  let calls = 0;
  const reader: ThreadReader = async () => {
    calls += 1;
    return "known";
  };
  return { reader, calls: () => calls };
}

async function threadApp(
  reader: ThreadReader,
): Promise<Hono<{ Variables: AppVariables }>> {
  const { data, resolver, gate } = harness();
  const actions = createConversationScopeActions({
    data,
    resolveScope: resolver,
    gate,
  });
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createThreadRoutes(harness().identity, requireUser, reader, actions),
  );
  return app;
}

function callAs(
  app: Hono<{ Variables: AppVariables }>,
  userId: string,
  path: string,
  init?: { readonly method?: string; readonly body?: unknown },
  company: "a" | "b" = "a",
): Promise<Response> {
  return app.request(path, {
    method: init?.method ?? "GET",
    headers: {
      "x-test-user": userId,
      "x-openbot-tenant": company === "a" ? TENANT_A : TENANT_B,
      "x-openbot-workspace": company === "a" ? WORKSPACE_A : WORKSPACE_B,
      ...(init?.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

/*
 * One more enterprise channel, with the member's legacy-share shape
 * (membership plus their own thread mapping) and a conversation root the
 * owner holds. `visibility` decides what the T06.01 policy answers for the
 * member: "workspace" = team-public, so the member sees the channel without
 * owning its conversation; "private" = the member never sees it.
 */
async function seedSharedChannel(
  visibility: "private" | "workspace",
): Promise<string> {
  const { sql, channelStore, identity } = harness();
  const channel = await channelStore.create(ownerActor, [BOT]);
  await sql`
    INSERT INTO enterprise_resources
      (tenant_id, id, workspace_id, kind, display_name, visibility)
    VALUES
      (${TENANT_A}, ${channel.id}, ${WORKSPACE_A}, 'channel', ${`T06.02 ${visibility} channel`}, ${visibility})`;
  await sql`
    INSERT INTO enterprise_conversations
      (tenant_id, workspace_id, principal_id, thread_id, title, storage_backend)
    VALUES
      (${TENANT_A}, ${WORKSPACE_A}, ${OWNER_PRINCIPAL}, ${channel.threadId}, 'T06.02 owner conversation', 'platform')`;
  await sql`
    INSERT INTO channel_memberships (channel_id, user_id)
    VALUES (${channel.id}, ${MEMBER_USER})`;
  await sql`
    INSERT INTO intelligence_channel_mappings (user_id, channel_id, thread_id)
    VALUES (${MEMBER_USER}, ${channel.id}, ${identity.mint()})`;
  return channel.id;
}

describe("T06.02 conversation scope actions (channels and threads on real decisions)", () => {
  beforeAll(async () => {
    state = await createHarness();
  });

  afterAll(async () => {
    const current = state;
    state = undefined;
    await current?.close();
  });

  test("same_team_private_conversation_remains_private", async () => {
    const app = await channelApp();
    const status = (await callAs(app, MEMBER_USER, `/${harness().channelId}`))
      .status;
    expect(status).toBe(404);
  });

  test("child_thread_cannot_cross_parent_company", async () => {
    const { reader, calls } = countingReader();
    const app = await threadApp(reader);
    // The same person, scoped to their second company: the thread's parent
    // root is anchored in company A, so the reader is never even asked.
    const response = await callAs(
      app,
      OWNER_USER,
      `/${harness().ownerThreadId}`,
      undefined,
      "b",
    );
    expect(response.status).toBe(404);
    expect(calls()).toBe(0);
  });

  test("owner_keeps_detail_rename_roster_and_thread_check", async () => {
    const app = await channelApp();
    const detail = await callAs(app, OWNER_USER, `/${harness().channelId}`);
    expect(detail.status).toBe(200);
    const channel = (await detail.json()) as {
      channel?: { id?: string; threadId?: string };
    };
    expect(channel.channel?.id).toBe(harness().channelId);
    expect(channel.channel?.threadId).toBe(harness().ownerThreadId);
    const rename = await callAs(app, OWNER_USER, `/${harness().channelId}`, {
      method: "PATCH",
      body: { name: "Renamed by the creator" },
    });
    expect(rename.status).toBe(200);
    const roster = await callAs(app, OWNER_USER, "/");
    const page = (await roster.json()) as {
      channels?: Array<{ id?: string }>;
    };
    expect(page.channels?.some((row) => row.id === harness().channelId)).toBe(
      true,
    );
    const { reader, calls } = countingReader();
    const threads = await threadApp(reader);
    const status = await callAs(
      threads,
      OWNER_USER,
      `/${harness().ownerThreadId}`,
    );
    expect(status.status).toBe(200);
    expect(calls()).toBe(1);
  });

  test("member_cannot_mutate_or_list_the_private_channel", async () => {
    const app = await channelApp();
    const rename = await callAs(app, MEMBER_USER, `/${harness().channelId}`, {
      method: "PATCH",
      body: { name: "Renamed by a teammate" },
    });
    expect(rename.status).toBe(404);
    const archive = await callAs(
      app,
      MEMBER_USER,
      `/${harness().channelId}/archive`,
      { method: "POST" },
    );
    expect(archive.status).toBe(404);
    // The roster's filtered page shows nothing, and no count leaks: the page
    // itself is empty rather than shortened.
    const roster = await callAs(app, MEMBER_USER, "/");
    const page = (await roster.json()) as {
      channels?: Array<{ id?: string }>;
      nextCursor?: string | null;
    };
    expect(page.channels).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  test("same_team_member_thread_check_is_canonical_not_found", async () => {
    const { reader, calls } = countingReader();
    const app = await threadApp(reader);
    const status = await callAs(
      app,
      MEMBER_USER,
      `/${harness().ownerThreadId}`,
    );
    expect(status.status).toBe(404);
    expect(calls()).toBe(0);
  });

  test("ungoverned_thread_keeps_the_legacy_check", async () => {
    const { reader, calls } = countingReader();
    const app = await threadApp(reader);
    // A thread no conversation row and no channel mapping claims — the
    // scratch/foreign thread the route documents — keeps the legacy check.
    const response = await callAs(app, OWNER_USER, `/${crypto.randomUUID()}`);
    expect(response.status).toBe(200);
    expect(calls()).toBe(1);
  });

  test("legacy_and_paused_authority_keep_the_family_green", async () => {
    const app = await channelApp();
    for (const scenario of [LEGACY_AUTHORITY, PAUSED_AUTHORITY]) {
      await harness().setAuthority(scenario);
      // The object decision does not depend on the authority phase: a private
      // conversation stays private and the child thread still cannot cross
      // its parent's company, with the creator's own family still green.
      const privateRead = (
        await callAs(app, MEMBER_USER, `/${harness().channelId}`)
      ).status;
      expect(privateRead).toBe(404);
      const ownRead = (await callAs(app, OWNER_USER, `/${harness().channelId}`))
        .status;
      expect(ownRead).toBe(200);
      const { reader, calls } = countingReader();
      const threads = await threadApp(reader);
      const crossCompany = await callAs(
        threads,
        OWNER_USER,
        `/${harness().ownerThreadId}`,
        undefined,
        "b",
      );
      expect(crossCompany.status).toBe(404);
      expect(calls()).toBe(0);
    }
    await harness().setAuthority(BA_AUTHORITY);
  });

  test("roster_pagination_does_not_drop_visible_channels_across_pages", async () => {
    const { sql, channelId: privateChannel } = harness();
    const visibleNew = await seedSharedChannel("workspace");
    const hidden = await seedSharedChannel("private");
    const visibleOld = await seedSharedChannel("workspace");
    /*
     * The roster scans RECENCY desc (pinned all false here), so the created
     * instants name the scan order: the member's filtered-out channel sits
     * BETWEEN two visible ones — the interleaving that a per-pass candidate
     * slice one short of `take` would drop (the bug this pins: a continued
     * pass advanced the cursor past the row it refused to evaluate).
     */
    for (const [id, instant] of [
      [privateChannel, "2026-01-01 00:00:04+00"],
      [visibleNew, "2026-01-01 00:00:03+00"],
      [hidden, "2026-01-01 00:00:02+00"],
      [visibleOld, "2026-01-01 00:00:01+00"],
    ] as const) {
      await sql`UPDATE channels SET created_at = ${instant} WHERE id = ${id}`;
    }
    const app = await channelApp();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const response = await callAs(
        app,
        MEMBER_USER,
        `/?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        channels?: Array<{ id?: string }>;
        nextCursor?: string | null;
      };
      seen.push(...(body.channels ?? []).map((row) => row.id ?? ""));
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
    }
    // Both visible channels survive the walk, and the hidden one never shows:
    // the page keeps being refilled until it holds `limit` the caller may see.
    expect(seen).toEqual([visibleNew, visibleOld]);
  });

  test("visible_but_not_creator_write_is_forbidden", async () => {
    const shared = await seedSharedChannel("workspace");
    const app = await channelApp();
    // The policy lets the member see the channel (team-public, not theirs).
    const detail = await callAs(app, MEMBER_USER, `/${shared}`);
    expect(detail.status).toBe(200);
    // Every write answers the visible-but-not-creator 403, including the
    // read-state writes the routes classify as "write" (pin, mark-read).
    const rename = await callAs(app, MEMBER_USER, `/${shared}`, {
      method: "PATCH",
      body: { name: "Renamed by a teammate" },
    });
    expect(rename.status).toBe(403);
    expect(await rename.json()).toEqual({
      error: "You can see this channel, but it is not yours to change.",
    });
    const pin = await callAs(app, MEMBER_USER, `/${shared}/pin`, {
      method: "PUT",
      body: { pinned: true },
    });
    expect(pin.status).toBe(403);
    const markRead = await callAs(app, MEMBER_USER, `/${shared}/read`, {
      method: "PUT",
    });
    expect(markRead.status).toBe(403);
    // The creator's own read-state writes stay green under the same gate.
    const ownPin = await callAs(
      app,
      OWNER_USER,
      `/${harness().channelId}/pin`,
      { method: "PUT", body: { pinned: true } },
    );
    expect(ownPin.status).toBe(200);
    const ownMarkRead = await callAs(
      app,
      OWNER_USER,
      `/${harness().channelId}/read`,
      { method: "PUT" },
    );
    expect(ownMarkRead.status).toBe(204);
  });

  test("ungoverned_channel_passthrough_keeps_the_legacy_surface", async () => {
    const { channelStore, sql, identity } = harness();
    // No enterprise_resources root anywhere: the port has no enterprise fact
    // for this channel, so the gate must answer nothing and let the legacy
    // checks stand — reads and writes alike, and on the roster too.
    const channel = await channelStore.create(ownerActor, [BOT]);
    await sql`
      INSERT INTO channel_memberships (channel_id, user_id)
      VALUES (${channel.id}, ${MEMBER_USER})`;
    await sql`
      INSERT INTO intelligence_channel_mappings (user_id, channel_id, thread_id)
      VALUES (${MEMBER_USER}, ${channel.id}, ${identity.mint()})`;
    const app = await channelApp();
    const detail = await callAs(app, MEMBER_USER, `/${channel.id}`);
    expect(detail.status).toBe(200);
    const pin = await callAs(app, MEMBER_USER, `/${channel.id}/pin`, {
      method: "PUT",
      body: { pinned: true },
    });
    expect(pin.status).toBe(200);
    const markRead = await callAs(app, MEMBER_USER, `/${channel.id}/read`, {
      method: "PUT",
    });
    expect(markRead.status).toBe(204);
    const roster = await callAs(app, MEMBER_USER, "/");
    const page = (await roster.json()) as {
      channels?: Array<{ id?: string }>;
    };
    expect(page.channels?.some((row) => row.id === channel.id)).toBe(true);
  });
});
