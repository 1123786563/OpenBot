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
import {
  type CredentialOwnershipAdminService,
  type CredentialOwnershipDecisionService,
  createCredentialOwnershipAdminService,
  createCredentialOwnershipDecisionService,
  type SecretVault,
} from "../../src/enterprise/tenancy/credential-ownership";
import { createBaScopeResolver } from "../../src/enterprise/tenancy/store";

/*
 * T06.03 (#575, original task P14) — authorizeUse / disclosePlaintext compare
 * the authorization source generations: the use/disclose action rows carry the
 * grantee's identity/company generation (and, for team credentials, the source
 * team generation), the personal credential carries its owner's pair, and the
 * decision refuses on a missing or mismatched version instead of stamping the
 * current one (design F01: an old source never lends a new ability).
 *
 * What this file pins on the isolated BA_TEST_* island:
 *
 * - `rejoined_member_cannot_disclose_or_use_old_credential_action`: a
 *   removal+rejoin advances the identity generation and both clocks, so the
 *   action rows granted against the OLD generations stop counting at the very
 *   next use/disclose decision — a rejoin never resurrects an old grant, and
 *   no external cleanup rewrites the rows (the comparison IS the revocation).
 * - `old_personal_owner_id_does_not_restore_authority`: the personal path no
 *   longer trusts the bare owner id — the credential's saved owner
 *   generations must still be the caller's current ones, so a stale owner
 *   pair leaves plaintextReads at exactly 0.
 * - issuance writes the source versions: register/grantAction accept the
 *   owner/grantee generations and persist them (both-or-neither, safe
 *   integers, team source generation only on team credentials), and a grant
 *   stamped with the current versions still allows use and disclose.
 * - legacy and paused scopes keep the original capability: those branches
 *   issue scopes without versions, and the decision leaves them byte for
 *   byte as before (T03.01's matrix applied to this surface).
 *
 * Fixture discipline (the better-auth island's standing recipe): the five
 * BA_TEST_* role URLs are required and must name one loopback
 * openbot_enterprise_* database; a missing URL is a blocked suite, never a
 * fallback to the shared/MT database, and no DSN is ever printed. The suite
 * applies the real 0221–0226 BA migrations, the MT027 credential RLS/grants
 * (both taken from server/scripts/multitenancy/migrate-test.ts — the single
 * source of truth, never re-typed here) and removes exactly what it created,
 * restoring the island's pre-credential-RLS resting shape.
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

const TENANT = "t0603-tenant";
const WORKSPACE = "t0603-workspace";
const TEAM = "t0603-team";
const MEMBER_USER = "t0603-member";
const ADMIN_USER = "t0603-admin";
const MEMBER_PRINCIPAL = "t0603-principal-member";
const ADMIN_PRINCIPAL = "t0603-principal-admin";
const TEAM_CREDENTIAL = "t0603-cred-team";
const PERSONAL_CREDENTIAL = "t0603-cred-personal";

// The grantee/owner source generations the fixture stamps at first issuance.
const IDENTITY_GENERATION = 4;
const COMPANY_GENERATION = 1;
const TEAM_GENERATION = 1;
const MEMBERSHIP_EPOCH = 1;
// The removal+rejoin advances every version: the same principal id returns
// with a new identity generation and both clocks move.
const REJOINED_IDENTITY_GENERATION = 5;
const REJOINED_COMPANY_GENERATION = 2;
const REJOINED_TEAM_GENERATION = 2;
const REJOINED_MEMBERSHIP_EPOCH = 2;

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

const CREDENTIAL_TABLE_STATEMENTS = statementsOfTask(
  "MT027",
  "credential_ownership_tables",
);
const CREDENTIAL_RLS_STATEMENTS = statementsOfTask(
  "MT027",
  "credential_rls_policies",
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
  await sql`DELETE FROM enterprise_workspace_memberships WHERE tenant_id LIKE 't0603-%'`;
  await sql`DELETE FROM enterprise_memberships WHERE tenant_id LIKE 't0603-%'`;
  await sql`DELETE FROM enterprise_principals WHERE id LIKE 't0603-%'`;
  await sql`DELETE FROM enterprise_workspaces WHERE tenant_id LIKE 't0603-%'`;
  await sql`DELETE FROM enterprise_tenants WHERE id LIKE 't0603-%'`;
  await sql`DELETE FROM users WHERE id LIKE 't0603-%'`;
  // The credential tables go back to the island's resting husk: bare MT027
  // step-1 shape (no generation columns, no RLS, no restricted-role grants).
  await sql.unsafe(
    `DROP TABLE IF EXISTS "enterprise_credential_audit", "enterprise_credential_actions", "enterprise_credentials" CASCADE`,
  );
  for (const statement of CREDENTIAL_TABLE_STATEMENTS) {
    await sql.unsafe(statement);
  }
  // The restricted-role grant this suite applied (crashed-run recovery).
  await sql.unsafe(
    `REVOKE SELECT ON TABLE "enterprise_workspace_memberships" FROM ob_ent_directory, ob_ent_data, ob_ent_operator`,
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

/**
 * Memory vault (the MT027 fixture's semantics): the envelope embeds the
 * plaintext verbatim, so a denied disclosure that still opened the envelope
 * would show up as an audit row or a leaked value, never silently.
 */
