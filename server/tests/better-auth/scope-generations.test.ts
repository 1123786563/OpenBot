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
import {
  COMPANY_REAUTH_REQUIRED,
  type CompanyAssurance,
  createClosedCompanyAssurance,
  isCompanyAssuranceRefusal,
} from "../../src/auth/company-assurance";
import { createDirectoryAuthority } from "../../src/auth/directory/authority";
import { createDatabase } from "../../src/db/client";
import { createBaRevocationGuard } from "../../src/enterprise/tenancy/revocation";
import { createBaWorkspaceGate } from "../../src/enterprise/tenancy/scope-gate";
import {
  assertTrustedScope,
  createBaScopeResolver,
} from "../../src/enterprise/tenancy/store";
import {
  MIGRATION_STATE_SCENARIOS,
  withAuthorityMatrix,
} from "./support/authority-matrix";

/*
 * T03.01 (#538, P05) — the real scope gate compares the persistent identity
 * and the two-layer eligibility versions (interfaces §4; design §7.1/§13.2).
 *
 * What this file pins, and why each fact is a database row rather than a code
 * convention:
 *
 * - `removed_rejoined_member_cannot_reuse_scope`: a removal+rejoin advances
 *   the same clock key's epoch and generation, so the OLD scope dies with
 *   SCOPE_REVOKED at the gate while a freshly issued scope works — a re-join
 *   never resurrects abilities issued against an older generation.
 * - `forged_scope_json_is_rejected`: a scope deserialized from JSON carries no
 *   process trust mark; the gate refuses it BEFORE touching the database, so
 *   the operation never runs (operationCalls === 0). Headers stay selectors.
 * - `pooled_connection_has_no_leftover_rls`: the gate's `set_config(..., true)`
 *   settings are transaction-local; on a single-connection pool the NEXT
 *   request sees no leftover `app.*` scope after the gate's commit.
 * - `with_authority_matrix_covers_legacy_paused_and_ba`: the same resolve+gate
 *   flow runs under every migration state M0–M4. Legacy and paused keep the
 *   original issuance and revalidation (no BA clock, no proof, scope without
 *   generation fields); ba enforces the new eligibility versions; a legacy
 *   tenant with no BA rows closes under ba instead of falling back.
 * - `authority_switch_to_ba_invalidates_legacy_scopes`: scopes minted before
 *   the switch carry no versions; the ba-branch gate refuses them — the
 *   switch is fail-closed, never a graceful degrade.
 * - `identity_generation_drift_closes_the_ba_branch` and
 *   `missing_clocks_close_the_ba_branch`: a missing or drifted version is
 *   "cannot compare", never a default, so the branch closes.
 * - `proof_is_required_only_in_the_ba_branch`: the CompanyAssurance port is a
 *   required injection of the BA factories and is asked in the ba branch; the
 *   legacy/paused branches never ask, so an existing tenant is not refused by
 *   a proof policy a migration it has not reached would enforce.
 * - `ba_factories_refuse_missing_dependencies`: the authority and assurance
 *   ports are required at construction — an optional port is the bypass.
 * - `revocation_guard_maps_the_ba_gate_verdicts`: the BA revocation guard maps
 *   the two gate codes to company/team denials and never folds proof or
 *   infrastructure refusals into a verdict.
 * - `thread_resolution_carry_versions_in_the_ba_branch`: resolveForThread also
 *   revalidates the BA facts and mints a versioned scope.
 *
 * The suite applies the real 0209–0214 better-auth migrations on the isolated
 * BA_TEST_* database and cleans up exactly what it created, restoring the
 * pre-T02.02 baseline (no identity_generation column, 0055 tenant-status
 * domain). All five BA_TEST_* role URLs are required; a missing one is a
 * blocked suite, never a fallback to the shared/MT database. No DSN is ever
 * printed.
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

const BA_TENANT = "t0301-tenant";
const BA_WORKSPACE = "t0301-workspace";
const BA_TEAM = "t0301-team";
const LEGACY_TENANT = "t0301-tenant-legacy";
const LEGACY_WORKSPACE = "t0301-workspace-legacy";
const USER = "t0301-user";
const PRINCIPAL = "t0301-principal";
const THREAD = "t0301-thread";
/** The identity generation the seeded BA principal carries. */
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
        `${variable} is required: the scope-generations suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
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
  await sql`DELETE FROM enterprise_workspace_memberships WHERE tenant_id LIKE 't0301-%'`;
  await sql`DELETE FROM enterprise_memberships WHERE tenant_id LIKE 't0301-%'`;
  await sql`DELETE FROM enterprise_principals WHERE id LIKE 't0301-%'`;
  await sql`DELETE FROM enterprise_workspaces WHERE tenant_id LIKE 't0301-%'`;
  await sql`DELETE FROM enterprise_tenants WHERE id LIKE 't0301-%'`;
  await sql`DELETE FROM users WHERE id LIKE 't0301-%'`;
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
      (${BA_TENANT}, 'T03.01 ba company'),
      (${LEGACY_TENANT}, 'T03.01 legacy company')`;
  await sql`
    INSERT INTO users (id, email) VALUES
      (${USER}, 't0301-user@example.test')`;
  // One user one principal. The principal carries a verified generation (the
  // legacy branch never reads it, so legacy tenancy is unaffected); a NULL
  // generation is exercised in the drift case against this same row.
  await sql`
    INSERT INTO enterprise_principals (id, user_id, identity_generation) VALUES
      (${PRINCIPAL}, ${USER}, ${IDENTITY_GENERATION})`;
  await sql`
    INSERT INTO enterprise_workspaces (tenant_id, id, name) VALUES
      (${BA_TENANT}, ${BA_WORKSPACE}, 'T03.01 ba workspace'),
      (${LEGACY_TENANT}, ${LEGACY_WORKSPACE}, 'T03.01 legacy workspace')`;
  await sql`
    INSERT INTO enterprise_memberships (tenant_id, principal_id, role, epoch) VALUES
      (${BA_TENANT}, ${PRINCIPAL}, 'member', 1),
      (${LEGACY_TENANT}, ${PRINCIPAL}, 'member', 1)`;
  await sql`
    INSERT INTO enterprise_workspace_memberships
      (tenant_id, workspace_id, principal_id, epoch)
    VALUES
      (${BA_TENANT}, ${BA_WORKSPACE}, ${PRINCIPAL}, 1),
      (${LEGACY_TENANT}, ${LEGACY_WORKSPACE}, ${PRINCIPAL}, 1)`;
  await sql`
    INSERT INTO enterprise_conversations (tenant_id, workspace_id, principal_id, thread_id, title)
    VALUES
      (${BA_TENANT}, ${BA_WORKSPACE}, ${PRINCIPAL}, ${THREAD}, 'T03.01 thread'),
      (${LEGACY_TENANT}, ${LEGACY_WORKSPACE}, ${PRINCIPAL}, 't0301-thread-legacy', 'T03.01 legacy thread')`;
  // The BA directory rows the ba branch reads as "who is a member now". The
  // 0214 DML guard on these tables demands a live command context; a test
  // fixture is not a command, so the guard is disabled around the seed and
  // restored right after (the T02.15 recipe). The clocks carry no guard.
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
        VALUES (${BA_TENANT}, 'T03.01 ba company', 't0301-ba-company')`;
      await sql`
        INSERT INTO auth_teams (id, organization_id, name)
        VALUES (${BA_TEAM}, ${BA_TENANT}, 'T03.01 ba team')`;
      await sql`
        INSERT INTO auth_team_bindings (tenant_id, workspace_id, team_id)
        VALUES (${BA_TENANT}, ${BA_WORKSPACE}, ${BA_TEAM})`;
      await sql`
        INSERT INTO auth_members (id, organization_id, user_id, role)
        VALUES ('t0301-member', ${BA_TENANT}, ${USER}, 'member')`;
      await sql`
        INSERT INTO auth_team_members (id, team_id, user_id)
        VALUES ('t0301-team-member', ${BA_TEAM}, ${USER})`;
    },
  );
  await seedClocks(sql);
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

/** The durable two-layer clocks: company (scope = tenant) and team (scope = workspace), established at 1/1. */
async function seedClocks(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO auth_eligibility_clocks
      (tenant_id, principal_id, kind, scope_id, epoch, generation, tombstone, last_command_id)
    VALUES
      (${BA_TENANT}, ${PRINCIPAL}, 'company', ${BA_TENANT}, 1, 1, false, 't0301-c0'),
      (${BA_TENANT}, ${PRINCIPAL}, 'team', ${BA_WORKSPACE}, 1, 1, false, 't0301-c0')`;
}

