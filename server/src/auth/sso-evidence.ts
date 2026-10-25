/**
 * The SSO evidence bridge (T01.06/T01.07, interface §5): `verify(request)`
 * turns a company-auth SSO callback into a `VerifiedSsoEvidence` whose every
 * field came from the *signed* protocol payload and from the *server's own*
 * challenge record — never from `provisionUser.userInfo`, never from the
 * callback clock.
 *
 * Two protocol paths share one discipline. OIDC (T01.06) verifies the raw
 * id_token from the token endpoint: signature, issuer, audience, nonce, PKCE
 * and the signed `auth_time`/`acr`/`amr`. SAML (T01.07) verifies the raw
 * POST-binding Response at the server's own ACS: the enveloped XML-DSig
 * signature over the assertion, Audience/Recipient/Destination, the signed
 * AuthnInstant/AuthnContextClassRef, and the InResponseTo/RelayState binding
 * to the persisted AuthnRequest challenge. Neither path accepts a claims
 * body or synthesizes a value the protocol did not sign.
 *
 * Ports, not wiring: the challenge lookup and the provider registry are
 * dependencies because P11 owns their persistence and registration. What this
 * module owns is the refusal discipline — one-time challenges, provider
 * binding, and the signed-payload checks — so a caller cannot get evidence
 * out of anything the IdP did not sign and the server did not issue.
 *
 * The OIDC verification is done against the raw id_token from the token
 * endpoint, not against anything Better Auth's SSO plugin derives for
 * `provisionUser`: `auth_time`, `acr` and `amr` ride the signed payload, and
 * a value the plugin synthesises from the callback would defeat the point
 * (Global Constraints: "公司证明不能从 accounts 绑定或 session freshness
 * 反推"). The SAML verification likewise reads only the POSTed
 * `SAMLResponse`, recomputing the signature digest from the parsed document:
 * a value the transport form asserts about itself is not evidence.
 */

/**
 * Evidence only this module's verifier can construct: the brand symbol is
 * module-private, so nothing outside can forge the type the assurance layer
 * consumes (interface §5: "私有品牌，仅协议 verifier 生成").
 */
const verifiedSsoEvidence = Symbol("verified-sso-evidence");

export type VerifiedSsoEvidence = Readonly<{
  challengeId: string;
  providerId: string;
  protocol: "oidc" | "saml";
  issuer: string;
  subject: string;
  authenticatedAt: Date;
  strength: string;
  protocolRequestId: string;
}> & { readonly [verifiedSsoEvidence]: true };

export interface SsoEvidenceBridge {
  verify(request: Request): Promise<VerifiedSsoEvidence>;
}

/** The refusal the bridge throws; `code` is stable for logging and tests. */
export type SsoEvidenceRefusalCode =
  | "SSO_REQUEST_UNRECOGNIZED"
  | "SSO_PROTOCOL_UNSUPPORTED"
  | "SSO_CHALLENGE_MISSING_OR_CONSUMED"
  | "SSO_CHALLENGE_EXPIRED"
  | "SSO_CHALLENGE_PROVIDER_MISMATCH"
  | "SSO_AUTHORIZATION_DENIED"
  | "SSO_PROVIDER_UNKNOWN"
  | "SSO_TOKEN_EXCHANGE_FAILED"
  | "SSO_JWKS_UNAVAILABLE"
  | "SSO_ID_TOKEN_MALFORMED"
  | "SSO_ID_TOKEN_UNSIGNED"
  | "SSO_ID_TOKEN_ALGORITHM_UNSUPPORTED"
  | "SSO_ID_TOKEN_SIGNATURE_INVALID"
  | "SSO_ID_TOKEN_ISSUER_MISMATCH"
  | "SSO_ID_TOKEN_AUDIENCE_MISMATCH"
  | "SSO_ID_TOKEN_TIME_INVALID"
  | "SSO_ID_TOKEN_NONCE_MISMATCH"
  | "SSO_ID_TOKEN_MISSING_CLAIM"
  | "SSO_SAML_RESPONSE_MALFORMED"
  | "SSO_SAML_ASSERTION_UNSIGNED"
  | "SSO_SAML_ALGORITHM_UNSUPPORTED"
  | "SSO_SAML_SIGNATURE_INVALID"
  | "SSO_SAML_ISSUER_MISMATCH"
  | "SSO_SAML_AUDIENCE_MISMATCH"
  | "SSO_SAML_RECIPIENT_MISMATCH"
  | "SSO_SAML_IN_RESPONSE_TO_MISMATCH"
  | "SSO_SAML_RELAY_STATE_MISMATCH"
  | "SSO_SAML_TIME_INVALID"
  | "SSO_SAML_MISSING_CLAIM";

export class SsoEvidenceRefused extends Error {
  readonly code: SsoEvidenceRefusalCode;

  constructor(code: SsoEvidenceRefusalCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "SsoEvidenceRefused";
    this.code = code;
  }
}

function refuse(
  code: SsoEvidenceRefusalCode,
  message: string,
): SsoEvidenceRefused {
  return new SsoEvidenceRefused(code, message);
}

/** The challenge the server issued for this authorization request (P11 owns
 * its creation; this port is the one-way, one-time read the bridge needs). */
export interface SsoChallengeRecord {
  readonly challengeId: string;
  readonly providerId: string;
  readonly state: string;
  readonly nonce: string;
  /** The PKCE code_verifier the server generated with the challenge. */
  readonly codeVerifier: string;
  /** The server's own id for the authorization request the browser followed. */
  readonly protocolRequestId: string;
  readonly expiresAt: Date;
}

export interface SsoChallengeStore {
  /**
   * Take the challenge for `state`, at most once. `null` means no such state —
   * unknown, already used, or created by another deployment — and must be the
   * atomic answer of the store (DELETE … RETURNING), not a read-then-delete
   * the bridge could race.
   *
   * For a SAML challenge the correlation token is the RelayState the server's
   * own SP issued with its AuthnRequest, and the record's `state` and
   * `protocolRequestId` carry that RelayState and the AuthnRequest ID; the
   * `nonce`/`codeVerifier` fields are the OIDC path's and are never read for
   * SAML.
   */
  consume(state: string): Promise<SsoChallengeRecord | null>;
}

/** A registered OIDC provider, as the bridge needs it. The secret is read only
 * for the back-channel exchange and never leaves this module. */
export interface SsoOidcProvider {
  readonly providerId: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
}

export interface SsoProviderRegistry {
  find(providerId: string): Promise<SsoOidcProvider | null>;

  /**
   * A registered SAML provider; absent means this deployment registers no
   * SAML IdPs, so every ACS request refuses with `SSO_PROVIDER_UNKNOWN` —
   * an enabled-SAML deployment that cannot produce evidence blocks the
   * production access behind it, it does not fall back to callback time.
   */
  findSaml?(providerId: string): Promise<SsoSamlProvider | null>;
}

/**
 * A registered SAML IdP, as the bridge needs it: the entity ID assertions
 * must name as Issuer, this SP's own entity ID and ACS URL the assertion must
 * be bound to (Audience, Recipient, Response Destination), and the IdP's
 * signing keys as PEM SubjectPublicKeyInfo blocks. Signature verification is
 * against these registered keys only — the document's KeyInfo, if any, is
 * never trusted to name the signer.
 */