class MemoryVault implements SecretVault {
  async seal(plaintext: string): Promise<string> {
    return `v1:${plaintext}`;
  }

  async open(envelope: string): Promise<string> {
    if (!envelope.startsWith("v1:")) throw new Error("VAULT_OPEN_INVALID");
    return envelope.slice(3);
  }
}

async function seedFixture(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO enterprise_tenants (id, name, policy_revision) VALUES
      (${TENANT}, 'T06.03 company', 'workspace-v1')`;
  await sql`
    INSERT INTO users (id, email) VALUES
      (${MEMBER_USER}, 't0603-member@example.test'),
      (${ADMIN_USER}, 't0603-admin@example.test')`;
  await sql`
    INSERT INTO enterprise_principals (id, user_id, identity_generation) VALUES
      (${MEMBER_PRINCIPAL}, ${MEMBER_USER}, ${IDENTITY_GENERATION}),
      (${ADMIN_PRINCIPAL}, ${ADMIN_USER}, ${IDENTITY_GENERATION})`;
  await sql`
    INSERT INTO enterprise_workspaces (tenant_id, id, name) VALUES
      (${TENANT}, ${WORKSPACE}, 'T06.03 team')`;
  await sql`
    INSERT INTO enterprise_memberships (tenant_id, principal_id, role, epoch) VALUES
      (${TENANT}, ${MEMBER_PRINCIPAL}, 'member', ${MEMBERSHIP_EPOCH}),
      (${TENANT}, ${ADMIN_PRINCIPAL}, 'tenant_admin', ${MEMBERSHIP_EPOCH})`;
  await sql`
    INSERT INTO enterprise_workspace_memberships
      (tenant_id, workspace_id, principal_id, epoch)
    VALUES (${TENANT}, ${WORKSPACE}, ${MEMBER_PRINCIPAL}, ${MEMBERSHIP_EPOCH})`;
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
        VALUES (${TENANT}, 'T06.03 company', 't0603-company')`;
      await sql`
        INSERT INTO auth_teams (id, organization_id, name)
        VALUES (${TEAM}, ${TENANT}, 'T06.03 team')`;
      await sql`
        INSERT INTO auth_team_bindings (tenant_id, workspace_id, team_id)
        VALUES (${TENANT}, ${WORKSPACE}, ${TEAM})`;
      await sql`
        INSERT INTO auth_members (id, organization_id, user_id, role) VALUES
          ('t0603-ba-member', ${TENANT}, ${MEMBER_USER}, 'member'),
          ('t0603-ba-admin', ${TENANT}, ${ADMIN_USER}, 'admin')`;
      await sql`
        INSERT INTO auth_team_members (id, team_id, user_id) VALUES
          ('t0603-ba-team-member', ${TEAM}, ${MEMBER_USER})`;
    },
  );
  await sql`
    INSERT INTO auth_eligibility_clocks
      (tenant_id, principal_id, kind, scope_id, epoch, generation, tombstone, last_command_id)
    VALUES
      (${TENANT}, ${MEMBER_PRINCIPAL}, 'company', ${TENANT}, ${MEMBERSHIP_EPOCH}, ${COMPANY_GENERATION}, false, 't0603-c0'),
      (${TENANT}, ${MEMBER_PRINCIPAL}, 'team', ${WORKSPACE}, ${MEMBERSHIP_EPOCH}, ${TEAM_GENERATION}, false, 't0603-c0')`;
  // The pre-rejoin fixtures, stamped with the CURRENT source generations:
  // a team credential with use/disclose action rows for the member, and a
  // personal credential owned by the member.
  await sql`
    INSERT INTO enterprise_credentials
      (tenant_id, id, kind, classification, workspace_id, owner_principal_id,
       target, display, envelope, owner_identity_generation, owner_company_generation)
    VALUES
      (${TENANT}, ${TEAM_CREDENTIAL}, 'connection', 'team', ${WORKSPACE}, NULL,
       'https://vendor.example', '{"label":"T06.03 team"}'::jsonb, 'v1:t0603-team-secret',
       NULL, NULL),
      (${TENANT}, ${PERSONAL_CREDENTIAL}, 'site-login', 'personal', NULL, ${MEMBER_PRINCIPAL},
       'https://portal.example', '{"label":"T06.03 personal"}'::jsonb, 'v1:t0603-personal-secret',
       ${IDENTITY_GENERATION}, ${COMPANY_GENERATION})`;
  await sql`
    INSERT INTO enterprise_credential_actions
      (tenant_id, credential_id, principal_id, action, granted_by,
       identity_generation, company_generation, source_team_generation)
    VALUES
      (${TENANT}, ${TEAM_CREDENTIAL}, ${MEMBER_PRINCIPAL}, 'use', ${ADMIN_PRINCIPAL},
       ${IDENTITY_GENERATION}, ${COMPANY_GENERATION}, ${TEAM_GENERATION}),
      (${TENANT}, ${TEAM_CREDENTIAL}, ${MEMBER_PRINCIPAL}, 'disclose', ${ADMIN_PRINCIPAL},
       ${IDENTITY_GENERATION}, ${COMPANY_GENERATION}, ${TEAM_GENERATION})`;
}

