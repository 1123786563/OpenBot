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
import {
  createMobileSessionHandoff,
  type MobileHandoffClient,
} from "../../src/auth/mobile-session";
import { createMobileSessionRoutes } from "../../src/auth/mobile-session-routes";
import { createDatabase } from "../../src/db/client";
import {
  authMobileHandoffCodes,
  authMobileSessionHandles,
  sessions,
} from "../../src/db/schema";

/*
 * T05.12 (#568, original task P12; interfaces §5.2 / F2) — the one-time
 * PKCE session handoff between the OpenBot authority and a registered
 * mobile BFF, as database facts and real HTTP:
 *
 * - `enterprise_session_exchange_is_single_use_pkce_bound`: six concurrent
 *   exchanges of one code answer exactly one 200
 *   (expect(successCount).toBe(1)), mint exactly one handle row, and leave
 *   the code consumed — the row lock, the conditional consume arm and the
 *   unique code_digest all decide in the database, not in the caller.
 * - `wrong_client_or_verifier_never_issues_handle`: the BFF credential of
 *   another registered client and a wrong PKCE verifier are both refused,
 *   and the handles table stays empty (expect(handles).toHaveLength(0)) —
 *   a wrong verifier does not even consume the code.
 *
 * Supporting: the authorize redirect carries only code/state/intentId
 * (never the BA session token) and only to the registered redirect; an
 * unknown client, a foreign redirect, a plain-method challenge, a missing
 * session and a cross-site Origin each refuse with their named code; the
 * code dies with its 120-second window; the handle never outlives the
 * original BA session (SESSION_EXPIRED while the row still exists, and the
 * 1800-second ceiling capped by the session expiry); a suspended principal
 * hands off nothing (403); and the stored row is the digest plus the
 * verified binding (issuer/subject, identityGeneration, principalId) —
 * never the plaintext handle.
 *
 * The five BA_TEST_* URLs are all required and must name one isolated
 * openbot_enterprise_* database. No DSN is ever printed. The suite replays
 * its own 0222 migration and removes exactly what it added, auth_ function
 * family included, so the island stays clean for the leak probe.
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

const MIGRATION_TAG = "0222_better_auth_mobile_session_handoff";
/**
 * The verified BA chain the handoff reads ride on: the directory tables and
 * command model (T02.01–T02.06), the assurance/authority-source alterations
 * to the enterprise tables — enterprise_principals.identity_generation among
 * them — and the T03–T05 guard amendments, applied in journal order and
 * normalized away again at cleanup, exactly the discipline the sibling BA
 * suites keep on this island.
 */
const PREREQUISITE_TAGS = [
  "0209_better_auth_directory",
  "0210_better_auth_clocks",
  "0211_better_auth_command_authority",
  "0212_better_auth_authority_sources",
  "0213_better_auth_assurance",
  "0214_better_auth_schema_roles",
  "0215_better_auth_company_lifecycle",
  "0216_better_auth_invitation_resend",
  "0217_better_auth_team_management_grants",
  "0218_better_auth_company_auth_challenge",
  "0219_better_auth_company_auth_complete",
  "0220_better_auth_company_auth_policy_read",
  "0221_better_auth_provisioning_rules",
] as const;

const PREFIX = "t0512";
const EMAIL_DOMAIN = "@t0512.example.test";

const USER = "t0512-user";
const LOCAL_USER = "t0512-local-user";
const SESSION = "t0512-session";
const SHORT_SESSION = "t0512-session-short";
const EXPIRED_SESSION = "t0512-session-expired";
const PRINCIPAL = "t0512-principal";
const LIVE_TOKEN = "t0512-token";

const REDIRECT_A = "https://mobile.example.test/callback";
const AUTHORITY_A = "https://openbot.example.test";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"; // RFC 7636 appendix B

const CLIENT_A: MobileHandoffClient = {
  clientId: "openmuse-mobile",
  redirectUri: REDIRECT_A,
  authorityOrigin: AUTHORITY_A,
  bffServiceId: "openmuse-bff",
  bffCredentialDigest: createHash("sha256")
    .update("t0512-bff-secret-a")
    .digest("hex"),
};
const CLIENT_B: MobileHandoffClient = {
  clientId: "other-mobile",
  redirectUri: "https://other.example.test/cb",
  authorityOrigin: "https://other-authority.example.test",
  bffServiceId: "other-bff",
  bffCredentialDigest: createHash("sha256")
    .update("t0512-bff-secret-b")
    .digest("hex"),
};

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
        `${variable} is required: the mobile-session-handoff suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
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
  // leftovers) and the handoff tables, in one sweep; every statement is a
  // no-op on a pristine baseline so a crashed earlier run also recovers.
  await sql.unsafe(`
    DO $$
    DECLARE target record;
    BEGIN
      FOR target IN SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND (tablename LIKE 'auth_%' ESCAPE ''
               OR tablename IN ('auth_mobile_session_handles', 'auth_mobile_handoff_codes'))
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

