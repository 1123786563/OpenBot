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
  type AssuranceRef,
  COMPANY_ASSURANCE_TARGET_REQUIRED,
  type CompanyAssurance,
  CompanyAssuranceRefusal,
  createCompanyAssurance,
} from "../../src/auth/company-assurance";
import { createDirectoryAuthority } from "../../src/auth/directory/authority";
import type { DirectoryActor } from "../../src/auth/directory/contracts";
import { createDatabase } from "../../src/db/client";

/*
 * T05.04 (#560, original task P11) — the real-time read half of the company
 * proof (design §9.1 step 5, interfaces §5): `require` inside a data-role
 * business transaction.
 *
 * What this file pins, and why each part is a database fact rather than a
 * code convention:
 *
 * - `linked_b_idp_does_not_authorize_password_session_for_b`: a linked
 *   (issuer, subject) account row authorizes NOTHING. Only a proof a VERIFIED
 *   callback earned — written by the real 0219 controlled function — answers
 *   the gate, and it answers it for the session it is bound to.
 * - `require_accepts_completed_proof_and_pins_versions`: a completed proof
 *   passes `require` on the data-role transaction and the returned
 *   AssuranceRef is the STORED proof's identity, versions and expiry — never
 *   a recomputation from the current clock.
 * - `session_refresh_never_extends_original_authentication_age`: extending
 *   the session row's expiry (the BA refresh) leaves the proof's stored
 *   expiry byte-identical; the authentication-age cap was judged at
 *   completion and never re-derived at read time.
 * - Policy revision change, identity/company generation drift, an aged-out
 *   proof, a rotated-away session and a revoked (deleted) session each close
 *   the gate with the one controlled 403, compared live inside the
 *   transaction that asked.
 * - A company with no stored policy row answers null — the ONLY null answer.
 *
 * The proofs are minted through the production `complete` (stub evidence
 * bridge over a really-issued, really-consumed 0218 challenge row), so every
 * proof this suite reads back was written by the 0219 controlled function
 * under the tenant lock. `require` runs on a real transaction of the
 * ob_ent_data capability connection — the data-role readable facts of the
 * interfaces §5 contract (auth_read_company_auth_policy after 0220,
 * auth_read_session_assurances, enterprise_principals' identity generation,
 * auth_read_eligibility_clocks' company generation).
 *
 * The suite applies the verified chain (0209–0214) plus 0218, 0219 and the
 * 0220 data-role policy-read grant on the isolated BA_TEST_* database and
 * removes exactly what it added. The five BA_TEST_* role URLs are all
 * required; a missing one is a blocked suite, never a fallback. No DSN is
 * ever printed.
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
/**
 * The verified chain the proof rides on, plus this task's two own
 * migrations: 0218 (challenge issuance), 0219 (completion + policy read) and
 * 0220 (the data role's EXECUTE on the policy read — the read gate's grant).
 */
const MIGRATION_TAGS = [
  "0221_better_auth_directory",
  "0222_better_auth_clocks",
  "0223_better_auth_command_authority",
  "0224_better_auth_authority_sources",
  "0225_better_auth_assurance",
  "0226_better_auth_schema_roles",
  "0230_better_auth_company_auth_challenge",
  "0231_better_auth_company_auth_complete",
  "0232_better_auth_company_auth_policy_read",
] as const;
const POLICY_READ_SIGNATURE = "auth_read_company_auth_policy(text)";