export interface SsoSamlProvider {
  readonly providerId: string;
  /** The IdP's entity ID (`saml:Issuer`). */
  readonly issuer: string;
  /** OpenBot's SP entity ID (`saml:Audience`). */
  readonly spEntityId: string;
  /** The server's own ACS URL (`Recipient` / `Destination`). */
  readonly acsUrl: string;
  /** RSA public keys, PEM SubjectPublicKeyInfo, any of which may have signed. */
  readonly signingKeys: readonly string[];
}

export interface SsoEvidenceDeps {
  readonly challenges: SsoChallengeStore;
  readonly providers: SsoProviderRegistry;
  /** Defaults to the wall clock; injected as a fixed clock by the tests. */
  readonly clock?: () => Date;
  /** Defaults to `fetch`; injectable to observe or isolate the IdP round trips. */
  readonly fetch?: typeof globalThis.fetch;
}

const OIDC_CALLBACK_PATH = /\/company-auth\/oidc\/callback\/([^/]+)\/?$/;
const SAML_ACS_PATH = /\/company-auth\/saml\/acs\/([^/]+)\/?$/;

/** JWS signing algorithms this bridge accepts. Symmetric (`HS*`) and `none`
 * never appear: the key comes from the provider's published JWKS, and a
 * client-secret-as-HMAC-key token would let the IdP's own client forge one. */
const ALLOWED_ALGORITHMS = {
  RS256: {
    kty: "RSA",
    import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    verify: { name: "RSASSA-PKCS1-v1_5" },
  },
  PS256: {
    kty: "RSA",
    import: { name: "RSA-PSS", hash: "SHA-256" },
    verify: { name: "RSA-PSS", saltLength: 32 },
  },
  ES256: {
    kty: "EC",
    import: { name: "ECDSA", namedCurve: "P-256" },
    verify: { name: "ECDSA", hash: "SHA-256" },
  },
} as const;

/** Tolerated difference between the signed `iat`/`auth_time` and our clock;
 * enough for ordinary drift, not enough to accept a token minted later. */
const CLOCK_SKEW_SECONDS = 60;

/** A JWKS is not fetched per callback: the same provider verifies many. Five
 * minutes bounds key rotation staleness while keeping the IdP round trip off
 * the hot path. */
const JWKS_CACHE_MS = 5 * 60_000;

const MULTI_FACTOR_METHODS = new Set([
  "mfa",
  "otp",
  "totp",
  "hwk",
  "swk",
  "webauthn",
  "fido2",
]);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** The JWKS key shape this bridge reads: the DOM `JsonWebKey` type has no
 * `kid`, but every IdP that rotates keys publishes one. */
type JwksKey = JsonWebKey & { kid?: string };

function decodeBase64Url(input: string): Uint8Array<ArrayBuffer> {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** The PKCE S256 code_challenge of a code_verifier, for whoever issues the
 * challenge and builds the authorization redirect. */
export async function s256CodeChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(codeVerifier),
  );
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function parseJsonSegment(segment: string): unknown {
  try {
    return JSON.parse(textDecoder.decode(decodeBase64Url(segment)));
  } catch {
    return null;
  }
}

function requireSingle(url: URL, name: string): string {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1 || !values[0]) {
    throw refuse(
      "SSO_REQUEST_UNRECOGNIZED",
      `the callback must carry exactly one non-empty ${name}`,
    );
  }
  return values[0];
}

interface ParsedOidcCallback {
  protocol: "oidc";
  url: URL;
  providerId: string;
  code: string;
  state: string;
}

interface ParsedSamlCallback {
  protocol: "saml";
  providerId: string;
  samlResponse: string;
  relayState: string;
}

type ParsedCallback = ParsedOidcCallback | ParsedSamlCallback;

/** Read the provider id out of the ACS/callback path segment. */
function providerIdOf(url: URL): string {
  const match =
    OIDC_CALLBACK_PATH.exec(url.pathname) ?? SAML_ACS_PATH.exec(url.pathname);
  if (!match) {
    throw refuse(
      "SSO_REQUEST_UNRECOGNIZED",
      "the request is not a company-auth SSO callback",
    );
  }
  let providerId: string;
  try {
    providerId = decodeURIComponent(match[1]);
  } catch {
    throw refuse(
      "SSO_REQUEST_UNRECOGNIZED",
      "the provider id is not URI-decodable",
    );
  }
  if (!providerId) {
    throw refuse("SSO_REQUEST_UNRECOGNIZED", "the callback names no provider");
  }
  return providerId;
}

/** The SAML POST binding: the browser hands the ACS a form whose only
 * payloads are the base64 `SAMLResponse` and the `RelayState` correlation
 * token. Anything else — a GET, a JSON claims body — is not a protocol
 * response and is not parsed as one. */
async function parseSamlCallback(
  request: Request,
  url: URL,
): Promise<ParsedSamlCallback> {
  if (request.method !== "POST") {
    throw refuse("SSO_REQUEST_UNRECOGNIZED", "the SAML ACS accepts a POST");
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/x-www-form-urlencoded\b/i.test(contentType)) {
    throw refuse(
      "SSO_REQUEST_UNRECOGNIZED",
      "the SAML ACS accepts only the protocol's form POST, not a claims body",
    );
  }
  const form = new URLSearchParams(await request.text());
  const single = (name: string): string => {
    const values = form.getAll(name);
    if (values.length !== 1 || !values[0]) {
      throw refuse(
        "SSO_REQUEST_UNRECOGNIZED",
        `the ACS POST must carry exactly one non-empty ${name}`,
      );
    }
    return values[0];
  };
  return {
    protocol: "saml",
    providerId: providerIdOf(url),
    samlResponse: single("SAMLResponse"),
    relayState: single("RelayState"),
  };
}

function parseOidcCallback(request: Request, url: URL): ParsedOidcCallback {
  if (request.method !== "GET") {
    throw refuse("SSO_REQUEST_UNRECOGNIZED", "the OIDC callback is a GET");
  }
  const match = OIDC_CALLBACK_PATH.exec(url.pathname);
  if (!match) {
    throw refuse(
      "SSO_REQUEST_UNRECOGNIZED",
      "the request is not a company-auth OIDC callback",
    );
  }
  const providerId = providerIdOf(url);
  return {
    protocol: "oidc",
    url,
    providerId,
    code: requireSingle(url, "code"),
    state: requireSingle(url, "state"),
  };
}

async function parseCallback(request: Request): Promise<ParsedCallback> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw refuse("SSO_REQUEST_UNRECOGNIZED", "the callback URL is malformed");
  }
  if (SAML_ACS_PATH.test(url.pathname)) {
    return parseSamlCallback(request, url);
  }
  return parseOidcCallback(request, url);
}

