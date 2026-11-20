import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { accountSnapshot } from "./account-access";

export type CasdoorConfig = {
  issuer: string;
  discoveryUrl: URL;
  accountStatusUrl: URL;
  clientId: string;
  clientSecret: string;
  allowLoopbackHttp?: boolean;
};

const discovery = z.object({
  issuer: z.string(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  userinfo_endpoint: z.url(),
  introspection_endpoint: z.url(),
  jwks_uri: z.url(),
});
const token = z.object({
  access_token: z.string().min(1),
  id_token: z.string().min(1),
  token_type: z.string().regex(/^bearer$/i),
});
const userinfo = z.object({
  iss: z.string(),
  sub: z.string().min(1),
  aud: z.string(),
  email: z.email().optional(),
  email_verified: z.boolean().optional(),
});
const introspection = z.discriminatedUnion("active", [
  z.object({ active: z.literal(false) }),
  z.object({
    active: z.literal(true),
    iss: z.string(),
    sub: z.string().min(1),
    client_id: z.string(),
  }),
]);

export const browserAttempt = z.object({
  verifier: z.string(),
  nonce: z.string(),
  expiresAt: z.number(),
});
type BrowserAttempt = z.infer<typeof browserAttempt>;

async function read(url: string | URL, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Casdoor request did not succeed");
  return response.json();
}

export function casdoor(config: CasdoorConfig, callback: string) {
  let discovered: Promise<Awaited<ReturnType<typeof discover>>> | undefined;

  async function discover() {
    const metadata = discovery.parse(await read(config.discoveryUrl));
    if (metadata.issuer !== config.issuer)
      throw new Error("Unexpected Casdoor issuer");
    for (const endpoint of [
      metadata.authorization_endpoint,
      metadata.token_endpoint,
      metadata.userinfo_endpoint,
      metadata.introspection_endpoint,
      metadata.jwks_uri,
      config.accountStatusUrl,
    ]) {
      const url = new URL(endpoint);
      const testLoopback =
        config.allowLoopbackHttp &&
        url.hostname === "127.0.0.1" &&
        url.protocol === "http:";
      if (
        url.origin !== config.discoveryUrl.origin ||
        (url.protocol !== "https:" && !testLoopback) ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new Error("Unexpected Casdoor endpoint");
    }
    return {
      metadata,
      keys: createRemoteJWKSet(new URL(metadata.jwks_uri), {
        timeoutDuration: 5_000,
      }),
    };
  }

  function provider() {
    discovered ??= discover().catch((error: unknown) => {
      discovered = undefined;
      throw error;
    });
    return discovered;
  }

  function authenticatedForm(fields: Record<string, string>) {
    return new URLSearchParams({
      ...fields,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });
  }

  async function accountActive(accessToken: string, subject: string) {
    const { metadata } = await provider();
    const status = introspection.parse(
      await read(metadata.introspection_endpoint, {
        method: "POST",
        body: authenticatedForm({
          token: accessToken,
          token_type_hint: "access_token",
        }),
      }),
    );
    if (!status.active) return false;
    if (
      status.iss !== config.issuer ||
      status.sub !== subject ||
      status.client_id !== config.clientId
    )
      throw new Error("Unexpected Casdoor token identity");
    return true;
  }

  return {
    async start(options?: { forceLogin: true }) {
      const { metadata } = await provider();
      const state = randomBytes(24).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      const nonce = randomBytes(24).toString("base64url");
      const authorization = new URL(metadata.authorization_endpoint);
      const params = {
        client_id: config.clientId,
        redirect_uri: callback,
        response_type: "code",
        scope: "openid email",
        state,
        nonce,
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
      };
      for (const [key, value] of Object.entries(params))
        authorization.searchParams.set(key, value);
      if (options?.forceLogin) {
        authorization.searchParams.set("prompt", "login");
        authorization.searchParams.set("max_age", "0");
      }
      return {
        authorization,
        state,
        attempt: { verifier, nonce, expiresAt: Date.now() + 10 * 60_000 },
      };
    },
    async authenticate(
      code: string,
      attempt: BrowserAttempt,
      options?: { authenticatedAfter: number },
    ) {
      const { metadata, keys } = await provider();
      const tokens = token.parse(
        await read(metadata.token_endpoint, {
          method: "POST",
          body: authenticatedForm({
            code,
            grant_type: "authorization_code",
            code_verifier: attempt.verifier,
            redirect_uri: callback,
          }),
        }),
      );
      const { payload } = await jwtVerify(tokens.id_token, keys, {
        issuer: config.issuer,
        audience: config.clientId,
        algorithms: ["RS256", "RS512", "ES256", "ES384", "ES512"],
        requiredClaims: ["exp", "iat", "sub", "nonce"],
        maxTokenAge: "10m",
      });
      if (
        !payload.sub ||
        payload.nonce !== attempt.nonce ||
        (payload.azp !== undefined && payload.azp !== config.clientId) ||
        (Array.isArray(payload.aud) &&
          payload.aud.length > 1 &&
          payload.azp !== config.clientId)
      )
        throw new Error("Unexpected Casdoor ID token");
      if (
        options &&
        (typeof payload.auth_time !== "number" ||
          !Number.isSafeInteger(payload.auth_time) ||
          payload.auth_time <= options.authenticatedAfter ||
          payload.auth_time > (payload.iat ?? 0) ||
          payload.auth_time > Math.floor(Date.now() / 1_000))
      )
        throw new Error("Casdoor did not re-verify the account");
      const identity = userinfo.parse(
        await read(metadata.userinfo_endpoint, {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        }),
      );
      if (
        identity.sub !== payload.sub ||
        identity.iss !== config.issuer ||
        identity.aud !== config.clientId
      )
        throw new Error("Unexpected Casdoor userinfo identity");
      if (identity.email_verified !== true || !identity.email)
        return { kind: "unverified" } as const;
      if (!(await accountActive(tokens.access_token, identity.sub)))
        return { kind: "inactive" } as const;
      return {
        kind: "verified",
        issuer: identity.iss,
        subject: identity.sub,
        email: identity.email,
        accessToken: tokens.access_token,
      } as const;
    },
    async accountStatus(subject: string) {
      await provider();
      return accountSnapshot.parse(
        await read(config.accountStatusUrl, {
          method: "POST",
          body: authenticatedForm({ subject }),
        }),
      );
    },
  };
}