/**
 * The removal+rejoin end state: the same principal id returns with a new
 * identity generation, the company/team clocks advance epoch+generation, and
 * the membership rows carry the new epoch. Everything the old action rows
 * were stamped against is now history — the directory command that performs
 * this transition is T04.03's suite; here it is the decision's input state.
 */
async function performRejoin(sql: postgres.Sql): Promise<void> {
  await sql`
    UPDATE enterprise_principals
       SET identity_generation = ${REJOINED_IDENTITY_GENERATION}
     WHERE id = ${MEMBER_PRINCIPAL}`;
  await sql`
    UPDATE enterprise_memberships
       SET epoch = ${REJOINED_MEMBERSHIP_EPOCH}
     WHERE tenant_id = ${TENANT} AND principal_id = ${MEMBER_PRINCIPAL}`;
  await sql`
    UPDATE enterprise_workspace_memberships
       SET epoch = ${REJOINED_MEMBERSHIP_EPOCH}
     WHERE tenant_id = ${TENANT}
       AND workspace_id = ${WORKSPACE}
       AND principal_id = ${MEMBER_PRINCIPAL}`;
  await sql`
    UPDATE auth_eligibility_clocks
       SET epoch = ${REJOINED_MEMBERSHIP_EPOCH},
           generation = ${REJOINED_COMPANY_GENERATION},
           last_command_id = 't0603-rejoin'
     WHERE tenant_id = ${TENANT} AND principal_id = ${MEMBER_PRINCIPAL}
       AND kind = 'company'`;
  await sql`
    UPDATE auth_eligibility_clocks
       SET epoch = ${REJOINED_MEMBERSHIP_EPOCH},
           generation = ${REJOINED_TEAM_GENERATION},
           last_command_id = 't0603-rejoin'
     WHERE tenant_id = ${TENANT} AND principal_id = ${MEMBER_PRINCIPAL}
       AND kind = 'team'`;
}