async function exchangeCode(
  provider: SsoOidcProvider,
  challenge: SsoChallengeRecord,
  code: string,
  fetcher: typeof globalThis.fetch,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: provider.redirectUri,
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    // The challenge's verifier, not the request's: PKCE is bound to what the
    // server issued, so a callback cannot substitute its own verifier.
    code_verifier: challenge.codeVerifier,
  });
  let response: Response;
  try {
    response = await fetcher(provider.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    throw refuse(
      "SSO_TOKEN_EXCHANGE_FAILED",
      "the provider's token endpoint could not be reached",
    );
  }
  if (!response.ok) {
    // Status only: the response body may echo the code or a client secret.
    throw refuse(
      "SSO_TOKEN_EXCHANGE_FAILED",
      `the provider's token endpoint answered ${response.status}`,
    );
  }
  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const idToken = payload?.id_token;
  if (typeof idToken !== "string" || !idToken) {
    throw refuse(
      "SSO_TOKEN_EXCHANGE_FAILED",
      "the token response carried no id_token",
    );
  }
  return idToken;
}

async function jwksKeys(
  provider: SsoOidcProvider,
  fetcher: typeof globalThis.fetch,
  cache: Map<string, { keys: JwksKey[]; fetchedAt: number }>,
): Promise<JwksKey[]> {
  const cached = cache.get(provider.jwksUri);
  if (cached && Date.now() - cached.fetchedAt < JWKS_CACHE_MS) {
    return cached.keys;
  }
  let response: Response;
  try {
    response = await fetcher(provider.jwksUri);
  } catch {
    throw refuse(
      "SSO_JWKS_UNAVAILABLE",
      "the provider's JWKS could not be reached",
    );
  }
  if (!response.ok) {
    throw refuse(
      "SSO_JWKS_UNAVAILABLE",
      `the provider's JWKS answered ${response.status}`,
    );
  }
  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const keys = payload?.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw refuse("SSO_JWKS_UNAVAILABLE", "the provider's JWKS carries no keys");
  }
  const typed = keys.filter(
    (key): key is JwksKey => Boolean(key) && typeof key === "object",
  );
  cache.set(provider.jwksUri, { keys: typed, fetchedAt: Date.now() });
  return typed;
}

async function verifySignature(
  header: Record<string, unknown>,
  signingInput: string,
  signatureSegment: string,
  provider: SsoOidcProvider,
  fetcher: typeof globalThis.fetch,
  cache: Map<string, { keys: JwksKey[]; fetchedAt: number }>,
): Promise<void> {
  const alg = header.alg;
  if (alg === "none") {
    throw refuse(
      "SSO_ID_TOKEN_UNSIGNED",
      "an unsecured JWS proves nothing about who asserted the claims",
    );
  }
  if (typeof alg !== "string" || !(alg in ALLOWED_ALGORITHMS)) {
    throw refuse(
      "SSO_ID_TOKEN_ALGORITHM_UNSUPPORTED",
      `the id_token uses an algorithm this bridge does not accept: ${String(alg)}`,
    );
  }
  const algorithm = ALLOWED_ALGORITHMS[alg as keyof typeof ALLOWED_ALGORITHMS];
  const keys = await jwksKeys(provider, fetcher, cache);
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  const candidates = keys.filter(
    (key) =>
      key.kty === algorithm.kty && (kid === undefined || key.kid === kid),
  );
  if (candidates.length === 0) {
    throw refuse(
      "SSO_ID_TOKEN_SIGNATURE_INVALID",
      "no key in the provider's JWKS matches the id_token header",
    );
  }
  const data = textEncoder.encode(signingInput);
  const signature = decodeBase64Url(signatureSegment);
  for (const key of candidates) {
    try {
      const cryptoKey = await crypto.subtle.importKey(
        "jwk",
        key,
        algorithm.import as RsaHashedImportParams | EcKeyImportParams,
        false,
        ["verify"],
      );
      if (
        await crypto.subtle.verify(
          algorithm.verify as RsaPssParams | EcdsaParams,
          cryptoKey,
          signature,
          data,
        )
      ) {
        return;
      }
    } catch {
      // A malformed candidate key is not the signer; try the next one.
    }
  }
  throw refuse(
    "SSO_ID_TOKEN_SIGNATURE_INVALID",
    "the id_token signature does not verify against the provider's JWKS",
  );
}

function requireString(
  payload: Record<string, unknown>,
  claim: string,
): string {
  const value = payload[claim];
  if (typeof value !== "string" || !value) {
    throw refuse(
      "SSO_ID_TOKEN_MISSING_CLAIM",
      `the signed id_token carries no ${claim}`,
    );
  }
  return value;
}

function requireNumber(
  payload: Record<string, unknown>,
  claim: string,
): number {
  const value = payload[claim];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw refuse(
      "SSO_ID_TOKEN_MISSING_CLAIM",
      `the signed id_token carries no numeric ${claim}`,
    );
  }
  return value;
}

/** `strength` from the signed `acr`, or from `amr` when the IdP sent no acr.
 * Neither claim means the IdP asserted no assurance at all, which is a
 * refusal rather than a default. */
function strengthOf(payload: Record<string, unknown>): string | null {
  const acr = typeof payload.acr === "string" ? payload.acr.trim() : "";
  if (acr) return acr;
  const amr = Array.isArray(payload.amr)
    ? payload.amr.filter(
        (method): method is string =>
          typeof method === "string" && method.length > 0,
      )
    : [];
  if (amr.length === 0) return null;
  return amr.some((method) => MULTI_FACTOR_METHODS.has(method.toLowerCase()))
    ? "mfa"
    : "single-factor";
}

async function verifyIdToken(
  provider: SsoOidcProvider,
  challenge: SsoChallengeRecord,
  idToken: string,
  now: Date,
  fetcher: typeof globalThis.fetch,
  cache: Map<string, { keys: JwksKey[]; fetchedAt: number }>,
): Promise<{
  issuer: string;
  subject: string;
  authenticatedAt: Date;
  strength: string;
}> {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw refuse(
      "SSO_ID_TOKEN_MALFORMED",
      "the id_token is not a JWS compact serialization",
    );
  }
  const header = parseJsonSegment(parts[0]);
  if (!header || typeof header !== "object" || Array.isArray(header)) {
    throw refuse("SSO_ID_TOKEN_MALFORMED", "the id_token header is not JSON");
  }
  await verifySignature(
    header as Record<string, unknown>,
    `${parts[0]}.${parts[1]}`,
    parts[2],
    provider,
    fetcher,
    cache,
  );

  const payload = parseJsonSegment(parts[1]);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw refuse("SSO_ID_TOKEN_MALFORMED", "the id_token payload is not JSON");
  }
  const claims = payload as Record<string, unknown>;

  const issuer = requireString(claims, "iss");
  if (issuer !== provider.issuer) {
    throw refuse(
      "SSO_ID_TOKEN_ISSUER_MISMATCH",
      "the id_token signer is not the provider this challenge belongs to",
    );
  }

  const audience = claims.aud;
  const audiences = Array.isArray(audience)
    ? audience.filter((value): value is string => typeof value === "string")
    : typeof audience === "string"
      ? [audience]
      : [];
  if (!audiences.includes(provider.clientId)) {
    throw refuse(
      "SSO_ID_TOKEN_AUDIENCE_MISMATCH",
      "the id_token was not issued for this client",
    );
  }
  if (audiences.length > 1 && claims.azp !== provider.clientId) {
    throw refuse(
      "SSO_ID_TOKEN_AUDIENCE_MISMATCH",
      "a multi-audience id_token must name this client as azp",
    );
  }

  const subject = requireString(claims, "sub");

  const expiresAt = requireNumber(claims, "exp");
  const issuedAt = requireNumber(claims, "iat");
  const nowSeconds = now.getTime() / 1000;
  if (nowSeconds >= expiresAt) {
    throw refuse("SSO_ID_TOKEN_TIME_INVALID", "the id_token has expired");
  }
  if (issuedAt > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw refuse(
      "SSO_ID_TOKEN_TIME_INVALID",
      "the id_token claims to have been issued in the future",
    );
  }

  const nonce = requireString(claims, "nonce");
  if (nonce !== challenge.nonce) {
    throw refuse(
      "SSO_ID_TOKEN_NONCE_MISMATCH",
      "the signed nonce does not answer this challenge",
    );
  }

  const authTime = requireNumber(claims, "auth_time");
  if (authTime < 0 || authTime > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw refuse(
      "SSO_ID_TOKEN_TIME_INVALID",
      "the signed auth_time is not a time the clock can confirm",
    );
  }

  const strength = strengthOf(claims);
  if (!strength) {
    throw refuse(
      "SSO_ID_TOKEN_MISSING_CLAIM",
      "the signed id_token carries neither acr nor amr, so no strength can be asserted",
    );
  }

  return {
    issuer,
    subject,
    authenticatedAt: new Date(Math.floor(authTime) * 1000),
    strength,
  };
}

