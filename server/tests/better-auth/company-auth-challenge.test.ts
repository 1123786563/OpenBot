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
  COMPANY_ASSURANCE_TARGET_REQUIRED,
  COMPANY_AUTH_NOT_READY,
  COMPANY_AUTH_RETURN_PATH_INVALID,
  type CompanyAssurance,
  CompanyAssuranceRefusal,
  createCompanyAssurance,
  isChallengeCompletable,
} from "../../src/auth/company-assurance";
import { createCompanyAuthRoutes } from "../../src/auth/company-auth-routes";
import {
  AUTHORITY_VERSION_CONFLICT,
  createDirectoryAuthority,
  DIRECTORY_MIGRATION_PAUSED,
  DIRECTORY_WRITE_AUTHORITY_CLOSED,
} from "../../src/auth/directory/authority";
import type { DirectoryActor } from "../../src/auth/directory/contracts";
import { createDatabase } from "../../src/db/client";
import { decryptSecret } from "../../src/credentials";

/*
 * T05.01 (#557, original task P11) — the persisted one-time company-auth
 * challenge (design §9.1 step 2, interfaces §5; confirmed defect H2; the
 * write-path half the T02.05 storage pinned for this task).
 *
 * What this file pins, and why each part is a database fact or a real
 * refusal rather than a code convention:
 *
 * - `challenge_is_bound_to_original_session_and_company`: the issued row is
 *   read back on the setup connection and its binding tuple (original user,
 *   original session, target company, allowed provider, protocol and policy
 *   revision, site-local returnPath) equals what the gate pinned at issue
 *   time — `expect(storedBinding).toEqual(expectedBinding)` — and the
 *   correlation token exists only as its SHA-256 digest while the nonce /
 *   PKCE verifier / request id exist only inside the sealed envelope a
 *   database read cannot open without the deployment key.
 * - `challenge_expired_after_600_seconds`: the Global Constraints ceiling is
 *   a stored fact — the function refuses an expiry beyond 600 seconds with a
 *   named error, the row it does issue is completable at issue time and not
 *   completable once a fixed clock stands 601 seconds past issue
 *   (`expect(completable).toBe(false)`), and the database CHECK refuses a
 *   directly-inserted over-age row as well.
 * - The refusal matrix: an external returnPath, a protocol-relative one, a
 *   backslash and a percent-encoded bypass are 400s; an unknown company, a
 *   company without a challenge policy and a non-member all answer the one
 *   404 (no company-existence leak); a session that names another user and
 *   an expired session are 401s; a legacy or paused authority closes the
 *   write with the T02.10 codes; a deployment whose redirect builder answers
 *   null refuses 503 and persists NOTHING.
 * - The mounted route: POST /challenge unauthenticated is 401, a malformed
 *   body is 400, and the happy path answers the frozen DTO.
 *
 * The suite applies the verified BA chain (0209–0214) plus the 0218
 * challenge-issuance function on the isolated BA_TEST_* database and removes
 * exactly what it added. The five BA_TEST_* role URLs are all required; a
 * missing one is a blocked suite, never a fallback. No DSN is ever printed.
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
const MIGRATION_TAG = "0218_better_auth_company_auth_challenge";
const MIGRATION_PATH = join(
  import.meta.dirname,
  `../../drizzle/${MIGRATION_TAG}.sql`,
);
const ISSUE_FUNCTION =
  "auth_issue_company_auth_challenge(text,text,text,text,text,text,bigint,text,text,text,timestamptz)";
/**
 * The verified chain the challenge write rides on: the directory tables
 * (T02.01), the clocks (T02.02), the command model and authority (T02.03),
 * the authority sources (T02.04), the challenge/proof storage (T02.05) and
 * the capability roles (T02.06) — applied in journal order, removed again at
 * cleanup, exactly the discipline the sibling BA suites keep on this island.
 */
const PREREQUISITE_TAGS = [
  "0209_better_auth_directory",
  "0210_better_auth_clocks",
  "0211_better_auth_command_authority",
  "0212_better_auth_authority_sources",
  "0213_better_auth_assurance",
  "0214_better_auth_schema_roles",
] as const;

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

