import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql as dsql } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import {
  COMPANY_AUTH_NOT_READY,
  COMPANY_REAUTH_REQUIRED,
  type CompanyAssurance,
  CompanyAssuranceRefusal,
  type CompanyAuthRedirectRequest,
  createCompanyAssurance,
} from "../../src/auth/company-assurance";
import { createCompanyAuthRoutes } from "../../src/auth/company-auth-routes";
import {
  createDirectoryAuthority,
  DIRECTORY_MIGRATION_PAUSED,
  DIRECTORY_WRITE_AUTHORITY_CLOSED,
  isAuthorityRefusal,
} from "../../src/auth/directory/authority";
import type { DirectoryActor } from "../../src/auth/directory/contracts";
import {
  createSsoEvidenceBridge,
  type SsoChallengeRecord,
  type SsoChallengeStore,
  type SsoOidcProvider,
} from "../../src/auth/sso-evidence";
import { decryptSecret, encryptSecret } from "../../src/credentials";
import { createDatabase } from "../../src/db/client";
import { createOidcTestIdp, type OidcTestIdp } from "./support/oidc-idp";

/*
 * T05.02 (#558, original task P11) — the OIDC callback half of the company
 * additional authentication (design §9.1 steps 3–4, interfaces §5): the
 * callback is verified by the real evidence bridge (signed auth_time/acr/amr,
 * issuer/audience/nonce/PKCE, one-time state) and completed under the tenant
 * lock — the 0219 controlled surface re-verifies the original session,
 * membership and the live stored policy, and writes the session-assurance
 * proof in the same transaction as that re-verification.
 *
 * What the named cases pin, as database facts rather than code conventions:
 *
 * - `oidc_completion_uses_claim_auth_time`: the proof row's authenticated_at
 *   is exactly the id_token's SIGNED auth_time — never the callback clock —
 *   and the proof binds the rotation-final live session of the challenge's
 *   original user, expiring with the session or the stored policy's max age.
 * - `account_changed_or_state_tampered_creates_no_proof`: a callback whose
 *   signed subject is not bound to the challenge's original user, and a
 *   callback whose state answers no open challenge, both refuse and leave
 *   the proof table at zero rows — expect(proofRows).toHaveLength(0).
 *
 * Around them: replay creates no second proof, a policy revision bump
 * refuses the already-issued challenge, session rotation binds only the
 * final session for this one company (never copying other companies'
 * proofs), legacy/paused authority closes the completion, the no-sessions
 * port binds the original session, a logged-out callback refuses, the route
 * answers controlled bodies, and a factory assembled without the evidence
 * bridge keeps the closed 503.
 *
 * The suite applies the verified BA chain (0209–0214) plus the 0218/0219
 * migrations on the isolated BA_TEST_* database and removes exactly what it
 * added. The five BA_TEST_* role URLs are all required; a missing one is a
 * blocked suite, never a fallback. No DSN is ever printed.
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
const MIGRATION_TAG = "0231_better_auth_company_auth_complete";
const COMPLETE_FUNCTIONS = [
  "auth_read_company_auth_policy(text)",
  "auth_consume_company_auth_challenge(text)",
  "auth_record_company_session_assurance(text,text,text,text,text,timestamp with time zone,text)",
] as const;
/**
 * The verified chain the completion rides on: the directory tables
 * (T02.01), the clocks (T02.02), the command model and authority (T02.03),
 * the authority sources (T02.04), the challenge/proof storage (T02.05), the
 * capability roles (T02.06) and the challenge issuance (T05.01) — applied in
 * journal order, removed again at cleanup, the sibling BA suites' discipline.
 */
const PREREQUISITE_TAGS = [
  "0221_better_auth_directory",
  "0222_better_auth_clocks",
  "0223_better_auth_command_authority",
  "0224_better_auth_authority_sources",
  "0225_better_auth_assurance",
  "0226_better_auth_schema_roles",
  "0230_better_auth_company_auth_challenge",
] as const;

