import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import {
  isMobileSessionRefusal,
  MOBILE_ADMISSIBLE_OPERATIONS,
  type MobileAdmissionSelector,
  type MobileSessionHandoff,
  type MobileSessionIdentity,
} from "./mobile-session";

/*
 * T05.12 (#568) + T05.13 (#569): the HTTP surfaces of the mobile session
 * handoff, mounted at /api/enterprise/mobile by app.ts:
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
 *   POST /session/authorize — the registered BFF's per-action admission
 *     (T05.13): the same service credential, a body of handle/requestId/
 *     selector/operation/resourceId, and NOTHING the caller could speak for
 *     itself. Any actor-shaped body key is refused 403 before a lock is
 *     taken; an explicit header selection against the body's is a conflict,
 *     not an override. Every admission decision is the handoff service's.
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
  context: {
    json: (body: unknown, status: 400 | 401 | 403 | 404 | 503) => Response;
  },
  code: string,
  status: 400 | 401 | 403 | 404 | 503,
): Response {
  return context.json(
    { error: "Request refused.", code, requestId: randomUUID() },
    status,
  );
}

/** The registered BFF's service credential, as HTTP Basic service id : secret. */
function basicCredential(authorization: string | undefined): {
  bffServiceId: string;
  bffServiceSecret: string;
} {
  const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(authorization ?? "");
  const decoded = match ? Buffer.from(match[1], "base64").toString() : "";
  const separator = decoded.indexOf(":");
  return separator > 0
    ? {
        bffServiceId: decoded.slice(0, separator),
        bffServiceSecret: decoded.slice(separator + 1),
      }
    : { bffServiceId: "", bffServiceSecret: "" };
}

/**
 * The wire-body keys no client may ever speak: the actor, its platform
 * flags, the company/team/payer the P17 wire bodies carry untrusted
 * (interfaces §5.2). The actor is the handle's, server-issued, always.
 */
const CLIENT_ASSERTED_ACTOR_KEYS = [
  "actor",
  "userId",
  "user_id",
  "principalId",
  "principal_id",
  "platform",
  "company",
  "companyId",
  "company_id",
  "team",
  "teamId",
  "team_id",
  "payer",
  "onBehalfOf",
  "on_behalf_of",
] as const;

const ADMISSION_BODY_KEYS = new Set([
  "handle",
  "requestId",
  "selectors",
  "operation",
  "resourceId",
]);

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
    const { bffServiceId, bffServiceSecret } = basicCredential(
      context.req.header("authorization"),
    );
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

  routes.post("/session/authorize", async (context) => {
    // The same registered-BFF credential the exchange answers to; a person's
    // cookie, an owner key or a caller-named authority is never read here.
    const { bffServiceId, bffServiceSecret } = basicCredential(
      context.req.header("authorization"),
    );
    if (!bffServiceId || !bffServiceSecret) {
      return mobileBffError(context, "BFF_CREDENTIAL_REQUIRED", 401);
    }

    let body: Record<string, unknown>;
    try {
      body = (await context.req.json()) as Record<string, unknown>;
    } catch {
      return mobileBffError(context, "INVALID_REQUEST", 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return mobileBffError(context, "INVALID_REQUEST", 400);
    }
    // The client never speaks for the actor: an actor-shaped key is
    // refused before anything else runs, so no wire body can smuggle a
    // user, platform flag, company or payer past the admission gate.
    for (const key of CLIENT_ASSERTED_ACTOR_KEYS) {
      if (key in body)
        return mobileBffError(context, "CLIENT_ASSERTED_ACTOR", 403);
    }
    // The closed body contract: nothing else may ride along either.
    for (const key of Object.keys(body)) {
      if (!ADMISSION_BODY_KEYS.has(key))
        return mobileBffError(context, "INVALID_REQUEST", 400);
    }
    if (
      typeof body.handle !== "string" ||
      body.handle.length === 0 ||
      body.handle.length > 512 ||
      typeof body.requestId !== "string" ||
      typeof body.operation !== "string" ||
      !Object.hasOwn(MOBILE_ADMISSIBLE_OPERATIONS, body.operation) ||
      (body.resourceId !== undefined &&
        body.resourceId !== null &&
        typeof body.resourceId !== "string")
    ) {
      return mobileBffError(context, "INVALID_REQUEST", 400);
    }
    let selector: MobileAdmissionSelector | null = null;
    if (body.selectors !== undefined && body.selectors !== null) {
      const raw = body.selectors as Record<string, unknown>;
      if (
        typeof raw !== "object" ||
        raw === null ||
        Object.keys(raw).some(
          (key) => key !== "tenantId" && key !== "workspaceId",
        ) ||
        typeof raw.tenantId !== "string" ||
        (MOBILE_ADMISSIBLE_OPERATIONS[body.operation] === "team" &&
          typeof raw.workspaceId !== "string") ||
        (raw.workspaceId !== undefined && typeof raw.workspaceId !== "string")
      ) {
        return mobileBffError(context, "INVALID_REQUEST", 400);
      }
      selector = {
        tenantId: raw.tenantId,
        ...(raw.workspaceId !== undefined
          ? { workspaceId: raw.workspaceId as string }
          : {}),
      };
    }
    // An explicit header selection against the body's is a conflict, never
    // an override (the selection is intent; one intent per request).
    const headerTenant = context.req.header("x-openbot-tenant");
    const headerWorkspace = context.req.header("x-openbot-workspace");
    if (headerTenant && selector && headerTenant !== selector.tenantId) {
      return mobileBffError(context, "SCOPE_SELECTOR_CONFLICT", 400);
    }
    if (
      headerWorkspace &&
      selector?.workspaceId &&
      headerWorkspace !== selector.workspaceId
    ) {
      return mobileBffError(context, "SCOPE_SELECTOR_CONFLICT", 400);
    }

    try {
      const admission = await deps.handoff.admission({
        bffServiceId,
        bffServiceSecret,
        handle: body.handle,
        requestId: body.requestId,
        selector,
        operation: body.operation,
        resourceId:
          typeof body.resourceId === "string" ? body.resourceId : null,
      });
      return context.json(admission, 200);
    } catch (error) {
      if (isMobileSessionRefusal(error))
        return mobileBffError(context, error.code, error.status);
      throw error;
    }
  });

  return routes;
}
