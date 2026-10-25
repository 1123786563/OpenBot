import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import {
  createSsoEvidenceBridge,
  type SsoChallengeRecord,
  type SsoChallengeStore,
  type SsoEvidenceBridge,
  SsoEvidenceRefused,
  type SsoOidcProvider,
  s256CodeChallenge,
  type VerifiedSsoEvidence,
} from "../../src/auth/sso-evidence";
import { createBaFixture } from "./support/fixture";
import {
  createOidcTestIdp,
  type OidcIdTokenClaims,
  type OidcTestIdp,
} from "./support/oidc-idp";

/*
 * The T01.06 contract (interface §5 SsoEvidenceBridge, defect H2): the bridge
 * must prove, against a locally-signed OIDC IdP and a challenge row written to
 * the real BA database through the restricted auth-writer role, that
 * `authenticatedAt` is the *signed* `auth_time` and `strength` the *signed*
 * `acr`/`amr`, that the state/nonce of the callback bind to the server-issued
 * challenge one-time, and that issuer/audience/signature/PKCE are verified —
 * any alteration or missing claim produces no evidence.
 *
 * The challenge store here is a DELETE … RETURNING over a real table the suite
 * owns (ba_t0106_evidence), proving the binding is to a persisted server
 * challenge, not to request data. The production store behind
 * `SsoChallengeStore` belongs to P11's CompanyAssurance.
 */

const PROVIDER_ID = "acme-okta";
const OTHER_PROVIDER_ID = "acme-keycloak";
const CALLBACK_PATH = `/api/enterprise/company-auth/oidc/callback/${PROVIDER_ID}`;
const REDIRECT_URI = `http://openbot.test${CALLBACK_PATH}`;
const SCHEMA = "ba_t0106_evidence";
const CHALLENGES_TABLE = "sso_challenges";

/** The whole suite answers to one fixed clock, so nothing can pass by
 * happening to be near wall time. */
