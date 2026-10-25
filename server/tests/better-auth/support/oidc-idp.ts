/*
 * An OIDC identity provider that signs real id_tokens for the better-auth suites
 * (T01.06, interface §5 SsoEvidenceBridge).
 *
 * Why a live one in this process: the contract under test is that
 * `VerifiedSsoEvidence.authenticatedAt` is the *signed* `auth_time` of the
 * id_token and `strength` its signed `acr`/`amr` — never the callback clock and
 * never `provisionUser.userInfo`. The only honest way to show a value came from
 * a signature is to have an IdP sign it and then alter either the signature or
 * the claim, and a local `Bun.serve` on loopback does that with no external IdP
 * and no network dependency beyond this machine.
 *
 * The front channel is simulated deliberately: `authorize()` mints the
 * authorization code the browser would have carried back, recording the nonce
 * and the PKCE code_challenge of the authorization request. The back channel is
 * real: the token endpoint requires the confidential-client credentials,
 * consumes each code exactly once, and enforces S256 PKCE against what
 * `authorize()` recorded — so a verifier/challenge mismatch fails the exchange
 * here, not in an assertion about the bridge's internals.
 *
 * `claims` passed to `authorize()` override the defaults claim by claim; a
 * `null` value removes that claim from the id_token entirely (the way negative
 * tests prove a missing signed claim is refused).
 */

export type OidcIdTokenClaims = Record<string, unknown>;

export interface OidcAuthorizeInput {
  /** The nonce the authorization request carried; lands in the signed id_token. */
  nonce: string;
  /** The PKCE code_challenge the authorization request carried (S256). */
  codeChallenge: string;
  /** The redirect_uri the authorization request carried. */
  redirectUri: string;
  /** Claim overrides for the id_token; `null` removes the claim. */
  claims?: OidcIdTokenClaims;
  /**
   * How the token endpoint signs this grant: `valid` with the IdP's key,
   * `foreign` with a key the IdP does not publish in its JWKS, `tampered` with
   * the IdP's key but a corrupted signature.
   */
  signature?: "valid" | "foreign" | "tampered";
}

export interface OidcTestIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  discoveryUrl: string;
  jwksUri: string;
  tokenEndpoint: string;
  /** Mint a one-time authorization code bound to this nonce and PKCE challenge. */
  authorize(input: OidcAuthorizeInput): string;
  /** How many POSTs the token endpoint has answered, including refused ones. */
  tokenRequestCount(): number;
  jwksRequestCount(): number;
  close(): Promise<void>;
}

interface Grant {
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
  claims: OidcIdTokenClaims;
  signature: "valid" | "foreign" | "tampered";
}

const textEncoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

/** S256, computed independently here so the bridge's verifier is checked against
 * a second implementation, not against its own. */
async function s256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(input),
  );
  return base64Url(new Uint8Array(digest));
}

async function generateEs256Pair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

async function publicJwk(
  publicKey: CryptoKey,
  kid: string,
): Promise<JsonWebKey> {
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  return { ...jwk, kid, alg: "ES256", use: "sig" };
}

async function signEs256(
  privateKey: CryptoKey,
  payloadJson: string,
  kid: string,
): Promise<string> {
  const header = base64Url(
    textEncoder.encode(JSON.stringify({ alg: "ES256", typ: "JWT", kid })),
  );
  const payload = base64Url(textEncoder.encode(payloadJson));
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    textEncoder.encode(input),
  );
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export interface OidcTestIdpOptions {
  clientId?: string;
  clientSecret?: string;
  /**
   * A label the issuer carries so a challenge bound to a *different* issuer is
   * visibly foreign in diagnostics. The issuer itself stays loopback.
   */
  label?: string;
}

