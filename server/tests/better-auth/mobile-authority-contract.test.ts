import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { createCompanyAssurance } from "../../src/auth/company-assurance";
import { createDirectoryAuthority } from "../../src/auth/directory/authority";
import {
  createMobileSessionHandoff,
  type MobileHandoffClient,
} from "../../src/auth/mobile-session";
import { createMobileSessionRoutes } from "../../src/auth/mobile-session-routes";
import { createDatabase } from "../../src/db/client";
import { authMobileSessionAdmissions, sessions } from "../../src/db/schema";

/*
 * T05.13 (#569, original task P12; interfaces §5.2 / F2) — the per-action
 * online admission of the mobile authority contract, as database facts and
 * real HTTP:
 *
 * - `bff_service_credentials_cannot_forge_actor_or_reuse_admission`: a body
 *   that speaks an actor of its own answers 403, and the same requestId
 *   under the same handle never admits twice
 *   (expect(status).toBe(403)) — the actor is the handle's, never the
 *   caller's, and one admission covers exactly one action.
 * - `revoked_session_is_refused_on_next_operation`: after the BA session is
 *   revoked, the NEXT authorize — a fresh requestId, so no fence could save
 *   it — answers 401 (expect(nextStatus).toBe(401)): nothing positive is
 *   cached between admissions.
 *
 * Supporting: the admission response is the frozen contract (actor from the
 * handle row, admissionId stored only as its digest, no bearer token at
 * all); an expired or unknown handle, a re-keyed principal, a changed
 * remote binding and a suspended identity each refuse on their next
 * operation; the operation whitelist and the scope-selector rules (missing,
 * conflicting, header-against-body) answer 400; a company-scoped admission
 * re-checks the same eligibility facts the scope lister reads (404, no side
 * channel), a company whose policy demands proof without a fresh one gets
 * 403 COMPANY_REAUTH_REQUIRED, and an assembly without the assurance
 * dependency fails closed at 503 AUTHORITY_UNAVAILABLE.
 *
 * The five BA_TEST_* URLs are all required and must name one isolated
 * openbot_enterprise_* database. No DSN is ever printed. The suite replays
 * its own BA chain (0209–0223) and removes exactly what it added, auth_
 * function family included, so the island stays clean for the leak probe.
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

const MIGRATION_TAG = "0235_better_auth_mobile_session_admission";
/**
 * The verified BA chain the admission reads ride on: the directory tables and
 * command model (T02.01–T02.06), the assurance/authority-source alterations
 * to the enterprise tables — enterprise_principals.identity_generation among
 * them — and the T03–T05 guard amendments, applied in journal order and
 * normalized away again at cleanup, exactly the discipline the sibling BA
 * suites keep on this island.
 */
const PREREQUISITE_TAGS = [
  "0221_better_auth_directory",
  "0222_better_auth_clocks",
  "0223_better_auth_command_authority",
  "0224_better_auth_authority_sources",
  "0225_better_auth_assurance",
  "0226_better_auth_schema_roles",
  "0227_better_auth_company_lifecycle",
  "0228_better_auth_invitation_resend",
  "0229_better_auth_team_management_grants",
  "0230_better_auth_company_auth_challenge",
  "0231_better_auth_company_auth_complete",
  "0232_better_auth_company_auth_policy_read",
  "0233_better_auth_provisioning_rules",
  "0234_better_auth_mobile_session_handoff",
] as const;

const PREFIX = "t0513";
const EMAIL_DOMAIN = "@t0513.example.test";

const USER = "t0513-user";
const SESSION = "t0513-session";
const REVOKE_SESSION = "t0513-session-revoke";
const PRINCIPAL = "t0513-principal";
const LIVE_TOKEN = "t0513-token";
const REVOKE_TOKEN = "t0513-token-revoke";

const TENANT = "t0513-tenant";
const PROOF_TENANT = "t0513-tenant-proof";
const FOREIGN_TENANT = "t0513-tenant-foreign";
const WORKSPACE = "t0513-workspace";
const TEAM = "t0513-team";