/*
 * ── SAML (T01.07) ─────────────────────────────────────────────────────────
 *
 * The POST binding carries a base64 samlp:Response whose assertion carries an
 * enveloped XML-DSig signature. Verifying it means recomputing the reference
 * digest over the assertion in exclusive canonical form — with the Signature
 * element itself removed by the enveloped transform — and then verifying the
 * SignedInfo's own canonical bytes against the provider's registered keys.
 * Nothing the document says about itself (KeyInfo, transport shape, attribute
 * spelling outside the signature) is trusted: a canonicalization that both
 * sides must agree on byte-for-byte is what makes an edited document fail,
 * not the transport having "looked wrong".
 *
 * The parser below is namespace-aware on the profile SAML actually uses
 * (prefixed elements, unprefixed attributes, no DTDs or PIs), refuses
 * undeclared prefixes and duplicate attributes, and drops comments and
 * processing instructions the way C14N would.
 */

const XMLDSIG_NAMESPACE = "http://www.w3.org/2000/09/xmldsig#";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const SAML_ASSERTION_NAMESPACE = "urn:oasis:names:tc:SAML:2.0:assertion";
const SAML_PROTOCOL_NAMESPACE = "urn:oasis:names:tc:SAML:2.0:protocol";
const BEARER_CONFIRMATION_METHOD = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const SAML_STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";
const EXCLUSIVE_C14N = "http://www.w3.org/2001/10/xml-exc-c14n#";
const ENVELOPED_SIGNATURE_TRANSFORM =
  "http://www.w3.org/2000/09/xmldsig#enveloped-signature";
const RSA_SHA256_SIGNATURE =
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
const SHA256_DIGEST = "http://www.w3.org/2001/04/xmlenc#sha256";

/** A SAML response big enough to matter for evidence is a few kilobytes; a
 * megabyte is a hostile payload, not a login. */
const MAX_SAML_RESPONSE_BYTES = 1 << 20;

interface XmlText {
  text: string;
}

interface XmlElement {
  readonly ns: string | null;
  readonly prefix: string | null;
  readonly local: string;
  readonly attributes: readonly XmlAttribute[];
  readonly children: XmlNode[];
  /** Prefix→URI bindings in scope at this element; "" is the default. */
  readonly namespaces: ReadonlyMap<string, string>;
}

type XmlNode = XmlElement | XmlText;

interface XmlAttribute {
  readonly ns: string | null;
  readonly prefix: string | null;
  readonly local: string;
  readonly value: string;
}

function xmlMalformed(why: string): SsoEvidenceRefused {
  return refuse(
    "SSO_SAML_RESPONSE_MALFORMED",
    `the SAMLResponse XML is malformed: ${why}`,
  );
}

function splitQname(raw: string): { prefix: string | null; local: string } {
  const colon = raw.indexOf(":");
  if (colon === -1) return { prefix: null, local: raw };
  if (
    colon === 0 ||
    colon === raw.length - 1 ||
    raw.indexOf(":", colon + 1) !== -1
  ) {
    throw xmlMalformed(`the name "${raw}" is not a valid qualified name`);
  }
  return { prefix: raw.slice(0, colon), local: raw.slice(colon + 1) };
}

