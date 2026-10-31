import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql as dsql } from "drizzle-orm";
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
import {
  createPersonalMemoryService,
  memoryCacheKey,
} from "../../src/enterprise/tenancy/personal-memory";
import { createBaScopeResolver } from "../../src/enterprise/tenancy/store";

/*
 * T06.04 (#576, original task P14) — memory recall keeps source authorization
 * and personal isolation: the enterprise PersonalMemoryService keeps the
 * company/team/principal provenance on every real entry point (list / recall /
 * confirm / forget), derives source-backed (kb/document) results per live
 * source authorization, and never widens a scope on confirmation.
 *
 * What this suite pins on the isolated BA_TEST_* island:
 *
 * - `memory_recall_filters_source_authorization`: a memory derived from a
 *   document whose explicit read grant was revoked is gone from the very next
 *   recall — the per-source re-derivation IS the revocation (no cleanup job
 *   rewrites rows), while memories from still-authorized sources (team-public
 *   KB, manual) keep answering — the filter is per source, not a blanket.
 * - `confirmed_memory_does_not_expand_team_visibility`: after the person
 *   confirms a memory in team A, the same person scoped to team B reads
 *   exactly 0 of it — confirmation changes no provenance and opens no team
 *   visibility.
 * - confirmation of a revoked source is refused (PERSONAL_MEMORY_SOURCE_REVOKED)
 *   and confirmation of a live source returns the unchanged view: 本人确认
 *   never expands the source range.
 * - the public-bot recall masks the source locator (sourceRef) — the Bot face
 *   learns the source KIND, never the person's private source id.
 * - forgetting is provenance-pinned: it removes the memory from the owner's
 *   own team scope, and the same principal scoped to another team cannot
 *   forget it (not found, never another team's row).
 * - a deactivated KB never comes back: its derived memory stops being recalled
 *   the moment the resource leaves active status, and nothing re-adds it.
 * - the legacy/paused authority matrix: the recall gate derives everything
 *   live, so under legacy and paused authority the same filtering holds with
 *   scopes that carry no versions (existing capability byte for byte).
 * - memoryCacheKey still pins company/team/principal under the memory:v1
 *   namespace — switching user or team gives a different key.
 *
 * Fixture discipline (the better-auth island's standing recipe): the five
 * BA_TEST_* role URLs are required and must name one loopback
 * openbot_enterprise_* database; a missing URL is a blocked suite, never a
 * fallback to the shared/MT database, and no DSN is ever printed. The suite
 * applies the real 0221–0226 BA migrations, the MT039 statements (both steps,
 * taken from migrate-test TASKS — the single source of truth, never re-typed
 * here) and the workspace-membership SELECT grant the live source/membership
 * re-derivation reads; it removes exactly what it created, restoring the
 * island's resting shape.
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

const TENANT = "t0604-tenant";
const WORKSPACE_A = "t0604-team-a";
const WORKSPACE_B = "t0604-team-b";
const TEAM_A = "t0604-ba-team-a";
const TEAM_B = "t0604-ba-team-b";
const MEMBER_USER = "t0604-member";
const MEMBER_PRINCIPAL = "t0604-principal-member";
const TEAM_KB = "t0604-res-team-kb";
const GRANTED_DOC = "t0604-res-granted-doc";
const OFFLINE_KB = "t0604-res-offline-kb";
const BOT = "t0604-public-bot";

const IDENTITY_GENERATION = 4;
const COMPANY_GENERATION = 1;
const TEAM_GENERATION = 1;
const MEMBERSHIP_EPOCH = 1;

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

function statementsOfTask(taskId: string, slug: string): string[] {
  const task = TASKS.get(taskId);
  const step = task?.steps.find((entry) => entry.slug === slug);
  if (!step) {
    throw new Error(
      `${taskId}/${slug} missing from migrate-test TASKS: update this suite's extraction before running it, never re-type the SQL here.`,
    );
  }
  return [...step.statements];
}

const PERSONAL_MEMORY_TABLE_STATEMENTS = statementsOfTask(
  "MT039",
  "personal_memory_table",
);
const PERSONAL_MEMORY_RLS_STATEMENTS = statementsOfTask(
  "MT039",
  "personal_memory_rls_policies",
);

/** The workspace-membership SELECT grant the island baseline predates. */
const WORKSPACE_MEMBERSHIP_GRANT = statementsFromTasks(
  /^GRANT SELECT ON TABLE "enterprise_workspace_memberships" TO /,
);
if (WORKSPACE_MEMBERSHIP_GRANT.length !== 1) {
  throw new Error(
    `the migrate-test single source no longer carries exactly one workspace-membership grant statement (${WORKSPACE_MEMBERSHIP_GRANT.length} found): update this suite's extraction before running it, never re-type the SQL here.`,
  );
}