/** The BA tables this suite's chain creates (schema-roles' list + 0219's). */
const BA_TABLES = [
  "auth_company_auth_policies",
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

const TENANT = "t0502-tenant";
const OTHER_TENANT = "t0502-other-tenant";
const USER = "t0502-user";
const OUTSIDER = "t0502-outsider";
const SESSION = "t0502-session";
const FINAL_SESSION = "t0502-session-final";
const OUTSIDER_SESSION = "t0502-session-outsider";
const RETURN_PATH = "/enterprise/team";
const PROVIDER = "t0502-idp";
const POLICY_REVISION = 7;
const MAX_AUTH_AGE_SECONDS = 900;
const REDIRECT_ORIGIN = "http://openbot.test";
const SUBJECT = "oidc-test-subject";
const IDENTITY_GENERATION = 3;
const COMPANY_GENERATION = 5;
/** A test-only AES-GCM key for the envelope (32 bytes, base64). Never a deployment's. */
const ENCRYPTION_KEY = Buffer.from(new Uint8Array(32).fill(0x52)).toString(
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
        `${variable} is required: the completion suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
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

/** Read lazily, so a worktree without the migrations still collects every case. */
function migrationSql(tag: string): string {
  const path = join(import.meta.dirname, `../../drizzle/${tag}.sql`);
  if (!existsSync(path)) {
    throw new Error(
      `${tag}.sql does not exist: the T05.02 completion surface sits on the verified T02.01–T02.06 + T05.01 stack, and a missing prerequisite is a workspace problem, not a target behavior.`,
    );
  }
  return readFileSync(path, "utf8");
}

interface Harness {
  /** Setup connection: DDL, seeds, read-back probes. */
  sql: postgres.Sql;
  /** The production client on the auth-writer capability connection. */
  writer: ReturnType<typeof createDatabase>;
  /** The locally-signing OIDC IdP the callbacks answer. */
  idp: OidcTestIdp;
  close(): Promise<void>;
}

let harnessState: Harness | undefined;

/**
 * Returns the island to the pre-T05.02 shape: the 0219 functions and policy
 * table, the 0218 issuance function and the chain tables/triggers/functions
 * gone, this suite's seeded rows gone. Every statement is a no-op on a
 * pristine baseline, so it also recovers a crashed earlier run. The
 * cluster-wide capability roles stay (the standing shape; the environment's
 * provisioning owns them).
 */
async function cleanupFixture(sql: postgres.Sql): Promise<void> {
  for (const signature of COMPLETE_FUNCTIONS) {
    await sql.unsafe(`DROP FUNCTION IF EXISTS public.${signature} CASCADE`);
  }
  await sql.unsafe(
    `DROP FUNCTION IF EXISTS public.auth_issue_company_auth_challenge(text,text,text,text,text,text,bigint,text,text,text,timestamptz) CASCADE`,
  );
  const triggerPairs = CHAIN_TRIGGERS.map(
    ([table, trigger]) => `('${table}', '${trigger}')`,
  ).join(", ");
  const functions = CHAIN_FUNCTIONS.map((signature) => `('${signature}')`).join(
    ", ",
  );
  const tables = BA_TABLES.map((name) => `('${name}')`).join(", ");
  await sql.unsafe(`
    DO $t0502_cleanup$
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
    $t0502_cleanup$`);
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
  await sql`DELETE FROM accounts WHERE user_id LIKE 't0502-%'`.catch(() => {});
  await sql`DELETE FROM sso_providers WHERE provider_id = ${PROVIDER}`.catch(
    () => {},
  );
  await sql`DELETE FROM auth_members WHERE id LIKE 't0502-%'`.catch(() => {});
  await sql`DELETE FROM enterprise_principals WHERE user_id LIKE 't0502-%'`.catch(
    () => {},
  );
  await sql`DELETE FROM auth_eligibility_clocks WHERE tenant_id LIKE 't0502-%'`.catch(
    () => {},
  );
  await sql`DELETE FROM sessions WHERE id LIKE 't0502-%'`;
  await sql`DELETE FROM users WHERE id LIKE 't0502-%'`;
  await sql`DELETE FROM enterprise_tenants WHERE id LIKE 't0502-%'`;
}

/**
 * Two companies (the policy holder and one without any policy row), the
 * member user with their original, rotation-final and outsider sessions, the
 * identity binding (issuer, subject) → USER in accounts, the issuance
 * generations on the principal and the company eligibility clock, and the
 * stored 0219 policy row. The directory tables' DML guard is suspended for
 * exactly the org/member inserts (the sibling suites' withGuardsDisabled
 * pattern) and re-enabled before any flow runs.
 */
async function seedBaselineFixture(
  sql: postgres.Sql,
  idpIssuer: string,
): Promise<void> {
  await sql`
    INSERT INTO enterprise_tenants (id, name) VALUES
      (${TENANT}, 'T05.02 company'),
      (${OTHER_TENANT}, 'T05.02 other company')`;
  await sql`
    INSERT INTO users (id, email) VALUES
      (${USER}, 't0502-user@example.test'),
      (${OUTSIDER}, 't0502-outsider@example.test')`;
  await sql`
    INSERT INTO sessions (id, user_id, token, expires_at) VALUES
      (${SESSION}, ${USER}, 't0502-token', now() + interval '2 hours'),
      (${FINAL_SESSION}, ${USER}, 't0502-token-final', now() + interval '3 hours'),
      (${OUTSIDER_SESSION}, ${OUTSIDER}, 't0502-token-outsider', now() + interval '2 hours')`;
  await sql`
    INSERT INTO accounts (id, account_id, provider_id, user_id, issuer)
    VALUES ('t0502-account', ${SUBJECT}, ${PROVIDER}, ${USER}, ${idpIssuer})`;
  await sql`
    INSERT INTO enterprise_principals (id, user_id, identity_generation)
    VALUES ('t0502-principal', ${USER}, ${IDENTITY_GENERATION})`;
  await sql`
    INSERT INTO auth_eligibility_clocks
      (tenant_id, principal_id, kind, scope_id, epoch, generation, tombstone, last_command_id)
    VALUES (${TENANT}, 't0502-principal', 'company', ${TENANT}, 1, ${COMPANY_GENERATION}, false, 't0502-seed')`;
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
        (${TENANT}, 'T05.02 company', 't0502-org'),
        (${OTHER_TENANT}, 'T05.02 other company', 't0502-org-other')`;
    await sql`
      INSERT INTO auth_members (id, organization_id, user_id, role) VALUES
        ('t0502-member', ${TENANT}, ${USER}, 'member')`;
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

/**
 * Empty the challenge/proof tables this suite owns: each scenario counts
 * WHOLE-table rows (the named zero-proof expectation reads best that way),
 * so every test starts from no flows at all. The harness is the database's
 * only tenant of these two tables.
 */
async function resetFlowState(): Promise<void> {
  await harness().sql`DELETE FROM auth_company_session_assurances`;
  await harness().sql`DELETE FROM auth_company_auth_challenges`;
}

async function createHarness(): Promise<Harness> {
  const setupUrl = readBaUrls();
  const sql = postgres(setupUrl, {
    max: 1,
    idle_timeout: 5,
    onnotice: () => {},
  });
  const idp = await createOidcTestIdp();
  try {
    await cleanupFixture(sql);
    for (const tag of [...PREREQUISITE_TAGS, MIGRATION_TAG]) {
      await sql.unsafe(migrationSql(tag));
    }
    await seedBaselineFixture(sql, idp.issuer);
    const writer = createDatabase(
      process.env.BA_TEST_AUTH_WRITER_DATABASE_URL!.trim(),
      { max: 4 },
    );
    return {
      sql,
      writer,
      idp,
      close: async () => {
        try {
          await cleanupFixture(sql);
        } finally {
          await writer.$client.close?.();
          await sql.end({ timeout: 5 }).catch(() => {});
          await idp.close();
        }
      },
    };
  } catch (error) {
    await cleanupFixture(sql).catch(() => {});
    await sql.end({ timeout: 5 }).catch(() => {});
    await idp.close();
    throw error;
  }
}

function harness(): Harness {
  if (!harnessState) throw new Error("completion harness is not initialized");
  return harnessState;
}

/** The registered provider row, sealed the way the deployment's adapter
 * seals it: the Better Auth registration JSON inside the AES-GCM envelope. */
async function seedProviderRegistration(): Promise<void> {
  const { idp } = harness();
  const config = JSON.stringify({
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    authorizationEndpoint: `${idp.issuer}/authorize`,
    tokenEndpoint: idp.tokenEndpoint,
    jwksEndpoint: idp.jwksUri,
    scopes: ["openid", "email", "profile"],
  });
  await harness().sql`
    INSERT INTO sso_providers (id, issuer, oidc_config, provider_id, domain)
    VALUES (
      't0502-provider-row',
      ${idp.issuer},
      ${await encryptSecret(ENCRYPTION_KEY, config)},
      ${PROVIDER},
      't0502.example.test'
    )`;
}

/*
 * ── T05.02 assembly ────────────────────────────────────────────────────────
 * The live factory over the REAL 0218/0219 storage, the REAL evidence bridge
 * and the REAL controlled functions. Where a production factory is not yet
 * imported this file builds the same shape inline and says so (v1 RED); the
 * named behaviors never touch a stand-in for the code under test.
 */

interface Assembly {
  assurance: CompanyAssurance;
  app: Hono;
}

interface AssemblyOptions {
  /** Cookie → session the factory's completion resolves (false = no port). */
  readonly sessionsPort?: boolean;
  readonly evidencePort?: boolean;
}

let assemblyState: Assembly | undefined;

function createAssembly(options: AssemblyOptions = {}): Assembly {
  const { writer, idp } = harness();

  // The stored policy views, inline (v1): the answers the 0219 row gives.
  const policyViews = {
    proof: {
      requiresProof: async (tenantId: string) => tenantId === TENANT,
    },
    challenge: {
      challengePolicy: async (tenantId: string) =>
        tenantId === TENANT
          ? {
              providerId: PROVIDER,
              protocol: "oidc" as const,
              policyRevision: POLICY_REVISION,
            }
          : null,
    },
  };

  // The registered provider's facts, inline (v1): what the seeded row holds.
  const facts = {
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    authorizationEndpoint: `${idp.issuer}/authorize`,
    tokenEndpoint: idp.tokenEndpoint,
    jwksUri: idp.jwksUri,
    redirectUri: `${REDIRECT_ORIGIN}/api/enterprise/company-auth/oidc/callback/${PROVIDER}`,
  };

  // The one-time store, inline (v1): the 0219 controlled consume, opened
  // with the deployment key exactly as the production store will.
  const challengeStore: SsoChallengeStore = {
    async consume(state: string): Promise<SsoChallengeRecord | null> {
      const digest = Buffer.from(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state)),
      ).toString("hex");
      const result = await writer.execute(
        dsql`SELECT challenge_id, secret_envelope, expires_at
               FROM public.auth_consume_company_auth_challenge(${digest})`,
      );
      const rows = Array.isArray(result)
        ? (result as Record<string, unknown>[])
        : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
      const row = rows[0];
      if (!row) return null;
      const opened = JSON.parse(
        await decryptSecret(ENCRYPTION_KEY, String(row.secret_envelope)),
      ) as { nonce: string; codeVerifier: string; protocolRequestId: string };
      return {
        challengeId: String(row.challenge_id),
        providerId: PROVIDER,
        state,
        nonce: opened.nonce,
        codeVerifier: opened.codeVerifier,
        protocolRequestId: opened.protocolRequestId,
        expiresAt: new Date(row.expires_at as string),
      };
    },
  };

  const provider: SsoOidcProvider = {
    providerId: PROVIDER,
    issuer: idp.issuer,
    clientId: facts.clientId,
    clientSecret: facts.clientSecret,
    redirectUri: facts.redirectUri,
    tokenEndpoint: facts.tokenEndpoint,
    jwksUri: facts.jwksUri,
  };

  const evidence = createSsoEvidenceBridge({
    challenges: challengeStore,
    providers: {
      find: async (providerId) => (providerId === PROVIDER ? provider : null),
    },
  });

  // The redirect builder, inline (v1): the frozen port's production shape.
  const redirect = {
    buildRedirect: async (request: CompanyAuthRedirectRequest) => {
      if (request.protocol !== "oidc") return null;
      const url = new URL(facts.authorizationEndpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", facts.clientId);
      url.searchParams.set("redirect_uri", facts.redirectUri);
      url.searchParams.set("scope", "openid email profile");
      url.searchParams.set("state", request.state);
      url.searchParams.set("nonce", request.nonce);
      url.searchParams.set("code_challenge", request.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    },
  };

  const assurance = createCompanyAssurance({
    policy: policyViews.proof,
    challengePolicy: policyViews.challenge,
    redirect,
    database: writer,
    authority: createDirectoryAuthority(),
    encryptionKey: ENCRYPTION_KEY,
    ...(options.evidencePort === false ? {} : { evidence }),
    ...(options.sessionsPort === false
      ? {}
      : {
          sessions: {
            resolveCurrent: async (request: Request) => {
              const cookie = request.headers.get("cookie") ?? "";
              if (cookie.includes("t0502-final"))
                return { userId: USER, sessionId: FINAL_SESSION };
              if (cookie.includes("t0502-live"))
                return { userId: USER, sessionId: SESSION };
              return null;
            },
          },
        }),
  });

  const app = new Hono();
  app.route(
    "/api/enterprise/company-auth",
    createCompanyAuthRoutes({
      authenticate: async (request) => {
        const cookie = request.headers.get("cookie") ?? "";
        if (cookie.includes("t0502-live"))
          return { userId: USER, sessionId: SESSION };
        if (cookie.includes("t0502-outsider"))
          return { userId: OUTSIDER, sessionId: OUTSIDER_SESSION };
        return null;
      },
      assurance,
    }),
  );
  return { assurance, app };
}

function assembly(): Assembly {
  if (!assemblyState) throw new Error("assembly is not initialized");
  return assemblyState;
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
    if (isAuthorityRefusal(error)) {
      return { status: 503, code: error.code };
    }
    throw error;
  }
  throw new Error(
    "expected a company-assurance refusal, but the operation succeeded",
  );
}

type StoredProof = {
  assurance_id: string;
  user_id: string;
  session_id: string;
  tenant_id: string;
  challenge_id: string;
  issuer: string;
  subject: string;
  authenticated_at: Date;
  strength: string;
  expires_at: Date;
  policy_revision: number;
  identity_generation: number;
  company_generation: number;
  status: string;
};

async function storedProofs(): Promise<StoredProof[]> {
  const rows = await harness().sql`
    SELECT assurance_id, user_id, session_id, tenant_id, challenge_id,
           issuer, subject, authenticated_at, strength, expires_at,
           policy_revision, identity_generation, company_generation, status
      FROM auth_company_session_assurances
     ORDER BY created_at`;
  return rows.map((row) => ({
    ...row,
    policy_revision: Number(row.policy_revision),
    identity_generation: Number(row.identity_generation),
    company_generation: Number(row.company_generation),
  }));
}

/** The signed auth_time every happy-path grant carries: 120 seconds ago. */
function authTimeNow(): { claim: number; date: Date } {
  const claim = Math.floor(Date.now() / 1000) - 120;
  return { claim, date: new Date(claim * 1000) };
}

/** A fresh IdP grant for one challenge's redirect, signed with these claims. */
function mintCode(
  redirectUrl: string,
  claims: Record<string, unknown>,
): string {
  const url = new URL(redirectUrl);
  return harness().idp.authorize({
    nonce: url.searchParams.get("nonce") ?? "",
    codeChallenge: url.searchParams.get("code_challenge") ?? "",
    redirectUri: url.searchParams.get("redirect_uri") ?? "",
    claims: {
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...claims,
    },
  });
}

/**
 * The whole §9.1 front channel, as the browser runs it: take the factory's
 * redirect, mint the IdP grant it names, and arrive at the callback route.
 */
async function walkRedirect(
  redirectUrl: string,
  options: {
    state?: string;
    claims?: Record<string, unknown>;
    cookie?: string;
  } = {},
): Promise<Response> {
  const url = new URL(redirectUrl);
  const code = mintCode(redirectUrl, {
    auth_time: Math.floor(Date.now() / 1000) - 120,
    sub: SUBJECT,
    ...options.claims,
  });
  const callbackUrl = new URL(url.searchParams.get("redirect_uri")!);
  callbackUrl.searchParams.set("code", code);
  callbackUrl.searchParams.set(
    "state",
    options.state ?? url.searchParams.get("state")!,
  );
  return assembly().app.request(callbackUrl.pathname + callbackUrl.search, {
    headers: options.cookie ? { cookie: options.cookie } : {},
  });
}

describe("T05.02 company auth OIDC callback completion (#558)", () => {
  beforeAll(async () => {
    harnessState = await createHarness();
    await seedProviderRegistration();
    assemblyState = createAssembly();
  }, 180_000);

  test("oidc_completion_uses_claim_auth_time", {
    timeout: 120_000,
  }, async () => {
    const { sql } = harness();
    await setAuthority(sql, {
      version: 101,
      phase: "M4",
      directoryAuthority: "ba",
    });
    await resetFlowState();
    const issued = await assembly().assurance.challenge(ACTOR, {
      tenantId: TENANT,
      returnPath: RETURN_PATH,
    });
    const { claim: authTimeClaim, date: authTime } = authTimeNow();

    const response = await walkRedirect(issued.redirectUrl, {
      cookie: "t0502-final",
      claims: { auth_time: authTimeClaim },
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(RETURN_PATH);

    // The proof: exactly one, bound to the final session and this company,
    // its authenticated_at the SIGNED auth_time — not the callback clock.
    const proofs = await storedProofs();
    expect(proofs).toHaveLength(1);
    const proof = proofs[0]!;
    expect(proof.authenticated_at).toEqual(authTime);
    expect(proof.session_id).toBe(FINAL_SESSION);
    expect(proof.tenant_id).toBe(TENANT);
    expect(proof.user_id).toBe(USER);
    expect(proof.challenge_id).toBe(issued.challengeId);
    expect(proof.issuer).toBe(harness().idp.issuer);
    expect(proof.subject).toBe(SUBJECT);
    expect(proof.strength).toBe("urn:mace:incommon:iap:silver");
    expect(proof.status).toBe("active");
    expect(proof.policy_revision).toBe(POLICY_REVISION);
    expect(proof.identity_generation).toBe(IDENTITY_GENERATION);
    expect(proof.company_generation).toBe(COMPANY_GENERATION);
    // §9.1: the proof expires with the session or the policy's max age,
    // judged from the signed authentication time — here the max age.
    expect(proof.expires_at.getTime()).toBe(
      authTime.getTime() + MAX_AUTH_AGE_SECONDS * 1000,
    );
    // The challenge: consumed exactly once, never deleted.
    const [challenge] = await harness().sql<{ consumed_at: Date | null }[]>`
        SELECT consumed_at FROM auth_company_auth_challenges
         WHERE challenge_id = ${issued.challengeId}`;
    expect(challenge?.consumed_at).not.toBeNull();
  });

  test("account_changed_or_state_tampered_creates_no_proof", {
    timeout: 120_000,
  }, async () => {
    const { sql } = harness();
    await setAuthority(sql, {
      version: 103,
      phase: "M4",
      directoryAuthority: "ba",
    });
    await resetFlowState();
    const proofRows = await storedProofs();
    expect(proofRows).toHaveLength(0);

    // The IdP authenticated a DIFFERENT account than the one bound to this
    // user: the callback verifies, the completion refuses, no proof lands.
    const changedAccount = await assembly().assurance.challenge(ACTOR, {
      tenantId: TENANT,
      returnPath: RETURN_PATH,
    });
    const changedResponse = await walkRedirect(changedAccount.redirectUrl, {
      cookie: "t0502-final",
      claims: { sub: "someone-else" },
    });
    expect(changedResponse.status).toBe(403);
    expect((await changedResponse.json()).error.code).toBe(
      COMPANY_REAUTH_REQUIRED,
    );

    // A tampered state answers no open challenge: the bridge refuses
    // before anything else, and the route answers the controlled body.
    const fresh = await assembly().assurance.challenge(ACTOR, {
      tenantId: TENANT,
      returnPath: RETURN_PATH,
    });
    const tamperedResponse = await walkRedirect(fresh.redirectUrl, {
      cookie: "t0502-final",
      state: "t0502-tampered-state-nobody-issued",
    });
    expect(tamperedResponse.status).toBe(400);
    expect((await tamperedResponse.json()).error.code).toBe(
      "SSO_CHALLENGE_MISSING_OR_CONSUMED",
    );

    // Both refusals, zero proof rows — the named expectation.
    expect(await storedProofs()).toHaveLength(0);
  });

  test("replayed_callback_creates_no_second_proof", {
    timeout: 120_000,
  }, async () => {
    const { sql } = harness();
    await setAuthority(sql, {
      version: 105,
      phase: "M4",
      directoryAuthority: "ba",
    });
    await resetFlowState();
    const issued = await assembly().assurance.challenge(ACTOR, {
      tenantId: TENANT,
      returnPath: RETURN_PATH,
    });
    const url = new URL(issued.redirectUrl);
    const code = mintCode(issued.redirectUrl, {
      auth_time: Math.floor(Date.now() / 1000) - 120,
      sub: SUBJECT,
    });
    const callbackPath = `${new URL(url.searchParams.get("redirect_uri")!).pathname}?code=${code}&state=${url.searchParams.get("state")!}`;
    const first = await assembly().app.request(callbackPath, {
      headers: { cookie: "t0502-final" },
    });
    expect(first.status).toBe(303);
    expect(await storedProofs()).toHaveLength(1);

    // The replay: the same state is spent, the bridge refuses first.
    const second = await assembly().app.request(callbackPath, {
      headers: { cookie: "t0502-final" },
    });
    expect(second.status).toBe(400);
    expect((await second.json()).error.code).toBe(
      "SSO_CHALLENGE_MISSING_OR_CONSUMED",
    );
    expect(await storedProofs()).toHaveLength(1);
  });

  test("policy_revision_change_refuses_completion", {
    timeout: 120_000,
  }, async () => {
    const { sql } = harness();
    await setAuthority(sql, {
      version: 107,
      phase: "M4",
      directoryAuthority: "ba",
    });
    await resetFlowState();
    const issued = await assembly().assurance.challenge(ACTOR, {
      tenantId: TENANT,
      returnPath: RETURN_PATH,
    });
    // The policy of record moves after issuance: the challenge's pinned
    // revision no longer answers, and the completion refuses.
    await sql`
        UPDATE auth_company_auth_policies
           SET policy_revision = ${POLICY_REVISION + 1}, updated_at = now()
         WHERE tenant_id = ${TENANT}`;
    const response = await walkRedirect(issued.redirectUrl, {
      cookie: "t0502-final",
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe(COMPANY_REAUTH_REQUIRED);
    expect(await storedProofs()).toHaveLength(0);
    // The spent challenge stays spent: no retry rides the old revision.
    const [challenge] = await harness().sql<{ consumed_at: Date | null }[]>`
        SELECT consumed_at FROM auth_company_auth_challenges
         WHERE challenge_id = ${issued.challengeId}`;
    expect(challenge?.consumed_at).not.toBeNull();
    // Restore: the later tests need the original revision back.
    await sql`
        UPDATE auth_company_auth_policies
           SET policy_revision = ${POLICY_REVISION}, updated_at = now()
         WHERE tenant_id = ${TENANT}`;
  });

  test("session_rotation_binds_only_final_session_for_this_company", {
    timeout: 120_000,
  }, async () => {
    const { sql } = harness();
    await setAuthority(sql, {
      version: 109,
      phase: "M4",
      directoryAuthority: "ba",
    });
    await resetFlowState();
    // A challenge and proof the user already holds for ANOTHER company on
    // the final session: completion for THIS company must not touch it.
    // (The proof's composite FK rides the challenge's binding tuple, so
    // the pairing challenge row is seeded first.)
    await sql`
        INSERT INTO auth_company_auth_challenges
          (challenge_id, user_id, session_id, tenant_id, provider_id, protocol,
           policy_revision, return_path, state_digest, secret_envelope, expires_at)
        VALUES
          ('t0502-other-challenge', ${USER}, ${SESSION}, ${OTHER_TENANT},
           't0502-other-idp', 'oidc', 1, '/', 't0502-other-digest',
           't0502-other-envelope', now() + interval '5 minutes')`;
    await sql`
        INSERT INTO auth_company_session_assurances
          (assurance_id, user_id, principal_id, session_id, tenant_id,
           challenge_id, provider_id, authentication_method, issuer, subject,
           authenticated_at, strength, expires_at, policy_revision,
           identity_generation, company_generation, status, created_at)
        VALUES
          ('t0502-other-company-proof', ${USER}, 't0502-principal', ${FINAL_SESSION},
           ${OTHER_TENANT}, 't0502-other-challenge', 't0502-other-idp', 'oidc',
           ${harness().idp.issuer}, ${SUBJECT}, now() - interval '60 seconds',
           'pwd', now() + interval '10 minutes', 1, ${IDENTITY_GENERATION},
           ${COMPANY_GENERATION}, 'active', now() - interval '60 seconds')`;

    // BA rotated the session away: the ORIGINAL session is gone, the
    // cookie carries the final one.
    const issued = await assembly().assurance.challenge(ACTOR, {
      tenantId: TENANT,
      returnPath: RETURN_PATH,
    });
    await sql`DELETE FROM sessions WHERE id = ${SESSION}`;
    const response = await walkRedirect(issued.redirectUrl, {
      cookie: "t0502-final",
    });
    expect(response.status).toBe(303);

    const proofs = await storedProofs();
    const mine = proofs.filter((proof) => proof.tenant_id === TENANT);
    expect(mine).toHaveLength(1);
    // The proof binds the FINAL session — never the rotated-away one.
    expect(mine[0]!.session_id).toBe(FINAL_SESSION);
    // The other company's proof: untouched, uncopied, still active.
    const others = proofs.filter((proof) => proof.tenant_id === OTHER_TENANT);
    expect(others).toHaveLength(1);
    expect(others[0]!.assurance_id).toBe("t0502-other-company-proof");
    expect(others[0]!.status).toBe("active");

    // Restore the seeded baseline: later scenarios issue against the
    // original session again.
    await sql`
        INSERT INTO sessions (id, user_id, token, expires_at)
        VALUES (${SESSION}, ${USER}, 't0502-token', now() + interval '2 hours')
        ON CONFLICT (id) DO NOTHING`;
  });

  test("legacy_and_paused_authority_close_the_completion", {
    timeout: 120_000,
  }, async () => {
    const { sql } = harness();
    await setAuthority(sql, {
      version: 111,
      phase: "M4",
      directoryAuthority: "ba",
    });
    await resetFlowState();
    const issued = await assembly().assurance.challenge(ACTOR, {
      tenantId: TENANT,
      returnPath: RETURN_PATH,
    });
    const url = new URL(issued.redirectUrl);
    const code = mintCode(issued.redirectUrl, {
      auth_time: Math.floor(Date.now() / 1000) - 120,
      sub: SUBJECT,
    });
    const callbackPath = `${new URL(url.searchParams.get("redirect_uri")!).pathname}?code=${code}&state=${url.searchParams.get("state")!}`;

    // Legacy (M1): BA runtime writes are closed before M4.
    await setAuthority(sql, {
      version: 112,
      phase: "M1",
      directoryAuthority: "legacy",
    });
    const legacyResponse = await assembly().app.request(callbackPath, {
      headers: { cookie: "t0502-final" },
    });
    expect(legacyResponse.status).toBe(503);
    expect((await legacyResponse.json()).error.code).toBe(
      DIRECTORY_WRITE_AUTHORITY_CLOSED,
    );
    expect(await storedProofs()).toHaveLength(0);

    // Paused (M2): every writer is paused, including this one. The spent
    // state from the legacy attempt answers nothing, so a fresh flow runs.
    await setAuthority(sql, {
      version: 113,
      phase: "M4",
      directoryAuthority: "ba",
    });
    await resetFlowState();
    const pausedIssued = await assembly().assurance.challenge(ACTOR, {
      tenantId: TENANT,
      returnPath: RETURN_PATH,
    });
    await setAuthority(sql, {
      version: 114,
      phase: "M2",
      directoryAuthority: "paused",
    });
    const pausedCode = mintCode(pausedIssued.redirectUrl, {
      auth_time: Math.floor(Date.now() / 1000) - 120,
      sub: SUBJECT,
    });
    const pausedUrl = new URL(pausedIssued.redirectUrl);
    const pausedResponse = await assembly().app.request(
      `${new URL(pausedUrl.searchParams.get("redirect_uri")!).pathname}?code=${pausedCode}&state=${pausedUrl.searchParams.get("state")!}`,
      { headers: { cookie: "t0502-final" } },
    );
    expect(pausedResponse.status).toBe(503);
    expect((await pausedResponse.json()).error.code).toBe(
      DIRECTORY_MIGRATION_PAUSED,
    );
    expect(await storedProofs()).toHaveLength(0);
  });

  test("completion_without_sessions_port_binds_the_original_session", {
    timeout: 120_000,
  }, async () => {
    const { sql } = harness();
    await setAuthority(sql, {
      version: 115,
      phase: "M4",
      directoryAuthority: "ba",
    });
    await resetFlowState();
    const standalone = createAssembly({ sessionsPort: false });
    const issued = await standalone.assurance.challenge(ACTOR, {
      tenantId: TENANT,
      returnPath: RETURN_PATH,
    });
    const url = new URL(issued.redirectUrl);
    const code = mintCode(issued.redirectUrl, {
      auth_time: Math.floor(Date.now() / 1000) - 120,
      sub: SUBJECT,
    });
    const callbackPath = `${new URL(url.searchParams.get("redirect_uri")!).pathname}?code=${code}&state=${url.searchParams.get("state")!}`;
    const response = await standalone.app.request(callbackPath, {
      headers: { cookie: "t0502-live" },
    });
    expect(response.status).toBe(303);
    const proofs = await storedProofs();
    const mine = proofs.filter((proof) => proof.tenant_id === TENANT);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.session_id).toBe(SESSION);
  });

  test("logged_out_mid_flow_refuses_without_proof", {
    timeout: 120_000,
  }, async () => {
    const { sql } = harness();
    await setAuthority(sql, {
      version: 117,
      phase: "M4",
      directoryAuthority: "ba",
    });
    await resetFlowState();
    const issued = await assembly().assurance.challenge(ACTOR, {
      tenantId: TENANT,
      returnPath: RETURN_PATH,
    });
    const url = new URL(issued.redirectUrl);
    const code = mintCode(issued.redirectUrl, {
      auth_time: Math.floor(Date.now() / 1000) - 120,
      sub: SUBJECT,
    });
    const callbackPath = `${new URL(url.searchParams.get("redirect_uri")!).pathname}?code=${code}&state=${url.searchParams.get("state")!}`;
    // The callback arrives with no live session at all: 401, no proof.
    const response = await assembly().app.request(callbackPath);
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("SESSION_EXPIRED");
    expect(await storedProofs()).toHaveLength(0);
  });

  test("route_protocol_failures_answer_controlled_bodies", {
    timeout: 120_000,
  }, async () => {
    const { sql } = harness();
    await setAuthority(sql, {
      version: 119,
      phase: "M4",
      directoryAuthority: "ba",
    });
    await resetFlowState();
    const callbackBase = "/api/enterprise/company-auth/oidc/callback/t0502-idp";
    // No code at all: not a protocol response.
    const noCode = await assembly().app.request(`${callbackBase}?state=x`);
    expect(noCode.status).toBe(400);
    expect((await noCode.json()).error.code).toBe("SSO_REQUEST_UNRECOGNIZED");
    // A state nobody issued: one-time, refused at the bridge.
    const unknownState = await assembly().app.request(
      `${callbackBase}?code=c&state=nobody-issued-this`,
    );
    expect(unknownState.status).toBe(400);
    expect((await unknownState.json()).error.code).toBe(
      "SSO_CHALLENGE_MISSING_OR_CONSUMED",
    );
    expect(await storedProofs()).toHaveLength(0);
  });

  test("closed_complete_answers_503", { timeout: 120_000 }, async () => {
    const { sql } = harness();
    await setAuthority(sql, {
      version: 121,
      phase: "M4",
      directoryAuthority: "ba",
    });
    await resetFlowState();
    const withoutEvidence = createAssembly({ evidencePort: false });
    const refusal = await refusalOf(() =>
      withoutEvidence.assurance.complete(
        new Request(
          `${REDIRECT_ORIGIN}/api/enterprise/company-auth/oidc/callback/${PROVIDER}?code=c&state=s`,
        ),
      ),
    );
    expect(refusal).toEqual({ status: 503, code: COMPANY_AUTH_NOT_READY });
    expect(await storedProofs()).toHaveLength(0);
  });

  afterAll(async () => {
    const created = harnessState;
    harnessState = undefined;
    assemblyState = undefined;
    if (created) await created.close();
    // Leak probe on a fresh connection: none of this suite's rows, none of
    // the chain's tables, none of the 0219 functions.
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
         WHERE n.nspname = 'public'
           AND p.proname IN ('auth_record_company_session_assurance', 'auth_consume_company_auth_challenge', 'auth_read_company_auth_policy')`;
      expect([...fns]).toEqual([]);
      const rows = await probe`
        SELECT id FROM users WHERE id LIKE 't0502-%'`;
      expect([...rows]).toEqual([]);
      const tenants = await probe`
        SELECT id FROM enterprise_tenants WHERE id LIKE 't0502-%'`;
      expect([...tenants]).toEqual([]);
    } finally {
      await probe.end({ timeout: 5 }).catch(() => {});
    }
  });
});