interface Harness {
  readonly sql: postgres.Sql;
  readonly admin: CredentialOwnershipAdminService;
  readonly decisions: CredentialOwnershipDecisionService;
  resolveMemberScope(): Promise<PlatformScope>;
  setAuthority(
    row: Parameters<typeof setAuthority>[1],
  ): ReturnType<typeof setAuthority>;
  performRejoin(): Promise<void>;
  actionGenerations(
    credentialId: string,
    action: string,
  ): Promise<{
    identityGeneration: number | null;
    companyGeneration: number | null;
    sourceTeamGeneration: number | null;
  }>;
  ownerGenerations(credentialId: string): Promise<{
    ownerIdentityGeneration: number | null;
    ownerCompanyGeneration: number | null;
  }>;
  plaintextReads(credentialId: string): Promise<number>;
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
    for (const statement of CREDENTIAL_RLS_STATEMENTS) {
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
    const vault = new MemoryVault();
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
      admin: createCredentialOwnershipAdminService(operator, vault),
      decisions: createCredentialOwnershipDecisionService(data, vault),
      resolveMemberScope: () =>
        resolver.resolve(
          new Request("http://t0603.local/", {
            headers: {
              "x-test-user": MEMBER_USER,
              "x-openbot-tenant": TENANT,
              "x-openbot-workspace": WORKSPACE,
            },
          }),
        ),
      setAuthority: (row) => setAuthority(sql, row),
      performRejoin: () => performRejoin(sql),
      actionGenerations: async (credentialId, action) => {
        const rows = await sql`
          SELECT identity_generation, company_generation, source_team_generation
            FROM enterprise_credential_actions
           WHERE tenant_id = ${TENANT}
             AND credential_id = ${credentialId}
             AND principal_id = ${MEMBER_PRINCIPAL}
             AND action = ${action}`;
        const row = rows[0] as
          | {
              identity_generation: string | null;
              company_generation: string | null;
              source_team_generation: string | null;
            }
          | undefined;
        return {
          identityGeneration: row ? Number(row.identity_generation) : null,
          companyGeneration: row ? Number(row.company_generation) : null,
          sourceTeamGeneration: row ? Number(row.source_team_generation) : null,
        };
      },
      ownerGenerations: async (credentialId) => {
        const rows = await sql`
          SELECT owner_identity_generation, owner_company_generation
            FROM enterprise_credentials
           WHERE tenant_id = ${TENANT} AND id = ${credentialId}`;
        const row = rows[0] as
          | {
              owner_identity_generation: string | null;
              owner_company_generation: string | null;
            }
          | undefined;
        return {
          ownerIdentityGeneration: row
            ? Number(row.owner_identity_generation)
            : null,
          ownerCompanyGeneration: row
            ? Number(row.owner_company_generation)
            : null,
        };
      },
      plaintextReads: async (credentialId) => {
        const rows = await sql`
          SELECT count(*)::int AS reads
            FROM enterprise_credential_audit
           WHERE tenant_id = ${TENANT} AND credential_id = ${credentialId}`;
        return Number((rows[0] as { reads: number | string }).reads);
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
    throw new Error("credential-source-generations harness is not initialized");
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

describe("T06.03 credential authorization-source generations", () => {
  test("grant_issuance_records_source_generations_and_current_grant_allows", async () => {
    const fixture = harness();
    // Issuance writes the versions: register a personal credential with the
    // owner pair, grant use/disclose with the grantee pair plus the team
    // source generation, and read the rows back.
    const { credentialId: personalId } = await fixture.admin.register({
      tenantId: TENANT,
      kind: "site-login",
      classification: "personal",
      ownerPrincipalId: MEMBER_PRINCIPAL,
      target: "https://issued.example",
      label: "Issued personal",
      plaintext: "t0603-issued-secret",
      ownerIdentityGeneration: IDENTITY_GENERATION,
      ownerCompanyGeneration: COMPANY_GENERATION,
    });
    expect(await fixture.ownerGenerations(personalId)).toEqual({
      ownerIdentityGeneration: IDENTITY_GENERATION,
      ownerCompanyGeneration: COMPANY_GENERATION,
    });
    const { credentialId: teamId } = await fixture.admin.register({
      tenantId: TENANT,
      kind: "connection",
      classification: "team",
      workspaceId: WORKSPACE,
      target: "https://issued-team.example",
      label: "Issued team",
      plaintext: "t0603-issued-team-secret",
    });
    await fixture.admin.grantAction({
      tenantId: TENANT,
      credentialId: teamId,
      principalId: MEMBER_PRINCIPAL,
      action: "use",
      grantedBy: ADMIN_PRINCIPAL,
      identityGeneration: IDENTITY_GENERATION,
      companyGeneration: COMPANY_GENERATION,
      sourceTeamGeneration: TEAM_GENERATION,
    });
    await fixture.admin.grantAction({
      tenantId: TENANT,
      credentialId: teamId,
      principalId: MEMBER_PRINCIPAL,
      action: "disclose",
      grantedBy: ADMIN_PRINCIPAL,
      identityGeneration: IDENTITY_GENERATION,
      companyGeneration: COMPANY_GENERATION,
      sourceTeamGeneration: TEAM_GENERATION,
    });
    expect(await fixture.actionGenerations(teamId, "use")).toEqual({
      identityGeneration: IDENTITY_GENERATION,
      companyGeneration: COMPANY_GENERATION,
      sourceTeamGeneration: TEAM_GENERATION,
    });
    // A grant stamped with the CURRENT versions still allows both actions:
    // the generation gate is a comparison, not a blanket refusal.
    const scope = await fixture.resolveMemberScope();
    expect(scope.identityGeneration).toBe(IDENTITY_GENERATION);
    expect(scope.companyGeneration).toBe(COMPANY_GENERATION);
    expect(scope.teamGeneration).toBe(TEAM_GENERATION);
    const use = await fixture.decisions.authorizeUse(scope, teamId);
    expect(use.outcome).toBe("allow");
    const disclose = await fixture.decisions.disclosePlaintext(scope, teamId);
    expect(disclose.outcome).toBe("allow");
    expect(await fixture.plaintextReads(teamId)).toBe(1);
  });

  test("rejoined_member_cannot_disclose_or_use_old_credential_action", async () => {
    const fixture = harness();
    await fixture.performRejoin();
    const scope = await fixture.resolveMemberScope();
    // The fresh scope carries the post-rejoin versions.
    expect(scope.identityGeneration).toBe(REJOINED_IDENTITY_GENERATION);
    expect(scope.companyGeneration).toBe(REJOINED_COMPANY_GENERATION);
    expect(scope.teamGeneration).toBe(REJOINED_TEAM_GENERATION);
    const use = await fixture.decisions.authorizeUse(scope, TEAM_CREDENTIAL);
    const disclose = await fixture.decisions.disclosePlaintext(
      scope,
      TEAM_CREDENTIAL,
    );
    const allowed = use.outcome === "allow" || disclose.outcome === "allow";
    expect(allowed).toBe(false);
    // A denied disclosure never opened the envelope: no audit row appeared.
    expect(await fixture.plaintextReads(TEAM_CREDENTIAL)).toBe(0);
  });

  test("old_personal_owner_id_does_not_restore_authority", async () => {
    const fixture = harness();
    // Still the post-rejoin state: the owner's principal id is unchanged, but
    // the credential's saved owner generations are the pre-rejoin pair.
    const scope = await fixture.resolveMemberScope();
    const disclosure = await fixture.decisions.disclosePlaintext(
      scope,
      PERSONAL_CREDENTIAL,
    );
    expect(disclosure.outcome).toBe("deny");
    const plaintextReads = await fixture.plaintextReads(PERSONAL_CREDENTIAL);
    expect(plaintextReads).toBe(0);
    const use = await fixture.decisions.authorizeUse(
      scope,
      PERSONAL_CREDENTIAL,
    );
    expect(use.outcome).toBe("deny");
  });

  test("legacy_and_paused_scopes_keep_original_credential_capability", async () => {
    const fixture = harness();
    // The stale rows from the rejoined state, read through scopes the legacy
    // and paused branches issue (no versions to compare): the original
    // decision path and its DTO stay exactly as before.
    for (const authority of [LEGACY_AUTHORITY, PAUSED_AUTHORITY]) {
      await fixture.setAuthority(authority);
      const scope = await fixture.resolveMemberScope();
      expect(scope.identityGeneration).toBeUndefined();
      const use = await fixture.decisions.authorizeUse(scope, TEAM_CREDENTIAL);
      expect(use.outcome).toBe("allow");
      const personalUse = await fixture.decisions.authorizeUse(
        scope,
        PERSONAL_CREDENTIAL,
      );
      expect(personalUse.outcome).toBe("allow");
    }
    await fixture.setAuthority(BA_AUTHORITY);
  });
});
