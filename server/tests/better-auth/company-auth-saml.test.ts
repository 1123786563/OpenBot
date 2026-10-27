import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
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
  type CompanyAssurance,
  createCompanyAssurance,
  createSamlRedirectBuilder,
  createStoredCompanyAuthPolicyViews,
} from "../../src/auth/company-assurance";
import { createCompanyAuthRoutes } from "../../src/auth/company-auth-routes";
import {
  createDirectoryAuthority,
  DIRECTORY_MIGRATION_PAUSED,
  DIRECTORY_WRITE_AUTHORITY_CLOSED,
} from "../../src/auth/directory/authority";
import type { DirectoryActor } from "../../src/auth/directory/contracts";
import {
  createSsoChallengeStore,
  createSsoEvidenceBridge,
  createStoredSsoProviders,
} from "../../src/auth/sso-evidence";
import { encryptSecret } from "../../src/credentials";
import { createDatabase } from "../../src/db/client";
import { createSamlTestIdp, type SamlTestIdp } from "./support/saml-idp";

/*
 * T05.03 (#559, original task P11) — the SAML half of the company additional
 * authentication (design §9.1 steps 2–4, interfaces §5): OpenBot's own SP
 * issues the AuthnRequest (HTTP-Redirect binding, RelayState = the
 * challenge's one-time state, ID = the persisted protocolRequestId) and the
 * ACS route `POST /api/enterprise/company-auth/saml/acs/:providerId` accepts
 * only the protocol's signed form POST — never a JSON claims body — and
 * completes through the evidence bridge (T01.07's signed-assertion verifier:
 * enveloped XML-DSig over exclusive C14N, Audience/Recipient/Destination,
 * InResponseTo/RelayState binding, AuthnInstant/AuthnContext) and the 0219
 * controlled functions.
 *
 * Every factory in the assembly is the PRODUCTION one: the stored policy
 * views (0219 policy read), the stored provider registry's `findSaml` /
 * `samlAuthorization` (the sealed saml_config row), the one-time challenge
 * store (0219 consume), the evidence bridge, the assurance factory and the
 * routes. What the named cases pin, as database facts:
 *
 * - `saml_completion_uses_assertion_time_and_strength`: the proof row's
 *   authenticated_at is exactly the SIGNED AuthnStatement@AuthnInstant and
 *   its strength the SIGNED AuthnContextClassRef — never the callback clock —
 *   bound to the rotation-final live session and this challenge.
 * - `relay_state_or_in_response_to_tamper_never_commits_proof`: a forged
 *   RelayState answers no open challenge, and a correctly-signed assertion
 *   whose InResponseTo names a foreign AuthnRequest still refuses — both
 *   leave the proof table at zero rows: expect(proofRows).toHaveLength(0).
 *
 * Around them: unsigned/foreign signatures, audience/recipient/destination
 * mismatches, an expired bearer window, a JSON claims body and a missing
 * RelayState, replay, a logged-out arrival, and the legacy/paused authority
 * matrix all refuse with zero proofs.
 *
 * The suite applies the verified BA chain (0209–0214) plus 0218/0219 on the
 * isolated BA_TEST_* database and removes exactly what it added. The five
 * BA_TEST_* role URLs are all required; a missing one is a blocked suite,
 * never a fallback. No DSN is ever printed.
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
const MIGRATION_TAG = "0219_better_auth_company_auth_complete";
const COMPLETE_FUNCTIONS = [
  "auth_read_company_auth_policy(text)",
  "auth_consume_company_auth_challenge(text)",
  "auth_record_company_session_assurance(text,text,text,text,text,timestamp with time zone,text)",
] as const;
/** The verified chain the completion rides on (the sibling suites' order). */
const PREREQUISITE_TAGS = [
  "0209_better_auth_directory",
  "0210_better_auth_clocks",
  "0211_better_auth_command_authority",
  "0212_better_auth_authority_sources",
  "0213_better_auth_assurance",
  "0214_better_auth_schema_roles",
  "0218_better_auth_company_auth_challenge",
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

const TENANT = "t0503-tenant";
const USER = "t0503-user";
const SESSION = "t0503-session";
const FINAL_SESSION = "t0503-session-final";
const RETURN_PATH = "/enterprise/team";
const PROVIDER = "t0503-idp";
/** A second registration whose sealed cert is an X.509 certificate (the
 * registration schema's shape), pinning the certificate→SPKI read. */
const X509_PROVIDER = "t0503-idp-x509";
const POLICY_REVISION = 7;
const MAX_AUTH_AGE_SECONDS = 900;
const REDIRECT_ORIGIN = "http://openbot.test";
const SP_ENTITY_ID = "http://openbot.test/saml/sp";
const ACS_PATH = `/api/enterprise/company-auth/saml/acs/${PROVIDER}`;
const ACS_URL = `${REDIRECT_ORIGIN}${ACS_PATH}`;
/** The IdP's SSO URL the AuthnRequest redirect addresses. Never fetched —
 * the front channel is the test walking the form itself. */
const IDP_ENTRY_POINT = "https://idp.t0503.example.test/sso";
const SUBJECT = "saml-test-subject";
const AUTHN_CONTEXT_CLASS =
  "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport";
const IDENTITY_GENERATION = 3;
const COMPANY_GENERATION = 5;
/** A test-only AES-GCM key for the envelope (32 bytes, base64). Never a deployment's. */
const ENCRYPTION_KEY = Buffer.from(new Uint8Array(32).fill(0x53)).toString(
  "base64",
);

/*
 * A self-signed X.509 certificate and its public key, generated once for this
 * suite (test data — the private key never existed in the repository and is
 * not needed: the case pins that a registered CERTIFICATE reads back as the
 * SAME SubjectPublicKeyInfo, which is a pure function of the certificate).
 */
const X509_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDGzCCAgOgAwIBAgIUeoNlyuZPf1QWL2rsjaLETXyatOswDQYJKoZIhvcNAQEL
BQAwHTEbMBkGA1UEAwwSdDA1MDMteDUwOS1maXh0dXJlMB4XDTI2MTAyNzA2MjAy
N1oXDTM2MTAyNDA2MjAyN1owHTEbMBkGA1UEAwwSdDA1MDMteDUwOS1maXh0dXJl
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkg4KUaf5Uxgj/jqlqW6K
O47q+Gnb4mAGk7Ua+Za3i0gkwT4S4j0h3vink8SZHnz16Gu1vGeyY/ypJEwWouF6
WoQTqAEuLCwZc/graq0f5f+4WB/Sh+FMMtieJyDWsCSXNhZ/YXusLt3hsv46aTQb
9BwrEwhYSTtvA+mq7TOrwEFq2O8BK0Mv6wF+y966dSNl94dF8ussnUym1k+ZBMvw
Z3ywLOp5LT1+8Vu/wLqmw261eED8ttlQVjdoQ1G8U4UCKKNnuPHl6um8Wfi18ZoD
GpDdFzhgOHQsRtyF0JQRkzMTCwKH5ZwaCTXlvMFWmU8MVRBfhMEww0XZyfBBCVnp
XQIDAQABo1MwUTAdBgNVHQ4EFgQU53Q58P3OMgQwjXqu5TK6dlfRjj4wHwYDVR0j
BBgwFoAU53Q58P3OMgQwjXqu5TK6dlfRjj4wDwYDVR0TAQH/BAUwAwEB/zANBgkq
hkiG9w0BAQsFAAOCAQEANLQgiYA5awIdCI+opK+S/qn9G//TWonh9iuioEkVjyNj
Lr3/+JsWxpr3rEyWQ0W4IMpr/N14755+sLgTsl8SkyEywcoEGeEFLyBR+uJXYSre
oTRYLH0SF8mwccN6sDtdFX0FxPvHvfRrLAleefdrkRuPv84RvHoKyUQ8eGMIdYZl
d4EaEldyC90X5DU9RDT91VSgcuUEj+EjI04wFcrIs8OPs6y+72x6e5ZxZWJzfLbL
xfYaI7E/waTO0tzzYM/MeEMQE8RXQ1b8UQVlw/SUpG9DJvbut1qv85yVcGZ/wMv0
RHazE7tA+SrvFJIk4TH3e5h/xaBEQclXhgRgt0Ha5w==
-----END CERTIFICATE-----`;
const X509_SPKI_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkg4KUaf5Uxgj/jqlqW6K
O47q+Gnb4mAGk7Ua+Za3i0gkwT4S4j0h3vink8SZHnz16Gu1vGeyY/ypJEwWouF6
WoQTqAEuLCwZc/graq0f5f+4WB/Sh+FMMtieJyDWsCSXNhZ/YXusLt3hsv46aTQb
9BwrEwhYSTtvA+mq7TOrwEFq2O8BK0Mv6wF+y966dSNl94dF8ussnUym1k+ZBMvw
Z3ywLOp5LT1+8Vu/wLqmw261eED8ttlQVjdoQ1G8U4UCKKNnuPHl6um8Wfi18ZoD
GpDdFzhgOHQsRtyF0JQRkzMTCwKH5ZwaCTXlvMFWmU8MVRBfhMEww0XZyfBBCVnp
XQIDAQAB
-----END PUBLIC KEY-----`;

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
        `${variable} is required: the SAML completion suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
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
      `${tag}.sql does not exist: the T05.03 SAML surface sits on the verified T02.01–T02.06 + T05.01 + T05.02 stack, and a missing prerequisite is a workspace problem, not a target behavior.`,
    );
  }
  return readFileSync(path, "utf8");
}

interface Harness {
  /** Setup connection: DDL, seeds, read-back probes. */
  sql: postgres.Sql;
  /** The production client on the auth-writer capability connection. */
  writer: ReturnType<typeof createDatabase>;
  /** The BA-runtime connection the provider registry reads through. */
  registryDb: ReturnType<typeof createDatabase>;
  /** The locally-signing SAML IdP the assertions answer. */
  idp: SamlTestIdp;
  close(): Promise<void>;
}

let harnessState: Harness | undefined;

/**
 * Returns the island to the pre-T05.03 shape: the 0219 functions and policy
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
    DO $t0503_cleanup$
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
    $t0503_cleanup$`);
  await sql.unsafe(
    `DROP TABLE IF EXISTS ${BA_TABLES.map((name) => `"${name}"`).join(", ")} CASCADE`,
  );
  // 0210/0212 ALTER existing enterprise tables; normalize exactly as the
  // sibling suites do, so the island's post-suite shape is identical from
  // any starting state.
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
  await sql`DELETE FROM accounts WHERE user_id LIKE 't0503-%'`.catch(() => {});
  await sql`DELETE FROM sso_providers WHERE provider_id LIKE 't0503-%'`.catch(
    () => {},
  );
  await sql`DELETE FROM auth_members WHERE id LIKE 't0503-%'`.catch(() => {});
  await sql`DELETE FROM enterprise_principals WHERE user_id LIKE 't0503-%'`.catch(
    () => {},
  );
  await sql`DELETE FROM auth_eligibility_clocks WHERE tenant_id LIKE 't0503-%'`.catch(
    () => {},
  );
  await sql`DELETE FROM sessions WHERE id LIKE 't0503-%'`;
  await sql`DELETE FROM users WHERE id LIKE 't0503-%'`;
  await sql`DELETE FROM enterprise_tenants WHERE id LIKE 't0503-%'`;
}

