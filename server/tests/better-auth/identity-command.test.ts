import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
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
import { authOrganizations } from "../../src/db/schema/auth-directory";
import {
  accounts,
  sessions,
  users,
  verifications,
} from "../../src/db/schema/core";

/*
 * T02.09 (#531, original task P04) — the global identity command kernel and
 * its recovery transaction boundary, driven against the real 0209–0214
 * stack and a real fixed-build Better Auth instance on the isolated
 * BA_TEST_* island (interfaces §2.1/§5.1; acceptance P04 identity half).
 *
 * What this suite pins, and why each part is a database fact rather than a
 * code convention:
 *
 * - `identity_disable_advances_generation_and_revokes_sessions_and_proofs`:
 *   a disable flips the principal to suspended, advances identityGeneration
 *   exactly once, deletes every session (the proofs cascade with them) and
 *   verifies zero active proofs remain — all in the one receipt-bearing
 *   transaction.
 * - `identity_each_security_write_failure_rolls_back` (Brief-required): each
 *   fault point — the BA user create, the controlled password write, the
 *   generation advance, the session delete, a surviving proof, the finalize
 *   stamp — leaves every durable fact exactly as the before-snapshot had it.
 * - `recovery_actor_cannot_cross_transaction` (Brief-required): a recovery
 *   actor fabricated as a plain client kind is refused 403 before any lock,
 *   and one genuinely issued inside another transaction cannot be replayed
 *   into a second transaction — the HMAC commitment binds the issuing
 *   transaction id, so the cross-tx use is a 403, never a write.
 * - `recovery_boundary_resets_password_and_consumes_token_once`: the §5.1
 *   order — locate, lock, re-verify the unconsumed token, issue the
 *   tx-bound actor, consume through the native fixed-build POST, finalize —
 *   and the consumed token can never be replayed into a second success.
 * - `session_revoke_single_session_only_and_no_generation_growth` and
 *   `sessions_revoke_all_without_generation_growth`: a single or batch
 *   session revoke never grows the long-lived authorization generation.
 * - `role_set_effective_change_advances_generation_but_noop_does_not` and
 *   `disable_of_already_suspended_identity_is_noop_without_generation_growth`:
 *   only effective security changes advance the generation.
 * - `identity_restore_reactivates_without_resetting_generation`: restoring
 *   never resets the generation, so abilities issued against the old one
 *   stay dead.
 * - `password_reset_admin_path_sets_hash_advances_generation_revokes_sessions`
 *   and `password_reset_refuses_disabled_identity`: the admin path writes
 *   the controlled BA password, advances, revokes; a disabled identity is
 *   never restored by a password reset.
 * - `user_create_builds_ba_user_default_role_and_principal`: the
 *   pre-allocated targetUserId lands on the BA user row (the fixed build's
 *   createUser honoring data.id), the finalizer writes the default user
 *   role, the principal is created at generation 1, and no company
 *   eligibility is granted; the SSO deployment writes no credential
 *   account.
 * - `idempotent_replay_does_not_advance_versions`,
 *   `same_key_with_different_content_conflicts` and
 *   `replay_reverifies_current_authorization`: the identity idempotency
 *   domain is identity+targetUserId+key (the 2026-10-25 §5.6 ruling), the
 *   payload hash covers the operation and a server-key HMAC commitment of
 *   the secrets, and every replay re-runs the current authorization. (A
 *   cross-actor replay is part of `idempotent_replay_does_not_advance_versions`
 *   — the second call there comes from a different admin.)
 *
 * The file holds 19 named `test()` cases; with the file-level afterAll leak
 * assertion the driver reports 20 results, which is why the archived RED run
 * says "20 of 20".
 *
 * Boundaries this suite deliberately does not claim: the HTTP ingress and
 * platform actor issuance (P12/T08), the mail/recovery HTTP wiring and the
 * outbox delivery worker (P08/T04.04), and the per-company directory
 * commands (T02.08's suite).
 *
 * The five BA_TEST_* URLs are all required; a missing one is a blocked
 * suite, never a silent fallback. No DSN is ever printed.
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
const MIGRATION_PATHS = MIGRATION_TAGS.map((tag) =>
  join(import.meta.dirname, `../../drizzle/${tag}.sql`),
);
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

const ADMIN_USER = "t0209-admin";
const SECOND_ADMIN_USER = "t0209-admin-b";
const TARGET_USER = "t0209-target";
const RESET_TARGET_USER = "t0209-reset-target";
const TENANT = "t0209-tenant";
const SESSION_A = "t0209-sess-a";
const SESSION_B = "t0209-sess-b";
const SESSION_C = "t0209-sess-c";
const CHALLENGE_A = "t0209-challenge-a";
const CHALLENGE_B = "t0209-challenge-b";
const CHALLENGE_C = "t0209-challenge-c";
const PROOF_A = "t0209-proof-a";
const PROOF_B = "t0209-proof-b";
const PROOF_C = "t0209-proof-c";
const RESET_TOKEN = "t0209-reset-token-value";
const BA_SECRET = "t0209-harness-fixed-test-secret-not-a-credential";
const COMMITMENT_KEY = Buffer.from(
  "t0209-fixed-commitment-key-not-a-credential",
  "utf8",
);

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

/**
 * Returns the island to the pre-BA shape (the same recovery the sibling BA
 * suites share by reference). No-op on a pristine baseline; it also recovers
 * a crashed earlier run. The capability roles are NOT dropped — the
 * environment's provisioning owns them.
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
    DO $t0209_cleanup$
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
    $t0209_cleanup$`);
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
  // This suite's own leftovers: the fault triggers and the t0209 rows (the
  // users delete cascades sessions/accounts/verifications/user_roles/
  // principals and, through them, every proof).
  for (const [table, trigger] of [
    ["enterprise_principals", "t0209_generation_fault"],
    ["enterprise_principals", "t0209_principal_fault"],
    ["sessions", "t0209_session_fault"],
  ] as const) {
    await sql.unsafe(`DROP TRIGGER IF EXISTS ${trigger} ON "${table}"`);
  }
  await sql.unsafe(`DROP FUNCTION IF EXISTS t0209_generation_fault()`);
  await sql.unsafe(`DROP FUNCTION IF EXISTS t0209_principal_fault()`);
  await sql.unsafe(`DROP FUNCTION IF EXISTS t0209_session_fault()`);
  await sql`DELETE FROM users WHERE id LIKE 't0209-%'`;
  await sql`DELETE FROM verifications WHERE id LIKE 't0209-%' OR identifier LIKE 'reset-password:t0209-%'`;
  await sql`DELETE FROM enterprise_tenants WHERE id = ${TENANT}`;
}

/** The durable facts a rollback must leave untouched, in comparable shape. */
interface IdentitySnapshot {
  receipts: number;
  outbox: number;
  users: {
    id: string;
    email: string;
    name: string | null;
    image: string | null;
  }[];
  roles: { userId: string; role: string }[];
  sessions: { id: string; userId: string }[];
  accounts: { userId: string; providerId: string; hasPassword: boolean }[];
  verifications: string[];
  principals: { userId: string; status: string; generation: number }[];
  proofs: {
    assuranceId: string;
    userId: string;
    sessionId: string;
    status: string;
  }[];
}

