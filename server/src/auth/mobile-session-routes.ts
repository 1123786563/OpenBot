import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import {
  isMobileSessionRefusal,
  type MobileSessionHandoff,
  type MobileSessionIdentity,
} from "./mobile-session";

/*
 * T05.12 (#568): the two HTTP surfaces of the mobile session handoff,
 * mounted at /api/enterprise/mobile by app.ts:
 *
 *   GET  /authorize        — the system browser, carrying its BA session
 *     cookie, asks for a handoff code. The route checks the cross-site
 *     intent (an Origin header from anywhere but this deployment refuses),
 *     reads the session through the app's real session reader, and answers
 *     303 to the client's registered redirect with code/state/intentId.
 *
 *   POST /session/exchange — the registered BFF only, authenticated by its
 *     service credential (HTTP Basic, service id : secret) and presenting
 *     the one-time code, its PKCE verifier and the registered redirect. The
 *     route owns nothing but parsing; every decision is the handoff
 *     service's, transactional in the database.
 *
 * Errors answer the frozen MobileBffError shape {error, code, requestId};
 * the message is fixed and the code is the machine word, so no refusal
 * carries more than the closed taxonomy does.
 */

export interface MobileSessionRouteDeps {
  /** The app's real BA session reader — the same seam the company-auth routes use. */
  authenticate(request: Request): Promise<MobileSessionIdentity | null>;
  handoff: MobileSessionHandoff;
}

function mobileBffError(
  context: { json: (body: unknown, status: 400 | 401 | 403) => Response },
  code: string,
  status: 400 | 401 | 403,
): Response {
  return context.json(
    { error: "Request refused.", code, requestId: randomUUID() },
    status,
  );
}

export function createMobileSessionRoutes(deps: MobileSessionRouteDeps): Hono {
  const routes = new Hono();

  routes.get("/authorize", async (context) => {
    // Cross-site intent: a navigation from the system browser carries no
    // Origin, a scripted fetch from another site does. Only this deployment
    // may start a handoff.
    const origin = context.req.header("origin");
    if (origin && origin !== new URL(context.req.url).origin) {
      return mobileBffError(context, "FORBIDDEN_ORIGIN", 403);
    }
    const identity = await deps.authenticate(context.req.raw);
    if (!identity) return mobileBffError(context, "SESSION_REQUIRED", 401);

    const query = context.req.query();
    try {
      const { redirectLocation } = await deps.handoff.authorize(identity, {
        clientId: query.client_id ?? "",
        redirectUri: query.redirect_uri ?? "",
        state: query.state ?? "",
        codeChallenge: query.code_challenge ?? "",
        codeChallengeMethod: query.code_challenge_method ?? "",
      });
      return context.redirect(redirectLocation, 303);
    } catch (error) {
      if (isMobileSessionRefusal(error))
        return mobileBffError(context, error.code, error.status);
      throw error;
    }
  });

  routes.post("/session/exchange", async (context) => {
    // The registered BFF's service credential: HTTP Basic, service id and
    // secret. No user cookie, owner key or caller-named authority is ever
    // read here — the exchange is the BFF's move, not a person's.
    const authorization = context.req.header("authorization");
    const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(authorization ?? "");
    const decoded = match ? Buffer.from(match[1], "base64").toString() : "";
    const separator = decoded.indexOf(":");
    const bffServiceId = separator > 0 ? decoded.slice(0, separator) : "";
    const bffServiceSecret = separator > 0 ? decoded.slice(separator + 1) : "";
    if (!bffServiceId || !bffServiceSecret) {
      return mobileBffError(context, "BFF_CREDENTIAL_REQUIRED", 401);
    }

    let body: Record<string, unknown>;
    try {
      body = (await context.req.json()) as Record<string, unknown>;
    } catch {
      return mobileBffError(context, "INVALID_REQUEST", 400);
    }
    // The frozen EnterpriseSessionInput: authMode is a literal, and the
    // string fields are strings. Anything else is refused before the
    // transaction opens.
    if (
      body.authMode !== "enterprise" ||
      typeof body.intentId !== "string" ||
      typeof body.code !== "string" ||
      typeof body.codeVerifier !== "string" ||
      typeof body.redirectUri !== "string"
    ) {
      return mobileBffError(context, "INVALID_REQUEST", 400);
    }

    try {
      const session = await deps.handoff.exchange({
        bffServiceId,
        bffServiceSecret,
        intentId: body.intentId,
        code: body.code,
        codeVerifier: body.codeVerifier,
        redirectUri: body.redirectUri,
      });
      return context.json(session, 200);
    } catch (error) {
      if (isMobileSessionRefusal(error))
        return mobileBffError(context, error.code, error.status);
      throw error;
    }
  });

  return routes;
}