const basicAuth = (serviceId: string, secret: string) =>
  `Basic ${Buffer.from(`${serviceId}:${secret}`).toString("base64")}`;

describe("T05.12 mobile session handoff (#568)", () => {
  /** Issue a code over the real HTTP authorize surface and hand back its parts. */
  const authorize = async (
    sessionToken: string,
    options?: {
      clientId?: string;
      redirectUri?: string;
      state?: string;
      challenge?: string;
      method?: string;
      origin?: string;
    },
  ): Promise<Response> => {
    const params = new URLSearchParams({
      client_id: options?.clientId ?? CLIENT_A.clientId,
      redirect_uri: options?.redirectUri ?? REDIRECT_A,
      state: options?.state ?? "t0512-state",
      code_challenge: options?.challenge ?? pkceChallenge(VERIFIER),
      code_challenge_method: options?.method ?? "S256",
    });
    return fetch(
      `${plane!.baseUrl}/authorize?${params.toString()}`,
      sessionToken
        ? {
            redirect: "manual",
            headers: {
              "x-test-session": sessionToken,
              ...(options?.origin ? { origin: options.origin } : {}),
            },
          }
        : { redirect: "manual" },
    );
  };

  const exchange = (input: {
    code: string;
    verifier?: string;
    authorization?: string;
    intentId: string;
    redirectUri?: string;
  }): Promise<Response> =>
    fetch(`${plane!.baseUrl}/session/exchange`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization:
          input.authorization ??
          basicAuth(CLIENT_A.bffServiceId, "t0512-bff-secret-a"),
      },
      body: JSON.stringify({
        authMode: "enterprise",
        intentId: input.intentId,
        code: input.code,
        codeVerifier: input.verifier ?? VERIFIER,
        redirectUri: input.redirectUri ?? REDIRECT_A,
      }),
    });

  const handlesFor = async (code: string) =>
    database!
      .select()
      .from(authMobileSessionHandles)
      .where(eq(authMobileSessionHandles.codeDigest, sha256Hex(code)));
  const codeRow = async (code: string) => {
    const [row] = await database!
      .select()
      .from(authMobileHandoffCodes)
      .where(eq(authMobileHandoffCodes.codeDigest, sha256Hex(code)));
    return row;
  };

  /** authorize + parse redirect into {code, intentId, state}. */
  const issueCode = async (sessionToken = LIVE_TOKEN) => {
    const response = await authorize(sessionToken);
    expect(response.status).toBe(303);
    const location = response.headers.get("location")!;
    const url = new URL(location);
    return {
      location,
      code: url.searchParams.get("code")!,
      state: url.searchParams.get("state")!,
      intentId: url.searchParams.get("intentId")!,
    };
  };

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
      INSERT INTO users (id, email) VALUES
        (${USER}, ${`user${EMAIL_DOMAIN}`}),
        (${LOCAL_USER}, ${`local${EMAIL_DOMAIN}`})`;
    await sql`
      INSERT INTO sessions (id, user_id, token, expires_at) VALUES
        (${SESSION}, ${USER}, ${`${PREFIX}-token`}, now() + interval '2 hours'),
        (${SHORT_SESSION}, ${LOCAL_USER}, ${`${PREFIX}-token-short`}, now() + interval '200 seconds'),
        (${EXPIRED_SESSION}, ${USER}, ${`${PREFIX}-token-expired`}, now() - interval '1 hour')`;
    await sql`
      INSERT INTO accounts (id, account_id, provider_id, issuer, user_id) VALUES
        (${`${PREFIX}-account`}, ${`${PREFIX}-subject`}, 'organization',
         'https://idp.example.test', ${USER})`;
    await sql`
      INSERT INTO enterprise_principals (id, user_id, status, identity_generation) VALUES
        (${PRINCIPAL}, ${USER}, 'active', 3)`;

    database = createDatabase(setupUrl, { max: 4 });
    const handoff = createMobileSessionHandoff({
      database,
      clients: [CLIENT_A, CLIENT_B],
    });
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
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: app.fetch,
    });
    plane = { baseUrl: server.url.origin, stop: () => server.stop(true) };
  });

  afterAll(async () => {
    plane?.stop();
    await database?.$client.close();
    if (sql) await cleanupFixture(sql);
    await sql?.end();
  });

  test("authorize_redirect_carries_only_code_state_intent", async () => {
    const issued = await issueCode();
    expect(issued.location.startsWith(`${REDIRECT_A}?`)).toBe(true);
    expect(issued.state).toBe("t0512-state");
    expect(issued.intentId).toMatch(/^[0-9a-f-]{36}$/);
    // The BA session token never rides the URL (interfaces §5.2).
    expect(issued.location.includes(`${PREFIX}-token`)).toBe(false);
    // The stored row is the digest, never the code.
    const row = await codeRow(issued.code);
    expect(row?.codeDigest).toBe(sha256Hex(issued.code));
    expect(row?.codeDigest).not.toBe(issued.code);
    expect(row?.sessionId).toBe(SESSION);
    expect(row?.codeChallenge).toBe(pkceChallenge(VERIFIER));
  });

  test("authorize_refusals_are_the_named_codes", async () => {
    expect((await authorize(LIVE_TOKEN, { clientId: "unknown" })).status).toBe(
      400,
    );
    expect(
      await (
        await authorize(LIVE_TOKEN, {
          redirectUri: "https://evil.example.test/cb",
        })
      ).text(),
    ).toContain("REDIRECT_UNREGISTERED");
    expect(
      await (await authorize(LIVE_TOKEN, { method: "plain" })).text(),
    ).toContain("PKCE_METHOD_UNSUPPORTED");
    expect((await authorize(null)).status).toBe(401);
    expect((await authorize(`${PREFIX}-token-expired`)).status).toBe(401);
    expect(
      (await authorize(LIVE_TOKEN, { origin: "https://evil.example.test" }))
        .status,
    ).toBe(403);
  });

  test("enterprise_session_exchange_is_single_use_pkce_bound", async () => {
    const issued = await issueCode();
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () =>
        exchange({ code: issued.code, intentId: issued.intentId }),
      ),
    );
    const successes = attempts.filter((r) => r.status === 200);
    const successCount = successes.length;
    expect(successCount).toBe(1);
    const replays = attempts.filter((r) => r.status !== 200);
    expect(replays.length).toBe(5);
    for (const replay of replays) {
      expect(await replay.text()).toContain("CODE_REPLAYED");
    }

    const handles = await handlesFor(issued.code);
    expect(handles).toHaveLength(1);
    const [handle] = handles;
    expect(handle?.codeDigest).toBe(sha256Hex(issued.code));
    const consumed = await codeRow(issued.code);
    expect(consumed?.consumedAt).not.toBeNull();

    // The one success answers the frozen EnterpriseSessionResponse.
    const body = (await successes[0]!.json()) as {
      token: string;
      mode: string;
      authMode: string;
      authority: string;
      expiresAt: string;
      user: { id: string; principalId: string | null };
      scope: unknown;
    };
    expect(body.mode).toBe("live");
    expect(body.authMode).toBe("enterprise");
    expect(body.authority).toBe(AUTHORITY_A);
    expect(body.user.id).toBe(USER);
    expect(body.user.principalId).toBe(PRINCIPAL);
    expect(body.scope).toBeNull();
    // The handle is stored only as its digest, with the verified binding.
    expect(handle?.handleDigest).toBe(sha256Hex(body.token));
    expect(handle?.handleDigest).not.toBe(body.token);
    expect(handle?.issuer).toBe("https://idp.example.test");
    expect(handle?.subject).toBe(`${PREFIX}-subject`);
    expect(handle?.identityGeneration).toBe(3);
    expect(handle?.principalId).toBe(PRINCIPAL);
    expect(handle?.audience).toBe("openmuse-mobile-bff");
  });

  test("wrong_client_or_verifier_never_issues_handle", async () => {
    const issued = await issueCode();

    // Another registered client's BFF credential never consumes this code.
    const wrongClient = await exchange({
      code: issued.code,
      intentId: issued.intentId,
      authorization: basicAuth(CLIENT_B.bffServiceId, "t0512-bff-secret-b"),
    });
    expect(wrongClient.status).toBe(400);

    // A wrong PKCE verifier is refused and consumes nothing.
    const wrongVerifier = await exchange({
      code: issued.code,
      intentId: issued.intentId,
      verifier: `${VERIFIER.slice(0, 42)}x`,
    });
    expect(wrongVerifier.status).toBe(400);
    expect(await wrongVerifier.text()).toContain("PKCE_VERIFICATION_FAILED");

    expect(await handlesFor(issued.code)).toHaveLength(0);
    const stillPending = await codeRow(issued.code);
    expect(stillPending?.consumedAt).toBeNull();

    // The rightful exchange still succeeds afterwards.
    const rightful = await exchange({
      code: issued.code,
      intentId: issued.intentId,
    });
    expect(rightful.status).toBe(200);
  });

  test("exchange_requires_registered_bff_credential", async () => {
    const issued = await issueCode();
    const missing = await fetch(`${plane!.baseUrl}/session/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authMode: "enterprise",
        intentId: issued.intentId,
        code: issued.code,
        codeVerifier: VERIFIER,
        redirectUri: REDIRECT_A,
      }),
    });
    expect(missing.status).toBe(401);
    const wrong = await exchange({
      code: issued.code,
      intentId: issued.intentId,
      authorization: basicAuth(CLIENT_A.bffServiceId, "not-the-secret"),
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("BFF_CREDENTIAL_INVALID");
    expect(await handlesFor(issued.code)).toHaveLength(0);
  });

  test("code_dies_with_its_120_second_window", async () => {
    const issued = await issueCode();
    // Shift the whole row back past the window (created_at and expires_at
    // together, so the row's own window CHECK still holds).
    await sql`UPDATE auth_mobile_handoff_codes
                SET created_at = created_at - interval '200 seconds',
                    expires_at = expires_at - interval '200 seconds'
              WHERE code_digest = ${sha256Hex(issued.code)}`;
    const response = await exchange({
      code: issued.code,
      intentId: issued.intentId,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("CODE_EXPIRED");
    expect(await handlesFor(issued.code)).toHaveLength(0);
  });

  test("expired_original_session_refused_with_no_handle", async () => {
    const issued = await issueCode();
    await sql`UPDATE sessions SET expires_at = now() - interval '1 minute'
              WHERE id = ${SESSION}`;
    try {
      const response = await exchange({
        code: issued.code,
        intentId: issued.intentId,
      });
      expect(response.status).toBe(401);
      expect(await response.text()).toContain("SESSION_EXPIRED");
      expect(await handlesFor(issued.code)).toHaveLength(0);
      // The code row survives (audit fact), unconsumed.
      expect((await codeRow(issued.code))?.consumedAt).toBeNull();
    } finally {
      // The suite's other cases still hand off on this live session.
      await sql`UPDATE sessions SET expires_at = now() + interval '2 hours'
                WHERE id = ${SESSION}`;
    }
  });

  test("handle_never_outlives_the_ba_session", async () => {
    // The short session (200 seconds) binds tighter than the 1800 ceiling.
    const short = await issueCode(`${PREFIX}-token-short`);
    const shortResponse = await exchange({
      code: short.code,
      intentId: short.intentId,
    });
    expect(shortResponse.status).toBe(200);
    const shortBody = (await shortResponse.json()) as { expiresAt: string };
    const [shortSession] = await database!
      .select({ expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.id, SHORT_SESSION));
    expect(new Date(shortBody.expiresAt).getTime()).toBe(
      shortSession!.expiresAt.getTime(),
    );

    // The long session gets exactly the 1800-second ceiling.
    const long = await issueCode();
    const longResponse = await exchange({
      code: long.code,
      intentId: long.intentId,
    });
    expect(longResponse.status).toBe(200);
    const longBody = (await longResponse.json()) as { expiresAt: string };
    const [handleRow] = await database!
      .select({ createdAt: authMobileSessionHandles.createdAt })
      .from(authMobileSessionHandles)
      .where(eq(authMobileSessionHandles.codeDigest, sha256Hex(long.code)));
    expect(
      new Date(longBody.expiresAt).getTime() - handleRow!.createdAt.getTime(),
    ).toBe(1800_000);
  });

  test("local_credential_user_hands_off_without_remote_binding", async () => {
    const issued = await issueCode(`${PREFIX}-token-short`);
    const response = await exchange({
      code: issued.code,
      intentId: issued.intentId,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user: { id: string; principalId: string | null };
    };
    expect(body.user.id).toBe(LOCAL_USER);
    // Not onboarded: no principal, and no remote issuer/subject to bind.
    expect(body.user.principalId).toBeNull();
    const [handle] = await database!
      .select()
      .from(authMobileSessionHandles)
      .where(eq(authMobileSessionHandles.codeDigest, sha256Hex(issued.code)));
    expect(handle?.issuer).toBeNull();
    expect(handle?.subject).toBeNull();
    expect(handle?.identityGeneration).toBeNull();
  });

  test("suspended_identity_hands_off_nothing", async () => {
    await sql`UPDATE enterprise_principals SET status = 'suspended' WHERE id = ${PRINCIPAL}`;
    try {
      const issued = await issueCode();
      const response = await exchange({
        code: issued.code,
        intentId: issued.intentId,
      });
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("IDENTITY_DISABLED");
      expect(await handlesFor(issued.code)).toHaveLength(0);
    } finally {
      await sql`UPDATE enterprise_principals SET status = 'active' WHERE id = ${PRINCIPAL}`;
    }
  });
});
