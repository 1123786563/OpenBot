import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import {
  afterAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { createDatabase } from "../../src/db/client";
import * as connections from "../../src/enterprise/tenancy/connections";

/*
 * T02.06 (#528, P03) — the restricted connections, the DML guard and the
 * deferred constraints, checked against the real migration on the isolated
 * BA_TEST_* stack (design §5.2.1 "约束时序与命令终结", §5.3 "强制覆盖所有路
 * 径", Global Constraints "受限连接/DML guard/延迟约束"; interfaces §2/§3;
 * acceptance BA08/H1; confirmed defect F-10).
 *
 * What this file pins, and why each part is a database fact rather than a
 * code convention:
 *
 * - `runtime_roles_cannot_write_projections_or_reset_clocks`: the protected
 *   projections (the PrincipalRegistry write surface `enterprise_principals`)
 *   and the eligibility clocks are writable by NO runtime role directly —
 *   the BA-side write path is the controlled functions alone, and calling
 *   those without the matching role grant is a 42501 refusal. The durable
 *   command model (receipts) is likewise function-only, even for the writer.
 *   The legacy writer (ob_ent_operator's enterprise_* grants of 0056) is
 *   deliberately NOT touched: M1 keeps it, M4 collects those rights.
 * - `valid_intermediate_order_requires_finalization`: a teamMember may be
 *   written before its company member (the legal intermediate state of the
 *   BA invitation order), and the association is validated by the DEFERRABLE
 *   INITIALLY DEFERRED constraint triggers at SET CONSTRAINTS/commit — a
 *   missing finalizer (unfinalized receipt / change key) or an orphan final
 *   state (member removed, the company's teamMember left behind) refuses to
 *   commit, and the rollback leaves nothing behind.
 * - `missing_role_grants_fail_startup_and_schema_roles`: the PrincipalRegistry
 *   / CompanyAssurance.require role grants (auth-writer → controlled functions,
 *   data → controlled reads) are startup-verified facts — drop one and the
 *   startup path fails (baStarted false) while the runtime role is denied the
 *   call.
 * - `migration_is_idempotent_and_keeps_legacy_writer`: the migration replays
 *   on an applied database, is registered as the journal's next entry, and
 *   changes nothing about the legacy operator writer of 0056.
 * - `writer_reader_data_capability_connections_verify`: the connections layer
 *   distinguishes the directory writer as a fourth verified capability, and
 *   refuses to mislabel a writer connection as one of the other capabilities.
 *
 * The five BA_TEST_* URLs are all required (presence and same-instance shape);
 * a missing one is a blocked suite, never a silent fallback to the shared, MT
 * or job-level database. No DSN is ever printed — refusals name the variable.
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
const MIGRATION_TAG = "0214_better_auth_schema_roles";
const MIGRATION_PATH = join(
  import.meta.dirname,
  `../../drizzle/${MIGRATION_TAG}.sql`,
);
/**
 * The verified BA stack this suite's roles/functions/triggers ride on: the
 * directory tables (T02.01), the clocks (T02.02), the command model (T02.03),
 * the authority sources (T02.04) and the assurance proof storage (T02.05).
 * The BA island's shared database carries the enterprise baseline only — every
 * task's suite applies its own migrations and reverts them again, so this
 * suite applies its verified prerequisites and removes them in cleanup.
 */
const PREREQUISITE_TAGS = [
  "0209_better_auth_directory",
  "0210_better_auth_clocks",
  "0211_better_auth_command_authority",
  "0212_better_auth_authority_sources",
  "0213_better_auth_assurance",
] as const;
const PREREQUISITE_PATHS = PREREQUISITE_TAGS.map((tag) =>
  join(import.meta.dirname, `../../drizzle/${tag}.sql`),
);
/** Every BA table this suite's migration touches, dropped again at cleanup. */
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
/** The controlled functions this suite's migration installs, with signatures. */
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

const TENANT_A = "t0206-tenant-a";
const TENANT_B = "t0206-tenant-b";
const USER_A = "t0206-user-a";
const USER_B = "t0206-user-b";
const PRINCIPAL_A = "t0206-principal-a";
const PRINCIPAL_B = "t0206-principal-b";
const SESSION_A = "t0206-session-a";
const USER_C = "t0206-user-c";
const PRINCIPAL_C = "t0206-principal-c";
const WORKSPACE_A = "ws-t0206";
const WORKSPACE_B = "ws-t0206-b";
const WORKSPACE_C = "ws-t0206-c";
/** The bound BA team of workspace A (auth_organizations.id IS the tenant id). */
const TEAM_A = "t0206-team";
/** The teams the bindings case creates inside commands (empty, count 0). */
const TEAM_2 = "t0206-team-2";
const TEAM_3 = "t0206-team-3";
const CHALLENGE_A = "t0206-challenge-a";
const ASSURANCE_A = "t0206-assurance-a";

function shapeOf(variable: string, raw: string) {
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
  return { endpoint: `${host}:${url.port || "5432"}`, database };
}

function readBaUrls(): { setup: string; shapes: Map<string, string> } {
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
  const signature = (variable: string) => {
    const { endpoint, database } = shapeOf(
      variable,
      process.env[variable]!.trim(),
    );
    return `${endpoint}/${database}`;
  };
  const reference = signature(DATABASE_VARIABLE);
  for (const variable of BA_URL_VARIABLES) {
    if (signature(variable) !== reference) {
      throw new Error(
        `${variable} must name the same PostgreSQL instance and database as ${DATABASE_VARIABLE}.`,
      );
    }
  }
  return { setup: process.env[DATABASE_VARIABLE]!.trim(), shapes };
}

function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const record = current as { code?: unknown; errno?: unknown };
    for (const code of [record.code, record.errno]) {
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Read lazily, so a worktree without the roles migration still collects (and
 * fails) every case with a message naming the missing target behavior instead
 * of dying at import time as a zero-case collection error.
 */
function loadMigrationSql(): string {
  if (!existsSync(MIGRATION_PATH)) {
    throw new Error(
      `${MIGRATION_TAG}.sql does not exist: the restricted-connection roles, the controlled functions, the DML guard and the deferred constraints this suite pins are the T02.06 target behavior, not an environment problem.`,
    );
  }
  return readFileSync(MIGRATION_PATH, "utf8");
}

interface RoleClient {
  directory: postgres.Sql;
  data: postgres.Sql;
  operator: postgres.Sql;
  writer: postgres.Sql;
}

interface Harness {
  sql: postgres.Sql;
  roles: RoleClient;
  baselineTableCount: number;
  operatorLegacyWriterBefore: boolean;
  close(): Promise<void>;
}

/**
 * Returns the island to the pre-T02.06 shape: this suite's triggers,
 * functions and role grants gone, the BA tables it needed gone, its seeded
 * rows gone. Every statement is a no-op on a pristine baseline, and it also
 * recovers a crashed earlier run that left any of them behind. The
 * cluster-wide ob_ent_auth_writer capability role is NOT dropped — it is the
 * standing shape the sibling ob_ent_* roles follow, and the environment's
 * provisioning owns it.
 */
async function cleanupFixture(sql: postgres.Sql): Promise<void> {
  const triggerPairs = MIGRATION_TRIGGERS.map(
    ([table, trigger]) => `('${table}', '${trigger}')`,
  ).join(", ");
  const functions = CONTROLLED_FUNCTIONS.map(
    (signature) => `('${signature}')`,
  ).join(", ");
  const tables = BA_TABLES.map((name) => `('${name}')`).join(", ");
  await sql.unsafe(`
    DO $t0206_cleanup$
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
    $t0206_cleanup$`);
  await sql.unsafe(
    `DROP TABLE IF EXISTS ${BA_TABLES.map((name) => `"${name}"`).join(", ")} CASCADE`,
  );
  /*
   * The prerequisites this suite re-applies (0210/0212) ALTER existing
   * enterprise tables, so a crashed earlier BA run can leave their columns
   * behind on the shared island — the same normalization T02.02/T02.04's own
   * cleanups perform. Dropping them here makes the apply work from either
   * state and keeps the post-suite island identical.
   */
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
  await sql`DELETE FROM sessions WHERE id LIKE 't0206-%'`;
  await sql`DELETE FROM enterprise_principals WHERE id LIKE 't0206-%'`;
  await sql`DELETE FROM users WHERE id LIKE 't0206-%'`;
  await sql`DELETE FROM enterprise_tenants WHERE id LIKE 't0206-%'`;
}

/**
 * The baseline the roles model rides on: two companies, the two users with
 * their one-per-user principals, a session the assurance proof can bind, and
 * workspace A with its bound BA team — the team whose member rows the guard
 * and the deferred fence argue about.
 */
async function seedBaselineFixture(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO enterprise_tenants (id, name) VALUES
      (${TENANT_A}, 'T02.06 company A'),
      (${TENANT_B}, 'T02.06 company B')`;
  await sql`
    INSERT INTO users (id, email) VALUES
      (${USER_A}, 't0206-user-a@example.test'),
      (${USER_B}, 't0206-user-b@example.test'),
      (${USER_C}, 't0206-user-c@example.test')`;
  await sql`
    INSERT INTO enterprise_principals (id, user_id) VALUES
      (${PRINCIPAL_A}, ${USER_A}),
      (${PRINCIPAL_B}, ${USER_B}),
      (${PRINCIPAL_C}, ${USER_C})`;
  await sql`
    INSERT INTO sessions (id, user_id, token, expires_at) VALUES
      (${SESSION_A}, ${USER_A}, 't0206-token-a', now() + interval '2 hours')`;
  await sql`
    INSERT INTO enterprise_workspaces (tenant_id, id, name) VALUES
      (${TENANT_A}, ${WORKSPACE_A}, 'T02.06 workspace A'),
      (${TENANT_A}, ${WORKSPACE_B}, 'T02.06 workspace B'),
      (${TENANT_A}, ${WORKSPACE_C}, 'T02.06 workspace C')`;
  await sql`
    INSERT INTO auth_organizations (id, name, slug) VALUES
      (${TENANT_A}, 'T02.06 company A', 't0206-org-a'),
      (${TENANT_B}, 'T02.06 company B', 't0206-org-b')`;
  await sql`
    INSERT INTO auth_teams (id, organization_id, name) VALUES
      (${TEAM_A}, ${TENANT_A}, 'T02.06 team A')`;
  await sql`
    INSERT INTO auth_team_bindings (tenant_id, workspace_id, team_id) VALUES
      (${TENANT_A}, ${WORKSPACE_A}, ${TEAM_A})`;
  // The assurance proof the data role's controlled read returns: one active
  // proof for user A in company A, bound to its consumed challenge.
  await sql`
    INSERT INTO auth_company_auth_challenges
      (challenge_id, user_id, session_id, tenant_id, provider_id, protocol,
       policy_revision, return_path, state_digest, secret_envelope,
       consumed_at, expires_at, created_at)
    VALUES
      (${CHALLENGE_A}, ${USER_A}, ${SESSION_A}, ${TENANT_A}, 't0206-idp', 'oidc',
       1, '/enterprise/team', encode(sha256('t0206-state'::bytea), 'hex'),
       't0206-sealed-envelope', now(), now() + interval '10 minutes', now())`;
  await sql`
    INSERT INTO auth_company_session_assurances
      (assurance_id, user_id, principal_id, session_id, tenant_id,
       challenge_id, provider_id, authentication_method, issuer, subject,
       authenticated_at, strength, expires_at, policy_revision,
       identity_generation, company_generation, status)
    VALUES
      (${ASSURANCE_A}, ${USER_A}, ${PRINCIPAL_A}, ${SESSION_A}, ${TENANT_A},
       ${CHALLENGE_A}, 't0206-idp', 'oidc', 'https://idp.example',
       'user-a-at-idp', now() - interval '30 seconds', 'mfa',
       now() + interval '45 minutes', 1, 1, 1, 'active')`;
}

async function countPublicTables(sql: postgres.Sql): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
  `;
  return Number(row?.count ?? 0);
}

function roleClient(variable: string): postgres.Sql {
  return postgres(process.env[variable]!.trim(), {
    max: 1,
    idle_timeout: 5,
    onnotice: () => {},
  });
}

async function createHarness(): Promise<Harness> {
  const { setup } = readBaUrls();
  const sql = postgres(setup, {
    max: 1,
    idle_timeout: 5,
    onnotice: () => {},
  });

  try {
    await cleanupFixture(sql);

    // The verified BA stack the roles ride on, in journal order.
    for (const path of PREREQUISITE_PATHS) {
      if (!existsSync(path)) {
        throw new Error(
          `${path} does not exist: the T02.06 roles migration sits on the verified T02.01–T02.05 stack, and a missing prerequisite is a workspace problem, not a target behavior.`,
        );
      }
      await sql.unsafe(readFileSync(path, "utf8"));
    }
    await seedBaselineFixture(sql);
    const baselineTableCount = await countPublicTables(sql);

    // The M1 legacy writer fact this suite must NOT disturb: the operator
    // capability's enterprise_* DML of migration 0056 stays exactly as it is
    // until M4 collects it.
    const [legacyBefore] = await sql<{ ok: boolean }[]>`
      SELECT has_table_privilege('ob_ent_operator', 'enterprise_memberships', 'INSERT') AS ok`;
    const operatorLegacyWriterBefore = legacyBefore?.ok === true;
    if (!operatorLegacyWriterBefore) {
      throw new Error(
        "the baseline is missing the ob_ent_operator legacy writer grant of 0056; the M1-keeps-legacy proof needs it",
      );
    }

    // The target behavior under test.
    await sql.unsafe(loadMigrationSql());

    const roles: RoleClient = {
      directory: roleClient("BA_TEST_DIRECTORY_DATABASE_URL"),
      data: roleClient("BA_TEST_DATA_DATABASE_URL"),
      operator: roleClient("BA_TEST_OPERATOR_DATABASE_URL"),
      writer: roleClient("BA_TEST_AUTH_WRITER_DATABASE_URL"),
    };

    return {
      sql,
      roles,
      baselineTableCount,
      operatorLegacyWriterBefore,
      close: async () => {
        try {
          await cleanupFixture(sql);
        } finally {
          await Promise.allSettled([
            sql.end({ timeout: 5 }),
            roles.directory.end({ timeout: 5 }),
            roles.data.end({ timeout: 5 }),
            roles.operator.end({ timeout: 5 }),
            roles.writer.end({ timeout: 5 }),
          ]);
        }
      },
    };
  } catch (error) {
    // Never leave the shared BA database holding this suite's objects when
    // setup itself fails.
    await cleanupFixture(sql).catch(() => {});
    await sql.end({ timeout: 5 }).catch(() => {});
    throw error;
  }
}

let harnessPromise: Promise<Harness> | undefined;

/** One harness per process; a setup failure is this suite's failure, not a skip. */
function loadHarness(): Promise<Harness> {
  harnessPromise ??= createHarness();
  return harnessPromise;
}

/** Runs one statement factory and reports whether it was refused with 42501. */
async function refusedAsDenied(
  attempt: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await attempt();
    return false;
  } catch (error) {
    return sqlStateOf(error) === "42501";
  }
}

/** The guard's refusal marker carried by a failed statement, or undefined. */
async function refusalMarker(
  attempt: () => Promise<unknown>,
): Promise<string | undefined> {
  try {
    await attempt();
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /^AUTH_[A-Z0-9_]+$/.test(message) ? message : message.slice(0, 120);
  }
}

/**
 * The full positive command lifecycle on the writer connection: begin →
 * teamMember before member (the legal intermediate) → clock advances matching
 * the guard-registered keys → projection → finalize → SET CONSTRAINTS …
 * IMMEDIATE → commit. `options.skip` names the one step a negative case
 * leaves out.
 */
async function runProvisionCommand(
  writer: postgres.Sql,
  options: {
    commandId: string;
    idempotencyKey: string;
    userId: string;
    principalId: string;
    skip?: "finalize";
  },
): Promise<{ committed: boolean; failure?: string }> {
  let failure: string | undefined;
  const committed = await writer
    .begin(async (tx) => {
      // The transaction marker is the caller's statement: set_config inside
      // the begin function would be scoped to the function, not the tx.
      await tx`SELECT set_config('auth.current_command', public.auth_directory_begin_command(
        ${options.commandId}, 'company', 'member.provision',
        ${TENANT_A}, null, ${options.userId}, 'session',
        ${options.idempotencyKey}, 't0206-payload-hash'), true)`;
      // The legal intermediate state: the team membership exists before the
      // company membership. The immediate guard registers both change keys.
      await tx`
        INSERT INTO auth_team_members (id, team_id, user_id)
        VALUES (${`${options.commandId}-tm`}, ${TEAM_A}, ${options.userId})`;
      await tx`
        INSERT INTO auth_members (id, organization_id, user_id, role)
        VALUES (${`${options.commandId}-m`}, ${TENANT_A}, ${options.userId}, 'member')`;
      await tx`SELECT public.auth_advance_eligibility_clock(
        ${TENANT_A}, ${options.principalId}, 'team', ${WORKSPACE_A}, 1, 1, false,
        ${options.commandId})`;
      await tx`SELECT public.auth_advance_eligibility_clock(
        ${TENANT_A}, ${options.principalId}, 'company', ${TENANT_A}, 1, 1, false,
        ${options.commandId})`;
      await tx`SELECT public.auth_project_company_membership(
        ${TENANT_A}, ${options.principalId}, 'member', 'active', 1, ${options.commandId})`;
      if (options.skip !== "finalize") {
        await tx`SELECT public.auth_directory_finalize_command(${options.commandId})`;
        await tx`SELECT set_config('auth.current_command', '', true)`;
      }
      await tx.unsafe("SET CONSTRAINTS ALL IMMEDIATE");
    })
    .then(() => true)
    .catch((error: unknown) => {
      failure = error instanceof Error ? error.message : String(error);
      return false;
    });
  return { committed, failure };
}

/**
 * The orphan negative: one transaction, two commands — the provision closes
 * cleanly, then a member.remove command removes the company member but
 * "forgets" the company's team member rows. Its own bookkeeping finalizes
 * perfectly; the deferred orphan fence still refuses the commit.
 */
async function runOrphanRemovalCommand(
  writer: postgres.Sql,
): Promise<{ committed: boolean; failure?: string }> {
  let failure: string | undefined;
  const committed = await writer
    .begin(async (tx) => {
      await tx`SELECT set_config('auth.current_command', public.auth_directory_begin_command(
        't0206-cmd-orphan-add', 'company', 'member.provision',
        ${TENANT_A}, null, ${USER_B}, 'session',
        't0206-key-orphan-add', 't0206-payload-hash'), true)`;
      await tx`
        INSERT INTO auth_team_members (id, team_id, user_id)
        VALUES ('t0206-cmd-orphan-add-tm', ${TEAM_A}, ${USER_B})`;
      await tx`
        INSERT INTO auth_members (id, organization_id, user_id, role)
        VALUES ('t0206-cmd-orphan-add-m', ${TENANT_A}, ${USER_B}, 'member')`;
      await tx`SELECT public.auth_advance_eligibility_clock(
        ${TENANT_A}, ${PRINCIPAL_B}, 'team', ${WORKSPACE_A}, 1, 1, false,
        't0206-cmd-orphan-add')`;
      await tx`SELECT public.auth_advance_eligibility_clock(
        ${TENANT_A}, ${PRINCIPAL_B}, 'company', ${TENANT_A}, 1, 1, false,
        't0206-cmd-orphan-add')`;
      await tx`SELECT public.auth_directory_finalize_command('t0206-cmd-orphan-add')`;
      await tx`SELECT set_config('auth.current_command', '', true)`;

      await tx`SELECT set_config('auth.current_command', public.auth_directory_begin_command(
        't0206-cmd-orphan-remove', 'company', 'member.remove',
        ${TENANT_A}, null, ${USER_A}, 'session',
        't0206-key-orphan-remove', 't0206-payload-hash'), true)`;
      await tx`DELETE FROM auth_members WHERE id = 't0206-cmd-orphan-add-m'`;
      await tx`SELECT public.auth_advance_eligibility_clock(
        ${TENANT_A}, ${PRINCIPAL_B}, 'company', ${TENANT_A}, 1, 2, true,
        't0206-cmd-orphan-remove')`;
      await tx`SELECT public.auth_directory_finalize_command('t0206-cmd-orphan-remove')`;
      await tx`SELECT set_config('auth.current_command', '', true)`;
      await tx.unsafe("SET CONSTRAINTS ALL IMMEDIATE");
    })
    .then(() => true)
    .catch((error: unknown) => {
      failure = error instanceof Error ? error.message : String(error);
      return false;
    });
  return { committed, failure };
}

describe("T02.06 restricted connections, DML guard and deferred constraints", () => {
  afterAll(async () => {
    const created = await harnessPromise?.catch(() => undefined);
    if (created) await created.close();
    // A fresh probe, so the leak check sees the cleaned database rather than
    // the harness's released pool: no table or function this suite adds, none
    // of its rows, no lingering role grants on the BA surface.
    const { setup } = readBaUrls();
    const probe = postgres(setup, { max: 1 });
    try {
      const tables = await probe<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = ANY(${[...BA_TABLES]}::text[])`;
      expect([...tables]).toEqual([]);
      const functions = await probe`
        SELECT proname FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND position('auth_' in proname) = 1`;
      expect([...functions]).toEqual([]);
      const tenants = await probe`
        SELECT id FROM enterprise_tenants WHERE id LIKE 't0206-%'`;
      expect([...tenants]).toEqual([]);
      const users = await probe`SELECT id FROM users WHERE id LIKE 't0206-%'`;
      expect([...users]).toEqual([]);
      const principals = await probe`
        SELECT id FROM enterprise_principals WHERE id LIKE 't0206-%'`;
      expect([...principals]).toEqual([]);
      const sessions = await probe`
        SELECT id FROM sessions WHERE id LIKE 't0206-%'`;
      expect([...sessions]).toEqual([]);
      const grants = await probe<{ count: number }[]>`
        SELECT count(*)::int AS count FROM information_schema.role_table_grants
         WHERE grantee IN ('ob_ent_directory','ob_ent_data','ob_ent_operator','ob_ent_auth_writer')
           AND table_name = ANY(${[...BA_TABLES]}::text[])`;
      expect(Number(grants[0]?.count ?? 0)).toBe(0);
    } finally {
      await probe.end({ timeout: 5 }).catch(() => {});
    }
  });

  test("runtime_roles_cannot_write_projections_or_reset_clocks", async () => {
    const harness = await loadHarness();

    // The controlled-function inventory must exist before the refusal proofs
    // mean anything: a 42501 on a function that does not exist would be the
    // migration's absence, not the role boundary.
    expect(typeof connections.verifyAuthWriterDatabase).toBe("function");

    for (const [name, client] of [
      ["directory", harness.roles.directory],
      ["data", harness.roles.data],
      ["operator", harness.roles.operator],
      ["writer", harness.roles.writer],
    ] as const) {
      // The PrincipalRegistry write surface: no runtime role inserts a
      // principal directly — the BA side registers principals through the
      // controlled function alone.
      const principalDenied = await refusedAsDenied(
        () =>
          client`
          INSERT INTO enterprise_principals (id, user_id) VALUES
            (${`t0206-rogue-${name}`}, ${USER_B})`,
      );
      expect(principalDenied).toBe(true);

      // The clocks: no runtime role may write or reset one directly — not
      // the epoch, not the generation, not a tombstone, and no inserts either.
      const clockWriteDenied = await refusedAsDenied(
        () =>
          client`UPDATE auth_eligibility_clocks SET generation = 0 WHERE false`,
      );
      expect(clockWriteDenied).toBe(true);
      const clockInsertDenied = await refusedAsDenied(
        () =>
          client`
          INSERT INTO auth_eligibility_clocks
            (tenant_id, principal_id, kind, scope_id, epoch, generation, tombstone, last_command_id)
          VALUES (${TENANT_B}, ${PRINCIPAL_B}, 'company', ${TENANT_B}, 1, 1, false, 't0206-rogue')`,
      );
      expect(clockInsertDenied).toBe(true);
      const clockDeleteDenied = await refusedAsDenied(
        () => client`DELETE FROM auth_eligibility_clocks WHERE false`,
      );
      expect(clockDeleteDenied).toBe(true);

      // The assurance facts are read-side data for the data role's controlled
      // read; no runtime role edits a proof.
      const assuranceDenied = await refusedAsDenied(
        () =>
          client`UPDATE auth_company_session_assurances SET status = 'revoked' WHERE false`,
      );
      expect(assuranceDenied).toBe(true);
    }

    // The BA directory itself: the reader/data/operator capabilities get no
    // DML. The writer's directory DML is guarded by the command context —
    // proven in the next case — so here only its receipts are pinned: the
    // durable command model is written through the controlled functions, and
    // even the writer may not insert a receipt directly.
    for (const client of [
      harness.roles.directory,
      harness.roles.data,
      harness.roles.operator,
    ] as const) {
      const memberDenied = await refusedAsDenied(
        () =>
          client`
          INSERT INTO auth_members (id, organization_id, user_id, role)
          VALUES ('t0206-rogue-m', ${TENANT_A}, ${USER_A}, 'member')`,
      );
      expect(memberDenied).toBe(true);
    }
    const receiptDenied = await refusedAsDenied(
      () =>
        harness.roles.writer`
        INSERT INTO auth_command_receipts
          (command_id, domain, operation, tenant_id, idempotency_key, payload_hash, actor_kind)
        VALUES ('t0206-rogue-receipt', 'company', 'member.provision', ${TENANT_A},
                't0206-rogue-key', 't0206-rogue-hash', 'session')`,
    );
    expect(receiptDenied).toBe(true);

    // The controlled functions carry no PUBLIC EXECUTE and no grants beyond
    // their one role: the reader/data/operator capabilities cannot even open
    // a command, the data role's read functions are the only ones it can
    // call, and the writer gets no controlled reads.
    for (const client of [
      harness.roles.directory,
      harness.roles.data,
      harness.roles.operator,
    ] as const) {
      const beginDenied = await refusedAsDenied(
        () =>
          client`SELECT public.auth_directory_begin_command(
          't0206-rogue-cmd', 'company', 'member.provision', ${TENANT_A}, null,
          ${USER_A}, 'session', 't0206-rogue-key', 't0206-rogue-hash')`,
      );
      expect(beginDenied).toBe(true);
    }
    const writerReadDenied = await refusedAsDenied(
      () =>
        harness.roles
          .writer`SELECT public.auth_read_eligibility_clocks(${TENANT_A}, ${PRINCIPAL_A})`,
    );
    expect(writerReadDenied).toBe(true);
    const operatorReadDenied = await refusedAsDenied(
      () =>
        harness.roles
          .operator`SELECT public.auth_read_eligibility_clocks(${TENANT_A}, ${PRINCIPAL_A})`,
    );
    expect(operatorReadDenied).toBe(true);

    // The data role's positive grant, so the refusals above are the boundary,
    // not a blanket outage: its controlled read returns the seeded proof and
    // clock facts without any direct table access.
    const clocks = await harness.roles.data<
      { kind: string; scope_id: string }[]
    >`SELECT kind, scope_id FROM public.auth_read_eligibility_clocks(${TENANT_A}, ${PRINCIPAL_A})`;
    expect(clocks).toEqual([]);
    const assurances = await harness.roles.data<
      { assurance_id: string; status: string }[]
    >`SELECT assurance_id, status FROM public.auth_read_session_assurances(${TENANT_A}, ${USER_A})`;
    expect(assurances).toHaveLength(1);
    expect(assurances[0]?.assurance_id).toBe(ASSURANCE_A);
    expect(assurances[0]?.status).toBe("active");
  });

  test("valid_intermediate_order_requires_finalization", async () => {
    const harness = await loadHarness();
    const writer = harness.roles.writer;

    // The legal order with the finalizer: teamMember lands before member, the
    // guard registers both change keys, the clock advances match them, the
    // finalizer closes the receipt, the deferred constraints fire at SET
    // CONSTRAINTS and the commit goes through.
    const done = await runProvisionCommand(writer, {
      commandId: "t0206-cmd-ok",
      idempotencyKey: "t0206-key-ok",
      userId: USER_A,
      principalId: PRINCIPAL_A,
    });
    expect(done.committed).toBe(true);

    const [receipt] = await harness.sql`
      SELECT finalized, finalized_at IS NOT NULL AS stamped FROM auth_command_receipts
       WHERE command_id = 't0206-cmd-ok'`;
    expect(receipt?.finalized).toBe(true);
    expect(receipt?.stamped).toBe(true);
    const [projection] = await harness.sql`
      SELECT role, status, epoch FROM enterprise_memberships
       WHERE tenant_id = ${TENANT_A} AND principal_id = ${PRINCIPAL_A}`;
    expect(projection?.role).toBe("member");
    expect(projection?.status).toBe("active");
    const keys = await harness.sql`
      SELECT kind, scope_id, epoch_after, generation_after, finalized
        FROM auth_command_change_keys WHERE command_id = 't0206-cmd-ok' ORDER BY kind`;
    expect(keys.map((key) => key.kind)).toEqual(["company", "team"]);
    for (const key of keys) expect(key.finalized).toBe(true);

    // The missing finalizer: everything else identical, but the receipt and
    // its change keys never close — the deferred fences refuse the commit and
    // the rollback leaves nothing behind.
    const unfinalized = await runProvisionCommand(writer, {
      commandId: "t0206-cmd-no-finalize",
      idempotencyKey: "t0206-key-no-finalize",
      userId: USER_B,
      principalId: PRINCIPAL_B,
      skip: "finalize",
    });
    expect(unfinalized.committed).toBe(false);
    const [leftoverMembers] = await harness.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM auth_members WHERE user_id = ${USER_B}`;
    expect(Number(leftoverMembers?.count ?? 0)).toBe(0);
    const [leftoverKeys] = await harness.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM auth_command_change_keys
       WHERE command_id = 't0206-cmd-no-finalize'`;
    expect(Number(leftoverKeys?.count ?? 0)).toBe(0);

    // The orphan final state: a perfectly finalized removal command that
    // forgets the company's team member rows may not commit.
    const orphan = await runOrphanRemovalCommand(writer);
    expect(orphan.committed).toBe(false);
    const [teamMembersLeft] = await harness.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM auth_team_members`;
    expect(Number(teamMembersLeft?.count ?? 0)).toBe(1);
    const [membersLeft] = await harness.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM auth_members`;
    expect(Number(membersLeft?.count ?? 0)).toBe(1);
    const [userBClock] = await harness.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM auth_eligibility_clocks
       WHERE principal_id = ${PRINCIPAL_B}`;
    expect(Number(userBClock?.count ?? 0)).toBe(0);
  });

  test("missing_role_grants_fail_startup_and_schema_roles", async () => {
    const harness = await loadHarness();
    expect(typeof connections.verifyBaSchemaRoles).toBe("function");

    // The startup shape: the configured writer connection must verify as the
    // writer capability, and the schema-roles probe must find every grant
    // this migration owes its consumers. Grant bookkeeping runs on the setup
    // connection the way a deployment's startup probe would.
    const attemptBaStartup = async (): Promise<boolean> => {
      let writer: ReturnType<typeof createDatabase> | undefined;
      let setup: ReturnType<typeof createDatabase> | undefined;
      try {
        writer = createDatabase(
          process.env.BA_TEST_AUTH_WRITER_DATABASE_URL!.trim(),
          { max: 1 },
        );
        await connections.verifyAuthWriterDatabase(writer);
        setup = createDatabase(process.env[DATABASE_VARIABLE]!.trim(), {
          max: 1,
        });
        await connections.verifyBaSchemaRoles(setup);
        return true;
      } catch {
        return false;
      } finally {
        await writer?.close?.().catch(() => undefined);
        await setup?.close?.().catch(() => undefined);
      }
    };

    // Whole first: with every grant in place the startup path passes.
    expect(await attemptBaStartup()).toBe(true);

    // CompanyAssurance.require's grant: without the data role's controlled
    // read the startup fails AND the runtime read is denied — the schema-roles
    // counterexample.
    await harness.sql.unsafe(
      `REVOKE EXECUTE ON FUNCTION public.auth_read_eligibility_clocks(text, text) FROM ob_ent_data`,
    );
    expect(await attemptBaStartup()).toBe(false);
    const dataReadDenied = await refusedAsDenied(
      () =>
        harness.roles
          .data`SELECT public.auth_read_eligibility_clocks(${TENANT_A}, ${PRINCIPAL_A})`,
    );
    expect(dataReadDenied).toBe(true);
    await harness.sql.unsafe(
      `GRANT EXECUTE ON FUNCTION public.auth_read_eligibility_clocks(text, text) TO ob_ent_data`,
    );
    expect(await attemptBaStartup()).toBe(true);

    // PrincipalRegistry's grant: without the writer's controlled principal
    // register the startup fails and the writer's call is denied.
    await harness.sql.unsafe(
      `REVOKE EXECUTE ON FUNCTION public.auth_principals_register(text, text, text) FROM ob_ent_auth_writer`,
    );
    expect(await attemptBaStartup()).toBe(false);
    const writerRegisterDenied = await refusedAsDenied(
      () =>
        harness.roles.writer`SELECT public.auth_principals_register(
        ${`t0206-principal-new-${Date.now()}`}, ${USER_B}, 't0206-cmd-registry')`,
    );
    expect(writerRegisterDenied).toBe(true);
    await harness.sql.unsafe(
      `GRANT EXECUTE ON FUNCTION public.auth_principals_register(text, text, text) TO ob_ent_auth_writer`,
    );
    expect(await attemptBaStartup()).toBe(true);

    // The per-privilege regression (review r1 R1-F2): losing ONE DML
    // privilege on ONE directory table — the DBA half-cleanup shape — must
    // fail startup, not pass until a runtime 42501. The probe checks each of
    // SELECT/INSERT/UPDATE/DELETE on its own, so a comma-list ANY shortcut
    // cannot paper over the gap.
    await harness.sql.unsafe(
      `REVOKE INSERT ON TABLE public.auth_members FROM ob_ent_auth_writer`,
    );
    expect(await attemptBaStartup()).toBe(false);
    const memberInsertDenied = await refusedAsDenied(
      () =>
        harness.roles.writer`
        INSERT INTO auth_members (id, organization_id, user_id, role)
        VALUES ('t0206-single-dml', ${TENANT_A}, ${USER_A}, 'member')`,
    );
    expect(memberInsertDenied).toBe(true);
    await harness.sql.unsafe(
      `GRANT INSERT ON TABLE public.auth_members TO ob_ent_auth_writer`,
    );
    expect(await attemptBaStartup()).toBe(true);
  });

  test("bindings_and_team_writes_follow_the_command_contract", async () => {
    const harness = await loadHarness();
    const writer = harness.roles.writer;

    // A binding written outside any command is refused by NAME — the guard's
    // own marker, never an undefined-column crash from a fall-through branch
    // (review r1 R1-F1: auth_team_bindings used to land in the invitations
    // ELSE and die with SQLSTATE 42703 on NEW.organization_id).
    const contextRefusal = await refusalMarker(
      () =>
        writer`INSERT INTO auth_team_bindings (tenant_id, workspace_id, team_id)
             VALUES (${TENANT_A}, ${WORKSPACE_B}, ${TEAM_A})`,
    );
    expect(contextRefusal).toBe("AUTH_COMMAND_CONTEXT_REQUIRED");

    // company.provision creates a team and its binding inside the command —
    // the structural write team.create's generated ids and the default-team
    // provisioning both need, and exactly the path that used to crash.
    await writer
      .begin(async (tx) => {
        await tx`SELECT set_config('auth.current_command', public.auth_directory_begin_command(
          't0206-cmd-bind-1', 'company', 'company.provision',
          ${TENANT_A}, null, ${USER_A}, 'session',
          't0206-key-bind-1', 't0206-payload-hash'), true)`;
        await tx`INSERT INTO auth_teams (id, organization_id, name, member_count)
                 VALUES (${TEAM_2}, ${TENANT_A}, 'T02.06 team 2', 0)`;
        await tx`INSERT INTO auth_team_bindings (tenant_id, workspace_id, team_id)
                 VALUES (${TENANT_A}, ${WORKSPACE_B}, ${TEAM_2})`;
        await tx`SELECT public.auth_directory_finalize_command('t0206-cmd-bind-1')`;
        await tx`SELECT set_config('auth.current_command', '', true)`;
        await tx.unsafe("SET CONSTRAINTS ALL IMMEDIATE");
      })
      .then(() => undefined)
      .catch((error: unknown) => {
        throw new Error(
          `company.provision binding flow failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    const [bindingRow] = await harness.sql`
      SELECT team_id FROM auth_team_bindings WHERE workspace_id = ${WORKSPACE_B}`;
    expect(bindingRow?.team_id).toBe(TEAM_2);

    // team.create does the same through its own operation.
    await writer
      .begin(async (tx) => {
        await tx`SELECT set_config('auth.current_command', public.auth_directory_begin_command(
          't0206-cmd-bind-2', 'company', 'team.create',
          ${TENANT_A}, null, ${USER_A}, 'session',
          't0206-key-bind-2', 't0206-payload-hash'), true)`;
        await tx`INSERT INTO auth_teams (id, organization_id, name, member_count)
                 VALUES (${TEAM_3}, ${TENANT_A}, 'T02.06 team 3', 0)`;
        await tx`INSERT INTO auth_team_bindings (tenant_id, workspace_id, team_id)
                 VALUES (${TENANT_A}, ${WORKSPACE_C}, ${TEAM_3})`;
        await tx`SELECT public.auth_directory_finalize_command('t0206-cmd-bind-2')`;
        await tx`SELECT set_config('auth.current_command', '', true)`;
        await tx.unsafe("SET CONSTRAINTS ALL IMMEDIATE");
      })
      .then(() => undefined)
      .catch((error: unknown) => {
        throw new Error(
          `team.create binding flow failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    // Bindings are immutable even inside a command: re-pointing or deleting is
    // a named refusal, matching the T02.01 structural contract.
    const immutable = await refusalMarker(() =>
      writer.begin(async (tx) => {
        await tx`SELECT set_config('auth.current_command', public.auth_directory_begin_command(
          't0206-cmd-bind-3', 'company', 'team.create',
          ${TENANT_A}, null, ${USER_A}, 'session',
          't0206-key-bind-3', 't0206-payload-hash'), true)`;
        await tx`UPDATE auth_team_bindings SET workspace_id = ${WORKSPACE_A}
                 WHERE workspace_id = ${WORKSPACE_B}`;
      }),
    );
    expect(immutable).toBe("AUTH_TEAM_BINDING_IMMUTABLE");

    // member_count is the plugin's own counter: a member command may move it
    // by exactly one and may touch nothing else on the team row.
    await writer
      .begin(async (tx) => {
        await tx`SELECT set_config('auth.current_command', public.auth_directory_begin_command(
          't0206-cmd-count-1', 'company', 'member.provision',
          ${TENANT_A}, null, ${USER_A}, 'session',
          't0206-key-count-1', 't0206-payload-hash'), true)`;
        await tx`INSERT INTO auth_members (id, organization_id, user_id, role)
                 VALUES ('t0206-cmd-count-1-m', ${TENANT_A}, ${USER_C}, 'member')`;
        await tx`INSERT INTO auth_team_members (id, team_id, user_id)
                 VALUES ('t0206-cmd-count-1-tm', ${TEAM_2}, ${USER_C})`;
        await tx`SELECT public.auth_advance_eligibility_clock(
          ${TENANT_A}, ${PRINCIPAL_C}, 'company', ${TENANT_A}, 1, 1, false,
          't0206-cmd-count-1')`;
        await tx`SELECT public.auth_advance_eligibility_clock(
          ${TENANT_A}, ${PRINCIPAL_C}, 'team', ${WORKSPACE_B}, 1, 1, false,
          't0206-cmd-count-1')`;
        await tx`UPDATE auth_teams SET member_count = 1, updated_at = now()
                 WHERE id = ${TEAM_2}`;
        await tx`SELECT public.auth_directory_finalize_command('t0206-cmd-count-1')`;
        await tx`SELECT set_config('auth.current_command', '', true)`;
        await tx.unsafe("SET CONSTRAINTS ALL IMMEDIATE");
      })
      .then(() => undefined)
      .catch((error: unknown) => {
        throw new Error(
          `member_count maintenance flow failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    const [counted] = await harness.sql`
      SELECT member_count FROM auth_teams WHERE id = ${TEAM_2}`;
    expect(Number(counted?.member_count ?? -1)).toBe(1);

    // A member command that renames the team under the same UPDATE is a named
    // refusal: the count is the only column it may move.
    const countOnly = await refusalMarker(() =>
      writer.begin(async (tx) => {
        await tx`SELECT set_config('auth.current_command', public.auth_directory_begin_command(
          't0206-cmd-count-2', 'company', 'team.member.add',
          ${TENANT_A}, null, ${USER_A}, 'session',
          't0206-key-count-2', 't0206-payload-hash'), true)`;
        await tx`INSERT INTO auth_team_members (id, team_id, user_id)
                 VALUES ('t0206-cmd-count-2-tm', ${TEAM_3}, ${USER_A})`;
        await tx`UPDATE auth_teams SET member_count = 1, name = 'renamed by member command'
                 WHERE id = ${TEAM_3}`;
      }),
    );
    expect(countOnly).toBe("AUTH_TEAM_MEMBER_COUNT_ONLY");

    // And a profile update may not touch the count at all.
    const profileCount = await refusalMarker(() =>
      writer.begin(async (tx) => {
        await tx`SELECT set_config('auth.current_command', public.auth_directory_begin_command(
          't0206-cmd-count-3', 'company', 'team.profile.update',
          ${TENANT_A}, null, ${USER_A}, 'session',
          't0206-key-count-3', 't0206-payload-hash'), true)`;
        await tx`UPDATE auth_teams SET member_count = 5
                 WHERE id = ${TEAM_3}`;
      }),
    );
    expect(profileCount).toBe("AUTH_TEAM_PROFILE_CANNOT_TOUCH_MEMBER_COUNT");
  });

  test("migration_is_idempotent_and_keeps_legacy_writer", async () => {
    const harness = await loadHarness();

    // Replaying the roles migration on the applied database is a no-op: the
    // triggers drop-if-exists before they create and the functions are
    // CREATE OR REPLACE, so an interrupted apply re-runs cleanly.
    await harness.sql.unsafe(loadMigrationSql());
    const replayStillWorks = await runProvisionCommand(harness.roles.writer, {
      commandId: "t0206-cmd-replay",
      idempotencyKey: "t0206-key-replay",
      userId: USER_B,
      principalId: PRINCIPAL_B,
    });
    expect(replayStillWorks.committed).toBe(true);

    // M1 keeps the legacy writer: the operator capability's enterprise_*
    // DML of 0056 is untouched by the roles migration.
    const [legacyAfter] = await harness.sql<{ ok: boolean }[]>`
      SELECT has_table_privilege('ob_ent_operator', 'enterprise_memberships', 'INSERT') AS ok`;
    expect(legacyAfter?.ok).toBe(harness.operatorLegacyWriterBefore);

    // The journal knows the migration as the next entry.
    const journal = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../../drizzle/meta/_journal.json"),
        "utf8",
      ),
    ) as { entries: { idx: number; tag: string }[] };
    const last = journal.entries[journal.entries.length - 1];
    const before = journal.entries[journal.entries.length - 2];
    // T03.04 (#541) appended 0215 (the guard's company.suspend/restore
    // admission) and amended this pin; T04.01 (#545) appended 0216 (the
    // guard's invitation.resend admission) and T04.07 (#551) appended 0217
    // (the guard's team-management-grant admission) the same way: the newest
    // entry is always the latest amendment, still contiguous on the one
    // before. T05.01 (#557; coordinator ruling 2026-10-27) appended 0218 the
    // same way — the challenge-issuance controlled function, which leaves the
    // DML-guard branches untouched (the table keeps zero direct privileges).
    // T05.02 (#558; coordinator ruling 2026-10-27) appended 0219 likewise:
    // the callback half's controlled surface (policy read, one-time
    // challenge consumption, the session-assurance proof write).
    // T05.04 (#560) appended 0220 the same way: the data role's EXECUTE on
    // 0219's policy read — the read gate's demand question joins the clocks
    // and assurance reads as the data role's controlled reads, and no table
    // or writer privilege moves.
    expect(before?.tag).toBe("0219_better_auth_company_auth_complete");
    expect(last?.tag).toBe("0220_better_auth_company_auth_policy_read");
    expect(last?.idx).toBe((before?.idx ?? 0) + 1);
    expect(existsSync(MIGRATION_PATH)).toBe(true);
  });

  test("writer_reader_data_capability_connections_verify", async () => {
    await loadHarness();
    expect(typeof connections.verifyAuthWriterDatabase).toBe("function");
    expect(typeof connections.assertAuthWriterDatabase).toBe("function");

    // The writer URL is a verified fourth capability: current_user is exactly
    // ob_ent_auth_writer, one membership, no escalation, no ownership.
    const writer = createDatabase(
      process.env.BA_TEST_AUTH_WRITER_DATABASE_URL!.trim(),
      { max: 1 },
    );
    let verified: connections.AuthWriterDatabase | undefined;
    try {
      verified = await connections.verifyAuthWriterDatabase(writer);
      connections.assertAuthWriterDatabase(verified);
    } finally {
      await writer.close?.();
    }
    expect(verified).toBeDefined();

    // The same connection is NOT any of the other capabilities — the brand
    // types cannot be swapped by a caller re-using a handle.
    const mislabeled = createDatabase(
      process.env.BA_TEST_AUTH_WRITER_DATABASE_URL!.trim(),
      { max: 1 },
    );
    try {
      await expect(
        connections.verifyDirectoryDatabase(mislabeled),
      ).rejects.toThrow();
      await expect(
        connections.verifyDataDatabase(mislabeled),
      ).rejects.toThrow();
      await expect(
        connections.verifyOperatorDatabase(mislabeled),
      ).rejects.toThrow();
    } finally {
      await mislabeled.close?.();
    }
  });
});