function parseXmlDocument(documentText: string): XmlElement {
  // Line-end normalization (\r\n and \r become \n) is a parse-time XML rule;
  // doing it up front keeps text and attribute values canonical-shaped.
  const text = documentText.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const length = text.length;
  let pos = 0;
  let root: XmlElement | null = null;
  const stack: XmlElement[] = [];

  const decodeEntities = (raw: string, context: string): string => {
    if (!raw.includes("&")) return raw;
    return raw.replace(
      /&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g,
      (whole, body: string) => {
        if (body === "amp") return "&";
        if (body === "lt") return "<";
        if (body === "gt") return ">";
        if (body === "quot") return '"';
        if (body === "apos") return "'";
        if (body.startsWith("#")) {
          const code = body.startsWith("#x")
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
          if (
            !Number.isInteger(code) ||
            code > 0x10ffff ||
            (code < 0x20 && code !== 0x9 && code !== 0xa && code !== 0xd)
          ) {
            throw xmlMalformed(
              `the character reference ${whole} is not XML-legal in ${context}`,
            );
          }
          return String.fromCodePoint(code);
        }
        throw xmlMalformed(`unknown entity ${whole} in ${context}`);
      },
    );
  };

  const appendText = (chunk: string, raw = false): void => {
    if (!chunk) return;
    const decoded = raw ? chunk : decodeEntities(chunk, "text content");
    const top = stack.at(-1);
    if (!top) {
      if (decoded.trim() !== "") {
        throw xmlMalformed("character data appears outside the root element");
      }
      return;
    }
    const last = top.children.at(-1);
    if (last && "text" in last) last.text += decoded;
    else top.children.push({ text: decoded });
  };

  const namePattern = /^[A-Za-z_:][A-Za-z0-9_.:-]*/;

  while (pos < length) {
    const next = text.indexOf("<", pos);
    if (next === -1) {
      appendText(text.slice(pos));
      pos = length;
      break;
    }
    if (next > pos) appendText(text.slice(pos, next));
    pos = next;
    if (text.startsWith("<!--", pos)) {
      const end = text.indexOf("-->", pos + 4);
      if (end === -1) throw xmlMalformed("a comment is unterminated");
      pos = end + 3;
    } else if (text.startsWith("<![CDATA[", pos)) {
      const end = text.indexOf("]]>", pos + 9);
      if (end === -1) throw xmlMalformed("a CDATA section is unterminated");
      appendText(text.slice(pos + 9, end), true);
      pos = end + 3;
    } else if (text.startsWith("<?", pos)) {
      const end = text.indexOf("?>", pos + 2);
      if (end === -1) {
        throw xmlMalformed("a processing instruction is unterminated");
      }
      pos = end + 2;
    } else if (text.startsWith("<!", pos)) {
      throw xmlMalformed("doctype and declarations are not accepted");
    } else if (text.startsWith("</", pos)) {
      const end = text.indexOf(">", pos + 2);
      if (end === -1) throw xmlMalformed("an end tag is unterminated");
      const rawName = text.slice(pos + 2, end).trim();
      const top = stack.at(-1);
      if (!top) throw xmlMalformed("an end tag closes no open element");
      const topName = top.prefix ? `${top.prefix}:${top.local}` : top.local;
      if (rawName !== topName) {
        throw xmlMalformed(
          `the end tag </${rawName}> does not match <${topName}>`,
        );
      }
      stack.pop();
      pos = end + 1;
    } else {
      let cursor = pos + 1;
      const nameMatch = namePattern.exec(text.slice(cursor));
      if (!nameMatch) throw xmlMalformed("a start tag names no element");
      const rawName = nameMatch[0];
      cursor += rawName.length;
      const attributes: XmlAttribute[] = [];
      const namespaces = new Map<string, string>(
        stack.at(-1)?.namespaces ?? [],
      );
      let selfClosing = false;
      for (;;) {
        while (cursor < length && /\s/.test(text.charAt(cursor))) cursor++;
        if (cursor >= length) throw xmlMalformed("a start tag is unterminated");
        if (text.charAt(cursor) === ">") {
          cursor += 1;
          break;
        }
        if (text.charAt(cursor) === "/") {
          if (text.charAt(cursor + 1) !== ">") {
            throw xmlMalformed("a start tag close is malformed");
          }
          selfClosing = true;
          cursor += 2;
          break;
        }
        const attributeMatch = namePattern.exec(text.slice(cursor));
        if (!attributeMatch) {
          throw xmlMalformed("expected an attribute name in a start tag");
        }
        const rawAttribute = attributeMatch[0];
        cursor += rawAttribute.length;
        while (cursor < length && /\s/.test(text.charAt(cursor))) cursor++;
        if (text.charAt(cursor) !== "=") {
          throw xmlMalformed("an attribute is not a name=value pair");
        }
        cursor++;
        while (cursor < length && /\s/.test(text.charAt(cursor))) cursor++;
        const quote = text.charAt(cursor);
        if (quote !== '"' && quote !== "'") {
          throw xmlMalformed("an attribute value is not quoted");
        }
        const valueEnd = text.indexOf(quote, cursor + 1);
        if (valueEnd === -1) {
          throw xmlMalformed("an attribute value is unterminated");
        }
        const rawValue = text.slice(cursor + 1, valueEnd);
        cursor = valueEnd + 1;
        if (rawAttribute === "xmlns") {
          namespaces.set("", rawValue);
        } else if (rawAttribute.startsWith("xmlns:")) {
          const prefix = rawAttribute.slice(6);
          if (!prefix) throw xmlMalformed("a namespace prefix is empty");
          namespaces.set(prefix, rawValue);
        } else {
          const { prefix, local } = splitQname(rawAttribute);
          let ns: string | null = null;
          if (prefix !== null) {
            if (prefix === "xml") ns = XML_NAMESPACE;
            else {
              ns = namespaces.get(prefix) ?? null;
              if (ns === null) {
                throw xmlMalformed(
                  `the prefix ${prefix} has no namespace declaration`,
                );
              }
            }
          }
          attributes.push({
            ns,
            prefix,
            local,
            value: decodeEntities(rawValue, "an attribute"),
          });
        }
      }
      const seen = new Set(
        attributes.map(
          (attribute) => `${attribute.ns ?? ""}|${attribute.local}`,
        ),
      );
      if (seen.size !== attributes.length) {
        throw xmlMalformed("an element carries a duplicate attribute");
      }
      const { prefix, local } = splitQname(rawName);
      let ns: string | null = null;
      if (prefix === "xml") ns = XML_NAMESPACE;
      else if (prefix !== null) {
        ns = namespaces.get(prefix) ?? null;
        if (ns === null) {
          throw xmlMalformed(
            `the prefix ${prefix} has no namespace declaration`,
          );
        }
      } else {
        ns = namespaces.get("") ?? null;
      }
      const element: XmlElement = {
        ns,
        prefix,
        local,
        attributes,
        children: [],
        namespaces,
      };
      const parent = stack.at(-1);
      if (parent) parent.children.push(element);
      else if (root) throw xmlMalformed("the document has more than one root");
      else root = element;
      if (!selfClosing) stack.push(element);
      pos = cursor;
    }
  }
  if (stack.length) throw xmlMalformed("an element is never closed");
  if (!root) throw xmlMalformed("the document has no root element");
  return root;
}

function xmlChildren(
  element: XmlElement,
  local: string,
  ns: string,
): XmlElement[] {
  return element.children.filter(
    (child): child is XmlElement =>
      "local" in child && child.local === local && child.ns === ns,
  );
}

function xmlChild(
  element: XmlElement,
  local: string,
  ns: string,
): XmlElement | null {
  return xmlChildren(element, local, ns)[0] ?? null;
}

/** SAML's own attributes are unprefixed; a prefixed one is not one of ours. */
function xmlAttribute(element: XmlElement, local: string): string | null {
  const found = element.attributes.find(
    (attribute) => attribute.ns === null && attribute.local === local,
  );
  return found ? found.value : null;
}

