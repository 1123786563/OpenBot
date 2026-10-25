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
import {
  type CompanyAssurance,
  createClosedCompanyAssurance,
} from "../../src/auth/company-assurance";
import { createDirectoryAuthority } from "../../src/auth/directory/authority";
import { createDatabase } from "../../src/db/client";
import { WORKSPACE_SCOPE_MOUNT_PREFIX } from "../../src/enterprise/tenancy/admin-separation";
import {
  createBaSelectionScopeMount,
  createWorkspaceScopeRoutes,
} from "../../src/enterprise/tenancy/workspace-scope-routes";
import {
  createBaScopeSelectionService,
  type WorkspaceScopeLister,
} from "../../src/enterprise/tenancy/workspace-admin";
import { Hono } from "hono";

/*
 * T03.02 (#539, P05) — the stable-ID company/team discovery and selection
 * surface (interfaces §4; design §7.1).
 *
 * What this file pins, and why each fact is a database row rather than a code
 * convention:
 *
 * - `validate_selection_answers_the_frozen_contract`: a valid explicit
 *   selection returns the §4 ValidatedSelection — stable organization/team
 *   ids and the durable two-layer versions — not a legacy DTO with invented
 *   ids.
 * - `explicit_b_company_does_not_follow_active_a`: the explicit SelectionInput
 *   decides; no active-company preference, no first-eligible default. Company
 *   a is alphabetically first and would be any default's answer; the explicit
 *   b is what comes back.
 * - `mixed_company_and_team_returns_refusal`: a selection assembled from two
 *   different listings' rows (company a + company b's workspace) answers 400
 *   SCOPE_SELECTOR_CONFLICT — a client assembly error, not a hidden object.
 * - `authority_advertisement_preserves_legacy_dto`: under legacy authority the
 *   same GET keeps the legacy listing byte-for-byte (toEqual against the
 *   legacy lister's own answer) and the surface advertises which DTO it
 *   serves; under ba it advertises ba-v1 and serves the §4 listing.
 * - `ba_listing_advertises_roles_capabilities_and_versions`: the §4 listing
 *   carries the BA role, the derived closed capability set and both layers'
 *   versions; a company admin with NO team still carries company:manage
 *   (company management never depends on team membership); a company the
 *   actor is not a member of is absent.
 * - `hidden_selections_answer_404_without_existence_leak`: a company the
 *   actor cannot see and a workspace that does not exist answer the SAME 404
 *   code.
 * - `paused_authority_serves_legacy_listing_and_refuses_validation` and
 *   `legacy_authority_refuses_ba_v1_validation`: the ba-v1 half exists only
 *   under ba authority — the branches are fail-closed 503s, never a silent
 *   legacy fallback.
 * - `proof_demanded_company_requires_reauth_to_validate`: validation asks the
 *   company proof port in its transaction; discovery never does.
 * - `unreadable_authority_state_is_a_storage_refusal`: a missing authority row
 *   is 503 on both halves, never a guessed branch.
 * - `tombstoned_clock_hides_the_company`: a tombstoned company clock hides the
 *   company from the listing and closes its validation — the same fact the
 *   T03.01 gate compares.
 * - `wrapper_delegates_every_base_route_unchanged`: the BA mount wrapper keeps
 *   every pre-existing route of the wrapped app answering exactly as before.
 *
 * The suite applies the real 0209–0214 better-auth migrations on the isolated
 * BA_TEST_* database and cleans up exactly what it created. All five
 * BA_TEST_* role URLs are required; a missing one is a blocked suite, never a
 * fallback to the shared/MT database. No DSN is ever printed.
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
  "0209_better_auth_directory",
  "0210_better_auth_clocks",
  "0211_better_auth_command_authority",
  "0212_better_auth_authority_sources",
  "0213_better_auth_assurance",
  "0214_better_auth_schema_roles",
] as const;

/** Everything the migrations above create (the T02.15 closed inventory). */
const SUITE_TABLES = [
  "auth_command_outbox",
  "auth_command_change_keys",
  "auth_command_receipts",
  "auth_authority_states",
  "auth_team_management_grants",
  "auth_provisioning_rules",
  "auth_organizations",
  "auth_teams",
  "auth_team_bindings",
  "auth_members",
  "auth_team_members",
  "auth_invitations",
  "auth_eligibility_clocks",
  "auth_company_auth_challenges",
  "auth_company_session_assurances",
] as const;