export async function createOidcTestIdp(
  options: OidcTestIdpOptions = {},
): Promise<OidcTestIdp> {
  const clientId = options.clientId ?? "openbot-enterprise";
  const clientSecret = options.clientSecret ?? `secret-${crypto.randomUUID()}`;

  const primary = await generateEs256Pair();
  const foreign = await generateEs256Pair();
  const primaryJwk = await publicJwk(primary.publicKey, "t0106-primary");
  // The foreign key deliberately shares the primary key id: a token it signs
  // must fail verification against the published key, which is a stronger check
  // than an unknown kid that is merely not found.
  const foreignKid = primaryJwk.kid;

  const grants = new Map<string, Grant>();
  let tokenRequests = 0;
  let jwksRequests = 0;

  let issuer = "";

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url);
      if (
        request.method === "GET" &&
        url.pathname === "/.well-known/openid-configuration"
      ) {
        return json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["ES256"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (request.method === "GET" && url.pathname === "/jwks") {
        jwksRequests += 1;
        return json({ keys: [primaryJwk] });
      }
      if (request.method === "POST" && url.pathname === "/token") {
        tokenRequests += 1;
        const form = new URLSearchParams(await request.text());
        if (
          form.get("client_id") !== clientId ||
          form.get("client_secret") !== clientSecret
        ) {
          return json({ error: "invalid_client" }, 401);
        }
        if (form.get("grant_type") !== "authorization_code") {
          return json({ error: "unsupported_grant_type" }, 400);
        }
        const code = form.get("code") ?? "";
        const grant = grants.get(code);
        // One-time even on refusal: an exchanged code is spent whether the
        // verifier matched or not, the way a real IdP burns the grant.
        if (code) grants.delete(code);
        if (!grant) {
          return json(
            {
              error: "invalid_grant",
              error_description: "unknown or consumed code",
            },
            400,
          );
        }
        if (form.get("redirect_uri") !== grant.redirectUri) {
          return json(
            {
              error: "invalid_grant",
              error_description: "redirect_uri mismatch",
            },
            400,
          );
        }
        const verifier = form.get("code_verifier") ?? "";
        if ((await s256(verifier)) !== grant.codeChallenge) {
          return json(
            {
              error: "invalid_grant",
              error_description: "PKCE verification failed",
            },
            400,
          );
        }
        const payload: Record<string, unknown> = {
          iss: issuer,
          aud: clientId,
          sub: "oidc-test-subject",
          nonce: grant.nonce,
          acr: "urn:mace:incommon:iap:silver",
          amr: ["pwd"],
          ...grant.claims,
        };
        for (const [key, value] of Object.entries(payload)) {
          if (value === null) delete payload[key];
        }
        const claims = JSON.stringify(payload);
        const key =
          grant.signature === "foreign"
            ? foreign.privateKey
            : primary.privateKey;
        const kid = grant.signature === "foreign" ? foreignKid : primaryJwk.kid;
        let idToken = await signEs256(key, claims, kid);
        if (grant.signature === "tampered") {
          const parts = idToken.split(".");
          const input = `${parts[0]}.${parts[1]}`;
          const bytes = decodeBase64Url(parts[2]);
          bytes[bytes.length - 1] ^= 0xff;
          idToken = `${input}.${base64Url(bytes)}`;
        }
        return json({
          access_token: `at-${crypto.randomUUID()}`,
          token_type: "Bearer",
          expires_in: 300,
          id_token: idToken,
        });
      }
      return json({ error: "not_found" }, 404);
    },
  });
  issuer = `http://127.0.0.1:${server.port}`;

  let grantCounter = 0;
  return {
    issuer,
    clientId,
    clientSecret,
    discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    jwksUri: `${issuer}/jwks`,
    tokenEndpoint: `${issuer}/token`,
    authorize(input) {
      const code = `code-${++grantCounter}-${crypto.randomUUID()}`;
      grants.set(code, {
        nonce: input.nonce,
        codeChallenge: input.codeChallenge,
        redirectUri: input.redirectUri,
        claims: input.claims ?? {},
        signature: input.signature ?? "valid",
      });
      return code;
    },
    tokenRequestCount: () => tokenRequests,
    jwksRequestCount: () => jwksRequests,
    async close() {
      server.stop(true);
    },
  };
}