function xmlText(element: XmlElement): string {
  return element.children
    .filter((child): child is XmlText => "text" in child)
    .map((child) => child.text)
    .join("");
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#xD;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value)
    .replace(/"/g, "&quot;")
    .replace(/\t/g, "&#x9;")
    .replace(/\n/g, "&#xA;");
}

/**
 * Exclusive canonical XML of an element subtree: namespace declarations are
 * emitted at the first element that visibly utilizes the prefix, declarations
 * and attributes sort by prefix then (namespace, local), and text escapes per
 * C14N. `removed` implements the enveloped-signature transform: the node is
 * serialized out of the subtree it is embedded in.
 */
function canonicalXml(element: XmlElement, removed: XmlElement | null): string {
  const parts: string[] = [];
  const emit = (node: XmlElement, inherited: ReadonlySet<string>): void => {
    const scope = new Set(inherited);
    const utilized = new Set<string>();
    if (node.prefix) utilized.add(node.prefix);
    for (const attribute of node.attributes) {
      if (attribute.prefix && attribute.prefix !== "xml") {
        utilized.add(attribute.prefix);
      }
    }
    const name = node.prefix ? `${node.prefix}:${node.local}` : node.local;
    parts.push(`<${name}`);
    for (const prefix of [...utilized]
      .filter((candidate) => !scope.has(candidate))
      .sort()) {
      const uri = node.namespaces.get(prefix);
      if (uri === undefined) {
        throw xmlMalformed(
          `the prefix ${prefix} has no namespace declaration to canonicalize`,
        );
      }
      parts.push(` xmlns:${prefix}="${escapeXmlAttribute(uri)}"`);
      scope.add(prefix);
    }
    const attributes = [...node.attributes].sort((left, right) => {
      const leftNs = left.ns ?? "";
      const rightNs = right.ns ?? "";
      if (leftNs !== rightNs) return leftNs < rightNs ? -1 : 1;
      return left.local < right.local ? -1 : left.local > right.local ? 1 : 0;
    });
    for (const attribute of attributes) {
      parts.push(
        ` ${attribute.prefix ? `${attribute.prefix}:` : ""}${attribute.local}="${escapeXmlAttribute(attribute.value)}"`,
      );
    }
    parts.push(">");
    for (const child of node.children) {
      if ("text" in child) parts.push(escapeXmlText(child.text));
      else if (child !== removed) emit(child, scope);
    }
    parts.push(`</${name}>`);
  };
  emit(element, new Set());
  return parts.join("");
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string, what: string): Uint8Array<ArrayBuffer> {
  const compact = value.replace(/\s+/g, "");
  try {
    const binary = atob(compact);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw refuse("SSO_SAML_RESPONSE_MALFORMED", `${what} is not base64`);
  }
}

async function sha256Base64(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(value),
  );
  return base64(new Uint8Array(digest));
}