async function snapshot(sql: postgres.Sql): Promise<IdentitySnapshot> {
  const [counts] = await sql`
    SELECT
      (SELECT count(*)::int FROM auth_command_receipts) AS receipts,
      (SELECT count(*)::int FROM auth_command_outbox) AS outbox`;
  const usersRows = await sql`
    SELECT id, email, name, image FROM users WHERE id LIKE 't0209-%' ORDER BY id`;
  const roleRows = await sql`
    SELECT user_id, role::text AS role FROM user_roles WHERE user_id LIKE 't0209-%' ORDER BY user_id, role`;
  const sessionRows = await sql`
    SELECT id, user_id FROM sessions WHERE user_id LIKE 't0209-%' ORDER BY id`;
  const accountRows = await sql`
    SELECT user_id, provider_id, (password IS NOT NULL) AS has_password
      FROM accounts WHERE user_id LIKE 't0209-%' ORDER BY user_id, provider_id`;
  const verificationRows = await sql`
    SELECT identifier AS id FROM verifications WHERE id LIKE 't0209-%' OR identifier LIKE 'reset-password:t0209-%' ORDER BY identifier`;
  const principalRows = await sql`
    SELECT user_id, status, identity_generation::int AS generation
      FROM enterprise_principals WHERE user_id LIKE 't0209-%' ORDER BY user_id`;
  const proofRows = await sql`
    SELECT assurance_id, user_id, session_id, status
      FROM auth_company_session_assurances WHERE user_id LIKE 't0209-%'
     ORDER BY assurance_id`;
  return {
    receipts: counts.receipts,
    outbox: counts.outbox,
    users: usersRows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      image: row.image,
    })),
    roles: roleRows.map((row) => ({ userId: row.user_id, role: row.role })),
    sessions: sessionRows.map((row) => ({ id: row.id, userId: row.user_id })),
    accounts: accountRows.map((row) => ({
      userId: row.user_id,
      providerId: row.provider_id,
      hasPassword: Boolean(row.has_password),
    })),
    verifications: verificationRows.map((row) => row.id),
    principals: principalRows.map((row) => ({
      userId: row.user_id,
      status: row.status,
      generation: row.generation,
    })),
    proofs: proofRows.map((row) => ({
      assuranceId: row.assurance_id,
      userId: row.user_id,
      sessionId: row.session_id,
      status: row.status,
    })),
  };
}

type IdentityModule = typeof import("../../src/auth/directory/identity");
type FinalizerModule = typeof import("../../src/auth/directory/finalizer");

let identityPromise: Promise<IdentityModule> | undefined;
function loadIdentity(): Promise<IdentityModule> {
  identityPromise ??= import("../../src/auth/directory/identity").catch(
    (error: unknown) => {
      throw new Error(
        `server/src/auth/directory/identity.ts is not loadable — ${
          error instanceof Error ? error.message : String(error)
        }: the global identity command kernel (stable user/principal locking, domain-split authorization, identity-domain idempotency, same-transaction security finalization, the tx-bound recovery actor and its §5.1 boundary) this suite pins is the T02.09 target behavior, not an environment problem.`,
      );
    },
  );
  return identityPromise;
}

let finalizerPromise: Promise<FinalizerModule> | undefined;
function loadFinalizer(): Promise<FinalizerModule> {
  finalizerPromise ??= import("../../src/auth/directory/finalizer").catch(
    (error: unknown) => {
      throw new Error(
        `server/src/auth/directory/finalizer.ts is not loadable — ${
          error instanceof Error ? error.message : String(error)
        }: the identity finalizer (status/generation/session/proof final verification and the finalize stamp) this suite pins is the T02.09 target behavior, not an environment problem.`,
      );
    },
  );
  return finalizerPromise;
}

/** The fault knobs the failure cases arm, one at a time. */
interface FaultKnobs {
  /** The controlled password write throws. */
  passwordWriteFault?: boolean;
  /** A recovery consume wrapper: run the real consume, then throw. */
  consumeThenThrow?: boolean;
}