/**
 * Returns the BA fixture to its seeded versions: clocks at 1/1, projections
 * at epoch 1 and active, the principal's generation back to the seed. Called
 * at the end of every case that advanced a version, so declaration order
 * never leaks state into the next case.
 */
async function restoreBaVersions(sql: postgres.Sql): Promise<void> {
  await sql`
    DELETE FROM auth_eligibility_clocks
     WHERE tenant_id = ${BA_TENANT} AND principal_id = ${PRINCIPAL}`;
  await seedClocks(sql);
  await sql`
    UPDATE enterprise_memberships SET epoch = 1, status = 'active'
     WHERE tenant_id = ${BA_TENANT} AND principal_id = ${PRINCIPAL}`;
  await sql`
    UPDATE enterprise_workspace_memberships SET epoch = 1, status = 'active'
     WHERE tenant_id = ${BA_TENANT} AND workspace_id = ${BA_WORKSPACE}
       AND principal_id = ${PRINCIPAL}`;
  await sql`
    UPDATE enterprise_principals SET identity_generation = ${IDENTITY_GENERATION}, status = 'active'
     WHERE id = ${PRINCIPAL}`;
}

interface Harness {
  sql: postgres.Sql;
  db: ReturnType<typeof createDatabase>;
  /** The real restricted ob_ent_data connection the clock read rides on. */
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
  try {
    await cleanupFixture(sql);
    for (const tag of MIGRATION_TAGS) {
      await sql.unsafe(loadMigrationSql(tag));
    }
    await seedFixture(sql);
    await setAuthority(sql, BA_AUTHORITY);
    const db = createDatabase(setupUrl, { max: 3 });
    const dataDb = createDatabase(
      process.env.BA_TEST_DATA_DATABASE_URL!.trim(),
      { max: 2 },
    );
    const close = async () => {
      try {
        await cleanupFixture(sql);
      } finally {
        await db.$client.close?.();
        await dataDb.$client.close?.();
        await sql.end({ timeout: 5 }).catch(() => {});
      }
    };
    return { sql, db, dataDb, close };
  } catch (error) {
    await cleanupFixture(sql).catch(() => {});
    await sql.end({ timeout: 5 }).catch(() => {});
    throw error;
  }
}

