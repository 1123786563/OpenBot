import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import { generateCodeChallenge } from "better-auth/oauth2";
import { z } from "zod";

const clientId = "openfuse";
const redirectUri = "openfuse://auth/callback";
const opaqueValue = z.string().regex(/^[a-f0-9]{64}$/);
const requestDetails = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
const authorization = requestDetails.extend({
  client_id: z.literal(clientId),
  redirect_uri: z.literal(redirectUri),
  code_challenge_method: z.literal("S256"),
});
const grant = requestDetails.extend({ userId: z.string().min(1) });

function randomValue(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "hex",
  );
}

function parseRecord<T>(schema: z.ZodType<T>, value: string | undefined): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value ?? "");
  } catch {
    throw invalidGrant();
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) throw invalidGrant();
  return parsed.data;
}

function invalidGrant() {
  return new APIError("BAD_REQUEST", {
    message: "Invalid or expired OpenFuse authorization.",
  });
}

function confirmationPage(request: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect OpenFuse</title></head><body><main><h1>Connect OpenFuse</h1><p>Continue to let OpenFuse access your OpenBot Personal Workspace.</p><form method="post" action="/api/auth/openfuse/approve"><input type="hidden" name="request" value="${request}"><button type="submit">Continue to OpenFuse</button></form></main></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "same-origin",
        "content-security-policy":
          "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      },
    },
  );
}

export function openFuseAuth(appUrl?: string) {
  const authorize = createAuthEndpoint(
    "/openfuse/authorize",
    { method: "GET", query: authorization },
    async (context) => {
      context.setHeader("cache-control", "no-store");
      context.setHeader("referrer-policy", "no-referrer");
      const browser = await getAuthoritativeSessionFromCtx(context);
      const { state, code_challenge } = context.query;
      const adapter = context.context.internalAdapter;
      const request = randomValue();
      await adapter.createVerificationValue({
        identifier: `openfuse-request:${request}`,
        value: JSON.stringify({ state, code_challenge }),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });
      if (browser) {
        return confirmationPage(request);
      }
      const signIn = new URL("/sign", appUrl ?? context.context.baseURL);
      signIn.searchParams.set("openfuse_request", request);
      throw context.redirect(signIn.href);
    },
  );

  const continueSignIn = createAuthEndpoint(
    "/openfuse/continue",
    { method: "GET", query: z.object({ request: opaqueValue }) },
    async (context) => {
      context.setHeader("cache-control", "no-store");
      context.setHeader("referrer-policy", "no-referrer");
      const browser = await getAuthoritativeSessionFromCtx(context);
      if (!browser)
        throw new APIError("UNAUTHORIZED", { message: "Sign in to continue." });
      return confirmationPage(context.query.request);
    },
  );

  const approve = createAuthEndpoint(
    "/openfuse/approve",
    {
      method: "POST",
      body: z.object({ request: opaqueValue }),
      metadata: { allowedMediaTypes: ["application/x-www-form-urlencoded"] },
    },
    async (context) => {
      context.setHeader("cache-control", "no-store");
      context.setHeader("referrer-policy", "no-referrer");
      const browser = await getAuthoritativeSessionFromCtx(context);
      if (!browser) {
        throw new APIError("UNAUTHORIZED", { message: "Sign in to continue." });
      }
      const adapter = context.context.internalAdapter;
      const record = await adapter.consumeVerificationValue(
        `openfuse-request:${context.body.request}`,
      );
      const { state, code_challenge } = parseRecord(
        requestDetails,
        record?.value,
      );
      const code = randomValue();
      await adapter.createVerificationValue({
        identifier: `openfuse-code:${await generateCodeChallenge(code)}`,
        value: JSON.stringify({
          state,
          code_challenge,
          userId: browser.user.id,
        }),
        expiresAt: new Date(Date.now() + 120_000),
      });
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", state);
      throw context.redirect(callback.href);
    },
  );

  const exchange = createAuthEndpoint(
    "/openfuse/exchange",
    {
      method: "POST",
      body: z.object({
        code: opaqueValue,
        codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
      }),
    },
    async (context) => {
      context.setHeader("cache-control", "no-store");
      const adapter = context.context.internalAdapter;
      const identifier = `openfuse-code:${await generateCodeChallenge(context.body.code)}`;
      const pending = await adapter.findVerificationValue(identifier);
      const details = parseRecord(grant, pending?.value);
      if (
        (await generateCodeChallenge(context.body.codeVerifier)) !==
        details.code_challenge
      )
        throw invalidGrant();
      const record = await adapter.consumeVerificationValue(identifier);
      if (!record || record.value !== pending?.value) throw invalidGrant();
      const user = await adapter.findUserById(details.userId);
      if (!user) throw invalidGrant();
      const session = await adapter.createSession(user.id);
      if (!session)
        throw new APIError("INTERNAL_SERVER_ERROR", {
          message: "Could not create an OpenFuse session.",
        });
      const { name, attributes } = context.context.authCookies.sessionToken;
      const serialized = await context.setSignedCookie(
        name,
        session.token,
        context.context.secret,
        attributes,
      );
      context.responseHeaders.delete("set-cookie");
      return context.json({ sessionCookie: serialized.split(";", 1)[0] });
    },
  );

  return {
    id: "openfuse",
    endpoints: {
      openFuseAuthorize: authorize,
      openFuseContinue: continueSignIn,
      openFuseApprove: approve,
      openFuseExchange: exchange,
    },
  } satisfies BetterAuthPlugin;
}