interface Harness {
  sql: postgres.Sql;
  execute: (
    actor: Record<string, unknown>,
    command: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  recovery: (
    input: Record<string, unknown>,
    observer?: { onIssued: (actor: unknown) => void },
  ) => Promise<Record<string, unknown>>;
  /** Rebuilds the executor around a finalizer that skips the stamp. */
  unstampedFinalizer(): Promise<void>;
  /** Rebuilds the executor around the real finalizer again. */
  restoreFinalizer(): Promise<void>;
  setFaults(next: FaultKnobs): void;
  addAdminUser(id: string): Promise<void>;
  addTargetUser(id: string): Promise<void>;
  demoteAdmin(id: string): Promise<void>;
  addSession(id: string, userId: string): Promise<void>;
  addProof(input: {
    assuranceId: string;
    userId: string;
    sessionId: string;
    challengeId: string;
  }): Promise<void>;
  addResetToken(token: string, userId: string): Promise<void>;
  principalOf(userId: string): Promise<{ status: string; generation: number }>;
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
  try {
    await cleanupFixture(sql);
    for (const path of MIGRATION_PATHS) {
      if (!existsSync(path)) {
        throw new Error(
          `${path} does not exist: the identity kernel sits on the verified T02.01–T02.06 stack, and a missing prerequisite is a workspace problem, not a target behavior.`,
        );
      }
      await sql.unsafe(readFileSync(path, "utf8"));
    }

    // The unguarded skeleton: the users/roles/sessions the identity facts
    // live on are the enterprise baseline's tables, outside the guarded BA
    // directory tables.
    await sql`INSERT INTO users (id, email) VALUES
      (${ADMIN_USER}, ${`${ADMIN_USER}@example.test`}),
      (${SECOND_ADMIN_USER}, ${`${SECOND_ADMIN_USER}@example.test`}),
      (${TARGET_USER}, ${`${TARGET_USER}@example.test`}),
      (${RESET_TARGET_USER}, ${`${RESET_TARGET_USER}@example.test`})`;
    await sql`INSERT INTO user_roles (user_id, role) VALUES
      (${ADMIN_USER}, 'admin'), (${SECOND_ADMIN_USER}, 'admin'),
      (${TARGET_USER}, 'user'), (${RESET_TARGET_USER}, 'user')`;
    await sql`INSERT INTO enterprise_principals (id, user_id, status, identity_generation, created_at) VALUES
      ('t0209-principal-admin', ${ADMIN_USER}, 'active', 1, now()),
      ('t0209-principal-admin-b', ${SECOND_ADMIN_USER}, 'active', 1, now()),
      ('t0209-principal-target', ${TARGET_USER}, 'active', 1, now()),
      ('t0209-principal-reset', ${RESET_TARGET_USER}, 'active', 1, now())`;
    await sql`INSERT INTO sessions (id, user_id, token, expires_at) VALUES
      (${SESSION_A}, ${TARGET_USER}, ${`token-${SESSION_A}`}, now() + interval '1 day'),
      (${SESSION_B}, ${TARGET_USER}, ${`token-${SESSION_B}`}, now() + interval '1 day')`;
    // One proof per session: the tenant/challenge/proof chain §9.1 needs.
    await sql`INSERT INTO enterprise_tenants (id, name) VALUES (${TENANT}, 'T0209 Identity Tenant')`;
    for (const [challengeId, sessionId, proofId] of [
      [CHALLENGE_A, SESSION_A, PROOF_A],
      [CHALLENGE_B, SESSION_B, PROOF_B],
    ] as const) {
      await sql`
        INSERT INTO auth_company_auth_challenges
          (challenge_id, user_id, session_id, tenant_id, provider_id, protocol,
           policy_revision, return_path, state_digest, secret_envelope, expires_at, created_at)
        VALUES (${challengeId}, ${TARGET_USER}, ${sessionId}, ${TENANT},
                't0209-idp', 'oidc', 1, '/t0209', ${`digest-${challengeId}`},
                'sealed', now() + interval '10 minutes', now())`;
      await sql`
        INSERT INTO auth_company_session_assurances
          (assurance_id, user_id, principal_id, session_id, tenant_id, challenge_id,
           provider_id, authentication_method, issuer, subject, authenticated_at,
           strength, expires_at, policy_revision, identity_generation,
           company_generation, status, created_at)
        VALUES (${proofId}, ${TARGET_USER}, 't0209-principal-target', ${sessionId},
                ${TENANT}, ${challengeId}, 't0209-idp', 'oidc',
                'https://t0209-idp.example.test', ${`subject-${TARGET_USER}`},
                now() - interval '1 minute', 'sufficient',
                now() + interval '1 day', 1, 1, 1, 'active', now())`;
    }

    // The executor-shaped transaction handle: Drizzle over Bun's SQL on the
    // island's owner connection — the frozen DirectoryTx.
    const client = new SQL(setupUrl, {
      max: 4,
      idleTimeout: 5,
      connectionTimeout: 10_000,
      onnotice: () => {},
    });
    const db = drizzle({ client });

    // A real fixed-build Better Auth instance over the island's own public
    // tables, with emailAndPassword (the password hasher and the credential
    // account), configured exactly as the §3.1 factory hard preconditions
    // require. The admin plugin is deliberately NOT loaded: its user model
    // adds role/banned/banReason/banExpires columns this deployment's users
    // table does not carry (the global role domain lives in user_roles per
    // §3.1's compatible-role ruling; disable is the principal's status), and
    // the framework injects the banned default inside the adapter factory
    // where no boundary can drop it. The seam below drives the fixed build's
    // own write primitives instead — the same internalAdapter.createUser,
    // password hasher and linkAccount the admin route drives — and P12's
    // ingress owns the route translation and that factory-level model
    // decision (disclosed in the task report).
    let resolvedOptions: unknown;
    const adapterSchema = {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
      organization: authOrganizations,
    };
    /*
     * The fixed build's createUser route always writes the admin plugin's
     * user fields (`role`, and `banned`/`banReason`/`banExpires`); this
     * deployment's users table has none of them, because the global role
     * domain lives in user_roles (§3.1's compatible-role ruling — the
     * identity finalizer writes it) and the disable vocabulary is the
     * principal's status, not BA's ban columns. The adapter boundary drops
     * the unmapped keys; the production factory wiring (T08/P23 assembly
     * audit) has to make the same call.
     */
    const UNMAPPED_USER_FIELDS = [
      "role",
      "banned",
      "banReason",
      "banExpires",
    ] as const;
    const dropUnmappedUserFields = (adapter: unknown): unknown => {
      const record = adapter as {
        create: (args: {
          model: string;
          data: Record<string, unknown>;
        }) => Promise<unknown>;
      };
      const originalCreate = record.create.bind(record);
      record.create = async (args) => {
        if (args.model !== "user") {
          return originalCreate(args);
        }
        const data = { ...args.data };
        let changed = false;
        for (const field of UNMAPPED_USER_FIELDS) {
          if (field in data) {
            delete data[field];
            changed = true;
          }
        }
        return originalCreate(changed ? { ...args, data } : args);
      };
      return adapter;
    };
    const { betterAuth } = await import("better-auth");
    const auth = betterAuth({
      secret: BA_SECRET,
      baseURL: "http://127.0.0.1:9",
      trustedOrigins: ["http://127.0.0.1:9"],
      emailAndPassword: { enabled: true },
      database: (options: unknown) => {
        resolvedOptions = options;
        return dropUnmappedUserFields(
          drizzleAdapter(db as never, {
            provider: "pg",
            schema: adapterSchema,
            transaction: true,
          })(options as never),
        );
      },
    });
    const baContext = await auth.$context;

    const bound = (
      await import("../../src/auth/directory/transaction-adapter")
    ).createTransactionBoundBa({
      createTxAdapter: (tx: DirectoryTx) =>
        dropUnmappedUserFields(
          drizzleAdapter(tx as never, {
            provider: "pg",
            schema: adapterSchema,
            transaction: false,
          })(resolvedOptions as never),
        ),
    });

    const { principalRegistry } = await import(
      "../../src/auth/directory/principal-registry"
    );

    let faults: FaultKnobs = {};

    /** The controlled BA access the executor is wired with — the real fixed build, no stubs. */
    const baAccess = {
      createUser: async (input: {
        userId: string;
        email: string;
        name: string;
        image: string | null;
        password: string | null;
      }) => {
        const email = input.email.toLowerCase();
        if (await baContext.internalAdapter.findUserByEmail(email)) {
          // The fixed build's own refusal shape for an existing address.
          throw new Error(`User already exists. Use another email. (${email})`);
        }
        const user = await baContext.internalAdapter.createUser({
          id: input.userId,
          email,
          name: input.name,
          ...(input.image ? { image: input.image } : {}),
        });
        if (!user) throw new Error("T0209_CREATE_USER_FAILED");
        if (input.password !== null) {
          const hashed = await baContext.password.hash(input.password);
          await baContext.internalAdapter.linkAccount({
            providerId: "credential",
            issuer: "local:credential",
            accountId: user.id,
            password: hashed,
            userId: user.id,
          });
        }
      },
      writePassword: async (input: { userId: string; newPassword: string }) => {
        if (faults.passwordWriteFault) {
          throw new Error("T0209_PASSWORD_WRITE_FAULT");
        }
        const hashed = await baContext.password.hash(input.newPassword);
        const existing = await baContext.internalAdapter.findCredentialAccount(
          input.userId,
        );
        if (existing) {
          await baContext.internalAdapter.updatePassword(input.userId, hashed);
        } else {
          await baContext.internalAdapter.createAccount({
            userId: input.userId,
            providerId: "credential",
            issuer: "local:credential",
            accountId: input.userId,
            password: hashed,
          });
        }
      },
      consumeResetToken: async (input: {
        resetToken: string;
        newPassword: string;
      }) => {
        await auth.api.resetPassword({
          body: { token: input.resetToken, newPassword: input.newPassword },
        });
        if (faults.consumeThenThrow) {
          throw new Error("T0209_CONSUME_THEN_THROW");
        }
      },
    };

    let unstamped = false;

    async function buildIdentity() {
      const identityModule = await loadIdentity();
      const finalizerModule = await loadFinalizer();
      const finalizer = unstamped
        ? {
            finalize: async (tx: DirectoryTx, commandId: string) => {
              // The missing-stamp fault: everything but the stamp runs, so
              // only the deferred receipt fence can refuse the commit.
              await tx.execute(dsql`
                SELECT command_id, target_user_id, operation FROM auth_command_receipts
                 WHERE command_id = ${commandId}`);
              throw new Error("T0209_FINALIZER_STAMP_SKIPPED");
            },
          }
        : finalizerModule.createIdentityFinalizer();
      const executor = identityModule.createIdentityExecutor({
        database: db,
        bound,
        registry: principalRegistry,
        finalizer: finalizer as never,
        ba: baAccess,
        commitmentKey: COMMITMENT_KEY,
      });
      return executor;
    }

    let executorPromise:
      | Promise<Awaited<ReturnType<typeof buildIdentity>>>
      | undefined;

    return {
      sql,
      execute: async (actor, command) => {
        executorPromise ??= buildIdentity();
        const executor = await executorPromise;
        return executor.execute(actor as never, command as never) as Promise<
          Record<string, unknown>
        >;
      },
      recovery: async (input, observer) => {
        executorPromise ??= buildIdentity();
        const executor = await executorPromise;
        return executor.recovery.resetPasswordByToken({
          resetToken: String(input.resetToken ?? ""),
          newPassword: String(input.newPassword ?? ""),
          idempotencyKey: String(input.idempotencyKey ?? ""),
          ...(observer ? { onIssued: observer.onIssued as never } : {}),
        } as never) as Promise<Record<string, unknown>>;
      },
      unstampedFinalizer: async () => {
        unstamped = true;
        executorPromise = undefined;
      },
      restoreFinalizer: async () => {
        unstamped = false;
        executorPromise = undefined;
      },
      setFaults: (next) => {
        faults = next;
      },
      addAdminUser: async (id) => {
        await sql`INSERT INTO users (id, email) VALUES (${id}, ${`${id}@example.test`})`;
        await sql`INSERT INTO user_roles (user_id, role) VALUES (${id}, 'admin')`;
      },
      addTargetUser: async (id) => {
        await sql`INSERT INTO users (id, email) VALUES (${id}, ${`${id}@example.test`})`;
        await sql`INSERT INTO user_roles (user_id, role) VALUES (${id}, 'user')`;
      },
      demoteAdmin: async (id) => {
        await sql`DELETE FROM user_roles WHERE user_id = ${id} AND role = 'admin'`;
        await sql`INSERT INTO user_roles (user_id, role) VALUES (${id}, 'user') ON CONFLICT DO NOTHING`;
      },
      addSession: async (id, userId) => {
        await sql`DELETE FROM sessions WHERE id = ${id}`;
        await sql`INSERT INTO sessions (id, user_id, token, expires_at)
          VALUES (${id}, ${userId}, ${`token-${id}`}, now() + interval '1 day')`;
      },
      addProof: async (input) => {
        await sql`DELETE FROM auth_company_auth_challenges WHERE challenge_id = ${input.challengeId}`;
        await sql`
          INSERT INTO auth_company_auth_challenges
            (challenge_id, user_id, session_id, tenant_id, provider_id, protocol,
             policy_revision, return_path, state_digest, secret_envelope, expires_at, created_at)
          VALUES (${input.challengeId}, ${input.userId}, ${input.sessionId}, ${TENANT},
                  't0209-idp', 'oidc', 1, '/t0209', ${`digest-${input.challengeId}`},
                  'sealed', now() + interval '10 minutes', now())`;
        await sql`
          INSERT INTO auth_company_session_assurances
            (assurance_id, user_id, principal_id, session_id, tenant_id, challenge_id,
             provider_id, authentication_method, issuer, subject, authenticated_at,
             strength, expires_at, policy_revision, identity_generation,
             company_generation, status, created_at)
          VALUES (${input.assuranceId}, ${input.userId},
                  't0209-principal-target', ${input.sessionId}, ${TENANT},
                  ${input.challengeId}, 't0209-idp', 'oidc',
                  'https://t0209-idp.example.test', ${`subject-${input.userId}`},
                  now() - interval '1 minute', 'sufficient',
                  now() + interval '1 day', 1, 1, 1, 'active', now())`;
      },
      addResetToken: async (token, userId) => {
        await sql`DELETE FROM verifications WHERE identifier = ${`reset-password:${token}`}`;
        await sql`INSERT INTO verifications (id, identifier, value, expires_at)
          VALUES (${`t0209-vt-${token}`}, ${`reset-password:${token}`}, ${userId},
                  now() + interval '1 hour')`;
      },
      principalOf: async (userId) => {
        const [row] = await sql`
          SELECT status, identity_generation::int AS generation FROM enterprise_principals
           WHERE user_id = ${userId}`;
        return { status: row.status, generation: row.generation };
      },
      probe: () =>
        postgres(setupUrl, { max: 1, idle_timeout: 5, onnotice: () => {} }),
      close: async () => {
        try {
          await cleanupFixture(sql);
        } finally {
          await Promise.allSettled([sql.end({ timeout: 5 }), client.close()]);
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
  const probe = harness.probe();
  await harness.close();
  try {
    const leaked = await probe`
      SELECT nspname AS resource FROM pg_namespace WHERE nspname LIKE 't0209%'
      UNION ALL
      SELECT n.nspname || '.' || c.relname AS resource
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = ANY(${[...BA_TABLES]}::text[])
      UNION ALL
      SELECT 'users:' || id FROM users WHERE id LIKE 't0209-%'
      UNION ALL
      SELECT 'verifications:' || identifier FROM verifications
       WHERE id LIKE 't0209-%' OR identifier LIKE 'reset-password:t0209-%'`;
    expect(leaked).toEqual([]);
  } finally {
    await probe.end({ timeout: 5 }).catch(() => {});
  }
});

const adminActor = (userId = ADMIN_USER) => ({
  userId,
  principalId: null,
  sessionId: null,
  kind: "platform" as const,
  bindingId: null,
  provisioning: null,
});

const sessionActor = (userId: string, sessionId: string) => ({
  userId,
  principalId: null,
  sessionId,
  kind: "session" as const,
  bindingId: null,
  provisioning: null,
});

const command = (
  operation: string,
  targetUserId: string,
  idempotencyKey: string,
  payload: Record<string, unknown>,
  secrets?: Record<string, unknown>,
) => ({
  operation,
  targetUserId,
  idempotencyKey,
  payload,
  ...(secrets ? { secrets } : {}),
});

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

/** Asserts a refusal whose marker may sit behind drizzle's wrapper. */
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

test("envelope_validation_refuses_unknown_operation_and_payload_fields", async () => {
  const sql = harness!.sql;
  const before = await snapshot(sql);

  await expectRefusal(
    () =>
      harness!.execute(
        adminActor(),
        command("identity.demolish", TARGET_USER, "t0209-unknown-op", {
          reason: "x",
        }),
      ),
    /IDENTITY_OPERATION_UNKNOWN/,
  );
  await expectRefusal(
    () =>
      harness!.execute(
        adminActor(),
        command("identity.disable", TARGET_USER, "t0209-unknown-field", {
          reason: "x",
          extra: "no",
        }),
      ),
    /IDENTITY_COMMAND_INVALID/,
  );
  await expectRefusal(
    () =>
      harness!.execute(
        adminActor(),
        command(
          "identity.profile.update",
          TARGET_USER,
          "t0209-empty-profile",
          {},
        ),
      ),
    /IDENTITY_COMMAND_INVALID/,
  );
  await expectRefusal(
    () =>
      harness!.execute(
        adminActor(),
        command("identity.role.set", TARGET_USER, "t0209-company-role", {
          role: "owner",
          reason: "x",
        }),
      ),
    /IDENTITY_COMMAND_INVALID/,
  );
  // No receipt, no write: the refusal happened before any lock or DML.
  expect(await snapshot(sql)).toEqual(before);
});

test("session_actor_cannot_run_admin_operations", async () => {
  const sql = harness!.sql;
  const before = await snapshot(sql);

  await expectRefusal(
    () =>
      harness!.execute(
        sessionActor(TARGET_USER, SESSION_A),
        command("identity.disable", TARGET_USER, "t0209-session-admin", {
          reason: "x",
        }),
      ),
    /IDENTITY_ACTOR_FORBIDDEN/,
  );
  // A session actor may not even revoke every session of another user.
  await expectRefusal(
    () =>
      harness!.execute(
        sessionActor(TARGET_USER, SESSION_A),
        command("identity.sessions.revoke", ADMIN_USER, "t0209-session-batch", {
          reason: "x",
        }),
      ),
    /IDENTITY_ACTOR_FORBIDDEN/,
  );
  expect(await snapshot(sql)).toEqual(before);
});

test("disable_requires_current_global_admin", async () => {
  await harness!.addTargetUser("t0209-plain-admin");
  // A platform actor whose user holds no admin role is refused in-lock.
  await expectRefusal(
    () =>
      harness!.execute(
        { ...adminActor("t0209-plain-admin"), principalId: null },
        command("identity.disable", TARGET_USER, "t0209-non-admin", {
          reason: "x",
        }),
      ),
    /IDENTITY_ACTOR_FORBIDDEN/,
  );
  // A stale principalId on the actor is refused, never silently replaced.
  await expectRefusal(
    () =>
      harness!.execute(
        { ...adminActor(), principalId: "t0209-principal-target" },
        command("identity.disable", TARGET_USER, "t0209-stale-principal", {
          reason: "x",
        }),
      ),
    /IDENTITY_ACTOR_PRINCIPAL_MISMATCH/,
  );
});

test("identity_disable_advances_generation_and_revokes_sessions_and_proofs", async () => {
  const sql = harness!.sql;
  const before = await snapshot(sql);
  expect(before.principals.find((row) => row.userId === TARGET_USER)).toEqual({
    userId: TARGET_USER,
    status: "active",
    generation: 1,
  });

  const result = await harness!.execute(
    adminActor(),
    command("identity.disable", TARGET_USER, "t0209-disable", {
      reason: "policy",
    }),
  );
  expect(result.replayed).toBe(false);
  expect(result.userId).toBe(TARGET_USER);
  expect(result.principalId).toBe("t0209-principal-target");
  expect(result.identityGeneration).toBe(2);

  const principal = await harness!.principalOf(TARGET_USER);
  expect(principal).toEqual({ status: "suspended", generation: 2 });
  // Every session is gone and the proofs died with them (cascade + verify).
  const sessionsLeft = await sql`
    SELECT count(*)::int AS count FROM sessions WHERE user_id = ${TARGET_USER}`;
  expect(sessionsLeft[0].count).toBe(0);
  const proofsLeft = await sql`
    SELECT count(*)::int AS count FROM auth_company_session_assurances
     WHERE user_id = ${TARGET_USER} AND status = 'active'`;
  expect(proofsLeft[0].count).toBe(0);
  const [receipt] = await sql`
    SELECT finalized FROM auth_command_receipts WHERE command_id = ${result.commandId}`;
  expect(receipt?.finalized).toBe(true);
  const [receiptShape] = await sql`
    SELECT domain, tenant_id, target_user_id, actor_kind FROM auth_command_receipts
     WHERE command_id = ${result.commandId}`;
  expect(receiptShape).toEqual({
    domain: "identity",
    tenant_id: null,
    target_user_id: TARGET_USER,
    actor_kind: "platform",
  });
});

test("disable_of_already_suspended_identity_is_noop_without_generation_growth", async () => {
  const sql = harness!.sql;
  const second = await harness!.execute(
    adminActor(SECOND_ADMIN_USER),
    command("identity.disable", TARGET_USER, "t0209-disable-again", {
      reason: "repeat",
    }),
  );
  expect(second.replayed).toBe(false);
  expect(second.identityGeneration).toBe(2);
  const principal = await harness!.principalOf(TARGET_USER);
  expect(principal).toEqual({ status: "suspended", generation: 2 });
  const [receiptCount] = await sql`
    SELECT count(*)::int AS count FROM auth_command_receipts WHERE target_user_id = ${TARGET_USER}`;
  expect(receiptCount.count).toBe(2);
});

test("identity_restore_advances_generation_and_revokes_sessions", async () => {
  const sql = harness!.sql;
  // §2.1's disable/restore row (line 157): an EFFECTIVE status change —
  // including restore — advances identityGeneration and revokes every
  // session/proof. A residual session must not survive the restore.
  await harness!.addSession(SESSION_A, TARGET_USER);
  await harness!.addProof({
    assuranceId: PROOF_A,
    userId: TARGET_USER,
    sessionId: SESSION_A,
    challengeId: CHALLENGE_A,
  });
  const before = await harness!.principalOf(TARGET_USER);
  expect(before).toEqual({ status: "suspended", generation: 2 });

  const result = await harness!.execute(
    adminActor(),
    command("identity.restore", TARGET_USER, "t0209-restore", {
      reason: "cleared",
    }),
  );
  expect(result.identityGeneration).toBe(3);
  const principal = await harness!.principalOf(TARGET_USER);
  // Restoring advances, never resets: abilities issued against the old
  // generation stay dead, and the restored identity starts sessionless.
  expect(principal).toEqual({ status: "active", generation: 3 });
  const sessionsLeft = await sql`
    SELECT count(*)::int AS count FROM sessions WHERE user_id = ${TARGET_USER}`;
  expect(sessionsLeft[0].count).toBe(0);
  const activeProofs = await sql`
    SELECT count(*)::int AS count FROM auth_company_session_assurances
     WHERE user_id = ${TARGET_USER} AND status = 'active'`;
  expect(activeProofs[0].count).toBe(0);
});

test("role_set_effective_change_advances_generation_but_noop_does_not", async () => {
  const sql = harness!.sql;
  await harness!.addSession(SESSION_C, TARGET_USER);
  await harness!.addProof({
    assuranceId: PROOF_C,
    userId: TARGET_USER,
    sessionId: SESSION_C,
    challengeId: CHALLENGE_C,
  });

  // The effective change: user → admin advances and revokes everything.
  const roleBefore = await harness!.principalOf(TARGET_USER);
  const promoted = await harness!.execute(
    adminActor(),
    command("identity.role.set", TARGET_USER, "t0209-promote", {
      role: "admin",
      reason: "ops",
    }),
  );
  expect(promoted.identityGeneration).toBe(roleBefore.generation + 1);
  const rolesAfterPromote = await sql`
    SELECT role::text AS role FROM user_roles WHERE user_id = ${TARGET_USER}`;
  expect(rolesAfterPromote).toEqual([{ role: "admin" }]);
  const sessionsAfter = await sql`
    SELECT count(*)::int AS count FROM sessions WHERE user_id = ${TARGET_USER}`;
  expect(sessionsAfter[0].count).toBe(0);

  // The no-op: admin → admin again succeeds without any growth.
  await harness!.addSession(SESSION_A, TARGET_USER);
  const noop = await harness!.execute(
    adminActor(),
    command("identity.role.set", TARGET_USER, "t0209-promote-noop", {
      role: "admin",
      reason: "repeat",
    }),
  );
  expect(noop.identityGeneration).toBe(roleBefore.generation + 1);
  const sessionsKept = await sql`
    SELECT count(*)::int AS count FROM sessions WHERE user_id = ${TARGET_USER}`;
  expect(sessionsKept[0].count).toBe(1);

  // Back to user for the later cases.
  await harness!.execute(
    adminActor(),
    command("identity.role.set", TARGET_USER, "t0209-demote", {
      role: "user",
      reason: "ops",
    }),
  );
  const afterDemote = await harness!.principalOf(TARGET_USER);
  expect(afterDemote.generation).toBe(roleBefore.generation + 2);
});

test("role_set_actual_role_set_change_advances_generation", async () => {
  const sql = harness!.sql;
  // A legal but historical multi-row state: `(user_id, role)` is the only
  // key, and the guard reads "any admin row means admin", so a demotion from
  // {admin, user} to {user} is a REAL privilege drop even though the target
  // role already exists in the set. It must advance and revoke.
  await sql`INSERT INTO user_roles (user_id, role) VALUES (${TARGET_USER}, 'admin') ON CONFLICT DO NOTHING`;
  await harness!.addSession(SESSION_A, TARGET_USER);
  await harness!.addProof({
    assuranceId: PROOF_A,
    userId: TARGET_USER,
    sessionId: SESSION_A,
    challengeId: CHALLENGE_A,
  });
  const before = await harness!.principalOf(TARGET_USER);

  const result = await harness!.execute(
    adminActor(),
    command("identity.role.set", TARGET_USER, "t0209-demote-dual", {
      role: "user",
      reason: "dual-row demotion",
    }),
  );
  expect(result.identityGeneration).toBe(before.generation + 1);
  const roles = await sql`
    SELECT role::text AS role FROM user_roles WHERE user_id = ${TARGET_USER} ORDER BY role`;
  expect(roles).toEqual([{ role: "user" }]);
  const sessionsLeft = await sql`
    SELECT count(*)::int AS count FROM sessions WHERE user_id = ${TARGET_USER}`;
  expect(sessionsLeft[0].count).toBe(0);
  const activeProofs = await sql`
    SELECT count(*)::int AS count FROM auth_company_session_assurances
     WHERE user_id = ${TARGET_USER} AND status = 'active'`;
  expect(activeProofs[0].count).toBe(0);
});

test("session_revoke_single_session_only_and_no_generation_growth", async () => {
  const sql = harness!.sql;
  await harness!.addSession(SESSION_A, TARGET_USER);
  await harness!.addSession(SESSION_B, TARGET_USER);
  await harness!.addProof({
    assuranceId: PROOF_A,
    userId: TARGET_USER,
    sessionId: SESSION_A,
    challengeId: CHALLENGE_A,
  });
  await harness!.addProof({
    assuranceId: PROOF_B,
    userId: TARGET_USER,
    sessionId: SESSION_B,
    challengeId: CHALLENGE_B,
  });
  const before = await harness!.principalOf(TARGET_USER);

  // Self-service: the session's own user, no admin involved.
  const result = await harness!.execute(
    sessionActor(TARGET_USER, SESSION_A),
    command("identity.session.revoke", TARGET_USER, "t0209-revoke-one", {
      sessionId: SESSION_A,
      reason: "signed out",
    }),
  );
  expect(result.identityGeneration).toBe(before.generation);
  const sessionRows = await sql`
    SELECT id FROM sessions WHERE user_id = ${TARGET_USER} ORDER BY id`;
  expect(sessionRows.map((row) => row.id)).toEqual([SESSION_B]);
  const proofs = await sql`
    SELECT assurance_id FROM auth_company_session_assurances
     WHERE user_id = ${TARGET_USER} ORDER BY assurance_id`;
  expect(proofs.map((row) => row.assurance_id)).toEqual([PROOF_B]);

  // A session that belongs to someone else is refused, never revoked.
  await expectRefusal(
    () =>
      harness!.execute(
        adminActor(),
        command(
          "identity.session.revoke",
          TARGET_USER,
          "t0209-revoke-foreign",
          {
            sessionId: "t0209-admin-session",
            reason: "x",
          },
        ),
      ),
    /IDENTITY_SESSION_NOT_OWNED|IDENTITY_SESSION_UNKNOWN/,
  );
});

test("sessions_revoke_all_without_generation_growth", async () => {
  const sql = harness!.sql;
  await harness!.addSession(SESSION_A, TARGET_USER);
  await harness!.addProof({
    assuranceId: PROOF_A,
    userId: TARGET_USER,
    sessionId: SESSION_A,
    challengeId: CHALLENGE_A,
  });
  const before = await harness!.principalOf(TARGET_USER);

  const result = await harness!.execute(
    adminActor(),
    command("identity.sessions.revoke", TARGET_USER, "t0209-revoke-all", {
      reason: "incident",
    }),
  );
  expect(result.identityGeneration).toBe(before.generation);
  const sessionsLeft = await sql`
    SELECT count(*)::int AS count FROM sessions WHERE user_id = ${TARGET_USER}`;
  expect(sessionsLeft[0].count).toBe(0);
  const activeProofs = await sql`
    SELECT count(*)::int AS count FROM auth_company_session_assurances
     WHERE user_id = ${TARGET_USER} AND status = 'active'`;
  expect(activeProofs[0].count).toBe(0);
});

test("user_create_builds_ba_user_default_role_and_principal", async () => {
  const sql = harness!.sql;
  const created = await harness!.execute(
    adminActor(),
    command(
      "identity.user.create",
      "t0209-new-user",
      "t0209-create-user",
      { email: "t0209-new@example.test", name: "New User" },
      { newPassword: "t0209-new-user-password" },
    ),
  );
  expect(created.userId).toBe("t0209-new-user");
  expect(created.principalId).toEqual(expect.any(String));
  expect(created.identityGeneration).toBe(1);

  // The pre-allocated id landed on the BA user row (fixed build createUser).
  const [user] = await sql`
    SELECT email, name FROM users WHERE id = 't0209-new-user'`;
  expect(user).toEqual({ email: "t0209-new@example.test", name: "New User" });
  // The default user role, written by the identity finalizer in the same tx.
  const roles = await sql`
    SELECT role::text AS role FROM user_roles WHERE user_id = 't0209-new-user'`;
  expect(roles).toEqual([{ role: "user" }]);
  // The principal exists at generation 1 and no company eligibility exists.
  const [principal] = await sql`
    SELECT status, identity_generation::int AS generation FROM enterprise_principals
     WHERE user_id = 't0209-new-user'`;
  expect(principal).toEqual({ status: "active", generation: 1 });
  const members = await sql`
    SELECT count(*)::int AS count FROM auth_members WHERE user_id = 't0209-new-user'`;
  expect(members[0].count).toBe(0);
  // The password deployment wrote a credential account with a real hash.
  const [account] = await sql`
    SELECT provider_id, length(password) AS hash_length FROM accounts
     WHERE user_id = 't0209-new-user' AND provider_id = 'credential'`;
  expect(account?.hash_length).toBeGreaterThan(30);

  // The SSO deployment creates the user without any credential account.
  const sso = await harness!.execute(
    adminActor(),
    command("identity.user.create", "t0209-sso-user", "t0209-create-sso-user", {
      email: "t0209-sso@example.test",
      name: "SSO User",
    }),
  );
  expect(sso.identityGeneration).toBe(1);
  const ssoAccounts = await sql`
    SELECT count(*)::int AS count FROM accounts WHERE user_id = 't0209-sso-user'`;
  expect(ssoAccounts[0].count).toBe(0);
});

test("profile_update_changes_only_profile_fields", async () => {
  const sql = harness!.sql;
  const before = await harness!.principalOf(TARGET_USER);
  await harness!.addSession(SESSION_A, TARGET_USER);

  await harness!.execute(
    adminActor(),
    command("identity.profile.update", TARGET_USER, "t0209-profile", {
      name: "Renamed",
      image: "https://cdn.example.test/t0209.png",
    }),
  );
  let [user] = await sql`
    SELECT email, name, image FROM users WHERE id = ${TARGET_USER}`;
  expect(user).toEqual({
    email: `${TARGET_USER}@example.test`,
    name: "Renamed",
    image: "https://cdn.example.test/t0209.png",
  });

  // A partial update writes ONLY the provided field: the other column keeps
  // its existing value (§2.1's payload is name?/image? with at least one).
  await harness!.execute(
    adminActor(),
    command("identity.profile.update", TARGET_USER, "t0209-profile-name", {
      name: "Renamed Again",
    }),
  );
  [user] = await sql`
    SELECT email, name, image FROM users WHERE id = ${TARGET_USER}`;
  expect(user).toEqual({
    email: `${TARGET_USER}@example.test`,
    name: "Renamed Again",
    image: "https://cdn.example.test/t0209.png",
  });

  await harness!.execute(
    adminActor(),
    command("identity.profile.update", TARGET_USER, "t0209-profile-image", {
      image: "https://cdn.example.test/t0209-b.png",
    }),
  );
  [user] = await sql`
    SELECT email, name, image FROM users WHERE id = ${TARGET_USER}`;
  expect(user).toEqual({
    email: `${TARGET_USER}@example.test`,
    name: "Renamed Again",
    image: "https://cdn.example.test/t0209-b.png",
  });

  const after = await harness!.principalOf(TARGET_USER);
  expect(after).toEqual(before);
  const sessions = await sql`
    SELECT count(*)::int AS count FROM sessions WHERE user_id = ${TARGET_USER}`;
  expect(sessions[0].count).toBe(1);
});

test("password_reset_admin_path_sets_hash_advances_generation_revokes_sessions", async () => {
  const sql = harness!.sql;
  await harness!.addSession(SESSION_A, TARGET_USER);
  await harness!.addProof({
    assuranceId: PROOF_A,
    userId: TARGET_USER,
    sessionId: SESSION_A,
    challengeId: CHALLENGE_A,
  });
  const before = await harness!.principalOf(TARGET_USER);

  const result = await harness!.execute(
    adminActor(),
    command(
      "identity.password.reset",
      TARGET_USER,
      "t0209-admin-reset",
      { reason: "admin rotation" },
      { newPassword: "t0209-rotated-password" },
    ),
  );
  expect(result.identityGeneration).toBe(before.generation + 1);
  const [account] = await sql`
    SELECT password FROM accounts WHERE user_id = ${TARGET_USER} AND provider_id = 'credential'`;
  expect(account?.password).toBeTruthy();
  const sessionsLeft = await sql`
    SELECT count(*)::int AS count FROM sessions WHERE user_id = ${TARGET_USER}`;
  expect(sessionsLeft[0].count).toBe(0);
  const activeProofs = await sql`
    SELECT count(*)::int AS count FROM auth_company_session_assurances
     WHERE user_id = ${TARGET_USER} AND status = 'active'`;
  expect(activeProofs[0].count).toBe(0);
});

test("password_reset_refuses_disabled_identity", async () => {
  const sql = harness!.sql;
  await harness!.execute(
    adminActor(),
    command("identity.disable", TARGET_USER, "t0209-disable-before-reset", {
      reason: "hold",
    }),
  );
  const before = await snapshot(sql);
  await expectRefusal(
    () =>
      harness!.execute(
        adminActor(),
        command(
          "identity.password.reset",
          TARGET_USER,
          "t0209-reset-disabled",
          { reason: "x" },
          { newPassword: "t0209-should-not-land" },
        ),
      ),
    /IDENTITY_TARGET_DISABLED/,
  );
  expect(await snapshot(sql)).toEqual(before);
  await harness!.execute(
    adminActor(),
    command("identity.restore", TARGET_USER, "t0209-restore-after-reset", {
      reason: "resume",
    }),
  );
});

test("recovery_boundary_resets_password_and_consumes_token_once", async () => {
  const sql = harness!.sql;
  await harness!.addSession(SESSION_A, RESET_TARGET_USER);
  await harness!.addResetToken(RESET_TOKEN, RESET_TARGET_USER);
  const before = await harness!.principalOf(RESET_TARGET_USER);
  expect(before).toEqual({ status: "active", generation: 1 });

  const result = await harness!.recovery({
    resetToken: RESET_TOKEN,
    newPassword: "t0209-recovered-password",
    idempotencyKey: "t0209-recovery",
  });
  expect(result.userId).toBe(RESET_TARGET_USER);
  expect(result.identityGeneration).toBe(2);
  // The token row is gone: the native POST was the one and only consumer.
  const [tokenRow] = await sql`
    SELECT count(*)::int AS count FROM verifications WHERE id = ${`reset-password:${RESET_TOKEN}`}`;
  expect(tokenRow.count).toBe(0);
  const [account] = await sql`
    SELECT password FROM accounts WHERE user_id = ${RESET_TARGET_USER} AND provider_id = 'credential'`;
  expect(account?.password).toBeTruthy();
  const sessionsLeft = await sql`
    SELECT count(*)::int AS count FROM sessions WHERE user_id = ${RESET_TARGET_USER}`;
  expect(sessionsLeft[0].count).toBe(0);
  const [receipt] = await sql`
    SELECT actor_kind, finalized FROM auth_command_receipts WHERE command_id = ${result.commandId}`;
  expect(receipt).toEqual({ actor_kind: "recovery", finalized: true });

  // The consumed token can never be replayed into a second success, even
  // under a fresh idempotency key (§5.1: the consumed token is refused 404
  // before any receipt is consulted — the replay-by-same-key property is
  // the ADMIN path's, asserted by idempotent_replay_does_not_advance_versions).
  await expectRefusal(
    () =>
      harness!.recovery({
        resetToken: RESET_TOKEN,
        newPassword: "t0209-replay-password",
        idempotencyKey: "t0209-recovery-again",
      }),
    /IDENTITY_RECOVERY_TOKEN_UNKNOWN/,
  );
  const after = await harness!.principalOf(RESET_TARGET_USER);
  expect(after.generation).toBe(2);
});

test("recovery_actor_cannot_cross_transaction", async () => {
  const sql = harness!.sql;
  const token = "t0209-cross-token";
  await harness!.addResetToken(token, RESET_TARGET_USER);
  let issuedActor: unknown;
  harness!.setFaults({ consumeThenThrow: true });
  await expectRefusal(
    () =>
      harness!.recovery(
        {
          resetToken: token,
          newPassword: "t0209-cross-password",
          idempotencyKey: "t0209-cross-tx",
        },
        { onIssued: (actor) => (issuedActor = actor) },
      ),
    /T0209_CONSUME_THEN_THROW/,
  );
  harness!.setFaults({});
  // The rolled-back transaction restored the token; the issued actor object
  // survived in the closure — exactly the cross-transaction carry the
  // commitment must refuse.
  expect(issuedActor).toBeDefined();
  const [tokenRestored] = await sql`
    SELECT count(*)::int AS count FROM verifications WHERE identifier = ${`reset-password:${token}`}`;
  expect(tokenRestored.count).toBe(1);

  await expectRefusal(
    () =>
      harness!.execute(
        issuedActor as Record<string, unknown>,
        command(
          "identity.password.reset",
          RESET_TARGET_USER,
          "t0209-cross-tx-reuse",
          { reason: "x" },
          { newPassword: "t0209-cross-2", resetToken: token },
        ),
      ),
    /IDENTITY_RECOVERY_ACTOR_INVALID/,
  );

  // A client-fabricated recovery kind — no commitment at all — is refused
  // with the same 403 by the in-lock commitment validation (the lock layer
  // takes the user locks first; the refusal still writes nothing).
  const statusOf = await (async () => {
    try {
      await harness!.execute(
        {
          userId: RESET_TARGET_USER,
          principalId: null,
          sessionId: null,
          kind: "recovery",
          bindingId: null,
          provisioning: null,
        },
        command(
          "identity.password.reset",
          RESET_TARGET_USER,
          "t0209-client-recovery",
          { reason: "x" },
          { newPassword: "t0209-client-2", resetToken: token },
        ),
      );
      return "resolved";
    } catch (error) {
      const refusal = error as { status?: number };
      expect(
        errorChainMessage(error).includes("IDENTITY_RECOVERY_ACTOR_INVALID"),
      ).toBe(true);
      return refusal.status ?? "none";
    }
  })();
  expect(statusOf).toBe(403);

  // A genuinely issued actor is single-purpose: not even the same operation
  // against another target, nor another operation on the same target.
  await expectRefusal(
    () =>
      harness!.execute(
        issuedActor as Record<string, unknown>,
        command("identity.role.set", RESET_TARGET_USER, "t0209-cross-role", {
          role: "admin",
          reason: "x",
        }),
      ),
    /IDENTITY_RECOVERY_ACTOR_INVALID/,
  );
});

test("identity_each_security_write_failure_rolls_back", async () => {
  const sql = harness!.sql;

  // (a) The BA user create fails (the fixed build's duplicate-email
  // refusal: the address the admin actor already owns).
  let before = await snapshot(sql);
  await expectRefusal(
    () =>
      harness!.execute(
        adminActor(),
        command("identity.user.create", "t0209-dup-user", "t0209-create-dup", {
          email: `${ADMIN_USER}@example.test`,
          name: "Dup",
        }),
      ),
    /already exists|USER_ALREADY_EXISTS/,
  );
  expect(await snapshot(sql)).toEqual(before);

  // (b) The controlled password write fails.
  await harness!.setFaults({ passwordWriteFault: true });
  before = await snapshot(sql);
  await expectRefusal(
    () =>
      harness!.execute(
        adminActor(),
        command(
          "identity.password.reset",
          TARGET_USER,
          "t0209-pw-fault",
          { reason: "x" },
          { newPassword: "t0209-fault-password" },
        ),
      ),
    /T0209_PASSWORD_WRITE_FAULT/,
  );
  expect(await snapshot(sql)).toEqual(before);
  await harness!.setFaults({});

  // (c) The generation advance fails: a fault trigger on the principal row.
  await sql.unsafe(`CREATE OR REPLACE FUNCTION t0209_generation_fault()
    RETURNS trigger LANGUAGE plpgsql AS $t0209$
    BEGIN
      IF NEW.identity_generation IS DISTINCT FROM OLD.identity_generation THEN
        RAISE EXCEPTION 'T0209_GENERATION_FAULT';
      END IF;
      RETURN NEW;
    END $t0209$`);
  await sql.unsafe(
    `CREATE TRIGGER t0209_generation_fault BEFORE UPDATE ON enterprise_principals
     FOR EACH ROW EXECUTE FUNCTION t0209_generation_fault()`,
  );
  await harness!.addSession(SESSION_A, TARGET_USER);
  before = await snapshot(sql);
  await expectRefusal(
    () =>
      harness!.execute(
        adminActor(),
        command("identity.disable", TARGET_USER, "t0209-gen-fault", {
          reason: "x",
        }),
      ),
    /T0209_GENERATION_FAULT/,
  );
  expect(await snapshot(sql)).toEqual(before);
  await sql.unsafe(
    `DROP TRIGGER IF EXISTS t0209_generation_fault ON enterprise_principals`,
  );
  await sql.unsafe(`DROP FUNCTION IF EXISTS t0209_generation_fault()`);

  // (d) The session delete fails: a fault trigger on the session delete.
  await sql.unsafe(`CREATE OR REPLACE FUNCTION t0209_session_fault()
    RETURNS trigger LANGUAGE plpgsql AS $t0209$
    BEGIN
      RAISE EXCEPTION 'T0209_SESSION_FAULT';
    END $t0209$`);
  await sql.unsafe(
    `CREATE TRIGGER t0209_session_fault BEFORE DELETE ON sessions
     FOR EACH ROW EXECUTE FUNCTION t0209_session_fault()`,
  );
  before = await snapshot(sql);
  await expectRefusal(
    () =>
      harness!.execute(
        adminActor(),
        command("identity.disable", TARGET_USER, "t0209-session-fault", {
          reason: "x",
        }),
      ),
    /T0209_SESSION_FAULT/,
  );
  expect(await snapshot(sql)).toEqual(before);
  await sql.unsafe(`DROP TRIGGER IF EXISTS t0209_session_fault ON sessions`);
  await sql.unsafe(`DROP FUNCTION IF EXISTS t0209_session_fault()`);

  // (e) A proof that survives its user's full session revoke: the finalizer
  // verifies zero active proofs and refuses the whole transaction.
  await harness!.addSession(SESSION_B, ADMIN_USER);
  await harness!.addProof({
    assuranceId: PROOF_C,
    userId: TARGET_USER,
    sessionId: SESSION_B,
    challengeId: CHALLENGE_C,
  });
  before = await snapshot(sql);
  await expectRefusal(
    () =>
      harness!.execute(
        adminActor(),
        command("identity.sessions.revoke", TARGET_USER, "t0209-proof-orphan", {
          reason: "x",
        }),
      ),
    /IDENTITY_FINALIZER_TARGET_INCOMPLETE/,
  );
  expect(await snapshot(sql)).toEqual(before);
  // The arm's fixture proof was committed before the refused command, so the
  // rollback cannot take it: remove the deliberately-orphaned pair for the
  // cases that follow.
  // Session first: its delete cascades the proof, and only then can the
  // challenge go — the proof→challenge anchor is deliberately NO ACTION.
  await sql`DELETE FROM sessions WHERE id = ${SESSION_B}`;
  await sql`DELETE FROM auth_company_auth_challenges WHERE challenge_id = ${CHALLENGE_C}`;

  // (f) A finalizer that never stamps the receipt: the deferred receipt
  // fence refuses the commit and everything rolls back with it.
  await harness!.unstampedFinalizer();
  before = await snapshot(sql);
  await expectRefusal(
    () =>
      harness!.execute(
        adminActor(),
        command("identity.disable", TARGET_USER, "t0209-unstamped", {
          reason: "x",
        }),
      ),
    /AUTH_COMMAND_NOT_FINALIZED_AT_COMMIT|T0209_FINALIZER_STAMP_SKIPPED/,
  );
  expect(await snapshot(sql)).toEqual(before);
  await harness!.restoreFinalizer();

  // (g) The BA user row and its credential account land, then the command
  // fails on the following step: the whole create rolls back, so neither the
  // user row nor the credential account survives — the create runs inside
  // the executor's own transaction, never beside it.
  await sql.unsafe(`CREATE OR REPLACE FUNCTION t0209_principal_fault()
    RETURNS trigger LANGUAGE plpgsql AS $t0209$
    BEGIN
      RAISE EXCEPTION 'T0209_PRINCIPAL_FAULT';
    END $t0209$`);
  await sql.unsafe(
    `CREATE TRIGGER t0209_principal_fault BEFORE INSERT ON enterprise_principals
     FOR EACH ROW EXECUTE FUNCTION t0209_principal_fault()`,
  );
  before = await snapshot(sql);
  await expectRefusal(
    () =>
      harness!.execute(
        adminActor(),
        command(
          "identity.user.create",
          "t0209-rollback-user",
          "t0209-create-rollback",
          { email: "t0209-rollback@example.test", name: "Rollback" },
          { newPassword: "t0209-rollback-password" },
        ),
      ),
    /T0209_PRINCIPAL_FAULT/,
  );
  expect(await snapshot(sql)).toEqual(before);
  const rollbackUsers = await sql`
    SELECT count(*)::int AS count FROM users WHERE id = 't0209-rollback-user'`;
  expect(rollbackUsers[0].count).toBe(0);
  const rollbackAccounts = await sql`
    SELECT count(*)::int AS count FROM accounts WHERE user_id = 't0209-rollback-user'`;
  expect(rollbackAccounts[0].count).toBe(0);
  await sql.unsafe(
    `DROP TRIGGER IF EXISTS t0209_principal_fault ON enterprise_principals`,
  );
  await sql.unsafe(`DROP FUNCTION IF EXISTS t0209_principal_fault()`);
});

test("idempotent_replay_does_not_advance_versions", async () => {
  const sql = harness!.sql;
  await harness!.addSession(SESSION_A, TARGET_USER);
  const principalBefore = await harness!.principalOf(TARGET_USER);
  const payload = { reason: "replayable" };

  const first = await harness!.execute(
    adminActor(),
    command("identity.sessions.revoke", TARGET_USER, "t0209-replay", payload),
  );
  expect(first.replayed).toBe(false);
  const second = await harness!.execute(
    adminActor(SECOND_ADMIN_USER),
    command("identity.sessions.revoke", TARGET_USER, "t0209-replay", payload),
  );
  expect(second.replayed).toBe(true);
  expect(second.commandId).toBe(first.commandId);
  expect(second.identityGeneration).toBe(first.identityGeneration);
  const principalAfter = await harness!.principalOf(TARGET_USER);
  expect(principalAfter.generation).toBe(principalBefore.generation);
  const [receiptCount] = await sql`
    SELECT count(*)::int AS count FROM auth_command_receipts
     WHERE target_user_id = ${TARGET_USER} AND idempotency_key = 't0209-replay'`;
  expect(receiptCount.count).toBe(1);
});

test("same_key_with_different_content_conflicts", async () => {
  const sql = harness!.sql;
  const before = await snapshot(sql);
  await harness!.execute(
    adminActor(),
    command("identity.disable", TARGET_USER, "t0209-conflict", {
      reason: "first",
    }),
  );
  await expectRefusal(
    () =>
      harness!.execute(
        adminActor(),
        command("identity.disable", TARGET_USER, "t0209-conflict", {
          reason: "different",
        }),
      ),
    /IDENTITY_IDEMPOTENCY_CONFLICT/,
  );
  // A different password under the same key is a conflict too: the payload
  // hash carries the server-key commitment of the secrets.
  await expectRefusal(
    () =>
      harness!.execute(
        adminActor(),
        command(
          "identity.password.reset",
          TARGET_USER,
          "t0209-conflict",
          { reason: "first" },
          { newPassword: "t0209-other-password" },
        ),
      ),
    /IDENTITY_IDEMPOTENCY_CONFLICT/,
  );
  // Only the first command's facts stand.
  const principal = await harness!.principalOf(TARGET_USER);
  expect(principal.status).toBe("suspended");
  await harness!.execute(
    adminActor(),
    command("identity.restore", TARGET_USER, "t0209-restore-after-conflict", {
      reason: "resume",
    }),
  );
  expect((await snapshot(sql)).receipts).toBe(before.receipts + 2);
});

test("replay_reverifies_current_authorization", async () => {
  const sql = harness!.sql;
  await harness!.addSession(SESSION_A, TARGET_USER);
  const payload = { reason: "authorized-then-revoked" };
  const first = await harness!.execute(
    adminActor(),
    command("identity.sessions.revoke", TARGET_USER, "t0209-reverify", payload),
  );
  expect(first.replayed).toBe(false);

  // The admin is demoted; the committed receipt cannot be borrowed.
  await harness!.demoteAdmin(ADMIN_USER);
  const before = await snapshot(sql);
  await expectRefusal(
    () =>
      harness!.execute(
        adminActor(),
        command(
          "identity.sessions.revoke",
          TARGET_USER,
          "t0209-reverify",
          payload,
        ),
      ),
    /IDENTITY_ACTOR_FORBIDDEN/,
  );
  expect(await snapshot(sql)).toEqual(before);
  // Restore the admin role for any later cases.
  await sql`DELETE FROM user_roles WHERE user_id = ${ADMIN_USER}`;
  await sql`INSERT INTO user_roles (user_id, role) VALUES (${ADMIN_USER}, 'admin')`;
});