const TENANT = "t0501-tenant";
const TENANT_NO_POLICY = "t0501-tenant-no-policy";
const USER = "t0501-user";
const OUTSIDER = "t0501-outsider";
const SESSION = "t0501-session";
const OUTSIDER_SESSION = "t0501-session-outsider";
const EXPIRED_SESSION = "t0501-session-expired";
const RETURN_PATH = "/enterprise/team";
const PROVIDER = "t0501-idp";
const POLICY_REVISION = 7;
/** A test-only AES-GCM key for the envelope (32 bytes, base64). Never a deployment's. */
const ENCRYPTION_KEY = Buffer.from(new Uint8Array(32).fill(0x51)).toString(
  "base64",
);

const ACTOR: DirectoryActor = Object.freeze({
  userId: USER,
  principalId: null,
  sessionId: SESSION,
  kind: "session",
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
        `${variable} is required: the challenge suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
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

/** Read lazily, so a worktree without the migration still collects every case. */
function loadMigrationSql(): string {
  if (!existsSync(MIGRATION_PATH)) {
    throw new Error(
      `${MIGRATION_TAG}.sql does not exist: the controlled challenge-issuance function is the T05.01 target behavior, not an environment problem.`,
    );
  }
  return readFileSync(MIGRATION_PATH, "utf8");
}

interface Harness {
  /** Setup connection: DDL, seeds, read-back probes. */
  sql: postgres.Sql;
  /** The production client on the auth-writer capability connection. */
  writer: ReturnType<typeof createDatabase>;
  close(): Promise<void>;
}

let harnessState: Harness | undefined;

/**
 * Returns the island to the pre-T05.01 shape: the issuance function and the
 * chain tables/triggers/functions gone, this suite's seeded rows gone. Every
 * statement is a no-op on a pristine baseline, so it also recovers a crashed
 * earlier run. The cluster-wide ob_ent_auth_writer role stays (the standing
 * shape the sibling roles follow; the environment's provisioning owns it).
 */
async function cleanupFixture(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`DROP FUNCTION IF EXISTS public.${ISSUE_FUNCTION} CASCADE`);
  const triggerPairs = CHAIN_TRIGGERS.map(
    ([table, trigger]) => `('${table}', '${trigger}')`,
  ).join(", ");
  const functions = CHAIN_FUNCTIONS.map((signature) => `('${signature}')`).join(
    ", ",
  );
  const tables = BA_TABLES.map((name) => `('${name}')`).join(", ");
  await sql.unsafe(`
    DO $t0501_cleanup$
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
    $t0501_cleanup$`);
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
  await sql`DELETE FROM auth_members WHERE id LIKE 't0501-%'`.catch(() => {});
  await sql`DELETE FROM sessions WHERE id LIKE 't0501-%'`;
  await sql`DELETE FROM users WHERE id LIKE 't0501-%'`;
  await sql`DELETE FROM enterprise_tenants WHERE id LIKE 't0501-%'`;
}

/**
 * Two companies (one with a challenge policy, one without), the member user
 * with a live and an expired session, and an outsider with their own live
 * session. The BA directory rows (organization + member) are what the
 * issuance function verifies in the lock. The directory tables' DML guard
 * demands command context, which fixture seeding deliberately has none of —
 * the guard is suspended for exactly these inserts (the sibling suites'
 * withGuardsDisabled pattern) and re-enabled before any challenge flow runs.
 */
async function seedBaselineFixture(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO enterprise_tenants (id, name) VALUES
      (${TENANT}, 'T05.01 company'),
      (${TENANT_NO_POLICY}, 'T05.01 company without a challenge policy')`;
  await sql`
    INSERT INTO users (id, email) VALUES
      (${USER}, 't0501-user@example.test'),
      (${OUTSIDER}, 't0501-outsider@example.test')`;
  await sql`
    INSERT INTO sessions (id, user_id, token, expires_at) VALUES
      (${SESSION}, ${USER}, 't0501-token', now() + interval '2 hours'),
      (${OUTSIDER_SESSION}, ${OUTSIDER}, 't0501-token-outsider', now() + interval '2 hours'),
      (${EXPIRED_SESSION}, ${USER}, 't0501-token-expired', now() - interval '1 hour')`;
  for (const [table, trigger] of [
    ["auth_organizations", "auth_directory_dml_guard"],
    ["auth_members", "auth_directory_dml_guard"],
  ] as const) {
    await sql.unsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
  }
  try {
    await sql`
      INSERT INTO auth_organizations (id, name, slug) VALUES
        (${TENANT}, 'T05.01 company', 't0501-org'),
        (${TENANT_NO_POLICY}, 'T05.01 company without policy', 't0501-org-no-policy')`;
    await sql`
      INSERT INTO auth_members (id, organization_id, user_id, role) VALUES
        ('t0501-member', ${TENANT}, ${USER}, 'member')`;
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
    for (const tag of PREREQUISITE_TAGS) {
      const path = join(import.meta.dirname, `../../drizzle/${tag}.sql`);
      if (!existsSync(path)) {
        throw new Error(
          `${tag}.sql does not exist: the T05.01 issuance function sits on the verified T02.01–T02.06 stack, and a missing prerequisite is a workspace problem, not a target behavior.`,
        );
      }
      await sql.unsafe(readFileSync(path, "utf8"));
    }
    await sql.unsafe(loadMigrationSql());
    await seedBaselineFixture(sql);
    const writer = createDatabase(
      process.env.BA_TEST_AUTH_WRITER_DATABASE_URL!.trim(),
      { max: 2 },
    );
    return {
      sql,
      writer,
      close: async () => {
        try {
          await cleanupFixture(sql);
        } finally {
          await writer.$client.close?.();
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
  if (!harnessState) throw new Error("challenge harness is not initialized");
  return harnessState;
}

/** The live factory against the real writer connection and authority. */
function liveAssurance(options?: {
  challengePolicyTenant?: string | null;
  redirectUrl?: string | null;
  seenRedirectStates?: string[];
  clock?: () => Date;
}): CompanyAssurance {
  const policyTenant =
    options?.challengePolicyTenant === undefined
      ? TENANT
      : options.challengePolicyTenant;
  return createCompanyAssurance({
    policy: {
      async requiresProof(tenantId: string) {
        return tenantId === TENANT;
      },
    },
    challengePolicy: {
      async challengePolicy(tenantId: string) {
        if (tenantId !== policyTenant) return null;
        return {
          providerId: PROVIDER,
          protocol: "oidc",
          policyRevision: POLICY_REVISION,
        };
      },
    },
    redirect: {
      async buildRedirect(request) {
        options?.seenRedirectStates?.push(request.state);
        if (options?.redirectUrl === null) return null;
        const base =
          options?.redirectUrl ?? "https://idp.example.test/authorize";
        const url = new URL(base);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", "t0501-client");
        url.searchParams.set("state", request.state);
        url.searchParams.set("nonce", request.nonce);
        url.searchParams.set("code_challenge", request.codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        return url.toString();
      },
    },
    database: harness().writer,
    authority: createDirectoryAuthority(),
    encryptionKey: ENCRYPTION_KEY,
    ...(options?.clock ? { clock: options.clock } : {}),
  });
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

/** The stored challenge row, read back on the setup connection. */
/** Total persisted challenges (any user): the before/after persistence probe. */
async function countChallenges(): Promise<number> {
  const [row] = await harness().sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM auth_company_auth_challenges`;
  return Number(row?.count ?? 0);
}

async function storedChallenge(challengeId: string) {
  const [row] = await harness().sql<
    {
      challenge_id: string;
      user_id: string;
      session_id: string;
      tenant_id: string;
      provider_id: string;
      protocol: string;
      policy_revision: string | number;
      return_path: string;
      state_digest: string;
      secret_envelope: string;
      expires_at: Date;
      consumed_at: Date | null;
      created_at: Date;
    }[]
  >`SELECT challenge_id, user_id, session_id, tenant_id, provider_id, protocol,
           policy_revision, return_path, state_digest, secret_envelope,
           expires_at, consumed_at, created_at
      FROM auth_company_auth_challenges WHERE challenge_id = ${challengeId}`;
  return row;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Buffer.from(digest).toString("hex");
}

describe("T05.01 company auth challenge issuance (#557)", () => {
  beforeAll(async () => {
    harnessState = await createHarness();
  }, 120_000);

  test("challenge_is_bound_to_original_session_and_company", async () => {
    const { sql } = harness();
    await setAuthority(sql, {
      version: 41,
      phase: "M4",
      directoryAuthority: "ba",
    });
    const seenStates: string[] = [];
    const assurance = liveAssurance({ seenRedirectStates: seenStates });

    const issued = await assurance.challenge(ACTOR, {
      tenantId: TENANT,
      returnPath: RETURN_PATH,
    });

    expect(typeof issued.challengeId).toBe("string");
    expect(issued.challengeId.length).toBeGreaterThan(0);
    expect(typeof issued.redirectUrl).toBe("string");
    expect(typeof issued.expiresAt).toBe("string");
    // The redirect carries the correlation token; the row carries only its digest.
    expect(seenStates).toHaveLength(1);
    const redirectUrl = new URL(issued.redirectUrl);
    expect(redirectUrl.searchParams.get("state")).toBe(seenStates[0]);

    const row = await storedChallenge(issued.challengeId);
    expect(row).toBeDefined();
    // The named binding: the row pins the ORIGINAL user and session, the
    // target company, the allowed provider/protocol and the policy revision —
    // none of them re-read from the callback's claims later.
    const storedBinding = {
      userId: row!.user_id,
      sessionId: row!.session_id,
      tenantId: row!.tenant_id,
      providerId: row!.provider_id,
      protocol: row!.protocol,
      policyRevision: Number(row!.policy_revision),
      returnPath: row!.return_path,
    };
    const expectedBinding = {
      userId: USER,
      sessionId: SESSION,
      tenantId: TENANT,
      providerId: PROVIDER,
      protocol: "oidc",
      policyRevision: POLICY_REVISION,
      returnPath: RETURN_PATH,
    };
    expect(storedBinding).toEqual(expectedBinding);

    // The correlation token exists only as its digest…
    expect(row!.state_digest).toBe(await sha256Hex(seenStates[0]!));
    expect(row!.state_digest).not.toBe(seenStates[0]);
    // …and the protocol secrets only inside the sealed envelope: the raw
    // column opens with the deployment key and names no plaintext material.
    const envelope = JSON.parse(row!.secret_envelope) as {
      version: number;
      iv: string;
      ciphertext: string;
    };
    expect(envelope.version).toBe(1);
    const opened = JSON.parse(
      await decryptSecret(ENCRYPTION_KEY, row!.secret_envelope),
    ) as { nonce: string; codeVerifier: string; protocolRequestId: string };
    expect(opened.nonce.length).toBeGreaterThan(0);
    expect(opened.codeVerifier.length).toBeGreaterThan(0);
    expect(opened.protocolRequestId).toBe(issued.challengeId);
    expect(row!.secret_envelope).not.toContain(seenStates[0]!);
    // Untouched until a callback consumes it (T05.02's half).
    expect(row!.consumed_at).toBeNull();
    // The 600-second ceiling holds as a stored fact.
    expect(
      row!.expires_at.getTime() - row!.created_at.getTime(),
    ).toBeLessThanOrEqual(600_000);
    expect(row!.expires_at.getTime()).toBeGreaterThan(
      row!.created_at.getTime(),
    );
  });

  test("challenge_expired_after_600_seconds", async () => {
    const { sql } = harness();
    await setAuthority(sql, {
      version: 43,
      phase: "M4",
      directoryAuthority: "ba",
    });
    // A fixed clock: issue time is T0 exactly, so the 601-second advance is
    // deterministic and not a race against the wall clock. T0 is captured
    // from the real clock because the database independently refuses an
    // expiry more than 600 seconds past ITS OWN now — a T0 arbitrarily far
    // from the database's clock would be rejected as out of range, which is
    // the ceiling working, not the test failing.
    const t0 = new Date();
    let clock = t0;
    const assurance = liveAssurance({ clock: () => clock });
    const issued = await assurance.challenge(ACTOR, {
      tenantId: TENANT,
      returnPath: RETURN_PATH,
    });
    const row = await storedChallenge(issued.challengeId);
    expect(row).toBeDefined();

    // Completable at issue…
    expect(
      isChallengeCompletable(
        { consumedAt: row!.consumed_at, expiresAt: row!.expires_at },
        t0,
      ),
    ).toBe(true);
    // …and not once the fixed clock stands 601 seconds past it.
    clock = new Date(t0.getTime() + 601_000);
    const completable = isChallengeCompletable(
      { consumedAt: row!.consumed_at, expiresAt: row!.expires_at },
      clock,
    );
    expect(completable).toBe(false);

    // The ceiling is enforced at the database, not by writer discipline: a
    // function call asking for 601 seconds is refused by name…
    const refusal = await sql
      .unsafe(
        `SELECT * FROM public.auth_issue_company_auth_challenge(
           't0501-over-age', $1, $2, $3, $4, 'oidc',
           1, '/enterprise/team', 't0501-digest-over-age', 't0501-envelope',
           now() + interval '601 seconds')`,
        [USER, SESSION, TENANT, PROVIDER],
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(String((refusal as Error)?.message)).toContain(
      "AUTH_CHALLENGE_EXPIRY_OUT_OF_RANGE",
    );
    // …and a hand-written over-age row violates the CHECK itself.
    const direct = await sql`
      INSERT INTO auth_company_auth_challenges
        (challenge_id, user_id, session_id, tenant_id, provider_id, protocol,
         policy_revision, return_path, state_digest, secret_envelope, expires_at)
      VALUES
        ('t0501-direct-over-age', ${USER}, ${SESSION}, ${TENANT}, ${PROVIDER}, 'oidc',
         1, '/enterprise/team', 't0501-digest-direct', 't0501-envelope',
         now() + interval '601 seconds')`.then(
      () => null,
      (error: unknown) => error,
    );
    expect(String((direct as Error)?.message)).toContain(
      "auth_company_auth_challenge_max_age",
    );
  });

  test("return_path_outside_the_site_is_refused", async () => {
    const { sql } = harness();
    await setAuthority(sql, {
      version: 45,
      phase: "M4",
      directoryAuthority: "ba",
    });
    const assurance = liveAssurance();
    // The refusal is request-level: no challenge row may appear for it. The
    // count is a before/after snapshot because the earlier named tests
    // legitimately hold rows for this user.
    const before = await countChallenges();
    for (const returnPath of [
      "https://evil.example/callback",
      "//evil.example/callback",
      "/\\evil.example",
      "/%2f%2fevil.example",
      "/%5Cevil.example",
      "javascript:alert(1)",
      "",
      "relative/path",
    ]) {
      const refusal = await refusalOf(() =>
        assurance.challenge(ACTOR, { tenantId: TENANT, returnPath }),
      );
      expect(refusal).toEqual({
        status: 400,
        code: COMPANY_AUTH_RETURN_PATH_INVALID,
      });
    }
    // Nothing was persisted for any of them.
    expect(await countChallenges()).toBe(before);
  });

  test("unknown_company_no_policy_and_non_member_answer_one_404", async () => {
    const { sql } = harness();
    await setAuthority(sql, {
      version: 47,
      phase: "M4",
      directoryAuthority: "ba",
    });
    const assurance = liveAssurance();
    // A company that does not exist…
    const unknown = await refusalOf(() =>
      assurance.challenge(ACTOR, {
        tenantId: "t0501-no-such-company",
        returnPath: RETURN_PATH,
      }),
    );
    // …a company whose policy demands no additional proof…
    const noPolicy = await refusalOf(() =>
      assurance.challenge(ACTOR, {
        tenantId: TENANT_NO_POLICY,
        returnPath: RETURN_PATH,
      }),
    );
    // …and a caller who is not a member of a policy-holding company all answer
    // identically: no side channel names which fact failed.
    const outsiderActor: DirectoryActor = {
      ...ACTOR,
      userId: OUTSIDER,
      sessionId: OUTSIDER_SESSION,
    };
    const notAMember = await refusalOf(() =>
      assurance.challenge(outsiderActor, {
        tenantId: TENANT,
        returnPath: RETURN_PATH,
      }),
    );
    for (const refusal of [unknown, noPolicy, notAMember]) {
      expect(refusal).toEqual({ status: 404, code: "RESOURCE_NOT_FOUND" });
    }
  });

  test("session_mismatch_and_expired_session_are_401", async () => {
    const { sql } = harness();
    await setAuthority(sql, {
      version: 49,
      phase: "M4",
      directoryAuthority: "ba",
    });
    const assurance = liveAssurance();
    // Another person's session id on this user: 账户不匹配.
    const stolen = await refusalOf(() =>
      assurance.challenge(
        { ...ACTOR, sessionId: OUTSIDER_SESSION },
        { tenantId: TENANT, returnPath: RETURN_PATH },
      ),
    );
    expect(stolen).toEqual({ status: 401, code: "SESSION_EXPIRED" });
    // An expired session, even the right user's.
    const expired = await refusalOf(() =>
      assurance.challenge(
        { ...ACTOR, sessionId: EXPIRED_SESSION },
        { tenantId: TENANT, returnPath: RETURN_PATH },
      ),
    );
    expect(expired).toEqual({ status: 401, code: "SESSION_EXPIRED" });
    // No session identity at all.
    const anonymous = await refusalOf(() =>
      assurance.challenge(
        { ...ACTOR, sessionId: null },
        { tenantId: TENANT, returnPath: RETURN_PATH },
      ),
    );
    expect(anonymous).toEqual({ status: 401, code: "AUTH_REQUIRED" });
    const noTenant = await refusalOf(() =>
      assurance.challenge(ACTOR, { tenantId: "  ", returnPath: RETURN_PATH }),
    );
    expect(noTenant).toEqual({
      status: 400,
      code: COMPANY_ASSURANCE_TARGET_REQUIRED,
    });
  });

  test("legacy_and_paused_authority_close_the_write", async () => {
    const { sql } = harness();
    // Legacy (M1): BA runtime writes are closed before M4.
    await setAuthority(sql, {
      version: 51,
      phase: "M1",
      directoryAuthority: "legacy",
    });
    const assurance = liveAssurance();
    const legacy = await refusalOf(() =>
      assurance.challenge(ACTOR, { tenantId: TENANT, returnPath: RETURN_PATH }),
    ).catch(async (error: unknown) => {
      const { isAuthorityRefusal } = await import(
        "../../src/auth/directory/authority"
      );
      if (isAuthorityRefusal(error)) {
        return { status: error.status, code: error.code };
      }
      throw error;
    });
    expect(legacy).toEqual({
      status: 503,
      code: DIRECTORY_WRITE_AUTHORITY_CLOSED,
    });
    // Paused (M2): every writer is paused, including this one.
    await setAuthority(sql, {
      version: 53,
      phase: "M2",
      directoryAuthority: "paused",
    });
    const paused = await assurance
      .challenge(ACTOR, { tenantId: TENANT, returnPath: RETURN_PATH })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(paused).toBeInstanceOf(Error);
    expect((paused as { code?: string }).code ?? "").toBe(
      DIRECTORY_MIGRATION_PAUSED,
    );
    // A stale expected version never issues: the CAS conflict propagates.
    await setAuthority(sql, {
      version: 55,
      phase: "M4",
      directoryAuthority: "ba",
    });
    const authority = createDirectoryAuthority();
    await harness()
      .writer.transaction(async (tx) => {
        const state = await authority.read(tx);
        expect(state.authorityVersion).toBe(55);
        const stale = await authority.requireWrite(tx, 54, "ba").then(
          () => null,
          (error: unknown) => error,
        );
        expect((stale as { code?: string })?.code).toBe(
          AUTHORITY_VERSION_CONFLICT,
        );
        throw new Error("rollback-only");
      })
      .catch((error: unknown) => {
        expect((error as Error).message).toBe("rollback-only");
      });
  });

  test("unbuildable_redirect_refuses_and_persists_nothing", async () => {
    const { sql } = harness();
    await setAuthority(sql, {
      version: 57,
      phase: "M4",
      directoryAuthority: "ba",
    });
    const assurance = liveAssurance({ redirectUrl: null });
    const before = await countChallenges();
    const refusal = await refusalOf(() =>
      assurance.challenge(ACTOR, { tenantId: TENANT, returnPath: RETURN_PATH }),
    );
    expect(refusal).toEqual({ status: 503, code: COMPANY_AUTH_NOT_READY });
    expect(await countChallenges()).toBe(before);
  });

  test("mounted_route_answers_the_frozen_shape", async () => {
    const { sql } = harness();
    await setAuthority(sql, {
      version: 59,
      phase: "M4",
      directoryAuthority: "ba",
    });
    const routes = createCompanyAuthRoutes({
      authenticate: async (request) => {
        // The test seam stands in for auth.api.getSession: the cookie header
        // names which fixture session this request carries.
        const cookie = request.headers.get("cookie") ?? "";
        if (cookie.includes("t0501-live"))
          return { userId: USER, sessionId: SESSION };
        if (cookie.includes("t0501-outsider"))
          return { userId: OUTSIDER, sessionId: OUTSIDER_SESSION };
        return null;
      },
      assurance: liveAssurance(),
    });

    // Unauthenticated: 401, no challenge.
    const anonymous = await routes.request("/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: TENANT, returnPath: RETURN_PATH }),
    });
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()).error.code).toBe("AUTH_REQUIRED");

    // Malformed body: 400.
    const malformed = await routes.request("/challenge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "t0501-live",
      },
      body: JSON.stringify({ tenantId: 42 }),
    });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.code).toBe("INVALID_REQUEST");

    // An off-site returnPath over the wire: 400 with the named code.
    const offSite = await routes.request("/challenge", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "t0501-live" },
      body: JSON.stringify({
        tenantId: TENANT,
        returnPath: "//evil.example",
      }),
    });
    expect(offSite.status).toBe(400);
    expect((await offSite.json()).error.code).toBe(
      COMPANY_AUTH_RETURN_PATH_INVALID,
    );

    // The happy path: the frozen DTO, and the row behind it.
    const issued = await routes.request("/challenge", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "t0501-live" },
      body: JSON.stringify({ tenantId: TENANT, returnPath: RETURN_PATH }),
    });
    expect(issued.status).toBe(200);
    const dto = (await issued.json()) as {
      challengeId: string;
      redirectUrl: string;
      expiresAt: string;
    };
    expect(typeof dto.challengeId).toBe("string");
    expect(typeof dto.redirectUrl).toBe("string");
    expect(Number.isFinite(Date.parse(dto.expiresAt))).toBe(true);
    const row = await storedChallenge(dto.challengeId);
    expect(row?.user_id).toBe(USER);
    expect(row?.session_id).toBe(SESSION);

    // The outsider reaches the same uniform 404 over the wire.
    const outsider = await routes.request("/challenge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "t0501-outsider",
      },
      body: JSON.stringify({ tenantId: TENANT, returnPath: RETURN_PATH }),
    });
    expect(outsider.status).toBe(404);
    expect((await outsider.json()).error.code).toBe("RESOURCE_NOT_FOUND");
  });

  afterAll(async () => {
    const created = harnessState;
    harnessState = undefined;
    if (created) await created.close();
    // Leak probe on a fresh connection: none of this suite's rows, none of the
    // chain's tables, not the issuance function.
    const setupUrl = readBaUrls();
    const probe = postgres(setupUrl, { max: 1 });
    try {
      const tables = await probe<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = ANY(${[...BA_TABLES]}::text[])`;
      expect([...tables]).toEqual([]);
      const fns = await probe<{ proname: string }[]>`
        SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'auth_issue_company_auth_challenge'`;
      expect([...fns]).toEqual([]);
      const rows = await probe`
        SELECT id FROM users WHERE id LIKE 't0501-%'`;
      expect([...rows]).toEqual([]);
      const tenants = await probe`
        SELECT id FROM enterprise_tenants WHERE id LIKE 't0501-%'`;
      expect([...tenants]).toEqual([]);
    } finally {
      await probe.end({ timeout: 5 }).catch(() => {});
    }
  });
});
