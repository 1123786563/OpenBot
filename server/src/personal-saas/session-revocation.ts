import { createHash } from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { seal, unseal } from "../auth/signed-value";
import { browserAttempt, casdoor } from "./casdoor";
import type { personalSaasStore } from "./store";

export const sessionCookie = "__Host-openbot-personal";
export const cookieOptions = {
  path: "/",
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
} as const;

const callbackPath = "/auth/casdoor/reverify/callback";
const attemptPrefix = "__Host-openbot-reverify-";
const revocationAttempt = browserAttempt.extend({
  sessionHash: z.string().length(43),
  authenticatedAfter: z.number().int(),
});

function hashSession(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}

export function sessionRevocationRoutes(options: {
  origin: string;
  encryptionKey: string;
  casdoor: Parameters<typeof casdoor>[0];
  store: Pick<
    ReturnType<typeof personalSaasStore>,
    "session" | "revokeAllSessions"
  >;
  failurePage: (status: 403 | 503) => Response | Promise<Response>;
}) {
  const app = new Hono();
  const provider = casdoor(
    options.casdoor,
    new URL(callbackPath, options.origin).href,
  );
  const { store } = options;

  app.post("/auth/sign-out-all", async (context) => {
    const token = getCookie(context, sessionCookie);
    if (!token || !(await store.session(token)))
      return context.redirect("/workspace", 303);
    try {
      const { authorization, state, attempt } = await provider.start({
        forceLogin: true,
      });
      const cookieName = `${attemptPrefix}${state}`;
      const pending = {
        ...attempt,
        sessionHash: hashSession(token),
        // auth_time has whole-second precision. Require proof from a later second.
        authenticatedAfter: Math.floor(Date.now() / 1_000),
      };
      setCookie(
        context,
        cookieName,
        await seal(JSON.stringify(pending), options.encryptionKey, cookieName),
        { ...cookieOptions, maxAge: 600 },
      );
      return context.redirect(authorization.href, 303);
    } catch {
      return options.failurePage(503);
    }
  });

  app.get(callbackPath, async (context) => {
    const state = context.req.query("state");
    const code = context.req.query("code");
    const issuer = context.req.query("iss");
    const token = getCookie(context, sessionCookie);
    if (!state || !/^[\w-]{32}$/.test(state)) return options.failurePage(403);

    const cookieName = `${attemptPrefix}${state}`;
    const encrypted = getCookie(context, cookieName);
    deleteCookie(context, cookieName, cookieOptions);
    if (
      !token ||
      !code ||
      (issuer !== undefined && issuer !== options.casdoor.issuer)
    )
      return options.failurePage(403);

    const sealed = await unseal(encrypted, options.encryptionKey, cookieName);
    if (!sealed) return options.failurePage(403);
    const result = revocationAttempt.safeParse(JSON.parse(sealed));
    if (
      !result.success ||
      result.data.sessionHash !== hashSession(token) ||
      result.data.expiresAt <= Date.now()
    )
      return options.failurePage(403);
    const attempt = result.data;
    const session = await store.session(token);
    if (!session || session.issuer !== options.casdoor.issuer)
      return options.failurePage(403);

    const identity = await provider
      .authenticate(code, attempt, {
        authenticatedAfter: attempt.authenticatedAfter,
      })
      .catch(() => undefined);
    if (
      identity?.kind !== "verified" ||
      identity.issuer !== session.issuer ||
      identity.subject !== session.subject ||
      attempt.expiresAt <= Date.now() ||
      !(await store.revokeAllSessions({ token, accountId: session.accountId }))
    )
      return options.failurePage(403);

    deleteCookie(context, sessionCookie, cookieOptions);
    return context.redirect("/", 303);
  });
  return app;
}