/**
 * The company, the member user with their original and rotation-final
 * sessions, the identity binding (IdP entity ID, NameID) → USER in accounts,
 * the issuance generations on the principal and the company eligibility
 * clock, and the stored 0219 policy row with protocol `saml`. The directory
 * tables' DML guard is suspended for exactly the org/member inserts (the
 * sibling suites' pattern) and re-enabled before any flow runs.
 */
async function seedBaselineFixture(
  sql: postgres.Sql,
  idpEntityId: string,
): Promise<void> {
  await sql`
    INSERT INTO enterprise_tenants (id, name) VALUES
      (${TENANT}, 'T05.03 company')`;
  await sql`
    INSERT INTO users (id, email) VALUES
      (${USER}, 't0503-user@example.test')`;
  await sql`
    INSERT INTO sessions (id, user_id, token, expires_at) VALUES
      (${SESSION}, ${USER}, 't0503-token', now() + interval '2 hours'),
      (${FINAL_SESSION}, ${USER}, 't0503-token-final', now() + interval '3 hours')`;
  await sql`
    INSERT INTO accounts (id, account_id, provider_id, user_id, issuer)
    VALUES ('t0503-account', ${SUBJECT}, ${PROVIDER}, ${USER}, ${idpEntityId})`;
  await sql`
    INSERT INTO enterprise_principals (id, user_id, identity_generation)
    VALUES ('t0503-principal', ${USER}, ${IDENTITY_GENERATION})`;
  await sql`
    INSERT INTO auth_eligibility_clocks
      (tenant_id, principal_id, kind, scope_id, epoch, generation, tombstone, last_command_id)
    VALUES (${TENANT}, 't0503-principal', 'company', ${TENANT}, 1, ${COMPANY_GENERATION}, false, 't0503-seed')`;
  await sql`
    INSERT INTO auth_company_auth_policies
      (tenant_id, provider_id, protocol, policy_revision, max_auth_age_seconds)
    VALUES (${TENANT}, ${PROVIDER}, 'saml', ${POLICY_REVISION}, ${MAX_AUTH_AGE_SECONDS})`;
  for (const [table, trigger] of [
    ["auth_organizations", "auth_directory_dml_guard"],
    ["auth_members", "auth_directory_dml_guard"],
  ] as const) {
    await sql.unsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
  }
  try {
    await sql`
      INSERT INTO auth_organizations (id, name, slug) VALUES
        (${TENANT}, 'T05.03 company', 't0503-org')`;
    await sql`
      INSERT INTO auth_members (id, organization_id, user_id, role) VALUES
        ('t0503-member', ${TENANT}, ${USER}, 'member')`;
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
  const idp = await createSamlTestIdp();
  try {
    await cleanupFixture(sql);
    for (const tag of [...PREREQUISITE_TAGS, MIGRATION_TAG]) {
      await sql.unsafe(migrationSql(tag));
    }
    await seedBaselineFixture(sql, idp.entityId);
    const writer = createDatabase(
      process.env.BA_TEST_AUTH_WRITER_DATABASE_URL!.trim(),
      { max: 4 },
    );
    const registryDb = createDatabase(process.env[DATABASE_VARIABLE]!.trim(), {
      max: 2,
    });
    return {
      sql,
      writer,
      registryDb,
      idp,
      close: async () => {
        try {
          await cleanupFixture(sql);
        } finally {
          await writer.$client.close?.();
          await registryDb.$client.close?.();
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
  if (!harnessState) throw new Error("SAML harness is not initialized");
  return harnessState;
}

/**
 * The registered provider rows, sealed the way the deployment's adapter seals
 * them: the Better Auth registration JSON inside the AES-GCM envelope. The
 * main provider carries the IdP's SPKI key directly; the X.509 one carries a
 * certificate, the registration schema's actual shape. Both rows deliberately
 * name an issuer column that is NOT the IdP entity ID, so a read that
 * consulted the wrong field fails the flow instead of passing silently.
 */
async function seedProviderRegistration(): Promise<void> {
  const { idp } = harness();
  const samlConfig = JSON.stringify({
    entryPoint: IDP_ENTRY_POINT,
    cert: idp.signingKeyPem,
    idpMetadata: { entityID: idp.entityId },
    spMetadata: { entityID: SP_ENTITY_ID },
  });
  await harness().sql`
    INSERT INTO sso_providers (id, issuer, saml_config, provider_id, domain)
    VALUES (
      't0503-provider-row',
      'https://t0503-issuer-column.example.test',
      ${await encryptSecret(ENCRYPTION_KEY, samlConfig)},
      ${PROVIDER},
      't0503.example.test'
    )`;
  const x509Config = JSON.stringify({
    entryPoint: "https://idp.t0503-x509.example.test/sso",
    cert: X509_CERT_PEM,
    idpMetadata: { entityID: "urn:openbot:test:t0503-x509-idp" },
    spMetadata: { entityID: SP_ENTITY_ID },
  });
  await harness().sql`
    INSERT INTO sso_providers (id, issuer, saml_config, provider_id, domain)
    VALUES (
      't0503-x509-provider-row',
      'https://t0503-x509-issuer.example.test',
      ${await encryptSecret(ENCRYPTION_KEY, x509Config)},
      ${X509_PROVIDER},
      't0503-x509.example.test'
    )`;
}

/*
 * ── T05.03 assembly ────────────────────────────────────────────────────────
 * The live factory over the REAL 0218/0219 storage, the REAL evidence bridge,
 * the REAL stored provider registry (findSaml/samlAuthorization over the
 * sealed saml_config row) and the REAL SAML redirect builder — the whole
 * policy protocol=saml consumption path, not a stand-in.
 */

interface Assembly {
  assurance: CompanyAssurance;
  app: Hono;
  providers: ReturnType<typeof createStoredSsoProviders>;
}

let assemblyState: Assembly | undefined;

function createAssembly(): Assembly {
  const { writer, registryDb } = harness();

  const providers = createStoredSsoProviders({
    database: registryDb,
    encryptionKey: ENCRYPTION_KEY,
    redirectOrigin: REDIRECT_ORIGIN,
  });
  const challengeStore = createSsoChallengeStore({
    database: writer,
    encryptionKey: ENCRYPTION_KEY,
  });
  const evidence = createSsoEvidenceBridge({
    challenges: challengeStore,
    providers: providers.registry,
  });
  const policyViews = createStoredCompanyAuthPolicyViews({
    database: writer,
  });
  const assurance = createCompanyAssurance({
    policy: policyViews.proof,
    challengePolicy: policyViews.challenge,
    redirect: createSamlRedirectBuilder({ providers }),
    database: writer,
    authority: createDirectoryAuthority(),
    encryptionKey: ENCRYPTION_KEY,
    evidence,
    sessions: {
      resolveCurrent: async (request: Request) => {
        const cookie = request.headers.get("cookie") ?? "";
        if (cookie.includes("t0503-final"))
          return { userId: USER, sessionId: FINAL_SESSION };
        if (cookie.includes("t0503-live"))
          return { userId: USER, sessionId: SESSION };
        return null;
      },
    },
  });

  const app = new Hono();
  app.route(
    "/api/enterprise/company-auth",
    createCompanyAuthRoutes({
      authenticate: async (request) => {
        const cookie = request.headers.get("cookie") ?? "";
        if (cookie.includes("t0503-live"))
          return { userId: USER, sessionId: SESSION };
        return null;
      },
      assurance,
    }),
  );
  return { assurance, app, providers };
}

function assembly(): Assembly {
  if (!assemblyState) throw new Error("assembly is not initialized");
  return assemblyState;
}

type StoredProof = {
  assurance_id: string;
  user_id: string;
  session_id: string;
  tenant_id: string;
  challenge_id: string;
  provider_id: string;
  authentication_method: string;
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
           provider_id, authentication_method, issuer, subject,
           authenticated_at, strength, expires_at,
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

interface AuthnRequestView {
  /** The AuthnRequest's ID — what a real IdP echoes as InResponseTo. */
  requestId: string;
  /** The RelayState the redirect carried — what the ACS form must echo. */
  relayState: string;
  /** The inflated AuthnRequest document. */
  document: string;
}

/**
 * The SP half of the front channel, as the IdP would read it: parse the
 * challenge's redirect, inflate the SAMLRequest (raw DEFLATE + base64, the
 * HTTP-Redirect binding) and hand back the carried correlation tokens.
 */
function readAuthnRequest(redirectUrl: string): AuthnRequestView {
  const url = new URL(redirectUrl);
  const samlRequest = url.searchParams.get("SAMLRequest");
  const relayState = url.searchParams.get("RelayState");
  if (!samlRequest || !relayState) {
    throw new Error(
      "the challenge redirect carries no SAMLRequest/RelayState — the AuthnRequest builder did not run",
    );
  }
  const document = inflateRawSync(
    Buffer.from(samlRequest, "base64"),
  ).toString();
  const requestId = /ID="([^"]+)"/.exec(document)?.[1];
  if (!requestId) {
    throw new Error("the AuthnRequest names no ID");
  }
  return { requestId, relayState, document };
}

/** The signed authentication time every happy-path assertion carries. */
function freshWindow(): { authnInstant: number; date: Date } {
  const authnInstant = Math.floor(Date.now() / 1000) - 120;
  return { authnInstant, date: new Date(authnInstant * 1000) };
}

/**
 * The whole §9.1 SAML front channel, as the browser runs it: take the
 * challenge's AuthnRequest redirect, have the IdP sign the Response that
 * answers it, and arrive at the ACS route with the protocol's form POST.
 */
async function walkSaml(
  redirectUrl: string,
  options: {
    /** Overrides handed to the IdP signer (the negative cases' ammunition). */
    assertion?: Partial<Parameters<SamlTestIdp["assertion"]>[0]>;
    /** The form's RelayState, when it is not the redirect's own (tamper). */
    relayState?: string;
    omitRelayState?: boolean;
    cookie?: string;
    method?: string;
    contentType?: string;
    rawBody?: string;
  } = {},
): Promise<{ response: Response; authn: AuthnRequestView }> {
  const authn = readAuthnRequest(redirectUrl);
  const now = Math.floor(Date.now() / 1000);
  const samlResponse = await harness().idp.assertion({
    inResponseTo: authn.requestId,
    acsUrl: ACS_URL,
    spEntityId: SP_ENTITY_ID,
    authnInstant: now - 120,
    issueInstant: now - 60,
    notBefore: now - 300,
    notOnOrAfter: now + 300,
    ...options.assertion,
  });
  const form = new URLSearchParams({ SAMLResponse: samlResponse });
  if (!options.omitRelayState) {
    form.set("RelayState", options.relayState ?? authn.relayState);
  }
  const headers: Record<string, string> = {
    "content-type": options.contentType ?? "application/x-www-form-urlencoded",
  };
  if (options.cookie) headers.cookie = options.cookie;
  const response = await assembly().app.request(ACS_PATH, {
    method: options.method ?? "POST",
    headers,
    body: options.rawBody ?? form.toString(),
  });
  return { response, authn };
}

describe("T05.03 company auth SAML ACS completion (#559)", () => {
  beforeAll(async () => {
    harnessState = await createHarness();
    await seedProviderRegistration();
    assemblyState = createAssembly();
  }, 180_000);

  test("saml_completion_uses_assertion_time_and_strength", {
    timeout: 120_000,
  }, async () => {
    const { sql, idp } = harness();
    await setAuthority(sql, {
      version: 201,
      phase: "M4",
      directoryAuthority: "ba",
    });
    await resetFlowState();
    const issued = await assembly().assurance.challenge(ACTOR, {
      tenantId: TENANT,
      returnPath: RETURN_PATH,
    });

    // The challenge's redirect IS this SP's AuthnRequest: the IdP's entry
    // point, the challenge's correlation tokens, and this SP's own names.
    const redirectUrl = new URL(issued.redirectUrl);
    expect(redirectUrl.origin + redirectUrl.pathname).toBe(IDP_ENTRY_POINT);
    const authn = readAuthnRequest(issued.redirectUrl);
    expect(authn.requestId.startsWith("_")).toBe(true);
    expect(authn.document).toContain(`Destination="${IDP_ENTRY_POINT}"`);
    expect(authn.document).toContain(
      `AssertionConsumerServiceURL="${ACS_URL}"`,
    );
    expect(authn.document).toContain(
      `<saml:Issuer>${SP_ENTITY_ID}</saml:Issuer>`,
    );

    const { authnInstant, date: authenticationTime } = freshWindow();
    const { response } = await walkSaml(issued.redirectUrl, {
      cookie: "t0503-final",
      assertion: {
        authnInstant,
        authnContextClassRef: AUTHN_CONTEXT_CLASS,
      },
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(RETURN_PATH);

    // The proof: exactly one, bound to the final session and this company,
    // its authenticated_at the SIGNED AuthnInstant — not the callback clock —
    // and its strength the SIGNED AuthnContextClassRef.
    const proofs = await storedProofs();
    expect(proofs).toHaveLength(1);
    const proof = proofs[0]!;
    expect(proof.authenticated_at).toEqual(authenticationTime);
    expect(proof.strength).toBe(AUTHN_CONTEXT_CLASS);
    expect(proof.session_id).toBe(FINAL_SESSION);
    expect(proof.tenant_id).toBe(TENANT);
    expect(proof.user_id).toBe(USER);
    expect(proof.challenge_id).toBe(issued.challengeId);
    expect(proof.provider_id).toBe(PROVIDER);
    expect(proof.authentication_method).toBe("saml");
    expect(proof.issuer).toBe(idp.entityId);
    expect(proof.subject).toBe(SUBJECT);
    expect(proof.status).toBe("active");
    expect(proof.policy_revision).toBe(POLICY_REVISION);
    expect(proof.identity_generation).toBe(IDENTITY_GENERATION);
    expect(proof.company_generation).toBe(COMPANY_GENERATION);
    // §9.1: the proof expires with the session or the policy's max age,
    // judged from the signed authentication time — here the max age.
    expect(proof.expires_at.getTime()).toBe(
      authenticationTime.getTime() + MAX_AUTH_AGE_SECONDS * 1000,
    );
    // The challenge: consumed exactly once, never deleted.
    const [challenge] = await harness().sql<{ consumed_at: Date | null }[]>`
        SELECT consumed_at FROM auth_company_auth_challenges
         WHERE challenge_id = ${issued.challengeId}`;
    expect(challenge?.consumed_at).not.toBeNull();
  });

  test("relay_state_or_in_response_to_tamper_never_commits_proof", {
    timeout: 120_000,
  }, async () => {
    const { sql } = harness();
    await setAuthority(sql, {
      version: 203,
      phase: "M4",
      directoryAuthority: "ba",
    });
    await resetFlowState();
    expect(await storedProofs()).toHaveLength(0);

    // (a) A forged RelayState answers no open challenge: the one-time gate
    // refuses before any assertion bytes are even read.
    const relayTampered = await assembly().assurance.challenge(ACTOR, {
      tenantId: TENANT,
      returnPath: RETURN_PATH,
    });
    const { response: relayResponse } = await walkSaml(
      relayTampered.redirectUrl,
      {
        cookie: "t0503-final",
        relayState: "t0503-forged-relay-state-nobody-issued",
      },
    );
    expect(relayResponse.status).toBe(400);
    expect((await relayResponse.json()).error.code).toBe(
      "SSO_CHALLENGE_MISSING_OR_CONSUMED",
    );

    // (b) A correctly-SIGNED response whose Response-level InResponseTo names
    // a foreign AuthnRequest: the binding to the persisted challenge refuses.
    const responseForged = await assembly().assurance.challenge(ACTOR, {
      tenantId: TENANT,
      returnPath: RETURN_PATH,
    });
    const { response: forgedResponse } = await walkSaml(
      responseForged.redirectUrl,
      {
        cookie: "t0503-final",
        assertion: { inResponseTo: "_t0503-forged-authn-request" },
      },
    );
    expect(forgedResponse.status).toBe(400);
    expect((await forgedResponse.json()).error.code).toBe(
      "SSO_SAML_IN_RESPONSE_TO_MISMATCH",
    );

    // (c) Only the bearer confirmation's InResponseTo is foreign: the
    // signature verifies over that very content, and the post-verification
    // binding check still refuses.
    const subjectForged = await assembly().assurance.challenge(ACTOR, {
      tenantId: TENANT,
      returnPath: RETURN_PATH,
    });
    const { response: subjectResponse } = await walkSaml(
      subjectForged.redirectUrl,
      {
        cookie: "t0503-final",
        assertion: { subjectInResponseTo: "_t0503-forged-authn-request" },
      },
    );
    expect(subjectResponse.status).toBe(400);
    expect((await subjectResponse.json()).error.code).toBe(
      "SSO_SAML_IN_RESPONSE_TO_MISMATCH",
    );

    // Three refusals, zero proof rows — the named expectation.
    expect(await storedProofs()).toHaveLength(0);
  });

  test("unsigned_or_foreign_signature_never_commits_proof", {
    timeout: 120_000,
  }, async () => {
    const { sql } = harness();
    await setAuthority(sql, {
      version: 205,
      phase: "M4",
      directoryAuthority: "ba",
    });
    await resetFlowState();

    const unsigned = await assembly().assurance.challenge(ACTOR, {
      tenantId: TENANT,
      returnPath: RETURN_PATH,
    });
    const { response: unsignedResponse } = await walkSaml(
      unsigned.redirectUrl,
      {
        cookie: "t0503-final",
        assertion: { signature: "unsigned" },
      },
    );
    expect(unsignedResponse.status).toBe(400);
    expect((await unsignedResponse.json()).error.code).toBe(
      "SSO_SAML_ASSERTION_UNSIGNED",
    );

    const foreign = await assembly().assurance.challenge(ACTOR, {
      tenantId: TENANT,
      returnPath: RETURN_PATH,
    });
    const { response: foreignResponse } = await walkSaml(foreign.redirectUrl, {
      cookie: "t0503-final",
      assertion: { signature: "foreign" },
    });
    expect(foreignResponse.status).toBe(400);
    expect((await foreignResponse.json()).error.code).toBe(
      "SSO_SAML_SIGNATURE_INVALID",
    );
    expect(await storedProofs()).toHaveLength(0);
  });

  test("audience_recipient_or_destination_mismatch_refuses", {
    timeout: 120_000,
  }, async () => {
    const { sql } = harness();
    await setAuthority(sql, {
      version: 207,
      phase: "M4",
      directoryAuthority: "ba",
    });
    await resetFlowState();

    const cases = [
      {
        assertion: { audience: "http://openbot.test/saml/another-sp" },
        code: "SSO_SAML_AUDIENCE_MISMATCH",
      },
      {
        assertion: { recipient: "http://openbot.test/api/elsewhere" },
        code: "SSO_SAML_RECIPIENT_MISMATCH",
      },
      {
        assertion: { destination: "http://openbot.test/api/elsewhere" },
        code: "SSO_SAML_RECIPIENT_MISMATCH",
      },
    ] as const;
    for (const { assertion, code } of cases) {
      const issued = await assembly().assurance.challenge(ACTOR, {
        tenantId: TENANT,
        returnPath: RETURN_PATH,
      });
      const { response } = await walkSaml(issued.redirectUrl, {
        cookie: "t0503-final",
        assertion,
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe(code);
    }
    expect(await storedProofs()).toHaveLength(0);
  });

  test("expired_confirmation_window_refuses", {
    timeout: 120_000,
  }, async () => {
    const { sql } = harness();
    await setAuthority(sql, {
      version: 209,
      phase: "M4",
      directoryAuthority: "ba",
    });
    await resetFlowState();
    const issued = await assembly().assurance.challenge(ACTOR, {
      tenantId: TENANT,
      returnPath: RETURN_PATH,
    });
    const now = Math.floor(Date.now() / 1000);
    const { response } = await walkSaml(issued.redirectUrl, {
      cookie: "t0503-final",
      assertion: {
        // A bearer window already closed: the assertion was for then, not now.
        notOnOrAfter: now - 10,
        authnInstant: now - 600,
        issueInstant: now - 600,
        notBefore: now - 900,
      },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("SSO_SAML_TIME_INVALID");
    expect(await storedProofs()).toHaveLength(0);
  });

  test("acs_accepts_only_the_protocol_form_post", {
    timeout: 120_000,
  }, async () => {
    const { sql } = harness();
    await setAuthority(sql, {
      version: 211,
      phase: "M4",
      directoryAuthority: "ba",
    });
    await resetFlowState();

    // A JSON claims body is not a protocol response — the ticket's "不收
    // JSON claims" — however plausible its contents.
    const jsonIssued = await assembly().assurance.challenge(ACTOR, {
      tenantId: TENANT,
      returnPath: RETURN_PATH,
    });
    const { response: jsonResponse } = await walkSaml(jsonIssued.redirectUrl, {
      cookie: "t0503-final",
      contentType: "application/json",
      rawBody: JSON.stringify({
        issuer: harness().idp.entityId,
        subject: SUBJECT,
        authenticatedAt: new Date().toISOString(),
      }),
    });
    expect(jsonResponse.status).toBe(400);
    expect((await jsonResponse.json()).error.code).toBe(
      "SSO_REQUEST_UNRECOGNIZED",
    );

    // A form POST without its RelayState is not a protocol response either.
    const noRelay = await assembly().assurance.challenge(ACTOR, {
      tenantId: TENANT,
      returnPath: RETURN_PATH,
    });
    const { response: noRelayResponse } = await walkSaml(noRelay.redirectUrl, {
      cookie: "t0503-final",
      omitRelayState: true,
    });
    expect(noRelayResponse.status).toBe(400);
    expect((await noRelayResponse.json()).error.code).toBe(
      "SSO_REQUEST_UNRECOGNIZED",
    );

    // The ACS is the POST binding only: a GET has no route to the evidence.
    const getResponse = await assembly().app.request(ACS_PATH, {
      method: "GET",
    });
    expect(getResponse.status).toBe(404);

    expect(await storedProofs()).toHaveLength(0);
  });

  test("legacy_and_paused_authority_close_the_acs", {
    timeout: 120_000,
  }, async () => {
    const { sql } = harness();
    await setAuthority(sql, {
      version: 213,
      phase: "M4",
      directoryAuthority: "ba",
    });
    await resetFlowState();

    // Legacy (M1): BA runtime writes are closed before M4.
    const legacyIssued = await assembly().assurance.challenge(ACTOR, {
      tenantId: TENANT,
      returnPath: RETURN_PATH,
    });
    await setAuthority(sql, {
      version: 214,
      phase: "M1",
      directoryAuthority: "legacy",
    });
    const { response: legacyResponse } = await walkSaml(
      legacyIssued.redirectUrl,
      { cookie: "t0503-final" },
    );
    expect(legacyResponse.status).toBe(503);
    expect((await legacyResponse.json()).error.code).toBe(
      DIRECTORY_WRITE_AUTHORITY_CLOSED,
    );
    expect(await storedProofs()).toHaveLength(0);

    // Paused (M2): every writer is paused, including this one. The spent
    // RelayState from the legacy attempt answers nothing, so a fresh flow
    // runs.
    await setAuthority(sql, {
      version: 215,
      phase: "M4",
      directoryAuthority: "ba",
    });
    await resetFlowState();
    const pausedIssued = await assembly().assurance.challenge(ACTOR, {
      tenantId: TENANT,
      returnPath: RETURN_PATH,
    });
    await setAuthority(sql, {
      version: 216,
      phase: "M2",
      directoryAuthority: "paused",
    });
    const { response: pausedResponse } = await walkSaml(
      pausedIssued.redirectUrl,
      { cookie: "t0503-final" },
    );
    expect(pausedResponse.status).toBe(503);
    expect((await pausedResponse.json()).error.code).toBe(
      DIRECTORY_MIGRATION_PAUSED,
    );
    expect(await storedProofs()).toHaveLength(0);
  });

  test("replayed_acs_post_creates_no_second_proof", {
    timeout: 120_000,
  }, async () => {
    const { sql } = harness();
    await setAuthority(sql, {
      version: 217,
      phase: "M4",
      directoryAuthority: "ba",
    });
    await resetFlowState();
    const issued = await assembly().assurance.challenge(ACTOR, {
      tenantId: TENANT,
      returnPath: RETURN_PATH,
    });
    const authn = readAuthnRequest(issued.redirectUrl);
    const now = Math.floor(Date.now() / 1000);
    const samlResponse = await harness().idp.assertion({
      inResponseTo: authn.requestId,
      acsUrl: ACS_URL,
      spEntityId: SP_ENTITY_ID,
      authnInstant: now - 120,
      issueInstant: now - 60,
      notBefore: now - 300,
      notOnOrAfter: now + 300,
    });
    const body = new URLSearchParams({
      SAMLResponse: samlResponse,
      RelayState: authn.relayState,
    }).toString();
    const post = () =>
      assembly().app.request(ACS_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: "t0503-final",
        },
        body,
      });
    const first = await post();
    expect(first.status).toBe(303);
    expect(await storedProofs()).toHaveLength(1);

    // The replay: the same RelayState is spent, the bridge refuses first.
    const second = await post();
    expect(second.status).toBe(400);
    expect((await second.json()).error.code).toBe(
      "SSO_CHALLENGE_MISSING_OR_CONSUMED",
    );
    expect(await storedProofs()).toHaveLength(1);
  });

  test("logged_out_acs_binds_nobody", { timeout: 120_000 }, async () => {
    const { sql } = harness();
    await setAuthority(sql, {
      version: 219,
      phase: "M4",
      directoryAuthority: "ba",
    });
    await resetFlowState();
    const issued = await assembly().assurance.challenge(ACTOR, {
      tenantId: TENANT,
      returnPath: RETURN_PATH,
    });
    // The ACS POST arrives with no live session at all: 401, no proof.
    const { response } = await walkSaml(issued.redirectUrl);
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("SESSION_EXPIRED");
    expect(await storedProofs()).toHaveLength(0);
  });

  test("closed_complete_answers_503", { timeout: 120_000 }, async () => {
    const { sql, writer } = harness();
    await setAuthority(sql, {
      version: 221,
      phase: "M4",
      directoryAuthority: "ba",
    });
    await resetFlowState();
    // A factory assembled without the evidence bridge keeps the closed
    // surface: the ACS route answers the controlled 503, never a guess.
    const policyViews = createStoredCompanyAuthPolicyViews({
      database: writer,
    });
    const providers = createStoredSsoProviders({
      database: harness().registryDb,
      encryptionKey: ENCRYPTION_KEY,
      redirectOrigin: REDIRECT_ORIGIN,
    });
    const closed = createCompanyAssurance({
      policy: policyViews.proof,
      challengePolicy: policyViews.challenge,
      redirect: createSamlRedirectBuilder({ providers }),
      database: writer,
      authority: createDirectoryAuthority(),
      encryptionKey: ENCRYPTION_KEY,
    });
    try {
      await closed.complete(
        new Request(`${REDIRECT_ORIGIN}${ACS_PATH}`, { method: "POST" }),
      );
      throw new Error("the closed complete accepted a callback");
    } catch (error) {
      expect(error).toMatchObject({
        status: 503,
        code: COMPANY_AUTH_NOT_READY,
      });
    }
    expect(await storedProofs()).toHaveLength(0);
  });

  test("x509_certificate_registration_reads_as_its_spki", {
    timeout: 120_000,
  }, async () => {
    // The registration schema's real shape is an X.509 certificate; the
    // registry reads it as the SAME public key in the SPKI form the verifier
    // imports. Compared on the base64 body: PEM armor and line wrapping are
    // transport spelling, not key material.
    const bodyOf = (pem: string) => pem.replace(/-----[^-]+-----|\s/g, "");
    const provider =
      await assembly().providers.registry.findSaml(X509_PROVIDER);
    expect(provider).not.toBeNull();
    expect(provider!.issuer).toBe("urn:openbot:test:t0503-x509-idp");
    expect(provider!.spEntityId).toBe(SP_ENTITY_ID);
    expect(provider!.acsUrl).toBe(
      `${REDIRECT_ORIGIN}/api/enterprise/company-auth/saml/acs/${X509_PROVIDER}`,
    );
    expect(provider!.signingKeys.map(bodyOf)).toEqual([bodyOf(X509_SPKI_PEM)]);

    const authorization =
      await assembly().providers.samlAuthorization(X509_PROVIDER);
    expect(authorization).toEqual({
      entryPoint: "https://idp.t0503-x509.example.test/sso",
      spEntityId: SP_ENTITY_ID,
      acsUrl: `${REDIRECT_ORIGIN}/api/enterprise/company-auth/saml/acs/${X509_PROVIDER}`,
    });

    // The OIDC views of the same source stay untouched by the SAML half.
    expect(await assembly().providers.registry.find(X509_PROVIDER)).toBeNull();
    expect(await assembly().providers.authorization(X509_PROVIDER)).toBeNull();
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
        SELECT id FROM users WHERE id LIKE 't0503-%'`;
      expect([...rows]).toEqual([]);
      const tenants = await probe`
        SELECT id FROM enterprise_tenants WHERE id LIKE 't0503-%'`;
      expect([...tenants]).toEqual([]);
    } finally {
      await probe.end({ timeout: 5 }).catch(() => {});
    }
  });
});