/*
 * The fixture's stable business ids. Companies a and b carry the exact ids the
 * Brief's named judgment reads back (`response.tenantId === "b"`); everything
 * else is prefixed so cleanup deletes exactly this suite's rows.
 */
const TENANT_A = "a";
const TENANT_B = "b";
const TENANT_SOLO = "t0302-company-solo";
const TENANT_GHOST = "t0302-company-ghost";
const WORKSPACE_A = "t0302-ws-a";
const WORKSPACE_B = "t0302-ws-b";
const TEAM_A = "t0302-team-a";
const TEAM_B = "t0302-team-b";
const USER = "t0302-user";
const PRINCIPAL = "t0302-principal";
/** The identity generation the seeded principal carries. */
const IDENTITY_GENERATION = 4;

const BA_AUTHORITY = {
  authorityVersion: 21,
  phase: "M4",
  directoryAuthority: "ba",
  multiTenantReleased: true,
} as const;
const LEGACY_AUTHORITY = {
  authorityVersion: 11,
  phase: "M1",
  directoryAuthority: "legacy",
  multiTenantReleased: false,
} as const;
const PAUSED_AUTHORITY = {
  authorityVersion: 15,
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

/** All five URLs, shaped and naming one database; missing means blocked. */
function readBaUrls(): string {
  let reference: string | undefined;
  for (const variable of BA_URL_VARIABLES) {
    const raw = process.env[variable]?.trim();
    if (!raw) {
      throw new Error(
        `${variable} is required: the selection-api suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
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
      `${tag}.sql does not exist: the BA directory model this suite pins is the integrated T02 target behavior, not an environment problem.`,
    );
  }
  return readFileSync(path, "utf8");
}

/**
 * Returns the island to the pre-T02.02 shape: this suite's rows gone, the BA
 * tables gone, `identity_generation` gone, the tenant status domain back to
 * active/suspended. Idempotent; also recovers a crashed earlier run.
 */
async function cleanupFixture(sql: postgres.Sql): Promise<void> {
  // The BA tables go FIRST: their workspace FK cascades into
  // auth_team_bindings, and that cascade would fire the DML guard while the
  // tables still exist.
  await sql.unsafe(
    `DROP TABLE IF EXISTS ${SUITE_TABLES.map((name) => `"${name}"`).join(", ")} CASCADE`,
  );
  // Literal id lists rather than array interpolation: postgres.js serializes
  // a JS array as a PostgreSQL array literal, so `IN (${array})` matches
  // nothing and a stale row survives into the seed as a duplicate key.
  await sql`
    DELETE FROM billing_company_finance_grants
     WHERE tenant_id IN ('a','b','t0302-company-solo','t0302-company-ghost')`;
  await sql`
    DELETE FROM enterprise_workspace_memberships
     WHERE tenant_id IN ('a','b','t0302-company-solo','t0302-company-ghost')`;
  await sql`
    DELETE FROM enterprise_memberships
     WHERE tenant_id IN ('a','b','t0302-company-solo','t0302-company-ghost')`;
  await sql`DELETE FROM enterprise_principals WHERE id LIKE 't0302-%'`;
  await sql`
    DELETE FROM enterprise_workspaces
     WHERE tenant_id IN ('a','b','t0302-company-solo','t0302-company-ghost')`;
  await sql`
    DELETE FROM enterprise_tenants
     WHERE id IN ('a','b','t0302-company-solo','t0302-company-ghost')`;
  await sql`DELETE FROM users WHERE id LIKE 't0302-%'`;
  await sql.unsafe(
    `ALTER TABLE "enterprise_principals" DROP COLUMN IF EXISTS "identity_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_tenants" DROP CONSTRAINT IF EXISTS "enterprise_tenant_status"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_tenants" ADD CONSTRAINT "enterprise_tenant_status" CHECK ("status" in ('active','suspended'))`,
  );
  // The 0212 authority-source columns on shared tables (the T02.04 recipe):
  // the island can carry them as restored-dump residue, and 0212 re-adds them
  // after this normalization — dropping the columns drops their CHECKs and
  // the access_grants FK with them.
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
    INSERT INTO enterprise_tenants (id, name) VALUES
      (${TENANT_A}, 'T03.02 company a'),
      (${TENANT_B}, 'T03.02 company b'),
      (${TENANT_SOLO}, 'T03.02 company solo'),
      (${TENANT_GHOST}, 'T03.02 company ghost')`;
  await sql`
    INSERT INTO users (id, email) VALUES
      (${USER}, 't0302-user@example.test')`;
  // One user one principal, carrying a verified generation (the legacy branch
  // never reads it; the ba branch refuses without it).
  await sql`
    INSERT INTO enterprise_principals (id, user_id, identity_generation) VALUES
      (${PRINCIPAL}, ${USER}, ${IDENTITY_GENERATION})`;
  await sql`
    INSERT INTO enterprise_workspaces (tenant_id, id, name) VALUES
      (${TENANT_A}, ${WORKSPACE_A}, 'T03.02 workspace a'),
      (${TENANT_B}, ${WORKSPACE_B}, 'T03.02 workspace b')`;
  await sql`
    INSERT INTO enterprise_memberships (tenant_id, principal_id, role, epoch) VALUES
      (${TENANT_A}, ${PRINCIPAL}, 'member', 1),
      (${TENANT_B}, ${PRINCIPAL}, 'member', 1),
      (${TENANT_SOLO}, ${PRINCIPAL}, 'tenant_admin', 1)`;
  // The finance capability fact of company b: an explicit read grant row for
  // this member — the same fact `assertCompanyFinanceReader` gates on. It
  // belongs to a plain member precisely so the listing proves the capability
  // never rides a role.
  await sql`
    INSERT INTO billing_company_finance_grants (tenant_id, principal_id, granted_by) VALUES
      (${TENANT_B}, ${PRINCIPAL}, ${PRINCIPAL})`;
  await sql`
    INSERT INTO enterprise_workspace_memberships
      (tenant_id, workspace_id, principal_id, epoch)
    VALUES
      (${TENANT_A}, ${WORKSPACE_A}, ${PRINCIPAL}, 1),
      (${TENANT_B}, ${WORKSPACE_B}, ${PRINCIPAL}, 1)`;
  // The BA directory rows the ba branch reads. The 0214 DML guard demands a
  // live command context; a test fixture is not a command, so the guard is
  // disabled around the seed and restored right after (the T02.15 recipe).
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
          (${TENANT_A}, 'T03.02 org a', 't0302-org-a'),
          (${TENANT_B}, 'T03.02 org b', 't0302-org-b'),
          (${TENANT_SOLO}, 'T03.02 org solo', 't0302-org-solo')`;
      await sql`
        INSERT INTO auth_teams (id, organization_id, name) VALUES
          (${TEAM_A}, ${TENANT_A}, 'T03.02 team a'),
          (${TEAM_B}, ${TENANT_B}, 'T03.02 team b')`;
      await sql`
        INSERT INTO auth_team_bindings (tenant_id, workspace_id, team_id) VALUES
          (${TENANT_A}, ${WORKSPACE_A}, ${TEAM_A}),
          (${TENANT_B}, ${WORKSPACE_B}, ${TEAM_B})`;
      await sql`
        INSERT INTO auth_members (id, organization_id, user_id, role) VALUES
          ('t0302-member-a', ${TENANT_A}, ${USER}, 'member'),
          ('t0302-member-b', ${TENANT_B}, ${USER}, 'member'),
          ('t0302-member-solo', ${TENANT_SOLO}, ${USER}, 'admin')`;
      await sql`
        INSERT INTO auth_team_members (id, team_id, user_id) VALUES
          ('t0302-team-member-a', ${TEAM_A}, ${USER}),
          ('t0302-team-member-b', ${TEAM_B}, ${USER})`;
    },
  );
  // The durable two-layer clocks for every eligible company/team, at 1/1.
  await sql`
    INSERT INTO auth_eligibility_clocks
      (tenant_id, principal_id, kind, scope_id, epoch, generation, tombstone, last_command_id)
    VALUES
      (${TENANT_A}, ${PRINCIPAL}, 'company', ${TENANT_A}, 1, 1, false, 't0302-c0'),
      (${TENANT_A}, ${PRINCIPAL}, 'team', ${WORKSPACE_A}, 1, 1, false, 't0302-c0'),
      (${TENANT_B}, ${PRINCIPAL}, 'company', ${TENANT_B}, 1, 1, false, 't0302-c0'),
      (${TENANT_B}, ${PRINCIPAL}, 'team', ${WORKSPACE_B}, 1, 1, false, 't0302-c0'),
      (${TENANT_SOLO}, ${PRINCIPAL}, 'company', ${TENANT_SOLO}, 1, 1, false, 't0302-c0')`;
}

/** Disable the named directory guard triggers, restore them after (T02.15 recipe). */
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

interface Harness {
  sql: postgres.Sql;
  db: ReturnType<typeof createDatabase>;
  /** The real restricted data connection the clock reads ride on. */
  dataDb: ReturnType<typeof createDatabase>;
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
  let db: ReturnType<typeof createDatabase> | undefined;
  let dataDb: ReturnType<typeof createDatabase> | undefined;
  try {
    await cleanupFixture(sql);
    for (const tag of MIGRATION_TAGS) {
      await sql.unsafe(loadMigrationSql(tag));
    }
    await seedFixture(sql);
    await setAuthority(sql, BA_AUTHORITY);
    db = createDatabase(setupUrl, { max: 3 });
    dataDb = createDatabase(process.env.BA_TEST_DATA_DATABASE_URL!.trim(), {
      max: 2,
    });
    const openDb = db;
    const close = async () => {
      try {
        await cleanupFixture(sql);
      } finally {
        await openDb.$client.close?.();
        await dataDb?.$client.close?.();
        await sql.end({ timeout: 5 }).catch(() => {});
      }
    };
    return { sql, db: openDb, dataDb, close };
  } catch (error) {
    await db?.$client.close?.().catch(() => {});
    await dataDb?.$client.close?.().catch(() => {});
    await cleanupFixture(sql).catch(() => {});
    await sql.end({ timeout: 5 }).catch(() => {});
    throw error;
  }
}

function harness(): Harness {
  if (!state) throw new Error("selection-api harness is not initialized");
  return state;
}

type TestIdentity = { actorId: string; entrypoint: "web" };

function noProof(): CompanyAssurance {
  return createClosedCompanyAssurance({
    policy: { requiresProof: async () => false },
  });
}

function makeSelection(assurance?: CompanyAssurance) {
  return createBaScopeSelectionService(harness().db, {
    data: harness().dataDb,
    authority: createDirectoryAuthority(),
    assurance: assurance ?? noProof(),
  });
}

/*
 * The base's legacy lister is a deterministic stub, not the production
 * lister: the BA island's role fixture deliberately fails the production
 * capability verification (escalation memberships the T01.02 fixture grants),
 * so the verified directory/data channels cannot be built here. What the
 * advertisement contract needs is exactly this: the wrapper serves the base's
 * own answer, whatever produced it, byte-for-byte.
 */
const LEGACY_LISTING = Object.freeze({
  companies: [
    Object.freeze({
      tenantId: TENANT_A,
      name: "Legacy company a",
      role: "member",
      memberEpoch: 7,
      teams: [
        Object.freeze({ workspaceId: WORKSPACE_A, name: "Legacy team a" }),
      ],
    }),
  ],
});

function stubLegacyLister(): WorkspaceScopeLister {
  return {
    async list(identity) {
      if (!identity?.actorId) throw new Error("AUTH_REQUIRED");
      return LEGACY_LISTING;
    },
  };
}

/**
 * The full production-shaped surface: the legacy routes built exactly as the
 * assembly builds them, wrapped by the BA selection mount, mounted at the
 * real prefix. Every request goes through the whole chain.
 */
function makeApp(
  assurance?: CompanyAssurance,
  authenticate?: () => Promise<TestIdentity | null>,
): Hono {
  const resolveIdentity =
    authenticate ??
    (async () => ({ actorId: USER, entrypoint: "web" as const }));
  const base = createWorkspaceScopeRoutes({
    authenticate: resolveIdentity,
    lister: stubLegacyLister(),
  });
  const mount = createBaSelectionScopeMount(base, {
    authenticate: resolveIdentity,
    selection: makeSelection(assurance),
  });
  const app: Hono = new Hono();
  app.route(WORKSPACE_SCOPE_MOUNT_PREFIX, mount);
  return app;
}

const surface = (path: string) =>
  `https://openbot.test${WORKSPACE_SCOPE_MOUNT_PREFIX}${path}`;

async function getListing(app: Hono, headers?: Record<string, string>) {
  // The entrance is the mount root without a trailing slash — exactly the
  // path production serves (the trailing-slash form stays a 404, pinned by
  // the wrapper's delegation branch).
  return app.request(surface(""), { headers });
}

async function postSelection(
  app: Hono,
  body: unknown,
  headers?: Record<string, string>,
) {
  return app.request(surface("/validate-selection"), {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify(body),
  });
}

async function errorOf(response: Response): Promise<string> {
  const body = (await response.json()) as {
    error?: { code?: string };
  };
  return String(body.error?.code ?? "");
}

describe("T03.02 selection api (Issue #539)", () => {
  beforeAll(async () => {
    state = await createHarness();
  });

  afterAll(async () => {
    const current = state;
    state = undefined;
    await current?.close();
  });

  test("ba_selection_service_requires_its_dependencies", () => {
    const { db, dataDb } = harness();
    const authority = createDirectoryAuthority();
    const assurance = noProof();
    // The authority and assurance ports are required at construction — an
    // optional port is the bypass, refused before any request is answered.
    expect(() =>
      createBaScopeSelectionService(db, {
        data: dataDb,
        authority,
        assurance: undefined as unknown as CompanyAssurance,
      }),
    ).toThrow("DEPS_REQUIRED");
    expect(() =>
      createBaScopeSelectionService(db, {
        data: dataDb,
        authority: undefined as never,
        assurance,
      }),
    ).toThrow("DEPS_REQUIRED");
    expect(() =>
      createBaScopeSelectionService(db, {
        data: undefined as never,
        authority,
        assurance,
      }),
    ).toThrow("DEPS_REQUIRED");
  });

  test("validate_selection_answers_the_frozen_contract", async () => {
    await setAuthority(harness().sql, BA_AUTHORITY);
    const response = await postSelection(makeApp(), {
      tenantId: TENANT_B,
      workspaceId: WORKSPACE_B,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tenantId: TENANT_B,
      workspaceId: WORKSPACE_B,
      organizationId: TENANT_B,
      teamId: TEAM_B,
      memberEpoch: 1,
      workspaceMemberEpoch: 1,
      companyGeneration: 1,
      teamGeneration: 1,
      // The member holds company b's explicit finance read grant — the
      // capability answers that fact, never the role.
      capabilities: ["finance:read"],
    });
  });

  test("explicit_b_company_does_not_follow_active_a", async () => {
    await setAuthority(harness().sql, BA_AUTHORITY);
    // Company a is alphabetically first and the actor's first membership —
    // any default, preference or "active company" would answer a. The
    // explicit selection names b, and b is what comes back: the input
    // decides, an active-session preference is never consulted server-side.
    const response = await postSelection(makeApp(), {
      tenantId: TENANT_B,
      workspaceId: WORKSPACE_B,
    });
    expect(response.status).toBe(200);
    const validated = (await response.json()) as { tenantId: string };
    expect(validated.tenantId).toBe("b");
  });

  test("mixed_company_and_team_returns_refusal", async () => {
    await setAuthority(harness().sql, BA_AUTHORITY);
    const response = await postSelection(makeApp(), {
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_B,
    });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("SCOPE_SELECTOR_CONFLICT");
  });

  test("selector_header_conflicts_with_explicit_selection", async () => {
    await setAuthority(harness().sql, BA_AUTHORITY);
    const tenantConflict = await postSelection(
      makeApp(),
      { tenantId: TENANT_A, workspaceId: WORKSPACE_A },
      { "x-openbot-tenant": TENANT_B },
    );
    expect(tenantConflict.status).toBe(400);
    expect(await errorOf(tenantConflict)).toBe("SCOPE_SELECTOR_CONFLICT");
    const workspaceConflict = await postSelection(
      makeApp(),
      { tenantId: TENANT_A, workspaceId: WORKSPACE_A },
      { "x-openbot-workspace": WORKSPACE_B },
    );
    expect(workspaceConflict.status).toBe(400);
    expect(await errorOf(workspaceConflict)).toBe("SCOPE_SELECTOR_CONFLICT");
    // An AGREEING header is not a conflict: the selection still validates.
    const agreeing = await postSelection(
      makeApp(),
      { tenantId: TENANT_A, workspaceId: WORKSPACE_A },
      {
        "x-openbot-tenant": TENANT_A,
        "x-openbot-workspace": WORKSPACE_A,
      },
    );
    expect(agreeing.status).toBe(200);
  });

  test("authority_advertisement_preserves_legacy_dto", async () => {
    const { sql } = harness();
    await setAuthority(sql, LEGACY_AUTHORITY);
    // The legacy body is the base's own answer, byte-for-byte — the wrapper
    // re-advertises it, it never re-shapes it.
    const oldBody = LEGACY_LISTING;
    const legacyResponse = await getListing(makeApp());
    expect(legacyResponse.status).toBe(200);
    expect(legacyResponse.headers.get("x-openbot-directory-authority")).toBe(
      "legacy",
    );
    expect(await legacyResponse.json()).toEqual(oldBody);
    // Under ba the same route advertises and serves the ba-v1 DTO.
    await setAuthority(sql, BA_AUTHORITY);
    const baResponse = await getListing(makeApp());
    expect(baResponse.status).toBe(200);
    expect(baResponse.headers.get("x-openbot-directory-authority")).toBe(
      "ba-v1",
    );
    const listing = (await baResponse.json()) as {
      companies: { tenantId: string; organizationId: string }[];
    };
    expect(listing.companies.map((company) => company.tenantId)).toEqual([
      TENANT_A,
      TENANT_B,
      TENANT_SOLO,
    ]);
    expect(
      listing.companies.every(
        (company) => company.organizationId === company.tenantId,
      ),
    ).toBe(true);
  });

  test("ba_listing_advertises_roles_capabilities_and_versions", async () => {
    await setAuthority(harness().sql, BA_AUTHORITY);
    const response = await getListing(makeApp());
    expect(response.status).toBe(200);
    const listing = (await response.json()) as {
      companies: {
        tenantId: string;
        name: string;
        role: string;
        memberEpoch: number;
        companyGeneration: number;
        capabilities: string[];
        teams: {
          workspaceId: string;
          teamId: string;
          name: string;
          workspaceMemberEpoch: number;
          teamGeneration: number;
        }[];
      }[];
    };
    const byTenant = new Map(
      listing.companies.map((company) => [company.tenantId, company]),
    );
    // A plain member of a and b: a has no capabilities at all; b carries
    // finance:read from its explicit grant row — with the role staying a
    // plain member (the grant never upgrades it).
    const companyA = byTenant.get(TENANT_A);
    expect(companyA).toMatchObject({
      name: "T03.02 org a",
      role: "member",
      memberEpoch: 1,
      companyGeneration: 1,
      capabilities: [],
    });
    const companyB = byTenant.get(TENANT_B);
    expect(companyB).toMatchObject({
      role: "member",
      capabilities: ["finance:read"],
    });
    expect(companyA?.teams).toEqual([
      {
        workspaceId: WORKSPACE_A,
        teamId: TEAM_A,
        name: "T03.02 team a",
        workspaceMemberEpoch: 1,
        teamGeneration: 1,
      },
    ]);
    // An admin of a company they hold NO team in: company management rides
    // the company role alone (公司管理不依赖团队), so the capabilities are
    // present with an empty team list.
    const companySolo = byTenant.get(TENANT_SOLO);
    expect(companySolo).toMatchObject({
      role: "admin",
      capabilities: [
        "company:manage",
        "team:members:manage",
        "audit:metadata:read",
      ],
    });
    expect(companySolo?.teams).toEqual([]);
    // A company the actor is not a member of is absent, not defaulted.
    expect(byTenant.has(TENANT_GHOST)).toBe(false);
  });

  test("hidden_selections_answer_404_without_existence_leak", async () => {
    await setAuthority(harness().sql, BA_AUTHORITY);
    const app = makeApp();
    // A company that exists but hides this actor (no membership) ...
    const ghostCompany = await postSelection(app, {
      tenantId: TENANT_GHOST,
      workspaceId: WORKSPACE_A,
    });
    expect(ghostCompany.status).toBe(404);
    const ghostCode = await errorOf(ghostCompany);
    // ... and a workspace that matches nothing answer the SAME code, so the
    // response cannot confirm which of the two it was.
    const ghostWorkspace = await postSelection(app, {
      tenantId: TENANT_A,
      workspaceId: "t0302-ws-ghost",
    });
    expect(ghostWorkspace.status).toBe(404);
    expect(await errorOf(ghostWorkspace)).toBe(ghostCode);
  });

  test("paused_authority_serves_legacy_listing_and_refuses_validation", async () => {
    const { sql } = harness();
    await setAuthority(sql, PAUSED_AUTHORITY);
    const app = makeApp();
    const pausedListing = await getListing(app);
    expect(pausedListing.status).toBe(200);
    expect(pausedListing.headers.get("x-openbot-directory-authority")).toBe(
      "legacy",
    );
    expect(await pausedListing.json()).toEqual(LEGACY_LISTING);
    const validation = await postSelection(app, {
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
    });
    expect(validation.status).toBe(503);
    expect(await errorOf(validation)).toBe("DIRECTORY_MIGRATION_PAUSED");
  });

  test("legacy_authority_refuses_ba_v1_validation", async () => {
    await setAuthority(harness().sql, LEGACY_AUTHORITY);
    const validation = await postSelection(makeApp(), {
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
    });
    expect(validation.status).toBe(503);
    expect(await errorOf(validation)).toBe("BA_SELECTION_AUTHORITY_CLOSED");
  });

  test("proof_demanded_company_requires_reauth_to_validate", async () => {
    await setAuthority(harness().sql, BA_AUTHORITY);
    const proofDemanding = createClosedCompanyAssurance({
      policy: { requiresProof: async () => true },
    });
    const app = makeApp(proofDemanding);
    const validation = await postSelection(app, {
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
    });
    expect(validation.status).toBe(403);
    expect(await errorOf(validation)).toBe("COMPANY_REAUTH_REQUIRED");
    // Discovery never asks the proof port: the company stays listed so the
    // client can see where to re-prove.
    const listing = await getListing(app);
    expect(listing.status).toBe(200);
    const body = (await listing.json()) as {
      companies: { tenantId: string }[];
    };
    expect(body.companies.some((c) => c.tenantId === TENANT_A)).toBe(true);
  });

  test("unreadable_authority_state_is_a_storage_refusal", async () => {
    const { sql } = harness();
    await setAuthority(sql, BA_AUTHORITY);
    await sql`DELETE FROM auth_authority_states WHERE id = 1`;
    const app = makeApp();
    const listing = await getListing(app);
    expect(listing.status).toBe(503);
    expect(await errorOf(listing)).toBe("AUTHORITY_STATE_MISSING");
    const validation = await postSelection(app, {
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
    });
    expect(validation.status).toBe(503);
    expect(await errorOf(validation)).toBe("AUTHORITY_STATE_MISSING");
    await sql`
      INSERT INTO auth_authority_states
        (id, authority_version, phase, directory_authority, multi_tenant_released, updated_at)
      VALUES (1, ${BA_AUTHORITY.authorityVersion}, ${BA_AUTHORITY.phase},
              ${BA_AUTHORITY.directoryAuthority}, ${BA_AUTHORITY.multiTenantReleased}, now())`;
  });

  test("unauthenticated_requests_answer_401", async () => {
    await setAuthority(harness().sql, BA_AUTHORITY);
    const app = makeApp(undefined, async () => null);
    const listing = await getListing(app);
    expect(listing.status).toBe(401);
    const validation = await postSelection(app, {
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
    });
    expect(validation.status).toBe(401);
  });

  test("tombstoned_clock_hides_the_company", async () => {
    const { sql } = harness();
    await setAuthority(sql, BA_AUTHORITY);
    await sql`
      UPDATE auth_eligibility_clocks SET tombstone = true, last_command_id = 't0302-c1'
       WHERE tenant_id = ${TENANT_B} AND principal_id = ${PRINCIPAL} AND kind = 'company'`;
    const app = makeApp();
    const listing = await getListing(app);
    expect(listing.status).toBe(200);
    const body = (await listing.json()) as {
      companies: { tenantId: string }[];
    };
    expect(body.companies.some((c) => c.tenantId === TENANT_B)).toBe(false);
    const validation = await postSelection(app, {
      tenantId: TENANT_B,
      workspaceId: WORKSPACE_B,
    });
    expect(validation.status).toBe(404);
    await sql`
      UPDATE auth_eligibility_clocks SET tombstone = false, last_command_id = 't0302-c0'
       WHERE tenant_id = ${TENANT_B} AND principal_id = ${PRINCIPAL} AND kind = 'company'`;
  });

  test("wrapper_delegates_every_base_route_unchanged", async () => {
    await setAuthority(harness().sql, BA_AUTHORITY);
    const app = makeApp();
    // The base was built without the admin channel, so its own admin face
    // answers 503 WORKSPACE_ADMIN_UNAVAILABLE — and the wrapper must pass
    // exactly that answer through, not intercept or re-shape it.
    const through = await app.request(surface("/admin/teams"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "nope" }),
    });
    expect(through.status).toBe(503);
    expect(await errorOf(through)).toBe("WORKSPACE_ADMIN_UNAVAILABLE");
  });
});
