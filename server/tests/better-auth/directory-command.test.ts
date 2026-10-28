import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { queueAfterTransactionHook } from "@better-auth/core/context";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { SQL } from "bun";
import { sql as dsql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import type { DirectoryTx } from "../../src/auth/directory/contracts";
import {
  authInvitations,
  authMembers,
  authOrganizations,
  authTeamMembers,
  authTeams,
} from "../../src/db/schema/auth-directory";
import {
  accounts,
  sessions,
  users,
  verifications,
} from "../../src/db/schema/core";

/*
 * T02.08 (#530, original task P04) — the Directory same-transaction command
 * executor and finalizer, driven against the real 0209–0214 stack and a real
 * fixed-build Better Auth instance on the isolated BA_TEST_* island
 * (interfaces §2/§3, design §5.2 step 5; acceptance P04 core loop).
 *
 * What this suite pins, and why each part is a database fact rather than a
 * code convention:
 *
 * - `idempotent_replay_does_not_advance_versions`: the same command under the
 *   same key replays the committed receipt — same command id, same versions,
 *   `replayed: true` — and neither the BA member row nor the eligibility
 *   clock moves a second time. The idempotency domain is the narrow ruling of
 *   2026-10-25 (company domain = tenant + key; actor/operation are NOT in the
 *   domain), which is exactly what `same_key_with_different_content_conflicts`
 *   and `cross_actor_replay_uses_the_narrow_idempotency_domain` pin from both
 *   sides: different content under the same key is a 409 conflict, a
 *   different actor with the same content is a replay.
 * - `missing_finalizer_or_audit_failure_rolls_back`: a command whose
 *   finalizer never stamps the receipt is refused by the deferred receipt
 *   fence at SET CONSTRAINTS IMMEDIATE, and a command whose audit write fails
 *   rolls back with everything it touched — receipts, BA rows, projections,
 *   clocks, audit — so `after` equals `before` exactly.
 * - `unclassified_post_commit_hook_refused_and_rolled_back`: a hook queued
 *   from a source the pinned-build registry does not know is refused before
 *   commit and never runs — not on the rollback, not later.
 * - `out_of_scope_dml_and_post_finalize_dml_are_refused_and_rolled_back`: the
 *   T02.06 DML guard refuses a statement outside the operation's allowlist
 *   and any directory DML after the finalize stamp, and the executor's whole
 *   transaction dies with the refusal.
 * - `member_provision_projects_company_membership_then_team_clocks` and
 *   `member_remove_suspends_projection_and_tombstones_clocks`: the finalizer
 *   writes the company membership projection first, then the team
 *   projection/clocks, advances both clocks to the change keys' after-values
 *   (tombstone exactly on the removal operations), records the audit fact and
 *   stamps the receipt — a removal maps to the legacy `suspended` + the
 *   company's single revoke vocabulary, never a second delete.
 * - `legacy_and_paused_authority_refuse_every_directory_write`: the T02.10
 *   authority gate refuses the BA writer under M1 legacy and every writer
 *   under M2 paused, before a receipt exists.
 * - `replay_reverifies_current_authority`: a replay that arrives after the
 *   authority moved on, or after the handler's authorization was revoked,
 *   cannot borrow the receipt — current checks run again and the refusal
 *   leaves the committed facts untouched.
 * - `incomplete_mail_callback_fence_refuses_commit`: the T02.12 mail-callback
 *   fence runs inside the executor's transaction — a token without its
 *   completed outbox receipt refuses the commit, and the rollback takes the
 *   token's durable fact with it.
 * - `envelope_validation_refuses_unknown_operation_and_payload_fields`: an
 *   operation outside the closed vocabulary, or an unknown payload field,
 *   is refused before any lock, receipt or DML.
 *
 * Boundaries this suite deliberately does not claim (later tasks own them):
 * the per-operation business handlers beyond the envelope's test doubles
 * (P06/P08/P09/P12), the read-side listEligibleScopes (P05/T02.11), the hook
 * classification registry itself (T01.04's transaction-hooks suite), and the
 * post-commit delivery worker (T02.12's outbox-fence suite).
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

/*
 * The verified BA stack the executor rides on, applied by this suite and
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

const TENANT = "t0208-tenant";
const TENANT_NAME = "T0208 Directory Command Tenant";
const WORKSPACE = "t0208-workspace";
const WORKSPACE_NAME = "T0208 Workspace";
const TEAM = "t0208-team";
const TEAM_NAME = "T0208 Team";
const ACTOR_USER = "t0208-actor";
const SECOND_ACTOR_USER = "t0208-actor-b";
const BA_SECRET = "t0208-harness-fixed-test-secret-not-a-credential";

/*
 * The audit table the finalizer writes (MT078's enterprise_audit_events).
 * The BA island's one-shot enterprise baseline (251 tables) predates MT078,
 * so this suite applies MT078's own statements for that table — copied from
 * server/scripts/multitenancy/migrate-test.ts (the migration's single source
 * of truth, `AUDIT_DOMAIN_TASK`) rather than re-invented — and removes them
 * again only when it created them: an island that already carries the table
 * keeps it untouched.
 */
const AUDIT_TABLE = "enterprise_audit_events";
const AUDIT_TABLE_STATEMENTS = [
  `CREATE TABLE "enterprise_audit_events" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"domain" text NOT NULL,
	"event_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"target_id" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_audit_events_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "enterprise_audit_event_domain" CHECK ("enterprise_audit_events"."domain" in ('business','identity','platform')),
	CONSTRAINT "enterprise_audit_events_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action
)`,
  `CREATE INDEX "enterprise_audit_event_tenant_domain_time" ON "enterprise_audit_events" ("tenant_id","domain","created_at")`,
  `ALTER TABLE "enterprise_audit_events" ENABLE ROW LEVEL SECURITY`,
  `CREATE POLICY "enterprise_audit_event_operator_read" ON "enterprise_audit_events"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_audit_events"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))`,
  `CREATE POLICY "enterprise_audit_event_operator_insert" ON "enterprise_audit_events"
  FOR INSERT TO ob_ent_operator
  WITH CHECK ("enterprise_audit_events"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
    AND "enterprise_audit_events"."id" = nullif(current_setting('app.operation_id', true), ''))`,
  `GRANT SELECT, INSERT ON TABLE "enterprise_audit_events" TO ob_ent_operator`,
  `ALTER TABLE "enterprise_audit_events" FORCE ROW LEVEL SECURITY`,
] as const;

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

/** Whether `public.<name>` exists on the island right now. */
async function tableExists(sql: postgres.Sql, name: string): Promise<boolean> {
  const [row] =
    await sql`SELECT to_regclass(${`public.${name}`}) IS NOT NULL AS present`;
  return Boolean(row?.present);
}

/**
 * Returns the island to the pre-BA shape (the outbox-fence suite's cleanup,
 * shared by reference because both suites own the same applied stack). Every
 * statement is a no-op on a pristine baseline, and it recovers a crashed
 * earlier run that left any of them behind. The cluster-wide capability role
 * is NOT dropped — the environment's provisioning owns it. The MT078 audit
 * table is only removed when this suite owns it (`ownsAuditTable`), so an
 * island that already carries MT078 keeps its table.
 */
async function cleanupFixture(
  sql: postgres.Sql,
  options: { ownsAuditTable: boolean },
): Promise<void> {
  const triggerPairs = MIGRATION_TRIGGERS.map(
    ([table, trigger]) => `('${table}', '${trigger}')`,
  ).join(", ");
  const functions = CONTROLLED_FUNCTIONS.map(
    (signature) => `('${signature}')`,
  ).join(", ");
  const tables = BA_TABLES.map((name) => `('${name}')`).join(", ");
  await sql.unsafe(`
    DO $t0208_cleanup$
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
    $t0208_cleanup$`);
  await sql.unsafe(
    `DROP TABLE IF EXISTS ${BA_TABLES.map((name) => `"${name}"`).join(", ")} CASCADE`,
  );
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
  // This suite's own leftovers: the audit fault trigger, the audit rows and
  // the MT078 table when this suite owns it.
  if (await tableExists(sql, AUDIT_TABLE)) {
    await sql.unsafe(
      `DROP TRIGGER IF EXISTS t0208_audit_fault ON ${AUDIT_TABLE}`,
    );
    await sql.unsafe(
      `DELETE FROM ${AUDIT_TABLE} WHERE tenant_id = '${TENANT}'`,
    );
  }
  await sql.unsafe(`DROP FUNCTION IF EXISTS t0208_audit_fault()`);
  if (options.ownsAuditTable) {
    await sql.unsafe(`DROP TABLE IF EXISTS ${AUDIT_TABLE}`);
  }
  await sql`DELETE FROM verifications WHERE id LIKE 't0208-%'`;
  await sql`DELETE FROM users WHERE id LIKE 't0208-%'`;
  await sql`DELETE FROM enterprise_workspaces WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM enterprise_tenants WHERE id = ${TENANT}`;
}

/** The durable facts one rollback must leave untouched, in comparable shape. */
interface DirectorySnapshot {
  receipts: number;
  changeKeys: number;
  outbox: number;
  members: string[];
  teamMembers: string[];
  memberships: {
    principalId: string;
    role: string;
    status: string;
    epoch: number;
  }[];
  clocks: {
    principalId: string;
    kind: string;
    scopeId: string;
    epoch: number;
    generation: number;
    tombstone: boolean;
  }[];
  audit: number;
  verifications: number;
}

async function snapshot(sql: postgres.Sql): Promise<DirectorySnapshot> {
  const [counts] = await sql`
    SELECT
      (SELECT count(*)::int FROM auth_command_receipts) AS receipts,
      (SELECT count(*)::int FROM auth_command_change_keys) AS change_keys,
      (SELECT count(*)::int FROM auth_command_outbox) AS outbox,
      (SELECT count(*)::int FROM enterprise_audit_events WHERE tenant_id = ${TENANT}) AS audit,
      (SELECT count(*)::int FROM verifications WHERE id LIKE 't0208-%') AS verifications`;
  const members = await sql`
    SELECT user_id FROM auth_members WHERE organization_id = ${TENANT} ORDER BY user_id`;
  const teamMembers = await sql`
    SELECT user_id FROM auth_team_members WHERE team_id = ${TEAM} ORDER BY user_id`;
  const memberships = await sql`
    SELECT principal_id, role, status, epoch FROM enterprise_memberships
     WHERE tenant_id = ${TENANT} ORDER BY principal_id`;
  const clocks = await sql`
    SELECT principal_id, kind, scope_id, epoch::int AS epoch,
           generation::int AS generation, tombstone
      FROM auth_eligibility_clocks WHERE tenant_id = ${TENANT}
     ORDER BY principal_id, kind, scope_id`;
  return {
    receipts: counts.receipts,
    changeKeys: counts.change_keys,
    outbox: counts.outbox,
    audit: counts.audit,
    verifications: counts.verifications,
    members: members.map((row) => row.user_id),
    teamMembers: teamMembers.map((row) => row.user_id),
    memberships: memberships.map((row) => ({
      principalId: row.principal_id,
      role: row.role,
      status: row.status,
      epoch: row.epoch,
    })),
    clocks: clocks.map((row) => ({
      principalId: row.principal_id,
      kind: row.kind,
      scopeId: row.scope_id,
      epoch: row.epoch,
      generation: row.generation,
      tombstone: row.tombstone,
    })),
  };
}

/** The two authority shapes the matrix needs, plus the BA-mode default. */
async function setAuthority(
  sql: postgres.Sql,
  phase: "M1" | "M2" | "M4",
): Promise<void> {
  const authority =
    phase === "M4" ? "ba" : phase === "M2" ? "paused" : "legacy";
  await sql`
    UPDATE auth_authority_states
       SET phase = ${phase}, directory_authority = ${authority}, authority_version = 1
     WHERE id = 1`;
}

type ExecutorModule = typeof import("../../src/auth/directory/executor");
type FinalizerModule = typeof import("../../src/auth/directory/finalizer");

let executorPromise: Promise<ExecutorModule> | undefined;
function loadExecutor(): Promise<ExecutorModule> {
  executorPromise ??= import("../../src/auth/directory/executor").catch(
    (error: unknown) => {
      throw new Error(
        `server/src/auth/directory/executor.ts is not loadable — ${
          error instanceof Error ? error.message : String(error)
        }: the same-transaction command executor (tenant lock, authority gate, narrow-domain idempotency, BA sync, hook fence, finalizer orchestration, named SET CONSTRAINTS IMMEDIATE, post-commit hook drain) this suite pins is the T02.08 target behavior, not an environment problem.`,
      );
    },
  );
  return executorPromise;
}

let finalizerPromise: Promise<FinalizerModule> | undefined;
function loadFinalizer(): Promise<FinalizerModule> {
  finalizerPromise ??= import("../../src/auth/directory/finalizer").catch(
    (error: unknown) => {
      throw new Error(
        `server/src/auth/directory/finalizer.ts is not loadable — ${
          error instanceof Error ? error.message : String(error)
        }: the command finalizer (final BA set verification, company membership projection before team projection, clock advances, audit fact, finalize stamp) this suite pins is the T02.08 target behavior, not an environment problem.`,
      );
    },
  );
  return finalizerPromise;
}

/**
 * The envelope's test handler knobs: the per-case variables of an otherwise
 * fixed `member.provision`-shaped handler. `authorize` runs for fresh and
 * replayed commands alike (the replay re-verification seam); `sync` runs only
 * inside the executor's TransactionBoundBa, so every BA/DML write it makes
 * rides the executor's own transaction.
 */
interface HandlerKnobs {
  /** authorize refuses when set (the revocation replay case flips this). */
  revoked?: boolean;
  /** Also insert a guarded team member row (the two-key projection case). */
  addToTeam?: boolean;
  /** Queue an unclassified post-commit hook from this file's own stack. */
  queueUnclassifiedHook?: { ran: () => void };
  /** Write a member row although the operation's allowlist forbids it. */
  outOfScopeDml?: boolean;
  /** Leave an observed token without its completed outbox receipt. */
  incompleteMailToken?: string;
}

interface Harness {
  sql: postgres.Sql;
  execute: (
    actor: Record<string, unknown>,
    command: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  /** Sets this suite's handler knobs for the default handlers. */
  knobs(next: HandlerKnobs): void;
  /** Rebuilds the executor around a different finalizer/handler wiring. */
  rebuild(options: {
    finalizer?: unknown;
    handlers?: Record<string, unknown>;
  }): Promise<{
    execute: (
      actor: Record<string, unknown>,
      command: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  }>;
  addUser(id: string): Promise<void>;
  probe(): postgres.Sql;
  close(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const setupUrl = readBaUrls();
  const sql = postgres(setupUrl, {
    max: 4,
    idle_timeout: 5,
    onnotice: () => {},
  });
  // The island predates MT078 (its sibling table is the tell): this suite
  // then owns the audit table life cycle. An island that already carries
  // MT078 keeps its table and this suite leaves it alone.
  const islandHasMt078 = await tableExists(
    sql,
    "billing_company_manage_grants",
  );
  const ownsAuditTable = !islandHasMt078;
  try {
    await cleanupFixture(sql, { ownsAuditTable });
    for (const path of MIGRATION_PATHS) {
      if (!existsSync(path)) {
        throw new Error(
          `${path} does not exist: the directory executor sits on the verified T02.01–T02.06 stack, and a missing prerequisite is a workspace problem, not a target behavior.`,
        );
      }
      await sql.unsafe(readFileSync(path, "utf8"));
    }
    if (ownsAuditTable) {
      for (const statement of AUDIT_TABLE_STATEMENTS) {
        await sql.unsafe(statement);
      }
    }

    // The unguarded skeleton: companies/workspaces/users are the enterprise
    // baseline's tables, outside the six guarded BA tables.
    await sql`INSERT INTO enterprise_tenants (id, name) VALUES (${TENANT}, ${TENANT_NAME})`;
    await sql`INSERT INTO enterprise_workspaces (tenant_id, id, name) VALUES (${TENANT}, ${WORKSPACE}, ${WORKSPACE_NAME})`;
    await sql`INSERT INTO users (id, email) VALUES (${ACTOR_USER}, ${`${ACTOR_USER}@example.test`}), (${SECOND_ACTOR_USER}, ${`${SECOND_ACTOR_USER}@example.test`})`;

    // The executor-shaped transaction handle: Drizzle over Bun's SQL on the
    // island's owner connection — the frozen DirectoryTx. The controlled
    // functions' capability check is satisfied for the owner; the
    // writer-role exclusivity is T02.06's proof, not this suite's subject.
    const client = new SQL(setupUrl, {
      max: 4,
      idleTimeout: 5,
      connectionTimeout: 10_000,
      onnotice: () => {},
    });
    const db = drizzle({ client });

    /*
     * The guarded directory skeleton (organization/team/binding) is created
     * through the real T02.03 command protocol — the same begin/marker/
     * finalize sequence the executor drives — because the T02.06 DML guard
     * refuses a bare insert on those tables. The binding branch registers no
     * eligibility key, so this fixture command needs no clock.
     */
    await db.transaction(async (tx) => {
      const fixtureCommandId = "t0208-fixture-command";
      await tx.execute(dsql`
        SELECT set_config('auth.current_command', public.auth_directory_begin_command(
          ${fixtureCommandId}, 'company', 'company.provision', ${TENANT}, null,
          null, 'migration', 't0208-fixture-key',
          't0208-fixture-payload-hash'), true)`);
      await tx.execute(dsql`
        INSERT INTO auth_organizations (id, name, slug)
        VALUES (${TENANT}, ${TENANT_NAME}, 't0208-directory-command')`);
      await tx.execute(dsql`
        INSERT INTO auth_teams (id, organization_id, name)
        VALUES (${TEAM}, ${TENANT}, ${TEAM_NAME})`);
      await tx.execute(dsql`
        INSERT INTO auth_team_bindings (tenant_id, workspace_id, team_id)
        VALUES (${TENANT}, ${WORKSPACE}, ${TEAM})`);
      await tx.execute(
        dsql`SELECT public.auth_directory_finalize_command(${fixtureCommandId})`,
      );
      await tx.execute(
        dsql`SELECT set_config('auth.current_command', '', true)`,
      );
      await tx.execute(dsql`SET CONSTRAINTS ALL IMMEDIATE`);
    });
    await setAuthority(sql, "M4");

    // A real fixed-build Better Auth instance over the island's own public
    // tables, with the organization plugin configured exactly as the §3.1
    // factory hard preconditions require (no secondaryStorage, no cookie
    // cache, sessions and verifications in the transaction database).
    let resolvedOptions: unknown;
    const adapterSchema = {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
      organization: authOrganizations,
      invitation: authInvitations,
      member: authMembers,
      team: authTeams,
      teamMember: authTeamMembers,
    };
    const auth = betterAuth({
      secret: BA_SECRET,
      baseURL: "http://127.0.0.1:9",
      trustedOrigins: ["http://127.0.0.1:9"],
      emailAndPassword: { enabled: true },
      plugins: [organization({ teams: { enabled: true } })],
      database: (options: unknown) => {
        resolvedOptions = options;
        return drizzleAdapter(db as never, {
          provider: "pg",
          schema: adapterSchema,
          transaction: true,
        })(options as never);
      },
    });
    await auth.$context;

    const bound = (
      await import("../../src/auth/directory/transaction-adapter")
    ).createTransactionBoundBa({
      createTxAdapter: (tx: DirectoryTx) =>
        drizzleAdapter(tx as never, {
          provider: "pg",
          schema: adapterSchema,
          transaction: false,
        })(resolvedOptions as never),
    });

    const authority = (
      await import("../../src/auth/directory/authority")
    ).createDirectoryAuthority();
    const { principalRegistry } = await import(
      "../../src/auth/directory/principal-registry"
    );

    let handlerKnobs: HandlerKnobs = {};
    const knobs = () => handlerKnobs;

    async function buildExecutor(
      options: { finalizer?: unknown; handlers?: Record<string, unknown> } = {},
    ) {
      const executorModule = await loadExecutor();
      const finalizerModule = await loadFinalizer();
      const finalizer =
        options.finalizer ?? finalizerModule.createDirectoryFinalizer();

      interface SyncContextShape {
        tx: DirectoryTx;
        command: { payload: Record<string, unknown> };
        registry: {
          ensure: (tx: DirectoryTx, userId: string) => Promise<unknown>;
        };
        fence: { observeTokenCreated: (token: string) => void };
      }

      const provisionHandler = {
        authorize: async () => {
          if (knobs().revoked) {
            throw new Error("T0208_HANDLER_AUTHORIZATION_REVOKED");
          }
        },
        sync: async (ctx: SyncContextShape) => {
          const requested = ctx.command.payload.userId;
          const target = String(requested ?? "");
          if (knobs().outOfScopeDml) {
            // A member write the operation's allowlist never granted: the
            // DML guard refuses the statement itself, before any principal
            // or FK work could mask the refusal.
            const oosTarget = String(requested ?? "t0208-oos-user");
            await ctx.tx.execute(dsql`
              INSERT INTO auth_members (id, organization_id, user_id, role)
              VALUES (${`t0208-oos-${oosTarget}`}, ${TENANT}, ${oosTarget}, 'member')`);
            return {};
          }
          await ctx.registry.ensure(ctx.tx, target);
          if (knobs().incompleteMailToken) {
            await ctx.tx.execute(dsql`
              INSERT INTO verifications (id, identifier, value, expires_at)
              VALUES (${`t0208-v-${knobs().incompleteMailToken}`},
                      ${`${target}@example.test`}, ${knobs().incompleteMailToken},
                      now() + interval '1 hour')`);
            ctx.fence.observeTokenCreated(knobs().incompleteMailToken);
            return {};
          }
          // The real BA sync: the fixed build's server-only addMember, run
          // under the executor's transaction-bound adapter.
          await auth.api.addMember({
            body: {
              userId: target,
              organizationId: TENANT,
              role: "member",
            },
          });
          if (knobs().queueUnclassifiedHook) {
            const observed = knobs().queueUnclassifiedHook;
            await queueAfterTransactionHook(async () => {
              observed.ran();
            });
          }
          if (knobs().addToTeam) {
            await ctx.tx.execute(dsql`
              INSERT INTO auth_team_members (id, team_id, user_id)
              VALUES (${`t0208-tm-${target}`}, ${TEAM}, ${target})`);
          }
          return {};
        },
      };

      const removalHandler = {
        authorize: async () => {},
        sync: async (ctx: SyncContextShape) => {
          const target = String(ctx.command.payload.userId ?? "");
          await ctx.tx.execute(
            dsql`DELETE FROM auth_team_members WHERE team_id = ${TEAM} AND user_id = ${target}`,
          );
          await ctx.tx.execute(
            dsql`DELETE FROM auth_members WHERE organization_id = ${TENANT} AND user_id = ${target}`,
          );
          return {};
        },
      };

      const handlers =
        options.handlers ??
        ({
          "member.provision": provisionHandler,
          "member.remove": removalHandler,
          "team.profile.update": provisionHandler,
        } as Record<string, unknown>);

      const directory = executorModule.createDirectoryExecutor({
        database: db,
        bound,
        authority,
        registry: principalRegistry,
        finalizer: finalizer as never,
        handlers: handlers as never,
      });
      return {
        execute: (
          actor: Record<string, unknown>,
          command: Record<string, unknown>,
        ) =>
          directory.execute(actor as never, command as never) as Promise<
            Record<string, unknown>
          >,
      };
    }

    // The default executor is built lazily, so the fixture (migrations,
    // skeleton, Better Auth instance) is provably healthy even when the
    // target modules are missing: every named case then fails with the
    // target-behavior message instead of dying at setup.
    let defaultExecutorPromise:
      | Promise<{
          execute: (
            actor: Record<string, unknown>,
            command: Record<string, unknown>,
          ) => Promise<Record<string, unknown>>;
        }>
      | undefined;

    return {
      sql,
      execute: async (actor, command) => {
        defaultExecutorPromise ??= buildExecutor();
        const executor = await defaultExecutorPromise;
        return executor.execute(actor, command);
      },
      knobs: (next) => {
        handlerKnobs = next;
      },
      rebuild: (options) => buildExecutor(options),
      addUser: async (id) => {
        await sql`INSERT INTO users (id, email) VALUES (${id}, ${`${id}@example.test`})`;
      },
      probe: () =>
        postgres(setupUrl, { max: 1, idle_timeout: 5, onnotice: () => {} }),
      close: async () => {
        try {
          await cleanupFixture(sql, { ownsAuditTable });
        } finally {
          await Promise.allSettled([sql.end({ timeout: 5 }), client.close()]);
        }
      },
    };
  } catch (error) {
    await cleanupFixture(sql, { ownsAuditTable }).catch(() => {});
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
  const probe = harness.probe();
  await harness.close();
  try {
    const leaked = await probe`
      SELECT nspname AS resource FROM pg_namespace WHERE nspname LIKE 't0208%'
      UNION ALL
      SELECT n.nspname || '.' || c.relname AS resource
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = ANY(${[...BA_TABLES]}::text[])
      UNION ALL
      SELECT 'verifications:' || id FROM verifications WHERE id LIKE 't0208-%'
      UNION ALL
      SELECT 'users:' || id FROM users WHERE id LIKE 't0208-%'`;
    const auditLeaks = (await tableExists(probe, AUDIT_TABLE))
      ? await probe`
          SELECT 'audit:' || tenant_id AS resource FROM enterprise_audit_events
           WHERE tenant_id LIKE 't0208-%'`
      : [];
    expect([...leaked, ...auditLeaks]).toEqual([]);
  } finally {
    await probe.end({ timeout: 5 }).catch(() => {});
  }
});

const actorOf = (userId = ACTOR_USER) => ({
  userId,
  principalId: null,
  sessionId: null,
  kind: "platform" as const,
  bindingId: null,
  provisioning: null,
});

function provisionCommand(userId: string, key: string) {
  return {
    operation: "member.provision",
    tenantId: TENANT,
    idempotencyKey: key,
    payload: { userId },
  };
}

/** Every message along an error's cause chain — drizzle wraps driver errors. */
function errorChainMessage(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    parts.push(current instanceof Error ? current.message : String(current));
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join("\n");
}

/** Asserts a refusal whose marker may sit behind drizzle's "Failed query" wrapper. */
async function expectRefusal(
  run: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(errorChainMessage(error)).toMatch(pattern);
    return;
  }
  throw new Error(
    `expected a refusal matching ${pattern}, but the call resolved`,
  );
}

function expectVersions(result: Record<string, unknown>) {
  return result.versions as {
    key: { principalId: string; kind: string; scopeId: string };
    value: { epoch: number; generation: number; tombstone: boolean };
  }[];
}

test("envelope_validation_refuses_unknown_operation_and_payload_fields", async () => {
  const sql = harness!.sql;
  await harness!.addUser("t0208-unknown-op-user");
  const before = await snapshot(sql);

  await expect(
    harness!.execute(actorOf(), {
      operation: "member.demolish",
      tenantId: TENANT,
      idempotencyKey: "t0208-unknown-op",
      payload: { userId: "t0208-unknown-op-user" },
    }),
  ).rejects.toThrow(/DIRECTORY_COMMAND_INVALID|DIRECTORY_OPERATION_UNKNOWN/);
  await expect(
    harness!.execute(actorOf(), {
      operation: "member.provision",
      tenantId: TENANT,
      idempotencyKey: "t0208-unknown-field",
      payload: { userId: "t0208-unknown-op-user", extra: "no" },
    }),
  ).rejects.toThrow(/DIRECTORY_COMMAND_INVALID/);
  // Neither refusal may have begun a receipt or written a row.
  expect(await snapshot(sql)).toEqual(before);
});

test("legacy_and_paused_authority_refuse_every_directory_write", async () => {
  const sql = harness!.sql;
  await harness!.addUser("t0208-matrix-user");
  const before = await snapshot(sql);

  await setAuthority(sql, "M1");
  await expect(
    harness!.execute(
      actorOf(),
      provisionCommand("t0208-matrix-user", "t0208-m1"),
    ),
  ).rejects.toThrow(/DIRECTORY_WRITE_AUTHORITY_CLOSED/);

  await setAuthority(sql, "M2");
  await expect(
    harness!.execute(
      actorOf(),
      provisionCommand("t0208-matrix-user", "t0208-m2"),
    ),
  ).rejects.toThrow(/DIRECTORY_MIGRATION_PAUSED/);

  await setAuthority(sql, "M4");
  // No receipt, no member, no clock: the gate refused before the begin.
  expect(await snapshot(sql)).toEqual(before);
});

test("member_provision_projects_company_membership_then_team_clocks", async () => {
  const sql = harness!.sql;
  await harness!.addUser("t0208-provision-user");
  const before = await snapshot(sql);
  expect(before.members).toEqual([]);

  harness!.knobs({ addToTeam: true });
  const result = await harness!.execute(
    actorOf(),
    provisionCommand("t0208-provision-user", "t0208-provision-key"),
  );
  harness!.knobs({});

  expect(result.replayed).toBe(false);
  expect(result.commandId).toEqual(expect.any(String));
  expect(result.tenantId).toBe(TENANT);
  const versions = expectVersions(result);
  expect(versions.map((entry) => entry.key.kind).sort()).toEqual([
    "company",
    "team",
  ]);
  for (const entry of versions) {
    expect(entry.value).toEqual({ epoch: 1, generation: 1, tombstone: false });
  }

  // The protected projection: an active legacy membership row at epoch 1.
  const memberships = await sql`
    SELECT m.role, m.status, m.epoch FROM enterprise_memberships m
      JOIN enterprise_principals p ON p.id = m.principal_id
     WHERE m.tenant_id = ${TENANT} AND p.user_id = 't0208-provision-user'`;
  expect(memberships).toEqual([{ role: "member", status: "active", epoch: 1 }]);
  // Both clocks finalized at 1/1 (company scope = tenant, team scope = workspace).
  const clocks = await sql`
    SELECT c.kind, c.scope_id, c.epoch::int AS epoch,
           c.generation::int AS generation, c.tombstone
      FROM auth_eligibility_clocks c
      JOIN enterprise_principals p ON p.id = c.principal_id
     WHERE c.tenant_id = ${TENANT} AND p.user_id = 't0208-provision-user'
     ORDER BY c.kind`;
  expect(clocks.map((row) => row.scope_id)).toEqual([TENANT, WORKSPACE]);
  for (const row of clocks) {
    expect([row.epoch, row.generation, row.tombstone]).toEqual([1, 1, false]);
  }
  // The audit fact and the finalized receipt are in the same transaction.
  const [receipt] = await sql`
    SELECT finalized FROM auth_command_receipts WHERE command_id = ${result.commandId}`;
  expect(receipt?.finalized).toBe(true);
  const [audit] = await sql`
    SELECT count(*)::int AS count FROM enterprise_audit_events
     WHERE tenant_id = ${TENANT} AND event_type = 'directory.command.finalized'`;
  expect(audit?.count).toBe(1);
});

test("idempotent_replay_does_not_advance_versions", async () => {
  const sql = harness!.sql;
  await harness!.addUser("t0208-replay-user");
  const command = provisionCommand("t0208-replay-user", "t0208-replay-key");

  const first = await harness!.execute(actorOf(), command);
  expect(first.replayed).toBe(false);
  const firstVersions = expectVersions(first);
  expect(firstVersions.length).toBeGreaterThan(0);

  const second = await harness!.execute(actorOf(), command);
  expect(second.replayed).toBe(true);
  expect(second.commandId).toBe(first.commandId);
  expect(second.versions).toEqual(first.versions);

  // No second member row, no clock movement: the replay wrote nothing.
  const [memberCount] = await sql`
    SELECT count(*)::int AS count FROM auth_members
     WHERE organization_id = ${TENANT} AND user_id = 't0208-replay-user'`;
  expect(memberCount?.count).toBe(1);
  const clocks = await sql`
    SELECT c.epoch::int AS epoch, c.generation::int AS generation
      FROM auth_eligibility_clocks c
      JOIN enterprise_principals p ON p.id = c.principal_id
     WHERE c.tenant_id = ${TENANT} AND p.user_id = 't0208-replay-user'`;
  expect(clocks.length).toBe(1);
  expect(clocks[0]).toEqual({ epoch: 1, generation: 1 });
  const [receiptCount] = await sql`
    SELECT count(*)::int AS count FROM auth_command_receipts
     WHERE idempotency_key = 't0208-replay-key' AND tenant_id = ${TENANT}`;
  expect(receiptCount?.count).toBe(1);
});

test("cross_actor_replay_uses_the_narrow_idempotency_domain", async () => {
  await harness!.addUser("t0208-cross-actor-user");
  const command = provisionCommand("t0208-cross-actor-user", "t0208-cross-key");

  const first = await harness!.execute(actorOf(ACTOR_USER), command);
  // The 2026-10-25 ruling: the idempotency domain is tenant + key — the
  // second actor's identity is NOT in the domain, so the same content
  // replays the same receipt instead of conflicting.
  const second = await harness!.execute(actorOf(SECOND_ACTOR_USER), command);
  expect(second.replayed).toBe(true);
  expect(second.commandId).toBe(first.commandId);
  expect(second.versions).toEqual(first.versions);
});

test("same_key_with_different_content_conflicts", async () => {
  await harness!.addUser("t0208-conflict-user-a");
  await harness!.addUser("t0208-conflict-user-b");

  const first = await harness!.execute(
    actorOf(),
    provisionCommand("t0208-conflict-user-a", "t0208-conflict-key"),
  );
  expect(first.replayed).toBe(false);

  await expect(
    harness!.execute(
      actorOf(),
      provisionCommand("t0208-conflict-user-b", "t0208-conflict-key"),
    ),
  ).rejects.toThrow(/DIRECTORY_IDEMPOTENCY_CONFLICT/);
  // The same content under the same key is still a replay after the refused
  // conflict: the conflict attempt wrote nothing.
  const replay = await harness!.execute(
    actorOf(),
    provisionCommand("t0208-conflict-user-a", "t0208-conflict-key"),
  );
  expect(replay.replayed).toBe(true);
});

test("replay_reverifies_current_authority", async () => {
  const sql = harness!.sql;
  await harness!.addUser("t0208-reverify-user");
  const command = provisionCommand("t0208-reverify-user", "t0208-reverify-key");
  const first = await harness!.execute(actorOf(), command);
  expect(first.replayed).toBe(false);
  const factsAfterFirst = await snapshot(sql);

  // (a) The authority moved on since the receipt: a replay is refused by the
  // current gate, never granted by the committed receipt.
  await setAuthority(sql, "M2");
  await expect(harness!.execute(actorOf(), command)).rejects.toThrow(
    /DIRECTORY_MIGRATION_PAUSED/,
  );
  await setAuthority(sql, "M4");

  // (b) The handler's authorization was revoked: the replay re-runs the
  // authorize step and the refusal leaves the committed facts untouched.
  const revokedExecutor = await harness!.rebuild({
    handlers: {
      "member.provision": {
        authorize: async () => {
          throw new Error("T0208_HANDLER_AUTHORIZATION_REVOKED");
        },
        sync: async () => ({}),
      },
    },
  });
  await expect(revokedExecutor.execute(actorOf(), command)).rejects.toThrow(
    /T0208_HANDLER_AUTHORIZATION_REVOKED/,
  );
  expect(await snapshot(sql)).toEqual(factsAfterFirst);
});

test("missing_finalizer_or_audit_failure_rolls_back", async () => {
  const sql = harness!.sql;
  await harness!.addUser("t0208-unfinalized-user");
  const before = await snapshot(sql);

  // (a) A finalizer that returns without stamping the receipt: the deferred
  // receipt fence refuses the commit at SET CONSTRAINTS IMMEDIATE.
  const unstamped = await harness!.rebuild({
    finalizer: {
      finalize: async (tx: DirectoryTx, commandId: string) => {
        await tx.execute(
          dsql`SELECT set_config('auth.current_command', '', true)`,
        );
        return {
          commandId,
          replayed: false,
          tenantId: TENANT,
          workspaceId: null,
          versions: [],
          resourceId: null,
          grantId: null,
          grantGeneration: null,
        };
      },
    },
  });
  await expectRefusal(
    () =>
      unstamped.execute(
        actorOf(),
        provisionCommand("t0208-unfinalized-user", "t0208-unfinalized-key"),
      ),
    /AUTH_COMMAND_NOT_FINALIZED_AT_COMMIT/,
  );
  expect(await snapshot(sql)).toEqual(before);

  // (b) The audit write fails: the command rolls back with everything it
  // touched (fault injected on the audit table only).
  await harness!.addUser("t0208-audit-fault-user");
  const beforeFault = await snapshot(sql);
  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION t0208_audit_fault() RETURNS trigger
    LANGUAGE plpgsql AS $t0208_fault$
    BEGIN
      RAISE EXCEPTION 't0208 injected audit failure' USING ERRCODE = 'P0001';
    END
    $t0208_fault$`);
  await sql.unsafe(`
    CREATE TRIGGER t0208_audit_fault BEFORE INSERT ON enterprise_audit_events
      FOR EACH ROW EXECUTE FUNCTION t0208_audit_fault()`);
  try {
    await expectRefusal(
      () =>
        harness!.execute(
          actorOf(),
          provisionCommand("t0208-audit-fault-user", "t0208-audit-fault-key"),
        ),
      /t0208 injected audit failure/,
    );
    expect(await snapshot(sql)).toEqual(beforeFault);
  } finally {
    await sql.unsafe(
      `DROP TRIGGER IF EXISTS t0208_audit_fault ON enterprise_audit_events`,
    );
    await sql.unsafe(`DROP FUNCTION IF EXISTS t0208_audit_fault()`);
  }
});

test("unclassified_post_commit_hook_refused_and_rolled_back", async () => {
  const sql = harness!.sql;
  await harness!.addUser("t0208-hook-user");
  const before = await snapshot(sql);
  let hookRan = false;

  harness!.knobs({ queueUnclassifiedHook: { ran: () => (hookRan = true) } });
  try {
    await expect(
      harness!.execute(
        actorOf(),
        provisionCommand("t0208-hook-user", "t0208-hook-key"),
      ),
    ).rejects.toThrow(/UNCLASSIFIED_POST_COMMIT_HOOK/);
    expect(hookRan).toBe(false);
    expect(await snapshot(sql)).toEqual(before);
  } finally {
    harness!.knobs({});
  }
});

test("out_of_scope_dml_and_post_finalize_dml_are_refused_and_rolled_back", async () => {
  const sql = harness!.sql;
  await harness!.addUser("t0208-oos-user");
  const before = await snapshot(sql);

  // (a) A member write the operation's allowlist never granted: the DML
  // guard refuses the statement and the executor dies with it.
  harness!.knobs({ outOfScopeDml: true });
  try {
    await expectRefusal(
      () =>
        harness!.execute(actorOf(), {
          operation: "team.profile.update",
          tenantId: TENANT,
          idempotencyKey: "t0208-oos-key",
          payload: { workspaceId: WORKSPACE, name: "renamed by t0208" },
        }),
      /AUTH_OPERATION_NOT_ALLOWED_FOR_ACTION/,
    );
    expect(await snapshot(sql)).toEqual(before);
  } finally {
    harness!.knobs({});
  }

  // (b) Directory DML after the finalize stamp: refused by name, whatever
  // the marker says, and the whole transaction rolls back.
  const finalizerModule = await loadFinalizer();
  const realFinalizer = finalizerModule.createDirectoryFinalizer();
  const postFinalizeDml = {
    finalize: async (tx: DirectoryTx, commandId: string) => {
      await realFinalizer.finalize(tx, commandId);
      // Marker cleared by the real finalize: bare DML now lacks a command
      // context at all. The refusal aborts the transaction, so the probe
      // runs under a savepoint the way the transaction adapter's own
      // rollback path does.
      await tx.execute(dsql.raw("SAVEPOINT t0208_post_finalize"));
      try {
        await tx.execute(dsql`
          INSERT INTO auth_team_members (id, team_id, user_id)
          VALUES ('t0208-post-finalize', ${TEAM}, 't0208-oos-user')`);
        throw new Error("t0208: post-finalize DML was not refused");
      } catch (error) {
        if (
          !/AUTH_COMMAND_CONTEXT_REQUIRED|AUTH_COMMAND_ALREADY_FINALIZED/.test(
            errorChainMessage(error),
          )
        ) {
          throw error;
        }
      }
      await tx.execute(dsql.raw("ROLLBACK TO SAVEPOINT t0208_post_finalize"));
      await tx.execute(dsql.raw("RELEASE SAVEPOINT t0208_post_finalize"));
      // The same statement with the marker re-pointed at the finalized
      // receipt: the guard answers ALREADY_FINALIZED — the receipt, never
      // the marker string, is the proof.
      await tx.execute(
        dsql`SELECT set_config('auth.current_command', ${commandId}, true)`,
      );
      await expectRefusal(
        () =>
          tx.execute(dsql`
            INSERT INTO auth_team_members (id, team_id, user_id)
            VALUES ('t0208-post-finalize-2', ${TEAM}, 't0208-oos-user')`),
        /AUTH_COMMAND_ALREADY_FINALIZED/,
      );
      throw new Error("T0208_POST_FINALIZE_PROVED");
    },
  };
  const executor = await harness!.rebuild({ finalizer: postFinalizeDml });
  try {
    await expect(
      executor.execute(
        actorOf(),
        provisionCommand("t0208-oos-user", "t0208-post-finalize-key"),
      ),
    ).rejects.toThrow(/T0208_POST_FINALIZE_PROVED/);
    // The wrapper's own refusal surfaced, the transaction rolled back with
    // it: no member, no clock, no receipt survived.
    expect(await snapshot(sql)).toEqual(before);
  } finally {
    harness!.knobs({});
  }
});

test("member_remove_suspends_projection_and_tombstones_clocks", async () => {
  const sql = harness!.sql;
  await harness!.addUser("t0208-remove-user");
  harness!.knobs({ addToTeam: true });
  try {
    await harness!.execute(
      actorOf(),
      provisionCommand("t0208-remove-user", "t0208-remove-provision-key"),
    );
  } finally {
    harness!.knobs({});
  }

  const result = await harness!.execute(actorOf(), {
    operation: "member.remove",
    tenantId: TENANT,
    idempotencyKey: "t0208-remove-key",
    payload: {
      userId: "t0208-remove-user",
      reason: "t0208 removal acceptance",
    },
  });
  expect(result.replayed).toBe(false);

  const versions = expectVersions(result);
  const companyEntry = versions.find((entry) => entry.key.kind === "company");
  const teamEntry = versions.find((entry) => entry.key.kind === "team");
  // A removal keeps the epoch, advances the generation and sets the
  // tombstone — on both the company and the team clock.
  expect(companyEntry?.value).toEqual({
    epoch: 1,
    generation: 2,
    tombstone: true,
  });
  expect(teamEntry?.value).toEqual({
    epoch: 1,
    generation: 2,
    tombstone: true,
  });

  // The legacy projection maps removal to suspended + the BA epoch, never a
  // second delete vocabulary.
  const memberships = await sql`
    SELECT m.status, m.epoch FROM enterprise_memberships m
      JOIN enterprise_principals p ON p.id = m.principal_id
     WHERE m.tenant_id = ${TENANT} AND p.user_id = 't0208-remove-user'`;
  expect(memberships).toEqual([{ status: "suspended", epoch: 1 }]);
  // Both member rows are gone in the final state.
  const [memberCount] = await sql`
    SELECT count(*)::int AS count FROM auth_members
     WHERE organization_id = ${TENANT} AND user_id = 't0208-remove-user'`;
  expect(memberCount?.count).toBe(0);
});

test("incomplete_mail_callback_fence_refuses_commit", async () => {
  const sql = harness!.sql;
  await harness!.addUser("t0208-mail-user");
  const before = await snapshot(sql);

  harness!.knobs({ incompleteMailToken: "t0208-mail-token" });
  try {
    await expect(
      harness!.execute(
        actorOf(),
        provisionCommand("t0208-mail-user", "t0208-mail-key"),
      ),
    ).rejects.toThrow(/OUTBOX_CALLBACK_INCOMPLETE/);
    // The rollback took the token's durable fact with it.
    const after = await snapshot(sql);
    expect(after).toEqual(before);
  } finally {
    harness!.knobs({});
  }
});
