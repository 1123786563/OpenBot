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
  type SsoProviderRegistry,
  type SsoSamlProvider,
  type VerifiedSsoEvidence,
} from "../../src/auth/sso-evidence";
import { createBaFixture } from "./support/fixture";
import {
  createSamlTestIdp,
  DEFAULT_AUTHN_CONTEXT_CLASS,
  type SamlAssertionInput,
  type SamlTestIdp,
  STATUS_RESPONDER,
} from "./support/saml-idp";

/*
 * The T01.07 contract (interface §5 SsoEvidenceBridge, defect H2): the bridge
 * must prove, against a locally-signing SAML IdP and an AuthnRequest/RelayState
 * challenge row written through the restricted auth-writer role, that
 * `authenticatedAt` is the *signed* AuthnStatement@AuthnInstant and `strength`
 * the *signed* AuthnContextClassRef — never the callback clock and never
 * anything the transport form asserts about itself. The Response/Assertion is
 * verified as a signed document (digest over exclusive C14N, RSA-SHA256 over
 * SignedInfo) and bound to the server's own persisted AuthnRequest: RelayState
 * is the one-time challenge token, InResponseTo must answer the challenge's
 * AuthnRequest ID, Audience/Recipient/Destination must name this SP, and any
 * alteration, foreign signature, or missing claim produces no evidence — no
 * row ever reaches the proof table the assurance layer would read.
 *
 * The challenge store here is a DELETE … RETURNING over a real table the suite
 * owns (ba_t0107_evidence), the way T01.06 proved the OIDC binding: for a SAML
 * challenge the `state` column holds the RelayState and `protocol_request_id`
 * the AuthnRequest ID (the nonce/code_verifier columns are the shared port's
 * OIDC-only fields and are never read on this path).
 */

const PROVIDER_ID = "acme-saml";
const OTHER_PROVIDER_ID = "acme-saml-two";
const ACS_PATH = `/api/enterprise/company-auth/saml/acs/${PROVIDER_ID}`;
const ACS_URL = `https://openbot.test${ACS_PATH}`;
const SP_ENTITY_ID = "https://openbot.test/saml/sp";
const SCHEMA = "ba_t0107_evidence";
const CHALLENGES_TABLE = "sso_challenges";
const PROOFS_TABLE = "sso_proofs";

/** The whole suite answers to one fixed clock, so nothing can pass by
 * happening to be near wall time. */