const REDIRECT_A = "https://mobile.example.test/callback";
const AUTHORITY_A = "https://openbot.example.test";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"; // RFC 7636 appendix B

const CLIENT_A: MobileHandoffClient = {
  clientId: "openmuse-mobile",
  redirectUri: REDIRECT_A,
  authorityOrigin: AUTHORITY_A,
  bffServiceId: "openmuse-bff",
  bffCredentialDigest: createHash("sha256")
    .update("t0513-bff-secret-a")
    .digest("hex"),
};
const CLIENT_B: MobileHandoffClient = {
  clientId: "other-mobile",
  redirectUri: "https://other.example.test/cb",
  authorityOrigin: "https://other-authority.example.test",
  bffServiceId: "other-bff",
  bffCredentialDigest: createHash("sha256")
    .update("t0513-bff-secret-b")
    .digest("hex"),
};

const ENCRYPTION_KEY = Buffer.from(new Uint8Array(32).fill(0x51)).toString(
  "base64",
);

const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const pkceChallenge = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

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
        `${variable} is required: the mobile-authority-contract suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
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

async function cleanupFixture(sql: postgres.Sql): Promise<void> {
  // The BA chain's tables (this suite's replay and any other suite's
  // leftovers) in one sweep; every statement is a no-op on a pristine
  // baseline so a crashed earlier run also recovers.
  await sql.unsafe(`
    DO $$
    DECLARE target record;
    BEGIN
      FOR target IN SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND (tablename LIKE 'auth_%' ESCAPE '')
      LOOP
        EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', target.tablename);
      END LOOP;
      FOR target IN SELECT proname FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND position('auth_' in proname) = 1
      LOOP
        EXECUTE format('DROP FUNCTION IF EXISTS public.%I CASCADE', target.proname);
      END LOOP;
    END $$;
  `);
  // 0210/0212 ALTER existing enterprise tables; normalize exactly as the
  // sibling BA suites do, so the island's post-suite shape is identical from
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
  // This suite's tenancy fixtures; the memberships cascade off their tenants.
  await sql`DELETE FROM enterprise_tenants WHERE id LIKE ${`${PREFIX}-%`}`;
  await sql`DELETE FROM enterprise_principals WHERE id LIKE ${`${PREFIX}-%`}`;
  await sql`DELETE FROM users WHERE email LIKE ${`%${EMAIL_DOMAIN}`}`;
}

interface HttpPlane {
  baseUrl: string;
  stop(): void;
}

let sql: postgres.Sql | undefined;
let database: ReturnType<typeof createDatabase> | undefined;
let plane: HttpPlane | undefined;
let barePlane: HttpPlane | undefined;

const basicAuth = (serviceId: string, secret: string) =>
  `Basic ${Buffer.from(`${serviceId}:${secret}`).toString("base64")}`;

describe("T05.13 mobile authority contract (#569)", () => {
  const handoffCode = async (sessionToken = LIVE_TOKEN) => {
    const params = new URLSearchParams({
      client_id: CLIENT_A.clientId,
      redirect_uri: REDIRECT_A,
      state: "t0513-state",
      code_challenge: pkceChallenge(VERIFIER),
      code_challenge_method: "S256",
    });
    const response = await fetch(
      `${plane!.baseUrl}/authorize?${params.toString()}`,
      {
        redirect: "manual",
        headers: { "x-test-session": sessionToken },
      },
    );
    expect(response.status).toBe(303);
    const url = new URL(response.headers.get("location")!);
    return {
      code: url.searchParams.get("code")!,
      intentId: url.searchParams.get("intentId")!,
    };
  };

  /** The full handoff: authorize in the browser, exchange at the BFF. */
  const issueHandle = async (sessionToken = LIVE_TOKEN) => {
    const { code, intentId } = await handoffCode(sessionToken);
    const response = await fetch(`${plane!.baseUrl}/session/exchange`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: basicAuth(CLIENT_A.bffServiceId, "t0513-bff-secret-a"),
      },
      body: JSON.stringify({
        authMode: "enterprise",
        intentId,
        code,
        codeVerifier: VERIFIER,
        redirectUri: REDIRECT_A,
      }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { token: string };
  };

  /** POST /session/authorize — the surface under contract. */
  const admit = (input: {
    handle: string;
    requestId: string;
    operation?: string;
    selector?: { tenantId: string; workspaceId?: string } | null;
    resourceId?: string | null;
    extra?: Record<string, unknown>;
    authorization?: string;
    headerTenant?: string;
    headerWorkspace?: string;
    bare?: boolean;
    omitAuthorization?: boolean;
  }): Promise<Response> => {
    const target = input.bare ? barePlane! : plane!;
    return fetch(`${target.baseUrl}/session/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.omitAuthorization
          ? {}
          : {
              authorization:
                input.authorization ??
                basicAuth(CLIENT_A.bffServiceId, "t0513-bff-secret-a"),
            }),
        ...(input.headerTenant
          ? { "x-openbot-tenant": input.headerTenant }
          : {}),
        ...(input.headerWorkspace
          ? { "x-openbot-workspace": input.headerWorkspace }
          : {}),
      },
      body: JSON.stringify({
        handle: input.handle,
        requestId: input.requestId,
        operation: input.operation ?? "scope.discover",
        ...(input.selector !== undefined ? { selectors: input.selector } : {}),
        ...(input.resourceId !== undefined
          ? { resourceId: input.resourceId }
          : {}),
        ...(input.extra ?? {}),
      }),
    });
  };

  const admissionRows = async (handle: string) =>
    database!
      .select()
      .from(authMobileSessionAdmissions)
      .where(eq(authMobileSessionAdmissions.handleDigest, sha256Hex(handle)));

  beforeAll(async () => {
    const setupUrl = readBaUrls();
    sql = postgres(setupUrl, { max: 4, idle_timeout: 5, onnotice: () => {} });
    await cleanupFixture(sql);
    for (const tag of [...PREREQUISITE_TAGS, MIGRATION_TAG]) {
      const path = join(import.meta.dirname, `../../drizzle/${tag}.sql`);
      if (!existsSync(path)) {
        throw new Error(`${tag}.sql does not exist.`);
      }
      for (const statement of readFileSync(path, "utf8").split(
        "--> statement-breakpoint",
      )) {
        const trimmed = statement.trim();
        if (trimmed) await sql.unsafe(trimmed);
      }
    }
    await sql`
      INSERT INTO users (id, email) VALUES (${USER}, ${`user${EMAIL_DOMAIN}`})`;
    await sql`
      INSERT INTO sessions (id, user_id, token, expires_at) VALUES
        (${SESSION}, ${USER}, ${LIVE_TOKEN}, now() + interval '2 hours'),
        (${REVOKE_SESSION}, ${USER}, ${REVOKE_TOKEN}, now() + interval '2 hours')`;
    await sql`
      INSERT INTO accounts (id, account_id, provider_id, issuer, user_id) VALUES
        (${"t0513-account"}, ${"t0513-subject"}, 'organization',
         'https://idp.example.test', ${USER})`;
    await sql`
      INSERT INTO enterprise_principals (id, user_id, status, identity_generation) VALUES
        (${PRINCIPAL}, ${USER}, 'active', 3)`;
    // The tenancy facts the company-scoped admissions re-check: an eligible
    // company, a proof-demanding company, a foreign company the user is no
    // member of, and one team.
    await sql`
      INSERT INTO enterprise_tenants (id, name) VALUES
        (${TENANT}, 'T05.13 company'),
        (${PROOF_TENANT}, 'T05.13 proof company'),
        (${FOREIGN_TENANT}, 'T05.13 foreign company')`;
    await sql`
      INSERT INTO enterprise_memberships (tenant_id, principal_id, role) VALUES
        (${TENANT}, ${PRINCIPAL}, 'member'),
        (${PROOF_TENANT}, ${PRINCIPAL}, 'member')`;
    await sql`
      INSERT INTO enterprise_workspaces (tenant_id, id, name) VALUES
        (${TENANT}, ${WORKSPACE}, 'T05.13 team')`;
    await sql`
      INSERT INTO enterprise_workspace_memberships (tenant_id, workspace_id, principal_id) VALUES
        (${TENANT}, ${WORKSPACE}, ${PRINCIPAL})`;
    for (const table of [
      "auth_organizations",
      "auth_teams",
      "auth_team_bindings",
      "auth_members",
      "auth_team_members",
    ]) {
      await sql.unsafe(
        `ALTER TABLE "${table}" DISABLE TRIGGER "auth_directory_dml_guard"`,
      );
    }
    try {
      await sql`
        INSERT INTO auth_organizations (id, name, slug) VALUES
          (${TENANT}, 'T05.13 company', 't0513-company'),
          (${PROOF_TENANT}, 'T05.13 proof company', 't0513-proof'),
          (${FOREIGN_TENANT}, 'T05.13 foreign company', 't0513-foreign')`;
      await sql`
        INSERT INTO auth_teams (id, organization_id, name)
        VALUES (${TEAM}, ${TENANT}, 'T05.13 team')`;
      await sql`
        INSERT INTO auth_team_bindings (tenant_id, workspace_id, team_id)
        VALUES (${TENANT}, ${WORKSPACE}, ${TEAM})`;
      await sql`
        INSERT INTO auth_members (id, organization_id, user_id, role) VALUES
          ('t0513-member', ${TENANT}, ${USER}, 'member'),
          ('t0513-proof-member', ${PROOF_TENANT}, ${USER}, 'member')`;
      await sql`
        INSERT INTO auth_team_members (id, team_id, user_id)
        VALUES ('t0513-team-member', ${TEAM}, ${USER})`;
    } finally {
      for (const table of [
        "auth_team_members",
        "auth_members",
        "auth_team_bindings",
        "auth_teams",
        "auth_organizations",
      ]) {
        await sql.unsafe(
          `ALTER TABLE "${table}" ENABLE TRIGGER "auth_directory_dml_guard"`,
        );
      }
    }
    await sql`
      UPDATE auth_authority_states
         SET authority_version = 21, phase = 'M4', directory_authority = 'ba',
             multi_tenant_released = true, updated_at = now()
       WHERE id = 1`;
    await sql`
      INSERT INTO auth_eligibility_clocks
        (tenant_id, principal_id, kind, scope_id, epoch, generation, tombstone, last_command_id)
      VALUES
        (${TENANT}, ${PRINCIPAL}, 'company', ${TENANT}, 1, 1, false, 't0513-c0'),
        (${TENANT}, ${PRINCIPAL}, 'team', ${WORKSPACE}, 1, 1, false, 't0513-c0')`;
    // The proof company's stored policy row IS the demand (T05.04's read
    // gate): this user holds no proof, so a company-scoped admission under
    // it must answer the re-auth refusal.
    await sql`
      INSERT INTO auth_company_auth_policies
        (tenant_id, provider_id, protocol, policy_revision, max_auth_age_seconds)
      VALUES
        (${PROOF_TENANT}, 't0513-provider', 'oidc', 1, 300)`;

    database = createDatabase(setupUrl, { max: 4 });
    // The real T05.04 read gate: only `require` is ever reached from the
    // admission path, and its demand and proof reads are live database
    // reads — the stubbed construction views are never consulted by it.
    const assurance = createCompanyAssurance({
      policy: {
        async requiresProof(tenantId) {
          return tenantId === PROOF_TENANT;
        },
      },
      challengePolicy: {
        async challengePolicy() {
          return null;
        },
      },
      redirect: {
        async buildRedirect() {
          return null;
        },
      },
      database,
      authority: createDirectoryAuthority(),
      encryptionKey: ENCRYPTION_KEY,
    });
    const mountRoutes = (
      handoff: ReturnType<typeof createMobileSessionHandoff>,
    ) => {
      const app = new Hono();
      app.route(
        "/",
        createMobileSessionRoutes({
          authenticate: async (request) => {
            const token = request.headers.get("x-test-session");
            if (!token) return null;
            // Parity with the production seam: BA's getSession refuses an
            // expired session, so the authorize surface never sees one.
            const [row] = await database!
              .select({
                id: sessions.id,
                userId: sessions.userId,
                expiresAt: sessions.expiresAt,
              })
              .from(sessions)
              .where(eq(sessions.token, token));
            return row && row.expiresAt.getTime() > Date.now()
              ? { userId: row.userId, sessionId: row.id }
              : null;
          },
          handoff,
        }),
      );
      return app;
    };
    const wired = mountRoutes(
      createMobileSessionHandoff({
        database,
        clients: [CLIENT_A, CLIENT_B],
        assurance,
      }),
    );
    const wiredServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: wired.fetch,
    });
    plane = {
      baseUrl: wiredServer.url.origin,
      stop: () => wiredServer.stop(true),
    };
    // An assembly without the assurance dependency: the scope-free half
    // still admits, the company-scoped half fails closed at 503.
    const bare = mountRoutes(
      createMobileSessionHandoff({ database, clients: [CLIENT_A, CLIENT_B] }),
    );
    const bareServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: bare.fetch,
    });
    barePlane = {
      baseUrl: bareServer.url.origin,
      stop: () => bareServer.stop(true),
    };
  });

  afterAll(async () => {
    plane?.stop();
    barePlane?.stop();
    await database?.$client.close();
    if (sql) {
      await cleanupFixture(sql);
      const [leaks] = await sql<
        {
          authTables: number;
          authFunctions: number;
          handoffTables: number;
          admissionTables: number;
        }[]
      >`
        SELECT
          (SELECT count(*)::int FROM pg_tables
            WHERE schemaname = 'public' AND tablename LIKE 'auth_%') AS "authTables",
          (SELECT count(*)::int FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND position('auth_' in p.proname) = 1) AS "authFunctions",
          (SELECT count(*)::int FROM pg_tables
            WHERE schemaname = 'public'
              AND tablename IN ('auth_mobile_session_handles','auth_mobile_handoff_codes')) AS "handoffTables",
          (SELECT count(*)::int FROM pg_tables
            WHERE schemaname = 'public'
              AND tablename = 'auth_mobile_session_admissions') AS "admissionTables"`;
      expect(leaks?.authTables).toBe(0);
      expect(leaks?.authFunctions).toBe(0);
      expect(leaks?.handoffTables).toBe(0);
      expect(leaks?.admissionTables).toBe(0);
      await sql.end();
    }
  });

  test("admission_contract_is_the_frozen_shape", async () => {
    const { token } = await issueHandle();
    const response = await admit({
      handle: token,
      requestId: "t0513-req-shape",
      operation: "scope.discover",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      mode: string;
      authMode: string;
      actor: {
        userId: string;
        principalId: string | null;
        identityGeneration: number | null;
      };
      session: { sessionId: string; handleExpiresAt: string };
      scope: unknown;
      assurance: unknown;
      admissionId: string;
      operation: string;
      resourceId: string | null;
    };
    expect(body.mode).toBe("live");
    expect(body.authMode).toBe("enterprise");
    // The actor is the handle's verified fact, never the caller's.
    expect(body.actor.userId).toBe(USER);
    expect(body.actor.principalId).toBe(PRINCIPAL);
    expect(body.actor.identityGeneration).toBe(3);
    expect(body.session.sessionId).toBe(SESSION);
    expect(new Date(body.session.handleExpiresAt).getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(body.scope).toBeNull();
    expect(body.assurance).toBeNull();
    expect(body.operation).toBe("scope.discover");
    expect(body.resourceId).toBeNull();
    // Not a bearer: no token key is ever present on an admission.
    expect("token" in body).toBe(false);
    // The fence row stores the admissionId only as its digest.
    const rows = await admissionRows(token);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.admissionDigest).toBe(sha256Hex(body.admissionId));
    expect(rows[0]?.admissionDigest).not.toBe(body.admissionId);
    expect(rows[0]?.requestId).toBe("t0513-req-shape");
  });

  test("bff_service_credentials_cannot_forge_actor_or_reuse_admission", async () => {
    const { token } = await issueHandle();
    // A body that speaks an actor of its own — the P17 wire body's
    // untrusted actor/company/payer keys — is refused before anything runs.
    const forged = await admit({
      handle: token,
      requestId: "t0513-req-forge",
      extra: { actor: { userId: "someone-else" }, payer: "not-yours" },
    });
    expect(forged.status).toBe(403);
    expect(await forged.text()).toContain("CLIENT_ASSERTED_ACTOR");

    // The rightful first admission succeeds.
    const first = await admit({
      handle: token,
      requestId: "t0513-req-once",
    });
    expect(first.status).toBe(200);

    // The same requestId under the same handle never admits twice.
    const reused = await admit({
      handle: token,
      requestId: "t0513-req-once",
    });
    expect(reused.status).toBe(403);
    expect(await reused.text()).toContain("ADMISSION_REUSED");
    // The fence row is exactly one.
    expect(await admissionRows(token)).toHaveLength(1);

    // Another registered BFF's credential cannot switch users on this handle.
    const switched = await admit({
      handle: token,
      requestId: "t0513-req-switch",
      authorization: basicAuth(CLIENT_B.bffServiceId, "t0513-bff-secret-b"),
    });
    expect(switched.status).toBe(401);
    expect(await switched.text()).toContain("BFF_CREDENTIAL_INVALID");
  });

  test("revoked_session_is_refused_on_next_operation", async () => {
    const { token } = await issueHandle(REVOKE_TOKEN);
    const first = await admit({
      handle: token,
      requestId: "t0513-req-live",
    });
    expect(first.status).toBe(200);
    // Revoke: the BA session row goes away (sign-out), and the handle
    // cascades with it.
    await sql`DELETE FROM sessions WHERE id = ${REVOKE_SESSION}`;
    const next = await admit({
      handle: token,
      requestId: "t0513-req-after-revoke",
    });
    expect(next.status).toBe(401);
    expect(await next.text()).toContain("SESSION_EXPIRED");
  });

  test("expired_or_unknown_handle_admits_nothing", async () => {
    const { token } = await issueHandle();
    // Shift the row back past its window (both columns, so the row's own
    // window CHECK still holds).
    await sql`UPDATE auth_mobile_session_handles
                SET created_at = created_at - interval '2000 seconds',
                    expires_at = expires_at - interval '2000 seconds'
              WHERE handle_digest = ${sha256Hex(token)}`;
    const expired = await admit({
      handle: token,
      requestId: "t0513-req-expired",
    });
    expect(expired.status).toBe(401);
    expect(await expired.text()).toContain("SESSION_EXPIRED");

    const unknown = await admit({
      handle: "never-issued-handle",
      requestId: "t0513-req-unknown",
    });
    expect(unknown.status).toBe(401);
  });

  test("account_change_paths_refuse_with_account_changed", async () => {
    const { token } = await issueHandle();
    // A re-keyed principal: the generation the handle pinned is gone.
    await sql`UPDATE enterprise_principals SET identity_generation = 4
              WHERE id = ${PRINCIPAL}`;
    try {
      const rekeyed = await admit({
        handle: token,
        requestId: "t0513-req-rekeyed",
      });
      expect(rekeyed.status).toBe(401);
      expect(await rekeyed.text()).toContain("ACCOUNT_CHANGED");
    } finally {
      await sql`UPDATE enterprise_principals SET identity_generation = 3
                WHERE id = ${PRINCIPAL}`;
    }
    // A re-bound remote identity: the issuer/subject the handle verified no
    // longer belongs to this user.
    await sql`UPDATE accounts SET account_id = 't0513-other-subject'
              WHERE id = 't0513-account'`;
    try {
      const rebound = await admit({
        handle: token,
        requestId: "t0513-req-rebound",
      });
      expect(rebound.status).toBe(401);
      expect(await rebound.text()).toContain("ACCOUNT_CHANGED");
    } finally {
      await sql`UPDATE accounts SET account_id = 't0513-subject'
                WHERE id = 't0513-account'`;
    }
  });

  test("suspended_identity_admits_nothing", async () => {
    const { token } = await issueHandle();
    await sql`UPDATE enterprise_principals SET status = 'suspended'
              WHERE id = ${PRINCIPAL}`;
    try {
      const response = await admit({
        handle: token,
        requestId: "t0513-req-suspended",
      });
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("IDENTITY_DISABLED");
      expect(await admissionRows(token)).toHaveLength(0);
    } finally {
      await sql`UPDATE enterprise_principals SET status = 'active'
                WHERE id = ${PRINCIPAL}`;
    }
  });

  test("operation_whitelist_and_scope_rules_are_enforced", async () => {
    const { token } = await issueHandle();
    // An operation outside the frozen whitelist is never admissible.
    const unknown = await admit({
      handle: token,
      requestId: "t0513-req-op",
      operation: "admin.impersonate",
    });
    expect(unknown.status).toBe(400);
    // A company-scoped operation without a selector cannot be admitted.
    const scopeless = await admit({
      handle: token,
      requestId: "t0513-req-scopeless",
      operation: "workspace.read",
    });
    expect(scopeless.status).toBe(400);
    expect(await scopeless.text()).toContain("SCOPE_REQUIRED");
    // The discovery operation takes no selection at all.
    const conflicting = await admit({
      handle: token,
      requestId: "t0513-req-conflict",
      operation: "scope.discover",
      selector: { tenantId: TENANT, workspaceId: WORKSPACE },
    });
    expect(conflicting.status).toBe(400);
    expect(await conflicting.text()).toContain("SCOPE_SELECTOR_CONFLICT");
    // An explicit header selection against the body's selection is a
    // conflict, not an override.
    const headerClash = await admit({
      handle: token,
      requestId: "t0513-req-header",
      operation: "workspace.read",
      selector: { tenantId: TENANT, workspaceId: WORKSPACE },
      headerTenant: FOREIGN_TENANT,
    });
    expect(headerClash.status).toBe(400);
    expect(await headerClash.text()).toContain("SCOPE_SELECTOR_CONFLICT");
    // An oversized resourceId is a shape violation, like the other bounds.
    const hugeResource = await admit({
      handle: token,
      requestId: "t0513-req-resource",
      resourceId: "r".repeat(513),
    });
    expect(hugeResource.status).toBe(400);
    expect(await hugeResource.text()).toContain("INVALID_REQUEST");
    // Unknown body keys are not silently dropped.
    const extraKey = await admit({
      handle: token,
      requestId: "t0513-req-extra",
      extra: { definitely: "not part of the contract" },
    });
    expect(extraKey.status).toBe(400);
  });

  test("company_scope_requires_visible_active_membership", async () => {
    const { token } = await issueHandle();
    // The eligible company with no proof policy: admitted, scope echoed.
    const member = await admit({
      handle: token,
      requestId: "t0513-req-company",
      operation: "workspace.read",
      selector: { tenantId: TENANT, workspaceId: WORKSPACE },
      resourceId: "ws-object",
    });
    expect(member.status).toBe(200);
    const memberBody = (await member.json()) as {
      scope: { tenantId: string; workspaceId: string } | null;
      resourceId: string | null;
    };
    expect(memberBody.scope?.tenantId).toBe(TENANT);
    expect(memberBody.scope?.workspaceId).toBe(WORKSPACE);
    expect(memberBody.resourceId).toBe("ws-object");

    // A company the user is no member of: the uniform 404, no side channel.
    const foreign = await admit({
      handle: token,
      requestId: "t0513-req-foreign",
      operation: "workspace.read",
      selector: { tenantId: FOREIGN_TENANT, workspaceId: WORKSPACE },
    });
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).toContain("RESOURCE_NOT_FOUND");

    // Directory revocation lands on the NEXT authorize, not later.
    await sql`UPDATE enterprise_memberships SET status = 'suspended'
              WHERE tenant_id = ${TENANT} AND principal_id = ${PRINCIPAL}`;
    try {
      const suspended = await admit({
        handle: token,
        requestId: "t0513-req-revoked-membership",
        operation: "workspace.read",
        selector: { tenantId: TENANT, workspaceId: WORKSPACE },
      });
      expect(suspended.status).toBe(404);
      expect(await suspended.text()).toContain("RESOURCE_NOT_FOUND");
    } finally {
      await sql`UPDATE enterprise_memberships SET status = 'active'
                WHERE tenant_id = ${TENANT} AND principal_id = ${PRINCIPAL}`;
    }

    // The team selection is checked against the same facts the scope
    // lister reads.
    const team = await admit({
      handle: token,
      requestId: "t0513-req-team",
      operation: "workspace.read",
      selector: { tenantId: TENANT, workspaceId: WORKSPACE },
    });
    expect(team.status).toBe(200);
    const teamBody = (await team.json()) as {
      scope: { tenantId: string; workspaceId: string | null } | null;
    };
    expect(teamBody.scope?.workspaceId).toBe(WORKSPACE);
    const validated = await admit({
      handle: token,
      requestId: "t0513-req-validated-scope",
      operation: "scope.validate",
      selector: { tenantId: TENANT, workspaceId: WORKSPACE },
    });
    expect(validated.status).toBe(200);
    const validatedBody = (await validated.json()) as {
      scope: {
        organizationId: string;
        teamId: string;
        memberEpoch: number;
        workspaceMemberEpoch: number;
        companyGeneration: number;
        teamGeneration: number;
        capabilities: string[];
      };
    };
    expect(validatedBody.scope.organizationId).toBe(TENANT);
    expect(validatedBody.scope.teamId).toBe(TEAM);
    expect(validatedBody.scope.memberEpoch).toBe(1);
    expect(validatedBody.scope.workspaceMemberEpoch).toBe(1);
    expect(validatedBody.scope.companyGeneration).toBe(1);
    expect(validatedBody.scope.teamGeneration).toBe(1);
    expect(validatedBody.scope.capabilities).toEqual([]);
    const invisibleTeam = await admit({
      handle: token,
      requestId: "t0513-req-team-x",
      operation: "workspace.read",
      selector: { tenantId: TENANT, workspaceId: "t0513-team-unknown" },
    });
    expect(invisibleTeam.status).toBe(404);
  });

  test("company_proof_demand_requires_fresh_proof", async () => {
    const { token } = await issueHandle();
    const response = await admit({
      handle: token,
      requestId: "t0513-req-proof",
      operation: "company.challenge",
      selector: { tenantId: PROOF_TENANT },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("COMPANY_REAUTH_REQUIRED");
    expect(await admissionRows(token)).toHaveLength(0);
  });

  test("assurance_dependency_unavailable_fails_closed_503", async () => {
    const { token } = await issueHandle();
    const scoped = await admit({
      handle: token,
      requestId: "t0513-req-bare",
      operation: "workspace.read",
      selector: { tenantId: TENANT, workspaceId: WORKSPACE },
      bare: true,
    });
    expect(scoped.status).toBe(503);
    expect(await scoped.text()).toContain("AUTHORITY_UNAVAILABLE");
    // The scope-free half of the contract never needed the dependency.
    const free = await admit({
      handle: token,
      requestId: "t0513-req-bare-free",
      bare: true,
    });
    expect(free.status).toBe(200);
  });

  test("authorize_requires_registered_bff_credential", async () => {
    const { token } = await issueHandle();
    const missing = await admit({
      handle: token,
      requestId: "t0513-req-cred",
      omitAuthorization: true,
    });
    expect(missing.status).toBe(401);
    const wrong = await admit({
      handle: token,
      requestId: "t0513-req-cred",
      authorization: basicAuth(CLIENT_A.bffServiceId, "not-the-secret"),
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("BFF_CREDENTIAL_INVALID");
  });
});