const NOW = new Date("2026-10-24T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const AUTH_TIME_SECONDS = NOW_SECONDS - 120;
const ASSERTED_TIME = new Date(AUTH_TIME_SECONDS * 1000);

let fixture: Awaited<ReturnType<typeof createBaFixture>> | undefined;
let idp: OidcTestIdp | undefined;
let sql: ReturnType<typeof postgres> | undefined;
let bridge: SsoEvidenceBridge | undefined;

function requireSetup(): {
  idp: OidcTestIdp;
  sql: ReturnType<typeof postgres>;
  bridge: SsoEvidenceBridge;
} {
  if (!idp || !sql || !bridge) {
    throw new Error("suite setup did not complete; the test is blocked");
  }
  return { idp, sql, bridge };
}

function createDbChallengeStore(
  db: ReturnType<typeof postgres>,
): SsoChallengeStore {
  return {
    async consume(state) {
      const rows = await db`
        DELETE FROM ${db(SCHEMA)}.${db(CHALLENGES_TABLE)}
        WHERE state = ${state}
        RETURNING challenge_id, provider_id, state, nonce, code_verifier,
                  protocol_request_id, expires_at
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        challengeId: row.challenge_id as string,
        providerId: row.provider_id as string,
        state: row.state as string,
        nonce: row.nonce as string,
        codeVerifier: row.code_verifier as string,
        protocolRequestId: row.protocol_request_id as string,
        expiresAt: new Date(row.expires_at as unknown as string),
      };
    },
  };
}

function randomToken(bytes = 24): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface IssuedChallenge extends SsoChallengeRecord {
  codeVerifier: string;
  code: string;
}

async function issueChallenge(
  options: {
    providerId?: string;
    expiresAt?: Date;
    /** The nonce the IdP signs into the token; defaults to the challenge nonce. */
    tokenNonce?: string;
    /** The PKCE challenge the IdP records; defaults to S256(stored verifier). */
    codeChallenge?: string;
    claims?: OidcIdTokenClaims;
    signature?: "valid" | "foreign" | "tampered";
  } = {},
): Promise<IssuedChallenge> {
  const setup = requireSetup();
  const nonce = `nonce-${randomToken(12)}`;
  const codeVerifier = randomToken(32);
  const codeChallenge =
    options.codeChallenge ?? (await s256CodeChallenge(codeVerifier));
  const code = setup.idp.authorize({
    nonce: options.tokenNonce ?? nonce,
    codeChallenge,
    redirectUri: REDIRECT_URI,
    signature: options.signature,
    claims: {
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + 300,
      auth_time: AUTH_TIME_SECONDS,
      ...options.claims,
    },
  });
  const challenge: SsoChallengeRecord = {
    challengeId: `challenge-${randomToken(8)}`,
    providerId: options.providerId ?? PROVIDER_ID,
    state: `state-${randomToken(12)}`,
    nonce,
    codeVerifier,
    protocolRequestId: `auth-request-${randomToken(8)}`,
    expiresAt: options.expiresAt ?? new Date(NOW.getTime() + 10 * 60_000),
  };
  await setup.sql`
    INSERT INTO ${setup.sql(SCHEMA)}.${setup.sql(CHALLENGES_TABLE)} (
      challenge_id, provider_id, state, nonce, code_verifier,
      protocol_request_id, expires_at
    ) VALUES (
      ${challenge.challengeId}, ${challenge.providerId}, ${challenge.state},
      ${challenge.nonce}, ${challenge.codeVerifier},
      ${challenge.protocolRequestId}, ${challenge.expiresAt}
    )
  `;
  return { ...challenge, code };
}

function callbackRequest(state: string, code: string): Request {
  const url = new URL(`http://openbot.test${CALLBACK_PATH}`);
  url.searchParams.set("code", code);
  url.searchParams.set("state", state);
  return new Request(url);
}

/** `verify` refuses by throwing; the contract assertions read "no evidence"
 * as null, so refusals become null and anything else still fails loud. */
async function evidenceOrNull(
  request: Request,
): Promise<VerifiedSsoEvidence | null> {
  const setup = requireSetup();
  try {
    return await setup.bridge.verify(request);
  } catch (error) {
    if (error instanceof SsoEvidenceRefused) return null;
    throw error;
  }
}

beforeAll(async () => {
  // T01.02 fixture: proves the suite runs only on its five isolated
  // BA_TEST_* role URLs before any of this test's own dials.
  fixture = await createBaFixture();
  idp = await createOidcTestIdp();

  const writerUrl = process.env.BA_TEST_AUTH_WRITER_DATABASE_URL?.trim();
  if (!writerUrl) {
    throw new Error(
      "BA_TEST_AUTH_WRITER_DATABASE_URL is required: the suite is blocked, not a shared-database fallback.",
    );
  }
  sql = postgres(writerUrl, { max: 2, idle_timeout: 5, onnotice: () => {} });
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await sql.unsafe(`CREATE SCHEMA "${SCHEMA}"`);
  await sql.unsafe(`
      CREATE TABLE "${SCHEMA}"."${CHALLENGES_TABLE}" (
        challenge_id text PRIMARY KEY,
        provider_id text NOT NULL,
        state text NOT NULL UNIQUE,
        nonce text NOT NULL,
        code_verifier text NOT NULL,
        protocol_request_id text NOT NULL,
        expires_at timestamptz NOT NULL
      )
    `);

  const provider: SsoOidcProvider = {
    providerId: PROVIDER_ID,
    issuer: idp.issuer,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    redirectUri: REDIRECT_URI,
    tokenEndpoint: idp.tokenEndpoint,
    jwksUri: idp.jwksUri,
  };
  bridge = createSsoEvidenceBridge({
    challenges: createDbChallengeStore(sql),
    providers: {
      find: async (providerId) =>
        providerId === PROVIDER_ID ? provider : null,
    },
    clock: () => new Date(NOW),
  });
}, 180_000);

afterAll(async () => {
  try {
    await sql?.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  } finally {
    await sql?.end({ timeout: 5 }).catch(() => {});
    await idp?.close();
    await fixture?.close();
  }
}, 180_000);

test("oidc_auth_time_is_signed_claim_time", { timeout: 60_000 }, async () => {
  const issued = await issueChallenge();
  const evidence = await requireSetup().bridge.verify(
    callbackRequest(issued.state, issued.code),
  );
  expect(evidence.authenticatedAt).toEqual(ASSERTED_TIME);
  expect(evidence.authenticatedAt.getTime()).not.toBe(NOW.getTime());
});

test("altered_state_or_nonce_never_produces_evidence", {
  timeout: 60_000,
}, async () => {
  const stateAltered = await issueChallenge();
  const byState = await evidenceOrNull(
    callbackRequest(`${stateAltered.state}-altered`, stateAltered.code),
  );
  expect(byState).toBeNull();

  const nonceAltered = await issueChallenge({
    tokenNonce: "nonce-from-another-request",
  });
  const byNonce = await evidenceOrNull(
    callbackRequest(nonceAltered.state, nonceAltered.code),
  );
  expect(byNonce).toBeNull();
});

test("verified_evidence_binds_challenge_provider_and_signed_claims", {
  timeout: 60_000,
}, async () => {
  const setup = requireSetup();
  const issued = await issueChallenge();

  // The challenge row landed through the restricted auth-writer capability,
  // not through a setup or superuser connection.
  const [role] =
    await setup.sql`SELECT current_user AS role, session_user AS session`;
  expect(role.role).toBe("ob_ent_auth_writer");
  expect(role.session).toBe("ent_ba_auth_writer");

  const evidence = await setup.bridge.verify(
    callbackRequest(issued.state, issued.code),
  );
  expect(evidence.challengeId).toBe(issued.challengeId);
  expect(evidence.providerId).toBe(PROVIDER_ID);
  expect(evidence.protocol).toBe("oidc");
  expect(evidence.issuer).toBe(setup.idp.issuer);
  expect(evidence.subject).toBe("oidc-test-subject");
  expect(evidence.strength).toBe("urn:mace:incommon:iap:silver");
  expect(evidence.protocolRequestId).toBe(issued.protocolRequestId);

  // One-time: the same authorization state yields no second evidence.
  const replay = await evidenceOrNull(
    callbackRequest(issued.state, issued.code),
  );
  expect(replay).toBeNull();
});

test("strength_comes_from_acr_or_amr_only", { timeout: 60_000 }, async () => {
  const acrOnly = await issueChallenge({
    claims: { amr: null },
  });
  const acrEvidence = await evidenceOrNull(
    callbackRequest(acrOnly.state, acrOnly.code),
  );
  expect(acrEvidence?.strength).toBe("urn:mace:incommon:iap:silver");

  const amrOnly = await issueChallenge({
    claims: { acr: null, amr: ["pwd", "otp"] },
  });
  const amrEvidence = await evidenceOrNull(
    callbackRequest(amrOnly.state, amrOnly.code),
  );
  expect(amrEvidence?.strength).toBe("mfa");
});

test("unsigned_or_misattributed_id_token_never_produces_evidence", {
  timeout: 60_000,
}, async () => {
  const tampered = await issueChallenge({ signature: "tampered" });
  expect(
    await evidenceOrNull(callbackRequest(tampered.state, tampered.code)),
  ).toBeNull();

  const foreign = await issueChallenge({ signature: "foreign" });
  expect(
    await evidenceOrNull(callbackRequest(foreign.state, foreign.code)),
  ).toBeNull();

  const wrongIssuer = await issueChallenge({
    claims: { iss: "https://evil.example.com" },
  });
  expect(
    await evidenceOrNull(callbackRequest(wrongIssuer.state, wrongIssuer.code)),
  ).toBeNull();

  const wrongAudience = await issueChallenge({
    claims: { aud: "some-other-client" },
  });
  expect(
    await evidenceOrNull(
      callbackRequest(wrongAudience.state, wrongAudience.code),
    ),
  ).toBeNull();
});

test("missing_auth_time_nonce_or_strength_claim_is_refused", {
  timeout: 60_000,
}, async () => {
  const noAuthTime = await issueChallenge({ claims: { auth_time: null } });
  expect(
    await evidenceOrNull(callbackRequest(noAuthTime.state, noAuthTime.code)),
  ).toBeNull();

  const noNonce = await issueChallenge({ claims: { nonce: null } });
  expect(
    await evidenceOrNull(callbackRequest(noNonce.state, noNonce.code)),
  ).toBeNull();

  const noStrength = await issueChallenge({
    claims: { acr: null, amr: null },
  });
  expect(
    await evidenceOrNull(callbackRequest(noStrength.state, noStrength.code)),
  ).toBeNull();
});

test("pkce_mismatch_and_expired_challenge_are_refused", {
  timeout: 60_000,
}, async () => {
  const setup = requireSetup();

  // The IdP recorded the S256 of a different verifier than the one the
  // challenge row stores, so the back-channel exchange itself fails.
  const pkceMismatched = await issueChallenge({
    codeChallenge: await s256CodeChallenge("a-verifier-that-is-not-stored"),
  });
  const beforePkce = setup.idp.tokenRequestCount();
  expect(
    await evidenceOrNull(
      callbackRequest(pkceMismatched.state, pkceMismatched.code),
    ),
  ).toBeNull();
  expect(setup.idp.tokenRequestCount()).toBe(beforePkce + 1);

  // An expired challenge is refused before any exchange is attempted.
  const expired = await issueChallenge({
    expiresAt: new Date(NOW.getTime() - 1_000),
  });
  const beforeExpired = setup.idp.tokenRequestCount();
  expect(
    await evidenceOrNull(callbackRequest(expired.state, expired.code)),
  ).toBeNull();
  expect(setup.idp.tokenRequestCount()).toBe(beforeExpired);
});

test("challenge_bound_to_another_provider_is_refused", {
  timeout: 60_000,
}, async () => {
  const otherProvider = await issueChallenge({
    providerId: OTHER_PROVIDER_ID,
  });
  expect(
    await evidenceOrNull(
      callbackRequest(otherProvider.state, otherProvider.code),
    ),
  ).toBeNull();
});