function importPemSpki(pem: string): Promise<CryptoKey> {
  const match =
    /-----BEGIN PUBLIC KEY-----([\s\S]+?)-----END PUBLIC KEY-----/.exec(pem);
  if (!match) {
    throw refuse(
      "SSO_SAML_SIGNATURE_INVALID",
      "a registered SAML signing key is not a PEM SubjectPublicKeyInfo",
    );
  }
  return crypto.subtle.importKey(
    "spki",
    decodeBase64(match[1], "the registered signing key"),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

function parseXsDateTime(value: string, claim: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw xmlMalformed(`${claim} is not a valid xs:dateTime: ${value}`);
  }
  return milliseconds;
}

/**
 * The enveloped signature over the assertion: the reference digest must match
 * the canonicalized assertion without the Signature element, and the
 * SignatureValue must verify over the canonicalized SignedInfo against one of
 * the provider's registered keys. KeyInfo is never consulted — which key may
 * sign is a registration fact, not a document fact.
 */
async function verifySamlSignature(
  assertion: XmlElement,
  signature: XmlElement,
  assertionId: string,
  provider: SsoSamlProvider,
): Promise<void> {
  const signedInfo = xmlChild(signature, "SignedInfo", XMLDSIG_NAMESPACE);
  if (!signedInfo) {
    throw xmlMalformed("the Signature carries no SignedInfo");
  }
  const algorithmOf = (parent: XmlElement, local: string): string | null => {
    const element = xmlChild(parent, local, XMLDSIG_NAMESPACE);
    return element ? xmlAttribute(element, "Algorithm") : null;
  };
  const canonicalization = algorithmOf(signedInfo, "CanonicalizationMethod");
  if (canonicalization !== EXCLUSIVE_C14N) {
    throw refuse(
      "SSO_SAML_ALGORITHM_UNSUPPORTED",
      `the signature canonicalization ${String(canonicalization)} is not exclusive c14n`,
    );
  }
  const signatureMethod = algorithmOf(signedInfo, "SignatureMethod");
  if (signatureMethod !== RSA_SHA256_SIGNATURE) {
    throw refuse(
      "SSO_SAML_ALGORITHM_UNSUPPORTED",
      `the signature method ${String(signatureMethod)} is not rsa-sha256`,
    );
  }
  const reference = xmlChild(signedInfo, "Reference", XMLDSIG_NAMESPACE);
  if (!reference) throw xmlMalformed("the SignedInfo carries no Reference");
  const referenceUri = xmlAttribute(reference, "URI");
  if (referenceUri !== `#${assertionId}`) {
    throw refuse(
      "SSO_SAML_SIGNATURE_INVALID",
      "the signature's reference does not cover the assertion it is embedded in",
    );
  }
  const transforms = xmlChild(reference, "Transforms", XMLDSIG_NAMESPACE);
  const transformAlgorithms = transforms
    ? xmlChildren(transforms, "Transform", XMLDSIG_NAMESPACE)
        .map((transform) => xmlAttribute(transform, "Algorithm"))
        .filter((algorithm): algorithm is string => algorithm !== null)
    : [];
  if (
    transformAlgorithms.length !== 2 ||
    !transformAlgorithms.includes(ENVELOPED_SIGNATURE_TRANSFORM) ||
    !transformAlgorithms.includes(EXCLUSIVE_C14N)
  ) {
    throw refuse(
      "SSO_SAML_SIGNATURE_INVALID",
      "the reference is not enveloped-signature plus exclusive c14n",
    );
  }
  const digestMethod = algorithmOf(reference, "DigestMethod");
  if (digestMethod !== SHA256_DIGEST) {
    throw refuse(
      "SSO_SAML_ALGORITHM_UNSUPPORTED",
      `the digest method ${String(digestMethod)} is not sha-256`,
    );
  }
  const digestValueElement = xmlChild(
    reference,
    "DigestValue",
    XMLDSIG_NAMESPACE,
  );
  const expectedDigest = digestValueElement
    ? xmlText(digestValueElement).trim()
    : "";
  if (!expectedDigest) {
    throw xmlMalformed("the reference carries no DigestValue");
  }
  // The enveloped transform: the digest input is the assertion exactly as
  // verified, with the Signature element spliced out.
  const actualDigest = await sha256Base64(canonicalXml(assertion, signature));
  if (actualDigest !== expectedDigest) {
    throw refuse(
      "SSO_SAML_SIGNATURE_INVALID",
      "the signed assertion bytes do not match the reference digest",
    );
  }
  const signatureValueElement = xmlChild(
    signature,
    "SignatureValue",
    XMLDSIG_NAMESPACE,
  );
  const signatureText = signatureValueElement
    ? xmlText(signatureValueElement).trim()
    : "";
  if (!signatureText) {
    throw xmlMalformed("the Signature carries no SignatureValue");
  }
  const signatureBytes = decodeBase64(signatureText, "the SignatureValue");
  const signedInfoBytes = textEncoder.encode(canonicalXml(signedInfo, null));
  for (const pem of provider.signingKeys) {
    try {
      const key = await importPemSpki(pem);
      if (
        await crypto.subtle.verify(
          { name: "RSASSA-PKCS1-v1_5" },
          key,
          signatureBytes,
          signedInfoBytes,
        )
      ) {
        return;
      }
    } catch {
      // A malformed registered key is a registration defect, not the signer;
      // the remaining keys still get their chance before the refusal.
    }
  }
  throw refuse(
    "SSO_SAML_SIGNATURE_INVALID",
    "the assertion signature does not verify against the provider's registered keys",
  );
}

/**
 * The raw-assertion checks (interface §5): every field the evidence carries
 * is read here from the *signed* assertion — Issuer, NameID, AuthnInstant,
 * AuthnContext — after the signature over those very bytes has verified, and
 * every binding the server owns is asserted against the persisted challenge:
 * InResponseTo must answer the AuthnRequest whose RelayState opened the
 * challenge, Recipient and Response Destination must name this SP's ACS, and
 * the Audience must name this SP.
 */
async function verifySamlResponse(
  provider: SsoSamlProvider,
  challenge: SsoChallengeRecord,
  samlResponseEncoded: string,
  now: Date,
): Promise<{
  issuer: string;
  subject: string;
  authenticatedAt: Date;
  strength: string;
}> {
  const decoded = decodeBase64(samlResponseEncoded, "the SAMLResponse");
  if (decoded.length > MAX_SAML_RESPONSE_BYTES) {
    throw refuse(
      "SSO_SAML_RESPONSE_MALFORMED",
      "the SAMLResponse is oversized",
    );
  }
  const response = parseXmlDocument(textDecoder.decode(decoded));
  if (
    response.ns !== SAML_PROTOCOL_NAMESPACE ||
    response.local !== "Response"
  ) {
    throw refuse(
      "SSO_SAML_RESPONSE_MALFORMED",
      "the SAMLResponse is not a samlp:Response",
    );
  }

  const destination = xmlAttribute(response, "Destination");
  if (!destination) {
    throw refuse("SSO_SAML_MISSING_CLAIM", "the Response names no Destination");
  }
  if (destination !== provider.acsUrl) {
    throw refuse(
      "SSO_SAML_RECIPIENT_MISMATCH",
      "the Response was not delivered to this SP's ACS",
    );
  }

  const status = xmlChild(response, "Status", SAML_PROTOCOL_NAMESPACE);
  const statusCode =
    status && xmlChild(status, "StatusCode", SAML_PROTOCOL_NAMESPACE);
  if (
    !statusCode ||
    xmlAttribute(statusCode, "Value") !== SAML_STATUS_SUCCESS
  ) {
    throw refuse(
      "SSO_AUTHORIZATION_DENIED",
      "the IdP did not answer the AuthnRequest with Success",
    );
  }

  const responseInResponseTo = xmlAttribute(response, "InResponseTo");
  if (
    !responseInResponseTo ||
    responseInResponseTo !== challenge.protocolRequestId
  ) {
    throw refuse(
      "SSO_SAML_IN_RESPONSE_TO_MISMATCH",
      "the Response does not answer this SP's AuthnRequest",
    );
  }

  const assertion = xmlChild(response, "Assertion", SAML_ASSERTION_NAMESPACE);
  if (!assertion) {
    throw refuse(
      "SSO_SAML_RESPONSE_MALFORMED",
      "the Response carries no assertion",
    );
  }
  const assertionId = xmlAttribute(assertion, "ID");
  if (!assertionId) {
    throw refuse("SSO_SAML_RESPONSE_MALFORMED", "the assertion carries no ID");
  }

  const issuerElement = xmlChild(assertion, "Issuer", SAML_ASSERTION_NAMESPACE);
  const issuer = issuerElement ? xmlText(issuerElement) : "";
  if (!issuer) {
    throw refuse("SSO_SAML_ISSUER_MISMATCH", "the assertion names no Issuer");
  }
  if (issuer !== provider.issuer) {
    throw refuse(
      "SSO_SAML_ISSUER_MISMATCH",
      "the assertion's Issuer is not the provider this challenge belongs to",
    );
  }

  const signature = xmlChild(assertion, "Signature", XMLDSIG_NAMESPACE);
  if (!signature) {
    throw refuse(
      "SSO_SAML_ASSERTION_UNSIGNED",
      "the assertion carries no enveloped signature",
    );
  }
  await verifySamlSignature(assertion, signature, assertionId, provider);

  const subjectElement = xmlChild(
    assertion,
    "Subject",
    SAML_ASSERTION_NAMESPACE,
  );
  if (!subjectElement) {
    throw refuse("SSO_SAML_MISSING_CLAIM", "the assertion carries no Subject");
  }
  const nameId = xmlChild(subjectElement, "NameID", SAML_ASSERTION_NAMESPACE);
  const subject = nameId ? xmlText(nameId) : "";
  if (!subject) {
    throw refuse("SSO_SAML_MISSING_CLAIM", "the assertion carries no NameID");
  }

  let confirmationData: XmlElement | null = null;
  for (const confirmation of xmlChildren(
    subjectElement,
    "SubjectConfirmation",
    SAML_ASSERTION_NAMESPACE,
  )) {
    if (xmlAttribute(confirmation, "Method") !== BEARER_CONFIRMATION_METHOD) {
      continue;
    }
    const data = xmlChild(
      confirmation,
      "SubjectConfirmationData",
      SAML_ASSERTION_NAMESPACE,
    );
    if (data) {
      confirmationData = data;
      break;
    }
  }
  if (!confirmationData) {
    throw refuse(
      "SSO_SAML_MISSING_CLAIM",
      "the assertion carries no bearer SubjectConfirmationData",
    );
  }
  const recipient = xmlAttribute(confirmationData, "Recipient");
  if (!recipient) {
    throw refuse(
      "SSO_SAML_MISSING_CLAIM",
      "the SubjectConfirmationData names no Recipient",
    );
  }
  if (recipient !== provider.acsUrl) {
    throw refuse(
      "SSO_SAML_RECIPIENT_MISMATCH",
      "the assertion was not issued for this SP's ACS",
    );
  }
  const inResponseTo = xmlAttribute(confirmationData, "InResponseTo");
  if (!inResponseTo || inResponseTo !== challenge.protocolRequestId) {
    throw refuse(
      "SSO_SAML_IN_RESPONSE_TO_MISMATCH",
      "the assertion does not answer this SP's AuthnRequest",
    );
  }
  const notOnOrAfter = xmlAttribute(confirmationData, "NotOnOrAfter");
  if (!notOnOrAfter) {
    throw refuse(
      "SSO_SAML_MISSING_CLAIM",
      "the SubjectConfirmationData names no NotOnOrAfter",
    );
  }
  if (parseXsDateTime(notOnOrAfter, "NotOnOrAfter") <= now.getTime()) {
    throw refuse(
      "SSO_SAML_TIME_INVALID",
      "the subject confirmation has expired",
    );
  }

  const conditions = xmlChild(
    assertion,
    "Conditions",
    SAML_ASSERTION_NAMESPACE,
  );
  if (!conditions) {
    throw refuse(
      "SSO_SAML_RESPONSE_MALFORMED",
      "the assertion carries no Conditions",
    );
  }
  const notBefore = xmlAttribute(conditions, "NotBefore");
  if (
    notBefore !== null &&
    parseXsDateTime(notBefore, "NotBefore") >
      now.getTime() + CLOCK_SKEW_SECONDS * 1000
  ) {
    throw refuse("SSO_SAML_TIME_INVALID", "the assertion is not yet valid");
  }
  const conditionsNotOnOrAfter = xmlAttribute(conditions, "NotOnOrAfter");
  if (
    conditionsNotOnOrAfter !== null &&
    parseXsDateTime(conditionsNotOnOrAfter, "Conditions NotOnOrAfter") <=
      now.getTime()
  ) {
    throw refuse(
      "SSO_SAML_TIME_INVALID",
      "the assertion conditions have expired",
    );
  }
  const audiences = new Set<string>();
  for (const restriction of xmlChildren(
    conditions,
    "AudienceRestriction",
    SAML_ASSERTION_NAMESPACE,
  )) {
    for (const audienceElement of xmlChildren(
      restriction,
      "Audience",
      SAML_ASSERTION_NAMESPACE,
    )) {
      const audience = xmlText(audienceElement).trim();
      if (audience) audiences.add(audience);
    }
  }
  if (!audiences.has(provider.spEntityId)) {
    throw refuse(
      "SSO_SAML_AUDIENCE_MISMATCH",
      "the assertion was not issued for this SP",
    );
  }

  const authnStatement = xmlChild(
    assertion,
    "AuthnStatement",
    SAML_ASSERTION_NAMESPACE,
  );
  if (!authnStatement) {
    throw refuse(
      "SSO_SAML_MISSING_CLAIM",
      "the assertion carries no AuthnStatement",
    );
  }
  const authnInstantRaw = xmlAttribute(authnStatement, "AuthnInstant");
  if (!authnInstantRaw) {
    throw refuse(
      "SSO_SAML_MISSING_CLAIM",
      "the AuthnStatement names no AuthnInstant",
    );
  }
  const authnInstant = parseXsDateTime(authnInstantRaw, "AuthnInstant");
  if (
    authnInstant < 0 ||
    authnInstant > now.getTime() + CLOCK_SKEW_SECONDS * 1000
  ) {
    throw refuse(
      "SSO_SAML_TIME_INVALID",
      "the signed AuthnInstant is not a time the clock can confirm",
    );
  }

  const authnContext = xmlChild(
    authnStatement,
    "AuthnContext",
    SAML_ASSERTION_NAMESPACE,
  );
  const classRef =
    authnContext &&
    xmlChild(authnContext, "AuthnContextClassRef", SAML_ASSERTION_NAMESPACE);
  const declRef =
    authnContext &&
    xmlChild(authnContext, "AuthnContextDeclRef", SAML_ASSERTION_NAMESPACE);
  const strength =
    (classRef && xmlText(classRef).trim()) ||
    (declRef && xmlText(declRef).trim()) ||
    "";
  if (!strength) {
    throw refuse(
      "SSO_SAML_MISSING_CLAIM",
      "the assertion carries neither AuthnContextClassRef nor DeclRef, so no strength can be asserted",
    );
  }

  return {
    issuer,
    subject,
    authenticatedAt: new Date(authnInstant),
    strength,
  };
}

export function createSsoEvidenceBridge(
  deps: SsoEvidenceDeps,
): SsoEvidenceBridge {
  const fetcher = deps.fetch ?? globalThis.fetch;
  const clock = deps.clock ?? (() => new Date());
  const jwksCache = new Map<string, { keys: JwksKey[]; fetchedAt: number }>();

  return {
    async verify(request) {
      const parsed = await parseCallback(request);

      if (parsed.protocol === "saml") {
        // The RelayState is the SAML correlation token: consuming it is the
        // one-time gate, exactly as the OIDC state is, and InResponseTo must
        // then answer the persisted AuthnRequest the challenge carries.
        const challenge = await deps.challenges.consume(parsed.relayState);
        if (!challenge) {
          throw refuse(
            "SSO_CHALLENGE_MISSING_OR_CONSUMED",
            "no open challenge answers this RelayState",
          );
        }
        if (challenge.providerId !== parsed.providerId) {
          throw refuse(
            "SSO_CHALLENGE_PROVIDER_MISMATCH",
            "the challenge was issued for a different provider",
          );
        }
        const now = clock();
        if (challenge.expiresAt.getTime() <= now.getTime()) {
          throw refuse("SSO_CHALLENGE_EXPIRED", "the challenge has expired");
        }
        if (challenge.state !== parsed.relayState) {
          throw refuse(
            "SSO_SAML_RELAY_STATE_MISMATCH",
            "the store returned a challenge bound to a different RelayState",
          );
        }
        const provider =
          (await deps.providers.findSaml?.(parsed.providerId)) ?? null;
        if (!provider) {
          throw refuse(
            "SSO_PROVIDER_UNKNOWN",
            "the ACS names no registered SAML provider",
          );
        }
        const verified = await verifySamlResponse(
          provider,
          challenge,
          parsed.samlResponse,
          now,
        );
        // Branded result: every field below is either a value the server
        // issued (challengeId, providerId, protocol, protocolRequestId) or a
        // value the IdP signed (issuer, subject, authenticatedAt, strength).
        return Object.freeze({
          challengeId: challenge.challengeId,
          providerId: challenge.providerId,
          protocol: "saml" as const,
          issuer: verified.issuer,
          subject: verified.subject,
          authenticatedAt: verified.authenticatedAt,
          strength: verified.strength,
          protocolRequestId: challenge.protocolRequestId,
          [verifiedSsoEvidence]: true as const,
        });
      }

      const { url, providerId, code, state } = parsed;

      // The provider refused at the front channel. The state is spent either
      // way, so a denied authorization cannot be retried into evidence.
      if (url.searchParams.has("error")) {
        await deps.challenges.consume(state);
        throw refuse(
          "SSO_AUTHORIZATION_DENIED",
          "the provider answered the authorization request with an error",
        );
      }

      const challenge = await deps.challenges.consume(state);
      if (!challenge) {
        throw refuse(
          "SSO_CHALLENGE_MISSING_OR_CONSUMED",
          "no open challenge answers this state",
        );
      }
      if (challenge.providerId !== providerId) {
        throw refuse(
          "SSO_CHALLENGE_PROVIDER_MISMATCH",
          "the challenge was issued for a different provider",
        );
      }
      const now = clock();
      if (challenge.expiresAt.getTime() <= now.getTime()) {
        throw refuse("SSO_CHALLENGE_EXPIRED", "the challenge has expired");
      }

      const provider = await deps.providers.find(providerId);
      if (!provider) {
        throw refuse(
          "SSO_PROVIDER_UNKNOWN",
          "the callback names no registered provider",
        );
      }

      const idToken = await exchangeCode(provider, challenge, code, fetcher);
      const verified = await verifyIdToken(
        provider,
        challenge,
        idToken,
        now,
        fetcher,
        jwksCache,
      );

      // Branded result: every field below is either a value the server issued
      // (challengeId, providerId, protocol, protocolRequestId) or a value the
      // IdP signed (issuer, subject, authenticatedAt, strength).
      return Object.freeze({
        challengeId: challenge.challengeId,
        providerId: challenge.providerId,
        protocol: "oidc" as const,
        issuer: verified.issuer,
        subject: verified.subject,
        authenticatedAt: verified.authenticatedAt,
        strength: verified.strength,
        protocolRequestId: challenge.protocolRequestId,
        [verifiedSsoEvidence]: true as const,
      });
    },
  };
}