function harness(): Harness {
  if (!state) throw new Error("scope-generations harness is not initialized");
  return state;
}

function baRequest(tenantId = BA_TENANT, workspaceId = BA_WORKSPACE): Request {
  return new Request("https://openbot.test/api/enterprise/copilotkit", {
    headers: {
      "x-openbot-tenant": tenantId,
      "x-openbot-workspace": workspaceId,
    },
  });
}

function legacyRequest(): Request {
  return baRequest(LEGACY_TENANT, LEGACY_WORKSPACE);
}

function makeResolver(assurance?: CompanyAssurance) {
  return createBaScopeResolver(harness().db, {
    authenticate: async () => ({ actorId: USER, entrypoint: "web" }),
    selectTenant: (request) => request.headers.get("x-openbot-tenant"),
    selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
    data: harness().dataDb,
    authority: createDirectoryAuthority(),
    assurance:
      assurance ??
      createClosedCompanyAssurance({
        policy: { requiresProof: async () => false },
      }),
  });
}

function makeGate() {
  return createBaWorkspaceGate(harness().db, {
    authority: createDirectoryAuthority(),
    assurance: createClosedCompanyAssurance({
      policy: { requiresProof: async () => false },
    }),
  });
}

/** Resolves to the thrown error code (empty string when it did not throw). */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    const codes: string[] = [];
    const messages: string[] = [];
    for (let e = error; e instanceof Error; e = e.cause) {
      messages.push(e.message);
      const code = (e as { code?: unknown }).code;
      if (typeof code === "string") codes.push(code);
    }
    const text = messages.join(" | ");
    return codes.length > 0 ? `${text} [${codes.join(",")}]` : text;
  }
}