const cleanupSql = async (sql: postgres.Sql): Promise<void> => {
  await sql.unsafe(
    `DROP TABLE IF EXISTS ${BA_TABLES.map((name) => `"${name}"`).join(", ")} CASCADE`,
  );
  // Sources first: enterprise_resources references enterprise_workspaces with
  // NO ACTION, so the workspace rows below cannot go while sources exist.
  await sql`DELETE FROM enterprise_resource_grants WHERE tenant_id LIKE 't0604-%'`;
  await sql`DELETE FROM enterprise_resources WHERE tenant_id LIKE 't0604-%'`;
  // The personal-memory table goes back to the island's resting shape: the
  // island baseline predates MT039 entirely. Drop it before its workspace
  // parents below (its composite FK is NO ACTION too).
  await sql.unsafe(
    `DROP TABLE IF EXISTS "enterprise_personal_memories" CASCADE`,
  );
  await sql`DELETE FROM enterprise_workspace_memberships WHERE tenant_id LIKE 't0604-%'`;
  await sql`DELETE FROM enterprise_memberships WHERE tenant_id LIKE 't0604-%'`;
  await sql`DELETE FROM enterprise_principals WHERE id LIKE 't0604-%'`;
  await sql`DELETE FROM enterprise_workspaces WHERE tenant_id LIKE 't0604-%'`;
  await sql`DELETE FROM enterprise_tenants WHERE id LIKE 't0604-%'`;
  await sql`DELETE FROM users WHERE id LIKE 't0604-%'`;
  // The restricted-role grant this suite applied (crashed-run recovery).
  await sql.unsafe(
    `REVOKE SELECT ON TABLE "enterprise_workspace_memberships" FROM ob_ent_directory, ob_ent_data, ob_ent_operator`,
  );
  // The pre-T02.02 baseline the BA migrations re-establish on top of.
  await sql.unsafe(
    `ALTER TABLE "enterprise_principals" DROP COLUMN IF EXISTS "identity_generation"`,
  );
  // 0224's credential-source columns (crashed-run recovery — this suite does
  // not otherwise touch the credential tables).
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
    `ALTER TABLE "enterprise_tenants" DROP CONSTRAINT IF EXISTS "enterprise_tenant_status"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_tenants" ADD CONSTRAINT "enterprise_tenant_status" CHECK ("status" in ('active','suspended'))`,
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
  await sql`
    INSERT INTO enterprise_tenants (id, name, policy_revision) VALUES
      (${TENANT}, 'T06.04 company', 'workspace-v1')`;
  await sql`
    INSERT INTO users (id, email) VALUES
      (${MEMBER_USER}, 't0604-member@example.test')`;
  await sql`
    INSERT INTO enterprise_principals (id, user_id, identity_generation) VALUES
      (${MEMBER_PRINCIPAL}, ${MEMBER_USER}, ${IDENTITY_GENERATION})`;
  await sql`
    INSERT INTO enterprise_workspaces (tenant_id, id, name) VALUES
      (${TENANT}, ${WORKSPACE_A}, 'T06.04 team A'),
      (${TENANT}, ${WORKSPACE_B}, 'T06.04 team B')`;
  await sql`
    INSERT INTO enterprise_memberships (tenant_id, principal_id, role, epoch) VALUES
      (${TENANT}, ${MEMBER_PRINCIPAL}, 'member', ${MEMBERSHIP_EPOCH})`;
  // The same person is an active member of BOTH teams: the sharpest case for
  // team isolation — cross-team reads must be empty even for the owner.
  await sql`
    INSERT INTO enterprise_workspace_memberships
      (tenant_id, workspace_id, principal_id, epoch)
    VALUES (${TENANT}, ${WORKSPACE_A}, ${MEMBER_PRINCIPAL}, ${MEMBERSHIP_EPOCH}),
           (${TENANT}, ${WORKSPACE_B}, ${MEMBER_PRINCIPAL}, ${MEMBERSHIP_EPOCH})`;
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
        VALUES (${TENANT}, 'T06.04 company', 't0604-company')`;
      await sql`
        INSERT INTO auth_teams (id, organization_id, name) VALUES
          (${TEAM_A}, ${TENANT}, 'T06.04 team A'),
          (${TEAM_B}, ${TENANT}, 'T06.04 team B')`;
      await sql`
        INSERT INTO auth_team_bindings (tenant_id, workspace_id, team_id) VALUES
          (${TENANT}, ${WORKSPACE_A}, ${TEAM_A}),
          (${TENANT}, ${WORKSPACE_B}, ${TEAM_B})`;
      await sql`
        INSERT INTO auth_members (id, organization_id, user_id, role) VALUES
          ('t0604-ba-member', ${TENANT}, ${MEMBER_USER}, 'member')`;
      await sql`
        INSERT INTO auth_team_members (id, team_id, user_id) VALUES
          ('t0604-ba-team-member-a', ${TEAM_A}, ${MEMBER_USER}),
          ('t0604-ba-team-member-b', ${TEAM_B}, ${MEMBER_USER})`;
    },
  );
  await sql`
    INSERT INTO auth_eligibility_clocks
      (tenant_id, principal_id, kind, scope_id, epoch, generation, tombstone, last_command_id)
    VALUES
      (${TENANT}, ${MEMBER_PRINCIPAL}, 'company', ${TENANT}, ${MEMBERSHIP_EPOCH}, ${COMPANY_GENERATION}, false, 't0604-c0'),
      (${TENANT}, ${MEMBER_PRINCIPAL}, 'team', ${WORKSPACE_A}, ${MEMBERSHIP_EPOCH}, ${TEAM_GENERATION}, false, 't0604-c0')`;
}

interface Harness {
  readonly sql: postgres.Sql;
  readonly memory: ReturnType<typeof createPersonalMemoryService>;
  resolveScope(workspace: string): Promise<PlatformScope>;
  setAuthority(
    row: Parameters<typeof setAuthority>[1],
  ): ReturnType<typeof setAuthority>;
  /** Operator-channel arrangement stand-ins (the real RLS policies execute). */
  revokeReadGrant(resourceId: string): Promise<void>;
  deactivateResource(resourceId: string): Promise<void>;
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
    for (const statement of PERSONAL_MEMORY_TABLE_STATEMENTS) {
      await sql.unsafe(statement);
    }
    for (const statement of PERSONAL_MEMORY_RLS_STATEMENTS) {
      await sql.unsafe(statement);
    }
    for (const statement of WORKSPACE_MEMBERSHIP_GRANT) {
      await sql.unsafe(statement);
    }
    await seedFixture(sql);
    await setAuthority(sql, BA_AUTHORITY);

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
      authority: createDirectoryAuthority(),
      assurance: createClosedCompanyAssurance({
        policy: { requiresProof: async () => false },
      }),
    });
    const memory = createPersonalMemoryService({ data });
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
      memory,
      // The scope resolver reads one team clock per principal (store.ts's
      // requireUsableClocks) and requires its scope_id to be the selected
      // workspace; the fixture therefore keeps the single team clock pointed
      // at the workspace being selected. The durable membership row and the
      // clock's epoch/generation stay the real ones.
      resolveScope: async (workspace) => {
        await sql`
          UPDATE auth_eligibility_clocks
             SET scope_id = ${workspace}, last_command_id = 't0604-clock-select'
           WHERE tenant_id = ${TENANT} AND principal_id = ${MEMBER_PRINCIPAL}
             AND kind = 'team'`;
        return resolver.resolve(
          new Request("http://t0604.local/", {
            headers: {
              "x-test-user": MEMBER_USER,
              "x-openbot-tenant": TENANT,
              "x-openbot-workspace": workspace,
            },
          }),
        );
      },
      setAuthority: (row) => setAuthority(sql, row),
      // The grant DELETE the directory remove path uses (group-membership
      // removeMember's operator policy recipe): the row's principal is pinned
      // via app.operator_principal_id.
      revokeReadGrant: async (resourceId) => {
        await operator.transaction(async (tx) => {
          await tx.execute(dsql`set local lock_timeout = '2s'`);
          await tx.execute(dsql`set local statement_timeout = '5s'`);
          await tx.execute(
            dsql`select set_config('app.tenant_id', ${TENANT}, true)`,
          );
          await tx.execute(
            dsql`select set_config('app.resource_id', ${resourceId}, true)`,
          );
          await tx.execute(
            dsql`select set_config('app.operator_principal_id', ${MEMBER_PRINCIPAL}, true)`,
          );
          await tx.execute(dsql`
            DELETE FROM enterprise_resource_grants
             WHERE tenant_id = ${TENANT}
               AND resource_id = ${resourceId}
               AND principal_id = ${MEMBER_PRINCIPAL}
               AND action = 'read'
          `);
        });
      },
      // Arrangement stand-in (setup channel): the island baseline grants the
      // operator role only the MT008 column-level UPDATE on `visibility`, so
      // "the KB leaves active status" has no operator policy path here. The
      // behavior under test is that the recall gate stops deriving the row.
      deactivateResource: async (resourceId) => {
        await sql`
          UPDATE enterprise_resources
             SET status = 'deleted'
           WHERE tenant_id = ${TENANT}
             AND id = ${resourceId}
        `;
      },
      close,
    };
  } catch (error) {
    await cleanupSql(sql).catch(() => {});
    await sql.end({ timeout: 5 }).catch(() => {});
    throw error;
  }
}

function harness(): Harness {
  if (!state) {
    throw new Error("memory-source-authorization harness is not initialized");
  }
  return state;
}

beforeAll(async () => {
  state = await createHarness();
});

afterAll(async () => {
  await state?.close();
  state = undefined;
});

describe("T06.04 memory recall keeps source authorization and personal isolation", () => {
  test("memory_recall_filters_source_authorization", async () => {
    const fixture = harness();
    const scopeA = await fixture.resolveScope(WORKSPACE_A);
    expect(scopeA.identityGeneration).toBe(IDENTITY_GENERATION);
    expect(scopeA.companyGeneration).toBe(COMPANY_GENERATION);
    expect(scopeA.teamGeneration).toBe(TEAM_GENERATION);

    // The person records three memories in team A: one derived from the
    // team-public KB, one from a document they hold an explicit read grant
    // on, one written by hand.
    const kb = await fixture.memory.writeMemory(scopeA, {
      memoryKey: "t0604-kb-fact",
      content: "t0604-fact-from-team-kb",
      sourceKind: "kb",
      sourceRef: TEAM_KB,
    });
    const doc = await fixture.memory.writeMemory(scopeA, {
      memoryKey: "t0604-doc-fact",
      content: "t0604-fact-from-granted-doc",
      sourceKind: "document",
      sourceRef: GRANTED_DOC,
    });
    const manual = await fixture.memory.writeMemory(scopeA, {
      memoryKey: "t0604-manual-fact",
      content: "t0604-fact-written-by-hand",
    });

    // Arrange the sources the way the fixture promises: the KB is
    // workspace-public in team A, the doc carries the member's explicit read
    // grant (operator channel, the real INSERT policy).
    await fixture.sql`
      INSERT INTO enterprise_resources
        (tenant_id, id, workspace_id, kind, display_name, visibility)
      VALUES
        (${TENANT}, ${TEAM_KB}, ${WORKSPACE_A}, 'knowledge_base', 'T06.04 team KB', 'workspace'),
        (${TENANT}, ${GRANTED_DOC}, ${WORKSPACE_A}, 'document', 'T06.04 granted doc', NULL)
    `;
    await fixture.sql`
      INSERT INTO enterprise_resource_grants
        (tenant_id, resource_id, principal_id, action)
      VALUES (${TENANT}, ${GRANTED_DOC}, ${MEMBER_PRINCIPAL}, 'read')
    `;

    // Positive path: every source is authorized, so every memory answers.
    let recalled = await fixture.memory.resolveMemoriesForPublicBot(scopeA, {
      agentId: BOT,
    });
    let returnedIds = recalled.map((row) => row.memoryId);
    expect(returnedIds).toContain(kb.memoryId);
    expect(returnedIds).toContain(doc.memoryId);
    expect(returnedIds).toContain(manual.memoryId);

    // Revoke the document's explicit read grant (the directory removeMember
    // operator recipe — the real DELETE policy). No cleanup job runs; the
    // next recall re-derives authorization live.
    await fixture.revokeReadGrant(GRANTED_DOC);

    recalled = await fixture.memory.resolveMemoriesForPublicBot(scopeA, {
      agentId: BOT,
    });
    returnedIds = recalled.map((row) => row.memoryId);
    expect(returnedIds).not.toContain(doc.memoryId);
    // Per source, not a blanket: the still-authorized KB memory and the
    // hand-written memory keep answering.
    expect(returnedIds).toContain(kb.memoryId);
    expect(returnedIds).toContain(manual.memoryId);

    // The person's own list path applies the same per-source filter.
    const hits = await fixture.memory.searchMemories(scopeA, {
      query: "t0604-fact",
    });
    const listedIds = hits.map((row) => row.memoryId);
    expect(listedIds).not.toContain(doc.memoryId);
    expect(listedIds).toContain(kb.memoryId);
    expect(listedIds).toContain(manual.memoryId);
  });

  test("confirmed_memory_does_not_expand_team_visibility", async () => {
    const fixture = harness();
    const scopeA = await fixture.resolveScope(WORKSPACE_A);
    const written = await fixture.memory.writeMemory(scopeA, {
      memoryKey: "t0604-confirmed-secret",
      content: "t0604-team-a-confirmed-secret",
    });

    // The same person, scoped to team B, reads exactly nothing of it — the
    // record never becomes another team's to see, whether on the list path or
    // on the Bot recall path.
    const scopeB = await fixture.resolveScope(WORKSPACE_B);
    const readFromTeamB = async () => {
      const listed = await fixture.memory.searchMemories(scopeB, {
        query: "t0604-team-a-confirmed-secret",
      });
      const recalled = await fixture.memory.resolveMemoriesForPublicBot(
        scopeB,
        { agentId: BOT },
      );
      return (
        listed.length +
        recalled.filter(
          (row) => row.content === "t0604-team-a-confirmed-secret",
        ).length
      );
    };
    const otherTeamReadsBeforeConfirm = await readFromTeamB();
    expect(otherTeamReadsBeforeConfirm).toBe(0);

    // 本人确认：the person confirms their own memory in team A. The
    // confirmation re-derives the source, changes no provenance, and returns
    // the same view.
    const confirmed = await fixture.memory.confirmMemory(scopeA, {
      memoryId: written.memoryId,
    });
    expect(confirmed.memoryId).toBe(written.memoryId);
    expect(confirmed.memoryKey).toBe("t0604-confirmed-secret");

    // Confirmation opened nothing: the other team still reads 0.
    const otherTeamReads = await readFromTeamB();
    expect(otherTeamReads).toBe(0);
  });

  test("confirmation_refuses_a_revoked_source_and_never_expands_scope", async () => {
    const fixture = harness();
    const scopeA = await fixture.resolveScope(WORKSPACE_A);
    // From the first test's state: the doc grant is gone, the KB is live. The
    // revoked memory no longer answers on any read path, so its id comes from
    // the row the suite itself wrote (setup channel).
    const [docRow] = await fixture.sql`
      SELECT id FROM enterprise_personal_memories
       WHERE tenant_id = ${TENANT} AND memory_key = 't0604-doc-fact'
    `;
    const [kbRow] = await fixture.sql`
      SELECT id FROM enterprise_personal_memories
       WHERE tenant_id = ${TENANT} AND memory_key = 't0604-kb-fact'
    `;
    const docMemoryId = (docRow as { id: string }).id;
    const kbMemoryId = (kbRow as { id: string }).id;
    await expect(
      fixture.memory.confirmMemory(scopeA, { memoryId: docMemoryId }),
    ).rejects.toThrow("PERSONAL_MEMORY_SOURCE_REVOKED");

    const confirmed = await fixture.memory.confirmMemory(scopeA, {
      memoryId: kbMemoryId,
    });
    expect(confirmed.memoryId).toBe(kbMemoryId);

    // Another team's scope cannot confirm team A's memory at all — the row is
    // not this scope's to find.
    const scopeB = await fixture.resolveScope(WORKSPACE_B);
    await expect(
      fixture.memory.confirmMemory(scopeB, { memoryId: kbMemoryId }),
    ).rejects.toThrow("PERSONAL_MEMORY_NOT_FOUND");
  });

  test("public_bot_recall_masks_the_source_reference", async () => {
    const fixture = harness();
    const scopeA = await fixture.resolveScope(WORKSPACE_A);

    // The person's own list keeps the source locator (it is their own source
    // world) ...
    const own = await fixture.memory.searchMemories(scopeA, {
      query: "t0604-fact-from-team-kb",
    });
    expect(own[0]?.sourceRef).toBe(TEAM_KB);

    // ... while the Bot face gets the source kind only: the sourceRef — the
    // private locator into the person's connected sources — is masked, and
    // the view carries no other source-private field.
    const recalled = await fixture.memory.resolveMemoriesForPublicBot(scopeA, {
      agentId: BOT,
    });
    for (const row of recalled) {
      expect(Object.keys(row).sort()).toEqual([
        "content",
        "memoryId",
        "memoryKey",
        "sourceKind",
        "sourceRef",
      ]);
      expect(row.sourceRef).toBeNull();
    }
  });

  test("forget_memory_is_provenance_pinned", async () => {
    const fixture = harness();
    const scopeA = await fixture.resolveScope(WORKSPACE_A);
    const written = await fixture.memory.writeMemory(scopeA, {
      memoryKey: "t0604-forgettable",
      content: "t0604-forget-me",
    });

    // The same principal scoped to team B cannot touch it — not even to
    // forget it: the row is not this scope's to find.
    const scopeB = await fixture.resolveScope(WORKSPACE_B);
    await expect(
      fixture.memory.forgetMemory(scopeB, { memoryId: written.memoryId }),
    ).rejects.toThrow("PERSONAL_MEMORY_NOT_FOUND");

    const forgotten = await fixture.memory.forgetMemory(scopeA, {
      memoryId: written.memoryId,
    });
    expect(forgotten.outcome).toBe("forgotten");
    const listed = await fixture.memory.searchMemories(scopeA, {
      query: "t0604-forget-me",
    });
    expect(listed).toHaveLength(0);
  });

  test("deactivated_source_is_never_recalled_or_restored", async () => {
    const fixture = harness();
    const scopeA = await fixture.resolveScope(WORKSPACE_A);
    await fixture.sql`
      INSERT INTO enterprise_resources
        (tenant_id, id, workspace_id, kind, display_name, visibility)
      VALUES (${TENANT}, ${OFFLINE_KB}, ${WORKSPACE_A}, 'knowledge_base', 'T06.04 offline KB', 'workspace')
    `;
    const kb = await fixture.memory.writeMemory(scopeA, {
      memoryKey: "t0604-offline-kb-fact",
      content: "t0604-fact-from-offline-kb",
      sourceKind: "kb",
      sourceRef: OFFLINE_KB,
    });
    let recalled = await fixture.memory.resolveMemoriesForPublicBot(scopeA, {
      agentId: BOT,
    });
    expect(recalled.map((row) => row.memoryId)).toContain(kb.memoryId);

    // The KB leaves active status (operator channel, the real UPDATE policy).
    // No cleanup rewrote the memory row — the recall gate itself stops
    // deriving it, and nothing puts it back: no KB restore.
    await fixture.deactivateResource(OFFLINE_KB);
    recalled = await fixture.memory.resolveMemoriesForPublicBot(scopeA, {
      agentId: BOT,
    });
    expect(recalled.map((row) => row.memoryId)).not.toContain(kb.memoryId);
    const listed = await fixture.memory.searchMemories(scopeA, {
      query: "t0604-fact-from-offline-kb",
    });
    expect(listed).toHaveLength(0);
  });

  test("legacy_and_paused_authority_keep_the_same_recall_gate", async () => {
    const fixture = harness();
    // The revoked doc memory's id: the recall/list paths filter it now, so
    // read the row the suite itself wrote through the setup channel.
    const docRows = await fixture.sql`
      SELECT id FROM enterprise_personal_memories
       WHERE tenant_id = ${TENANT} AND memory_key = 't0604-doc-fact'
    `;
    expect(docRows).toHaveLength(1);
    const docMemoryId = (docRows[0] as { id: string }).id;
    // The gate derives authorization live and never reads scope versions, so
    // legacy and paused scopes — issued without any version — meet exactly
    // the same filtering as ba scopes.
    for (const authority of [LEGACY_AUTHORITY, PAUSED_AUTHORITY]) {
      await fixture.setAuthority(authority);
      const scopeA = await fixture.resolveScope(WORKSPACE_A);
      expect(scopeA.identityGeneration).toBeUndefined();
      const recalled = await fixture.memory.resolveMemoriesForPublicBot(
        scopeA,
        {
          agentId: BOT,
        },
      );
      const returnedIds = recalled.map((row) => row.memoryId);
      const returnedContents = recalled.map((row) => row.content);
      const listed = await fixture.memory.searchMemories(scopeA, {
        query: "t0604-fact",
      });
      const listedIds = listed.map((row) => row.memoryId);
      // The revoked doc source stays filtered under every authority; the
      // live sources keep answering (existing capability, byte for byte).
      expect(returnedIds).not.toContain(docMemoryId);
      expect(listedIds).not.toContain(docMemoryId);
      expect(returnedContents).toContain("t0604-fact-from-team-kb");
      expect(listed.map((row) => row.content)).toContain(
        "t0604-fact-from-team-kb",
      );
    }
    await fixture.setAuthority(BA_AUTHORITY);
  });

  test("memory_cache_key_pins_company_team_principal", () => {
    const inA = {
      tenantId: TENANT,
      workspaceId: WORKSPACE_A,
      principalId: MEMBER_PRINCIPAL,
    };
    const inB = { ...inA, workspaceId: WORKSPACE_B };
    const other = { ...inA, principalId: "t0604-principal-other" };

    expect(memoryCacheKey(inA)).toBe(memoryCacheKey(inA));
    const keys = [inA, inB, other].map((input) => memoryCacheKey(input));
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) {
      expect(key.startsWith("memory:v1:")).toBe(true);
      expect(key.split(":")).toHaveLength(5);
    }
    // The segments are the provenance itself — checkable, not a hash blackbox:
    // company / team / principal, namespaced and versioned.
    expect(memoryCacheKey(inA)).toBe(
      `memory:v1:${TENANT}:${WORKSPACE_A}:${MEMBER_PRINCIPAL}`,
    );
  });
});