/** The BA tables this suite's chain creates (schema-roles' list). */
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
  "auth_company_auth_policies",
] as const;
/** The chain's controlled functions (0214's set), dropped at cleanup. */
const CHAIN_FUNCTIONS = [
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
/** 0219's own controlled functions, dropped with the chain's set. */
const COMPLETE_FUNCTIONS = [
  `${POLICY_READ_SIGNATURE}`,
  "auth_consume_company_auth_challenge(text)",
  "auth_record_company_session_assurance(text,text,text,text,text,timestamp with time zone,text)",
] as const;
const ISSUE_FUNCTION =
  "auth_issue_company_auth_challenge(text,text,text,text,text,text,bigint,text,text,text,timestamptz)";
const CHAIN_TRIGGERS = [
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

const TENANT = "t0504-tenant";
const OTHER_TENANT = "t0504-tenant-no-policy";
const USER = "t0504-user";
const PRINCIPAL = "t0504-principal";
const FINAL_SESSION = "t0504-session-final";
const PASSWORD_SESSION = "t0504-session-password";
const SHORT_SESSION = "t0504-session-short";
const RETURN_PATH = "/enterprise/team";
const PROVIDER = "t0504-idp";
const ISSUER = "https://idp.t0504.example.test";
const SUBJECT = "t0504-subject";
const POLICY_REVISION = 7;
const NEXT_POLICY_REVISION = 8;
const IDENTITY_GENERATION = 5;
const NEXT_IDENTITY_GENERATION = 6;
const COMPANY_GENERATION = 3;
const NEXT_COMPANY_GENERATION = 4;
const MAX_AUTH_AGE_SECONDS = 900;
/** A test-only AES-GCM key for the envelope (32 bytes, base64). Never a deployment's. */
const ENCRYPTION_KEY = Buffer.from(new Uint8Array(32).fill(0x61)).toString(
  "base64",
);
const STRENGTH = "urn:mace:incommon:iap:silver";

/** The session-bound actor the interactive halves and the read gate carry. */
function sessionActor(sessionId: string): DirectoryActor {
  return Object.freeze({
    userId: USER,
    principalId: null,
    sessionId,
    kind: "session",
    bindingId: null,
    provisioning: null,
  });
}

/** The platform actor the workspace gate and the BA resolver mint (T03.01). */
const PLATFORM_ACTOR: DirectoryActor = Object.freeze({
  userId: USER,
  principalId: null,
  sessionId: null,
  kind: "platform",
  bindingId: null,
  provisioning: null,
});

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
        `${variable} is required: the assurance suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
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

/** Read lazily, so a missing migration fails the named target behavior. */
function loadMigrationSql(tag: string): string {
  const path = join(import.meta.dirname, `../../drizzle/${tag}.sql`);
  if (!existsSync(path)) {
    throw new Error(
      `${tag}.sql does not exist: the controlled surface it opens is the T05.04 target behavior, not an environment problem.`,
    );
  }
  return readFileSync(path, "utf8");
}

interface Harness {
  /** Setup connection: DDL, seeds, read-back probes. */
  sql: postgres.Sql;
  /** The production client on the auth-writer capability connection. */
  writer: ReturnType<typeof createDatabase>;
  /** The production client on the data capability connection — require's role. */
  data: ReturnType<typeof createDatabase>;
  close(): Promise<void>;
}

let harnessState: Harness | undefined;

/**
 * Returns the island to the pre-T05.04 shape: this task's 0220 grant
 * revoked, the 0218/0219 functions, the policy table and the chain
 * tables/triggers/functions gone, this suite's seeded rows gone. Every
 * statement is a no-op on a pristine baseline, so it also recovers a crashed
 * earlier run. The cluster-wide capability roles stay (the standing shape
 * the sibling roles follow; the environment's provisioning owns them).
 */
async function cleanupFixture(sql: postgres.Sql): Promise<void> {
  // This task's own grant, revoked back: a no-op on a pristine baseline
  // (the function itself may not exist yet), hence the caught error.
  await sql
    .unsafe(
      `REVOKE EXECUTE ON FUNCTION public.${POLICY_READ_SIGNATURE} FROM ob_ent_data`,
    )
    .catch(() => {});
  for (const signature of COMPLETE_FUNCTIONS) {
    await sql.unsafe(`DROP FUNCTION IF EXISTS public.${signature} CASCADE`);
  }
  await sql.unsafe(`DROP FUNCTION IF EXISTS public.${ISSUE_FUNCTION} CASCADE`);
  const triggerPairs = CHAIN_TRIGGERS.map(
    ([table, trigger]) => `('${table}', '${trigger}')`,
  ).join(", ");
  const functions = [...CHAIN_FUNCTIONS].map((signature) => `('${signature}')`);
  for (const signature of COMPLETE_FUNCTIONS) {
    functions.push(`('${signature}')`);
  }
  const tables = BA_TABLES.map((name) => `('${name}')`).join(", ");
  await sql.unsafe(`
    DO $t0504_cleanup$
      DECLARE
        target record;
      BEGIN
        FOR target IN SELECT * FROM (VALUES ${triggerPairs}) AS triggers(table_name, trigger_name) LOOP
          IF to_regclass('public.' || target.table_name) IS NOT NULL THEN
            EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', target.trigger_name, target.table_name);
          END IF;
        END LOOP;
        FOR target IN SELECT * FROM (VALUES ${functions.join(", ")}) AS functions(signature) LOOP
          EXECUTE format('DROP FUNCTION IF EXISTS public.%s', target.signature);
        END LOOP;
        FOR target IN SELECT * FROM (VALUES ${tables}) AS tables(table_name) LOOP
          IF to_regclass('public.' || target.table_name) IS NOT NULL THEN
            EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator, ob_ent_auth_writer', target.table_name);
          END IF;
        END LOOP;
      END
    $t0504_cleanup$`);
  await sql.unsafe(
    `DROP TABLE IF EXISTS ${BA_TABLES.map((name) => `"${name}"`).join(", ")} CASCADE`,
  );
  // 0210/0212 ALTER existing enterprise tables; normalize exactly as the
  // schema-roles suite does, so the island's post-suite shape is identical
  // from any starting state.
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
  await sql`DELETE FROM accounts WHERE user_id LIKE 't0504-%'`.catch(() => {});
  await sql`DELETE FROM auth_members WHERE id LIKE 't0504-%'`.catch(() => {});
  await sql`DELETE FROM enterprise_principals WHERE user_id LIKE 't0504-%'`.catch(
    () => {},
  );
  await sql`DELETE FROM auth_eligibility_clocks WHERE tenant_id LIKE 't0504-%'`.catch(
    () => {},
  );
  await sql`DELETE FROM sessions WHERE id LIKE 't0504-%'`;
  await sql`DELETE FROM users WHERE id LIKE 't0504-%'`;
  await sql`DELETE FROM enterprise_tenants WHERE id LIKE 't0504-%'`;
}

/**
 * Two companies (the policy holder and one without any policy row), the
 * member user with the rotation-final, ordinary password and short-lived
 * sessions, the identity binding (issuer, subject) → USER in accounts (the
 * linked-IdP fact that must authorize nothing by itself), the issuance
 * generations on the principal and the company eligibility clock, and the
 * stored 0219 policy row. The directory tables' DML guard is suspended for
 * exactly the org/member inserts (the sibling suites'
 * withGuardsDisabled pattern) and re-enabled before any flow runs.
 */
async function seedBaselineFixture(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO enterprise_tenants (id, name) VALUES
      (${TENANT}, 'T05.04 company'),
      (${OTHER_TENANT}, 'T05.04 company without a policy')`;
  await sql`
    INSERT INTO users (id, email) VALUES
      (${USER}, 't0504-user@example.test')`;
  await sql`
    INSERT INTO sessions (id, user_id, token, expires_at) VALUES
      (${FINAL_SESSION}, ${USER}, 't0504-token-final', now() + interval '3 hours'),
      (${PASSWORD_SESSION}, ${USER}, 't0504-token-password', now() + interval '2 hours'),
      (${SHORT_SESSION}, ${USER}, 't0504-token-short', now() + interval '5 minutes')`;
  await sql`
    INSERT INTO accounts (id, account_id, provider_id, user_id, issuer)
    VALUES ('t0504-account', ${SUBJECT}, ${PROVIDER}, ${USER}, ${ISSUER})`;
  await sql`
    INSERT INTO enterprise_principals (id, user_id, identity_generation)
    VALUES (${PRINCIPAL}, ${USER}, ${IDENTITY_GENERATION})`;
  await sql`
    INSERT INTO auth_eligibility_clocks
      (tenant_id, principal_id, kind, scope_id, epoch, generation, tombstone, last_command_id)
    VALUES (${TENANT}, ${PRINCIPAL}, 'company', ${TENANT}, 1, ${COMPANY_GENERATION}, false, 't0504-seed')`;
  await sql`
    INSERT INTO auth_company_auth_policies
      (tenant_id, provider_id, protocol, policy_revision, max_auth_age_seconds)
    VALUES (${TENANT}, ${PROVIDER}, 'oidc', ${POLICY_REVISION}, ${MAX_AUTH_AGE_SECONDS})`;
  for (const [table, trigger] of [
    ["auth_organizations", "auth_directory_dml_guard"],
    ["auth_members", "auth_directory_dml_guard"],
  ] as const) {
    await sql.unsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
  }
  try {
    await sql`
      INSERT INTO auth_organizations (id, name, slug) VALUES
        (${TENANT}, 'T05.04 company', 't0504-org'),
        (${OTHER_TENANT}, 'T05.04 company without policy', 't0504-org-other')`;
    await sql`
      INSERT INTO auth_members (id, organization_id, user_id, role) VALUES
        ('t0504-member', ${TENANT}, ${USER}, 'member')`;
  } finally {
    for (const [table, trigger] of [
      ["auth_organizations", "auth_directory_dml_guard"],
      ["auth_members", "auth_directory_dml_guard"],
    ] as const) {
      await sql
        .unsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`)
        .catch(() => {});
    }
  }
}

/** One migration-state fact: the singleton row as the scenario needs it. */
async function setAuthority(
  sql: postgres.Sql,
  row: { version: number; phase: string; directoryAuthority: string },
): Promise<void> {
  await sql`
    UPDATE auth_authority_states
       SET authority_version = ${row.version},
           phase = ${row.phase},
           directory_authority = ${row.directoryAuthority},
           multi_tenant_released = ${row.directoryAuthority === "ba"},
           updated_at = now()
     WHERE id = 1`;
}

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
    await seedBaselineFixture(sql);
    await setAuthority(sql, {
      version: 121,
      phase: "M4",
      directoryAuthority: "ba",
    });
    const writer = createDatabase(
      process.env.BA_TEST_AUTH_WRITER_DATABASE_URL!.trim(),
      { max: 2 },
    );
    const data = createDatabase(process.env.BA_TEST_DATA_DATABASE_URL!.trim(), {
      max: 2,
    });
    return {
      sql,
      writer,
      data,
      close: async () => {
        try {
          await cleanupFixture(sql);
        } finally {
          await writer.$client.close?.();
          await data.$client.close?.();
          await sql.end({ timeout: 5 }).catch(() => {});
        }
      },
    };
  } catch (error) {
    await cleanupFixture(sql).catch(() => {});
    await sql.end({ timeout: 5 }).catch(() => {});
    throw error;
  }
}

function harness(): Harness {
  if (!harnessState) throw new Error("assurance harness is not initialized");
  return harnessState;
}

/**
 * The stub evidence bridge: `complete` asks it to verify a callback and it
 * hands back the evidence the test pinned — the challenge a real issuance
 * created and a chosen signed authentication time. Everything else the 0219
 * completion re-verifies stays real.
 */
function stubEvidenceBridge() {
  let next: { challengeId: string; authenticatedAt: Date } | null = null;
  return {
    evidence: {
      async verify() {
        const current = next;
        if (!current) {
          throw new Error(
            "stub bridge asked to verify with no evidence pinned",
          );
        }
        return {
          challengeId: current.challengeId,
          providerId: PROVIDER,
          protocol: "oidc",
          issuer: ISSUER,
          subject: SUBJECT,
          authenticatedAt: current.authenticatedAt,
          strength: STRENGTH,
          protocolRequestId: current.challengeId,
        };
      },
    },
    setEvidence(value: { challengeId: string; authenticatedAt: Date }) {
      next = value;
    },
  };
}

/** The live factory against the real writer connection and authority. */
function liveAssurance() {
  const bridge = stubEvidenceBridge();
  const assurance = createCompanyAssurance({
    policy: {
      async requiresProof(tenantId: string) {
        return tenantId === TENANT;
      },
    },
    challengePolicy: {
      async challengePolicy(tenantId: string) {
        return tenantId === TENANT
          ? {
              providerId: PROVIDER,
              protocol: "oidc",
              policyRevision: POLICY_REVISION,
            }
          : null;
      },
    },
    redirect: {
      async buildRedirect(request) {
        const url = new URL("https://idp.t0504.example.test/authorize");
        url.searchParams.set("state", request.state);
        return url.toString();
      },
    },
    database: harness().writer,
    authority: createDirectoryAuthority(),
    encryptionKey: ENCRYPTION_KEY,
    evidence: bridge.evidence,
  });
  return { assurance, setEvidence: bridge.setEvidence };
}

/**
 * Mints one real proof for `actor`'s session: the 0218 issuance, the
 * bridge-side one-time consumption (the setup connection marks the row — the
 * stub bridge stands where the OIDC verifier consumes by state digest), and
 * the 0219 completion under the tenant lock.
 */
async function mintProof(
  assurance: CompanyAssurance,
  setEvidence: (value: { challengeId: string; authenticatedAt: Date }) => void,
  actor: DirectoryActor,
  authenticatedAt: Date,
): Promise<{ sessionId: string; tenantId: string }> {
  const issued = await assurance.challenge(actor, {
    tenantId: TENANT,
    returnPath: RETURN_PATH,
  });
  await harness().sql`
    UPDATE auth_company_auth_challenges SET consumed_at = now()
     WHERE challenge_id = ${issued.challengeId}`;
  setEvidence({
    challengeId: issued.challengeId,
    authenticatedAt,
  });
  return assurance.complete(
    new Request(
      "https://app.t0504.example.test/api/enterprise/company-auth/oidc/callback/x",
    ),
  );
}

/** `require` inside one real transaction of the data capability connection. */
async function requireAs(
  assurance: CompanyAssurance,
  actor: DirectoryActor,
  tenantId: string,
): Promise<AssuranceRef | null> {
  return harness().data.transaction((tx) =>
    assurance.require(tx, actor, tenantId),
  );
}

async function refusalOf(
  work: () => Promise<unknown>,
): Promise<{ status: number; code: string }> {
  try {
    await work();
  } catch (error) {
    if (error instanceof CompanyAssuranceRefusal) {
      return { status: error.status, code: error.code };
    }
    throw error;
  }
  throw new Error(
    "expected a company-assurance refusal, but the operation succeeded",
  );
}

/** Empty the challenge/proof tables: each scenario counts whole-table rows. */
async function resetFlowState(): Promise<void> {
  await harness().sql`DELETE FROM auth_company_session_assurances`;
  await harness().sql`DELETE FROM auth_company_auth_challenges`;
  // The drift scenarios mutate the policy, the generations and the session
  // expiry; every minting scenario starts from the seeded facts again.
  await harness().sql`
    UPDATE auth_company_auth_policies
       SET policy_revision = ${POLICY_REVISION}, updated_at = now()
     WHERE tenant_id = ${TENANT}`;
  await harness().sql`
    UPDATE enterprise_principals
       SET identity_generation = ${IDENTITY_GENERATION}
     WHERE id = ${PRINCIPAL}`;
  await harness().sql`
    UPDATE auth_eligibility_clocks
       SET generation = ${COMPANY_GENERATION}
     WHERE tenant_id = ${TENANT} AND principal_id = ${PRINCIPAL}
       AND kind = 'company'`;
  await harness().sql`
    UPDATE sessions SET expires_at = now() + interval '5 minutes'
     WHERE id = ${SHORT_SESSION}`;
  // The revoke scenario deletes the final session (and its proof with it);
  // a later mint needs the session row back, live again.
  await harness().sql`
    INSERT INTO sessions (id, user_id, token, expires_at) VALUES
      (${FINAL_SESSION}, ${USER}, 't0504-token-final', now() + interval '3 hours')
    ON CONFLICT (id) DO UPDATE SET expires_at = excluded.expires_at`;
}

/** The stored proof rows, read back on the setup connection. */
async function storedProofs(): Promise<
  {
    assurance_id: string;
    session_id: string;
    expires_at: Date;
    policy_revision: number;
    identity_generation: number;
    company_generation: number;
  }[]
> {
  const rows = await harness().sql`
    SELECT assurance_id, session_id, expires_at, policy_revision,
           identity_generation, company_generation
      FROM auth_company_session_assurances ORDER BY created_at`;
  return rows.map((row) => ({
    ...row,
    policy_revision: Number(row.policy_revision),
    identity_generation: Number(row.identity_generation),
    company_generation: Number(row.company_generation),
  }));
}

/** 120 seconds ago, the signed auth_time a fresh proof carries. */
function authTimeNow(): Date {
  return new Date(Date.now() - 120_000);
}

describe("T05.04 company assurance read gate (#560)", () => {
  beforeAll(async () => {
    harnessState = await createHarness();
  }, 120_000);

  afterAll(async () => {
    await harnessState?.close();
  }, 60_000);

  test("no_policy_company_answers_null", async () => {
    await resetFlowState();
    const { assurance } = liveAssurance();
    await expect(
      requireAs(assurance, PLATFORM_ACTOR, OTHER_TENANT),
    ).resolves.toBeNull();
    // A proof-less question about no company is still not "no proof needed".
    const nameless = await refusalOf(() =>
      requireAs(assurance, PLATFORM_ACTOR, "   "),
    );
    expect(nameless).toEqual({
      status: 403,
      code: COMPANY_ASSURANCE_TARGET_REQUIRED,
    });
  });

  test("linked_b_idp_does_not_authorize_password_session_for_b", async () => {
    await resetFlowState();
    const { assurance } = liveAssurance();
    // The linked (issuer, subject) account exists, the session is live — and
    // none of it is a proof: the read gate answers the one 403.
    const refusal = await refusalOf(() =>
      requireAs(assurance, sessionActor(PASSWORD_SESSION), TENANT),
    );
    expect(refusal.status).toBe(403);
    expect(refusal.code).toBe("COMPANY_REAUTH_REQUIRED");
    expect(await storedProofs()).toHaveLength(0);
  });

  test("require_accepts_completed_proof_and_pins_versions", async () => {
    const { assurance: live, setEvidence } = liveAssurance();
    await resetFlowState();
    const completed = await mintProof(
      live,
      setEvidence,
      sessionActor(FINAL_SESSION),
      authTimeNow(),
    );
    expect(completed.sessionId).toBe(FINAL_SESSION);
    expect(completed.tenantId).toBe(TENANT);

    const ref = await requireAs(live, sessionActor(FINAL_SESSION), TENANT);
    const [proof] = await storedProofs();
    expect(proof).toBeDefined();
    // The ref IS the stored proof — identity, versions and the stored expiry,
    // never a recomputation from the read clock.
    expect(ref).toEqual({
      assuranceId: proof!.assurance_id,
      sessionId: FINAL_SESSION,
      tenantId: TENANT,
      policyRevision: POLICY_REVISION,
      identityGeneration: IDENTITY_GENERATION,
      companyGeneration: COMPANY_GENERATION,
      expiresAt: proof!.expires_at.toISOString(),
    });
    // The linked IdP alone still authorizes nothing: the OTHER session of
    // the same user stays behind the gate (the proof binds one session).
    const otherSession = await refusalOf(() =>
      requireAs(live, sessionActor(PASSWORD_SESSION), TENANT),
    );
    expect(otherSession).toEqual({
      status: 403,
      code: "COMPANY_REAUTH_REQUIRED",
    });
  });

  test("session_refresh_never_extends_original_authentication_age", async () => {
    const { assurance: live, setEvidence } = liveAssurance();
    await resetFlowState();
    // The session (5 minutes) is the binding expiry: auth+900s is later, so
    // 0219 stores the SESSION expiry as the proof's.
    await mintProof(
      live,
      setEvidence,
      sessionActor(SHORT_SESSION),
      authTimeNow(),
    );
    const [proof] = await storedProofs();
    expect(proof).toBeDefined();

    const before = await requireAs(live, sessionActor(SHORT_SESSION), TENANT);
    expect(before).not.toBeNull();
    const expiresAtBefore = before!.expiresAt;

    // The refresh: the session row lives two more hours…
    await harness().sql`
      UPDATE sessions SET expires_at = now() + interval '2 hours'
       WHERE id = ${SHORT_SESSION}`;
    const [session] = await harness().sql<{ expires_at: Date }[]>`
      SELECT expires_at FROM sessions WHERE id = ${SHORT_SESSION}`;

    // …and the proof's expiry does not move: the authentication-age cap was
    // judged at completion against the THEN-session, never re-derived.
    const after = await requireAs(live, sessionActor(SHORT_SESSION), TENANT);
    expect(after).not.toBeNull();
    const expiresAtAfter = after!.expiresAt;
    expect(expiresAtAfter).toBe(expiresAtBefore);
    expect(new Date(expiresAtAfter).getTime()).toBeLessThan(
      session!.expires_at.getTime(),
    );
  });

  test("policy_revision_change_requires_reauth", async () => {
    const { assurance: live, setEvidence } = liveAssurance();
    await resetFlowState();
    await mintProof(
      live,
      setEvidence,
      sessionActor(FINAL_SESSION),
      authTimeNow(),
    );
    await expect(
      requireAs(live, sessionActor(FINAL_SESSION), TENANT),
    ).resolves.not.toBeNull();

    await harness().sql`
      UPDATE auth_company_auth_policies
         SET policy_revision = ${NEXT_POLICY_REVISION}, updated_at = now()
       WHERE tenant_id = ${TENANT}`;
    await expect(
      refusalOf(() => requireAs(live, sessionActor(FINAL_SESSION), TENANT)),
    ).resolves.toEqual({ status: 403, code: "COMPANY_REAUTH_REQUIRED" });
  });

  test("identity_or_company_generation_drift_requires_reauth", async () => {
    const { assurance: live, setEvidence } = liveAssurance();
    await resetFlowState();
    await mintProof(
      live,
      setEvidence,
      sessionActor(FINAL_SESSION),
      authTimeNow(),
    );

    await harness().sql`
      UPDATE enterprise_principals
         SET identity_generation = ${NEXT_IDENTITY_GENERATION}
       WHERE id = ${PRINCIPAL}`;
    await expect(
      refusalOf(() => requireAs(live, sessionActor(FINAL_SESSION), TENANT)),
    ).resolves.toEqual({ status: 403, code: "COMPANY_REAUTH_REQUIRED" });

    await harness().sql`
      UPDATE enterprise_principals
         SET identity_generation = ${IDENTITY_GENERATION}
       WHERE id = ${PRINCIPAL}`;
    await harness().sql`
      UPDATE auth_eligibility_clocks
         SET generation = ${NEXT_COMPANY_GENERATION}
       WHERE tenant_id = ${TENANT} AND principal_id = ${PRINCIPAL}
         AND kind = 'company'`;
    await expect(
      refusalOf(() => requireAs(live, sessionActor(FINAL_SESSION), TENANT)),
    ).resolves.toEqual({ status: 403, code: "COMPANY_REAUTH_REQUIRED" });
  });

  test("aged_out_proof_never_authorizes", async () => {
    const { assurance: live, setEvidence } = liveAssurance();
    await resetFlowState();
    // A proof whose signed authentication is already past the policy's max
    // age: 0219 stores auth+maxAge (in the past) and require refuses it.
    await mintProof(
      live,
      setEvidence,
      sessionActor(FINAL_SESSION),
      new Date(Date.now() - (MAX_AUTH_AGE_SECONDS + 300) * 1000),
    );
    const [proof] = await storedProofs();
    expect(proof!.expires_at.getTime()).toBeLessThan(Date.now());
    await expect(
      refusalOf(() => requireAs(live, sessionActor(FINAL_SESSION), TENANT)),
    ).resolves.toEqual({ status: 403, code: "COMPANY_REAUTH_REQUIRED" });
  });

  test("session_revoke_deletes_proof_and_closes_gate", async () => {
    const { assurance: live, setEvidence } = liveAssurance();
    await resetFlowState();
    await mintProof(
      live,
      setEvidence,
      sessionActor(FINAL_SESSION),
      authTimeNow(),
    );
    await expect(
      requireAs(live, sessionActor(FINAL_SESSION), TENANT),
    ).resolves.not.toBeNull();

    // Deleting the session row cascades its proofs: nothing remains to
    // answer with, and no config-free exception lets the read through.
    await harness().sql`DELETE FROM sessions WHERE id = ${FINAL_SESSION}`;
    expect(await storedProofs()).toHaveLength(0);
    await expect(
      refusalOf(() => requireAs(live, sessionActor(FINAL_SESSION), TENANT)),
    ).resolves.toEqual({ status: 403, code: "COMPANY_REAUTH_REQUIRED" });
  });

  test("platform_actor_reads_the_users_active_proof", async () => {
    const { assurance: live, setEvidence } = liveAssurance();
    await resetFlowState();
    await mintProof(
      live,
      setEvidence,
      sessionActor(FINAL_SESSION),
      authTimeNow(),
    );
    // The workspace gate's platform actor (no session id of its own, T03.01)
    // reads the user's active proof — the disclosed boundary until P05's
    // private sessionId/assuranceId association widens the gate's actor.
    const ref = await requireAs(live, PLATFORM_ACTOR, TENANT);
    expect(ref?.sessionId).toBe(FINAL_SESSION);
  });
});