const NOW = new Date("2026-10-24T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const AUTHN_INSTANT_SECONDS = NOW_SECONDS - 120;
const ASSERTION_TIME = new Date(AUTHN_INSTANT_SECONDS * 1000);

let fixture: Awaited<ReturnType<typeof createBaFixture>> | undefined;
let idp: SamlTestIdp | undefined;
let sql: ReturnType<typeof postgres> | undefined;
let bridge: SsoEvidenceBridge | undefined;

function requireSetup(): {
  idp: SamlTestIdp;
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

interface IssuedSamlChallenge extends SsoChallengeRecord {
  /** The base64 SAMLResponse the IdP signed for this challenge. */
  samlResponse: string;
}

async function issueSamlChallenge(
  options: {
    providerId?: string;
    expiresAt?: Date;
    /** Overrides into the signed response; `inResponseTo` still defaults to
     * this challenge's AuthnRequest ID. */
    response?: Partial<SamlAssertionInput>;
  } = {},
): Promise<IssuedSamlChallenge> {
  const setup = requireSetup();
  const protocolRequestId = `authn-${randomToken(8)}`;
  const challenge: SsoChallengeRecord = {
    challengeId: `challenge-${randomToken(8)}`,
    providerId: options.providerId ?? PROVIDER_ID,
    // SAML's correlation token: the RelayState the server's own SP issued
    // with the AuthnRequest whose ID is protocolRequestId.
    state: `relay-${randomToken(12)}`,
    nonce: `oidc-only-${randomToken(6)}`,
    codeVerifier: `oidc-only-${randomToken(8)}`,
    protocolRequestId,
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
  const samlResponse = await setup.idp.assertion({
    inResponseTo: protocolRequestId,
    acsUrl: ACS_URL,
    spEntityId: SP_ENTITY_ID,
    authnInstant: AUTHN_INSTANT_SECONDS,
    issueInstant: NOW_SECONDS,
    notBefore: NOW_SECONDS - 60,
    notOnOrAfter: NOW_SECONDS + 300,
    ...options.response,
  });
  return { ...challenge, samlResponse };
}

function acsRequest(
  relayState: string,
  samlResponse: string,
  init: RequestInit = {},
): Request {
  return new Request(`https://openbot.test${ACS_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      SAMLResponse: samlResponse,
      RelayState: relayState,
    }).toString(),
    ...init,
  });
}

/**
 * `verify` refuses by throwing; the contract assertions read "no evidence" as
 * null. A verified evidence is what would become a proof row for the
 * assurance layer, so this helper records exactly that — the `proofRows` the
 * negative cases then count.
 */
async function attemptProof(
  request: Request,
  target: SsoEvidenceBridge = requireSetup().bridge,
): Promise<VerifiedSsoEvidence | null> {
  const setup = requireSetup();
  try {
    const evidence = await target.verify(request);
    await setup.sql`
      INSERT INTO ${setup.sql(SCHEMA)}.${setup.sql(PROOFS_TABLE)} (
        challenge_id, provider_id, protocol, issuer, subject,
        authenticated_at, strength, protocol_request_id
      ) VALUES (
        ${evidence.challengeId}, ${evidence.providerId}, ${evidence.protocol},
        ${evidence.issuer}, ${evidence.subject}, ${evidence.authenticatedAt},
        ${evidence.strength}, ${evidence.protocolRequestId}
      )
    `;
    return evidence;
  } catch (error) {
    if (error instanceof SsoEvidenceRefused) return null;
    throw error;
  }
}

/** `verify` through a bridge that never answers, for the refusal codes. */
async function refusalOrNull(
  request: Request,
  target: SsoEvidenceBridge = requireSetup().bridge,
): Promise<string | null> {
  try {
    await target.verify(request);
    return null;
  } catch (error) {
    if (error instanceof SsoEvidenceRefused) return error.code;
    throw error;
  }
}

beforeAll(async () => {
  // T01.02 fixture: proves the suite runs only on its five isolated
  // BA_TEST_* role URLs before any of this test's own dials.
  fixture = await createBaFixture();
  idp = await createSamlTestIdp();

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
  await sql.unsafe(`
      CREATE TABLE "${SCHEMA}"."${PROOFS_TABLE}" (
        challenge_id text PRIMARY KEY,
        provider_id text NOT NULL,
        protocol text NOT NULL,
        issuer text NOT NULL,
        subject text NOT NULL,
        authenticated_at timestamptz NOT NULL,
        strength text NOT NULL,
        protocol_request_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

  const provider: SsoSamlProvider = {
    providerId: PROVIDER_ID,
    issuer: idp.entityId,
    spEntityId: SP_ENTITY_ID,
    acsUrl: ACS_URL,
    signingKeys: [idp.signingKeyPem],
  };
  const providers: SsoProviderRegistry = {
    find: async () => null,
    findSaml: async (providerId) =>
      providerId === PROVIDER_ID ? provider : null,
  };
  bridge = createSsoEvidenceBridge({
    challenges: createDbChallengeStore(sql),
    providers,
    clock: () => new Date(NOW),
  });
}, 180_000);

afterAll(async () => {
  try {
    await sql?.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  } finally {
    await sql?.end({ timeout: 5 }).catch(() => {});
    await fixture?.close();
  }
}, 180_000);

test("saml_authenticated_at_matches_authn_instant", {
  timeout: 60_000,
}, async () => {
  const setup = requireSetup();
  const issued = await issueSamlChallenge();

  // The challenge row landed through the restricted auth-writer capability,
  // not through a setup or superuser connection.
  const [role] =
    await setup.sql`SELECT current_user AS role, session_user AS session`;
  expect(role.role).toBe("ob_ent_auth_writer");
  expect(role.session).toBe("ent_ba_auth_writer");

  const evidence = await attemptProof(
    acsRequest(issued.state, issued.samlResponse),
  );
  expect(evidence).not.toBeNull();
  // The signed AuthnInstant, 120s before the fixed callback clock: the
  // callback never supplies the authentication time.
  expect(evidence!.authenticatedAt).toEqual(ASSERTION_TIME);
  expect(evidence!.authenticatedAt.getTime()).not.toBe(NOW.getTime());
  expect(evidence!.challengeId).toBe(issued.challengeId);
  expect(evidence!.providerId).toBe(PROVIDER_ID);
  expect(evidence!.protocol).toBe("saml");
  expect(evidence!.issuer).toBe(setup.idp.entityId);
  expect(evidence!.subject).toBe("saml-test-subject");
  expect(evidence!.strength).toBe(DEFAULT_AUTHN_CONTEXT_CLASS);
  expect(evidence!.protocolRequestId).toBe(issued.protocolRequestId);
});

test("altered_relay_state_or_in_response_to_is_refused", {
  timeout: 60_000,
}, async () => {
  const setup = requireSetup();

  // The signed response is untouched, but the POST carries a RelayState that
  // answers no open challenge of this SP.
  const alteredRelay = await issueSamlChallenge();
  expect(
    await attemptProof(
      acsRequest(`${alteredRelay.state}-altered`, alteredRelay.samlResponse),
    ),
  ).toBeNull();

  // A validly signed response that answers a different AuthnRequest: the
  // signature is honest, the binding to *this* challenge is not.
  const crossRequest = await issueSamlChallenge({
    response: { inResponseTo: "authn-request-of-another-flow" },
  });
  expect(
    await attemptProof(
      acsRequest(crossRequest.state, crossRequest.samlResponse),
    ),
  ).toBeNull();

  // IdP-initiated (unsolicited): no InResponseTo anywhere to bind.
  const unsolicited = await issueSamlChallenge({
    response: { inResponseTo: "" },
  });
  expect(
    await attemptProof(acsRequest(unsolicited.state, unsolicited.samlResponse)),
  ).toBeNull();

  // None of the attempts may have left proof rows behind.
  const proofRows = await setup.sql`
    SELECT challenge_id FROM ${setup.sql(SCHEMA)}.${setup.sql(PROOFS_TABLE)}
    WHERE challenge_id IN (
      ${alteredRelay.challengeId}, ${crossRequest.challengeId}, ${unsolicited.challengeId}
    )
  `;
  expect(proofRows).toHaveLength(0);
});

test("tampered_signature_or_signed_content_is_refused", {
  timeout: 60_000,
}, async () => {
  const setup = requireSetup();

  const tamperedSignature = await issueSamlChallenge({
    response: { signature: "tampered" },
  });
  expect(
    await attemptProof(
      acsRequest(tamperedSignature.state, tamperedSignature.samlResponse),
    ),
  ).toBeNull();

  const foreignKey = await issueSamlChallenge({
    response: { signature: "foreign" },
  });
  expect(
    await attemptProof(acsRequest(foreignKey.state, foreignKey.samlResponse)),
  ).toBeNull();

  const unsigned = await issueSamlChallenge({
    response: { signature: "unsigned" },
  });
  expect(
    await refusalOrNull(acsRequest(unsigned.state, unsigned.samlResponse)),
  ).toBe("SSO_SAML_ASSERTION_UNSIGNED");

  // The signature bytes are valid, but the signed document was edited after
  // signing: the recomputed digest cannot match.
  const editedContent = await issueSamlChallenge();
  const tamperedDocument = btoa(
    atob(editedContent.samlResponse).replace(
      "saml-test-subject",
      "attacker-subject",
    ),
  );
  expect(
    await attemptProof(acsRequest(editedContent.state, tamperedDocument)),
  ).toBeNull();

  const proofRows = await setup.sql`
    SELECT challenge_id FROM ${setup.sql(SCHEMA)}.${setup.sql(PROOFS_TABLE)}
    WHERE challenge_id IN (
      ${tamperedSignature.challengeId}, ${foreignKey.challengeId},
      ${unsigned.challengeId}, ${editedContent.challengeId}
    )
  `;
  expect(proofRows).toHaveLength(0);
});

test("wrong_audience_recipient_destination_or_issuer_is_refused", {
  timeout: 60_000,
}, async () => {
  const wrongAudience = await issueSamlChallenge({
    response: { audience: "https://other-sp.example.com/metadata" },
  });
  expect(
    await refusalOrNull(
      acsRequest(wrongAudience.state, wrongAudience.samlResponse),
    ),
  ).toBe("SSO_SAML_AUDIENCE_MISMATCH");

  const wrongRecipient = await issueSamlChallenge({
    response: { recipient: "https://other-sp.example.com/acs" },
  });
  expect(
    await refusalOrNull(
      acsRequest(wrongRecipient.state, wrongRecipient.samlResponse),
    ),
  ).toBe("SSO_SAML_RECIPIENT_MISMATCH");

  const wrongDestination = await issueSamlChallenge({
    response: { destination: "https://other-sp.example.com/acs" },
  });
  expect(
    await refusalOrNull(
      acsRequest(wrongDestination.state, wrongDestination.samlResponse),
    ),
  ).toBe("SSO_SAML_RECIPIENT_MISMATCH");

  const wrongIssuer = await issueSamlChallenge({
    response: { issuer: "https://evil.example.com/idp" },
  });
  expect(
    await refusalOrNull(
      acsRequest(wrongIssuer.state, wrongIssuer.samlResponse),
    ),
  ).toBe("SSO_SAML_ISSUER_MISMATCH");
});

test("missing_authn_instant_authn_context_or_confirmation_is_refused", {
  timeout: 60_000,
}, async () => {
  const noAuthnInstant = await issueSamlChallenge({
    response: { omitAuthnInstant: true },
  });
  expect(
    await refusalOrNull(
      acsRequest(noAuthnInstant.state, noAuthnInstant.samlResponse),
    ),
  ).toBe("SSO_SAML_MISSING_CLAIM");

  const noAuthnContext = await issueSamlChallenge({
    response: { authnContextClassRef: null },
  });
  expect(
    await refusalOrNull(
      acsRequest(noAuthnContext.state, noAuthnContext.samlResponse),
    ),
  ).toBe("SSO_SAML_MISSING_CLAIM");

  const noConfirmationData = await issueSamlChallenge({
    response: { omitSubjectConfirmationData: true },
  });
  expect(
    await refusalOrNull(
      acsRequest(noConfirmationData.state, noConfirmationData.samlResponse),
    ),
  ).toBe("SSO_SAML_MISSING_CLAIM");
});

test("expired_or_future_assertion_times_are_refused", {
  timeout: 60_000,
}, async () => {
  const expired = await issueSamlChallenge({
    response: { notOnOrAfter: NOW_SECONDS - 60 },
  });
  expect(
    await attemptProof(acsRequest(expired.state, expired.samlResponse)),
  ).toBeNull();

  const futureAuthnInstant = await issueSamlChallenge({
    response: { authnInstant: NOW_SECONDS + 600 },
  });
  expect(
    await attemptProof(
      acsRequest(futureAuthnInstant.state, futureAuthnInstant.samlResponse),
    ),
  ).toBeNull();

  const notYetValid = await issueSamlChallenge({
    response: { notBefore: NOW_SECONDS + 600 },
  });
  expect(
    await attemptProof(acsRequest(notYetValid.state, notYetValid.samlResponse)),
  ).toBeNull();
});

test("saml_relay_state_is_one_time", { timeout: 60_000 }, async () => {
  const setup = requireSetup();
  const issued = await issueSamlChallenge();

  const first = await attemptProof(
    acsRequest(issued.state, issued.samlResponse),
  );
  expect(first).not.toBeNull();

  // The same RelayState cannot yield a second evidence: the challenge is spent.
  const replay = await attemptProof(
    acsRequest(issued.state, issued.samlResponse),
  );
  expect(replay).toBeNull();

  const proofRows = await setup.sql`
    SELECT challenge_id FROM ${setup.sql(SCHEMA)}.${setup.sql(PROOFS_TABLE)}
    WHERE challenge_id = ${issued.challengeId}
  `;
  expect(proofRows).toHaveLength(1);
});

test("challenge_bound_to_another_provider_is_refused", {
  timeout: 60_000,
}, async () => {
  const otherProvider = await issueSamlChallenge({
    providerId: OTHER_PROVIDER_ID,
  });
  expect(
    await attemptProof(
      acsRequest(otherProvider.state, otherProvider.samlResponse),
    ),
  ).toBeNull();
});

test("saml_production_access_is_blocked_without_registered_provider_or_protocol_response", {
  timeout: 60_000,
}, async () => {
  const setup = requireSetup();

  // A deployment that has not registered the SAML provider cannot turn any
  // assertion into evidence — refusal, not a callback-time fallback.
  const bridgeWithoutSaml = createSsoEvidenceBridge({
    challenges: createDbChallengeStore(setup.sql),
    providers: { find: async () => null },
    clock: () => new Date(NOW),
  });
  const issued = await issueSamlChallenge();
  expect(
    await refusalOrNull(
      acsRequest(issued.state, issued.samlResponse),
      bridgeWithoutSaml,
    ),
  ).toBe("SSO_PROVIDER_UNKNOWN");

  // The ACS path takes only a protocol response: a GET is not one,
  expect(
    await refusalOrNull(new Request(`https://openbot.test${ACS_PATH}`)),
  ).toBe("SSO_REQUEST_UNRECOGNIZED");

  // and neither is a JSON claims body the endpoint never accepts.
  expect(
    await refusalOrNull(
      acsRequest(issued.state, issued.samlResponse, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          issuer: setup.idp.entityId,
          subject: "saml-test-subject",
          authenticatedAt: new Date(AUTHN_INSTANT_SECONDS * 1000).toISOString(),
        }),
      }),
    ),
  ).toBe("SSO_REQUEST_UNRECOGNIZED");

  const proofRows = await setup.sql`
    SELECT challenge_id FROM ${setup.sql(SCHEMA)}.${setup.sql(PROOFS_TABLE)}
    WHERE challenge_id = ${issued.challengeId}
  `;
  expect(proofRows).toHaveLength(0);
});

test("non_success_status_is_refused", { timeout: 60_000 }, async () => {
  const denied = await issueSamlChallenge({
    response: { status: STATUS_RESPONDER },
  });
  expect(
    await refusalOrNull(acsRequest(denied.state, denied.samlResponse)),
  ).toBe("SSO_AUTHORIZATION_DENIED");
});