/** Drizzle execute results arrive as rows or wrapped rows depending on driver shape. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
}

async function resolveBaScope() {
  return makeResolver().resolve(baRequest());
}

describe("T03.01 scope generations (Issue #538)", () => {
  beforeAll(async () => {
    state = await createHarness();
  });

  afterAll(async () => {
    const current = state;
    state = undefined;
    await current?.close();
  });

  test("ba_factories_refuse_missing_dependencies", async () => {
    const { db, dataDb } = harness();
    const authenticate = async () => ({ actorId: USER, entrypoint: "web" });
    const authority = createDirectoryAuthority();
    const assurance = createClosedCompanyAssurance({
      policy: { requiresProof: async () => false },
    });
    // A runtime caller that passes a half-built options object is refused at
    // construction — the DEPS_REQUIRED refusal, before any request is answered.
    expect(() =>
      createBaScopeResolver(db, {
        authenticate,
        data: dataDb,
        authority,
        assurance: undefined as unknown as CompanyAssurance,
      }),
    ).toThrow("DEPS_REQUIRED");
    expect(() =>
      createBaScopeResolver(db, {
        authenticate,
        data: dataDb,
        authority: undefined as never,
        assurance,
      }),
    ).toThrow("DEPS_REQUIRED");
    expect(() =>
      createBaWorkspaceGate(db, {
        authority,
        assurance: undefined as unknown as CompanyAssurance,
      }),
    ).toThrow("DEPS_REQUIRED");
    expect(() =>
      createBaWorkspaceGate(db, {
        authority: undefined as never,
        assurance,
      }),
    ).toThrow("DEPS_REQUIRED");
    expect(() =>
      createBaRevocationGuard(db, {
        authority: undefined as never,
        assurance,
      }),
    ).toThrow("DEPS_REQUIRED");
  });

  test("ba_issuance_produces_frozen_trusted_scope_with_versions", async () => {
    await setAuthority(harness().sql, BA_AUTHORITY);
    const scope = await resolveBaScope();
    expect(Object.isFrozen(scope)).toBe(true);
    expect(() => assertTrustedScope(scope)).not.toThrow();
    expect(scope.tenantId).toBe(BA_TENANT);
    expect(scope.principalId).toBe(PRINCIPAL);
    expect(scope.memberEpoch).toBe(1);
    expect(scope.identityGeneration).toBe(IDENTITY_GENERATION);
    expect(scope.companyGeneration).toBe(1);
    expect(scope.workspaceMemberEpoch).toBe(1);
    expect(scope.teamGeneration).toBe(1);
  });

  test("removed_rejoined_member_cannot_reuse_scope", async () => {
    const { sql } = harness();
    await setAuthority(sql, BA_AUTHORITY);
    const gate = makeGate();
    const oldScope = await resolveBaScope();
    // The removal advances the company clock; the re-join re-establishes the
    // same key at epoch/generation 2 (tombstone cleared by the new
    // relationship) and the projections advance in the same command.
    await sql`
      UPDATE auth_eligibility_clocks
         SET epoch = 2, generation = 2, tombstone = false, last_command_id = 't0301-c2'
       WHERE tenant_id = ${BA_TENANT} AND principal_id = ${PRINCIPAL}
         AND kind = 'company'`;
    await sql`
      UPDATE enterprise_memberships SET epoch = 2
       WHERE tenant_id = ${BA_TENANT} AND principal_id = ${PRINCIPAL}`;
    // The OLD scope must be dead at the gate even though the member is back.
    let operationCalls = 0;
    const oldResult = await gate
      .transaction(oldScope, async () => {
        operationCalls += 1;
        return "ran";
      })
      .then(
        () => ({ code: "" }),
        (error: Error) => ({ code: error.message }),
      );
    expect(operationCalls).toBe(0);
    expect(oldResult.code).toBe("SCOPE_REVOKED");
    // A freshly issued scope against the CURRENT versions works.
    const newScope = await resolveBaScope();
    expect(newScope.memberEpoch).toBe(2);
    expect(newScope.companyGeneration).toBe(2);
    const ran = await gate.transaction(newScope, async () => "ran");
    expect(ran).toBe("ran");
    await restoreBaVersions(sql);
  });

  test("forged_scope_json_is_rejected", async () => {
    await setAuthority(harness().sql, BA_AUTHORITY);
    const gate = makeGate();
    const issued = await resolveBaScope();
    const forged = JSON.parse(JSON.stringify(issued));
    expect(JSON.stringify(forged)).toBe(JSON.stringify(issued));
    let operationCalls = 0;
    await expect(
      gate.transaction(forged, async () => {
        operationCalls += 1;
      }),
    ).rejects.toThrow("UNVERIFIED_SCOPE");
    expect(operationCalls).toBe(0);
  });

  test("pooled_connection_has_no_leftover_rls", async () => {
    const { sql } = harness();
    await setAuthority(sql, BA_AUTHORITY);
    // A one-connection pool proves the SAME pooled connection is reused: the
    // gate's transaction ends, the next execute rides the connection back
    // from the pool, and it must carry none of the gate's app.* settings.
    const pooled = createDatabase(process.env[DATABASE_VARIABLE]!.trim(), {
      max: 1,
    });
    try {
      const gate = createBaWorkspaceGate(pooled, {
        authority: createDirectoryAuthority(),
        assurance: createClosedCompanyAssurance({
          policy: { requiresProof: async () => false },
        }),
      });
      const scope = await resolveBaScope();
      await gate.transaction(scope, async () => "ok");
      const rows = rowsOf(
        await pooled.execute(
          dsql`select nullif(current_setting('app.tenant_id', true), '') as tenant_id,
                      nullif(current_setting('app.principal_id', true), '') as principal_id,
                      nullif(current_setting('app.user_id', true), '') as user_id,
                      nullif(current_setting('app.workspace_id', true), '') as workspace_id`,
        ),
      );
      const row = rows[0] ?? {};
      const nextRequestScope =
        row.tenant_id ??
        row.principal_id ??
        row.user_id ??
        row.workspace_id ??
        null;
      expect(nextRequestScope).toBeNull();
    } finally {
      await pooled.$client.close?.();
    }
  });

  test("team_layer_versions_gate_the_team_half", async () => {
    const { sql } = harness();
    await setAuthority(sql, BA_AUTHORITY);
    const gate = makeGate();
    const scope = await resolveBaScope();
    // Advance ONLY the team layer (clock and its projection, the way one
    // command transaction would): the company half stays valid, the team
    // half must die with WORKSPACE_REVOKED.
    await sql`
      UPDATE auth_eligibility_clocks
         SET epoch = 2, generation = 3, last_command_id = 't0301-c3'
       WHERE tenant_id = ${BA_TENANT} AND principal_id = ${PRINCIPAL}
         AND kind = 'team' AND scope_id = ${BA_WORKSPACE}`;
    await sql`
      UPDATE enterprise_workspace_memberships SET epoch = 2
       WHERE tenant_id = ${BA_TENANT} AND workspace_id = ${BA_WORKSPACE}
         AND principal_id = ${PRINCIPAL}`;
    const result = await gate
      .transaction(scope, async () => "ran")
      .then(
        () => ({ code: "" }),
        (error: Error) => ({ code: error.message }),
      );
    expect(result.code).toBe("WORKSPACE_REVOKED");
    const fresh = await resolveBaScope();
    expect(fresh.workspaceMemberEpoch).toBe(2);
    expect(fresh.teamGeneration).toBe(3);
    expect(await gate.transaction(fresh, async () => "ran")).toBe("ran");
    // A suspended workspace-membership row denies even a versioned scope.
    await sql`
      UPDATE enterprise_workspace_memberships SET status = 'suspended'
       WHERE tenant_id = ${BA_TENANT} AND workspace_id = ${BA_WORKSPACE}
         AND principal_id = ${PRINCIPAL}`;
    await expect(gate.transaction(fresh, async () => "ran")).rejects.toThrow(
      "WORKSPACE_REVOKED",
    );
    await restoreBaVersions(sql);
  });

  test("identity_generation_drift_closes_the_ba_branch", async () => {
    const { sql } = harness();
    await setAuthority(sql, BA_AUTHORITY);
    const gate = makeGate();
    const scope = await resolveBaScope();
    await sql`
      UPDATE enterprise_principals SET identity_generation = 5 WHERE id = ${PRINCIPAL}`;
    await expect(gate.transaction(scope, async () => "ran")).rejects.toThrow(
      "SCOPE_REVOKED",
    );
    // A NULL generation is "cannot compare" at issuance: closed, not guessed.
    await sql`
      UPDATE enterprise_principals SET identity_generation = NULL WHERE id = ${PRINCIPAL}`;
    expect(await codeOf(resolveBaScope())).toBe("TENANT_FORBIDDEN");
    await sql`
      UPDATE enterprise_principals SET identity_generation = ${IDENTITY_GENERATION} WHERE id = ${PRINCIPAL}`;
    expect(
      await gate.transaction(await resolveBaScope(), async () => "ran"),
    ).toBe("ran");
  });

  test("missing_clocks_close_the_ba_branch", async () => {
    const { sql } = harness();
    await setAuthority(sql, BA_AUTHORITY);
    await sql`
      DELETE FROM auth_eligibility_clocks
       WHERE tenant_id = ${BA_TENANT} AND principal_id = ${PRINCIPAL} AND kind = 'team'`;
    expect(await codeOf(resolveBaScope())).toBe("WORKSPACE_FORBIDDEN");
    await sql`
      DELETE FROM auth_eligibility_clocks
       WHERE tenant_id = ${BA_TENANT} AND principal_id = ${PRINCIPAL} AND kind = 'company'`;
    expect(await codeOf(resolveBaScope())).toBe("TENANT_FORBIDDEN");
    await seedClocks(sql);
    expect((await resolveBaScope()).companyGeneration).toBe(1);
  });

  test("proof_is_required_only_in_the_ba_branch", async () => {
    const { sql } = harness();
    const proofDemanding = createClosedCompanyAssurance({
      policy: { requiresProof: async () => true },
    });
    await setAuthority(sql, BA_AUTHORITY);
    // ba: the proof port is asked inside the resolver's transaction.
    const baRefusal = await makeResolver(proofDemanding)
      .resolve(baRequest())
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(isCompanyAssuranceRefusal(baRefusal)).toBe(true);
    expect(baRefusal).toMatchObject({ code: COMPANY_REAUTH_REQUIRED });
    // The gate asks too — with a scope that is otherwise perfectly valid.
    const scope = await resolveBaScope();
    const gateRefusal = await createBaWorkspaceGate(harness().db, {
      authority: createDirectoryAuthority(),
      assurance: proofDemanding,
    })
      .transaction(scope, async () => "ran")
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(isCompanyAssuranceRefusal(gateRefusal)).toBe(true);
    expect(gateRefusal).toMatchObject({ code: COMPANY_REAUTH_REQUIRED });
    // legacy: the same proof-demanding port is never asked — an existing
    // tenant is not refused by a policy a migration it has not reached owns.
    await setAuthority(sql, LEGACY_AUTHORITY);
    const legacyScope = await makeResolver(proofDemanding).resolve(
      legacyRequest(),
    );
    expect(legacyScope.tenantId).toBe(LEGACY_TENANT);
  });

  test("authority_switch_to_ba_invalidates_legacy_scopes", async () => {
    const { sql } = harness();
    await setAuthority(sql, LEGACY_AUTHORITY);
    const gate = makeGate();
    const scope = await resolveBaScope();
    // Under legacy the mint carries no versions; it works.
    expect(scope.companyGeneration).toBeUndefined();
    expect(await gate.transaction(scope, async () => "ran")).toBe("ran");
    // The M4 switch: the same scope is refused — no graceful degrade.
    await setAuthority(sql, BA_AUTHORITY);
    await expect(gate.transaction(scope, async () => "ran")).rejects.toThrow(
      "SCOPE_REVOKED",
    );
  });

  test("revocation_guard_maps_the_ba_gate_verdicts", async () => {
    const { sql } = harness();
    await setAuthority(sql, BA_AUTHORITY);
    const guard = createBaRevocationGuard(harness().db, {
      authority: createDirectoryAuthority(),
      assurance: createClosedCompanyAssurance({
        policy: { requiresProof: async () => false },
      }),
    });
    const scope = await resolveBaScope();
    expect(await guard.decide(scope, "task.sensitive")).toEqual({
      outcome: "allow",
    });
    await sql`
      UPDATE auth_eligibility_clocks
         SET generation = generation + 1, last_command_id = 't0301-c4'
       WHERE tenant_id = ${BA_TENANT} AND principal_id = ${PRINCIPAL}
         AND kind = 'company'`;
    expect(await guard.decide(scope, "credentials.access")).toEqual({
      outcome: "deny",
      code: "SCOPE_REVOKED",
      level: "company",
    });
    // A proof refusal is never folded into a verdict: it propagates.
    const fresh = await resolveBaScope();
    const proofGuard = createBaRevocationGuard(harness().db, {
      authority: createDirectoryAuthority(),
      assurance: createClosedCompanyAssurance({
        policy: { requiresProof: async () => true },
      }),
    });
    await expect(proofGuard.decide(fresh, "list")).rejects.toMatchObject({
      code: COMPANY_REAUTH_REQUIRED,
    });
    await restoreBaVersions(sql);
  });

  test("headers_select_but_membership_decides", async () => {
    await setAuthority(harness().sql, BA_AUTHORITY);
    // A tenant the actor holds no membership in stays forbidden under ba even
    // though the selector header names it: the header is intent, not fact.
    expect(
      await codeOf(
        makeResolver().resolve(baRequest("t0301-tenant-other", BA_WORKSPACE)),
      ),
    ).toBe("TENANT_FORBIDDEN");
    // A workspace with no binding for the selected company closes the team
    // half without leaking whether the workspace exists.
    expect(
      await codeOf(
        makeResolver().resolve(baRequest(BA_TENANT, "t0301-workspace-ghost")),
      ),
    ).toBe("WORKSPACE_FORBIDDEN");
  });

  test("thread_resolution_carries_versions_in_the_ba_branch", async () => {
    const { sql } = harness();
    await setAuthority(sql, BA_AUTHORITY);
    const resolver = makeResolver();
    const scope = await resolver.resolveForThread(
      baRequest(BA_TENANT, BA_WORKSPACE),
      THREAD,
    );
    expect(() => assertTrustedScope(scope)).not.toThrow();
    expect(scope.identityGeneration).toBe(IDENTITY_GENERATION);
    expect(scope.companyGeneration).toBe(1);
    expect(scope.teamGeneration).toBe(1);
    expect(await makeGate().transaction(scope, async () => "ran")).toBe("ran");
    await setAuthority(sql, LEGACY_AUTHORITY);
    const legacyScope = await resolver.resolveForThread(
      legacyRequest(),
      "t0301-thread-legacy",
    );
    expect(legacyScope.companyGeneration).toBeUndefined();
  });

  test("with_authority_matrix_covers_legacy_paused_and_ba", async () => {
    const { sql, db } = harness();
    const resolver = makeResolver();
    const gate = makeGate();
    await withAuthorityMatrix(
      {
        setAuthorityState: (state) => setAuthority(sql, state),
        inDirectoryTransaction: (work) =>
          db.transaction((tx) => work(tx as never)),
      },
      async ({ scenario }) => {
        if (scenario.directoryAuthority === "ba") {
          // ba: the BA tenant resolves WITH versions and the gate accepts.
          const scope = await resolver.resolve(baRequest());
          expect(scope.companyGeneration).toBe(1);
          expect(scope.identityGeneration).toBe(IDENTITY_GENERATION);
          expect(await gate.transaction(scope, async () => "ran")).toBe("ran");
          // A legacy tenant with no BA rows closes instead of falling back.
          expect(await codeOf(resolver.resolve(legacyRequest()))).toBe(
            "TENANT_FORBIDDEN",
          );
        } else {
          // legacy and paused: business keeps the original issuance and
          // revalidation on the legacy facts; no clock, no proof, no versions.
          const scope = await resolver.resolve(legacyRequest());
          expect(scope.companyGeneration).toBeUndefined();
          expect(scope.teamGeneration).toBeUndefined();
          expect(await gate.transaction(scope, async () => "ran")).toBe("ran");
        }
      },
      MIGRATION_STATE_SCENARIOS,
    );
  });
});
