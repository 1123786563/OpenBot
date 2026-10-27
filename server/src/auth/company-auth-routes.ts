/*
 * The company-auth challenge and completion routes (T05.01/T05.02,
 * #557/#558, original task P11):
 * `POST /api/enterprise/company-auth/challenge` starts an additional company
 * authentication for a signed-in member of a company whose stored policy
 * demands one, and
 * `GET /api/enterprise/company-auth/oidc/callback/:providerId` verifies the
 * IdP's callback through the evidence bridge and completes the challenge
 * (one-time consumption, in-lock re-verification, proof write).
 *
 * The surface is thin by design — every decision lives in the assurance
 * (company-assurance.ts) — and it keeps the directory-surface error
 * discipline: refusal bodies are `{error:{code, message:"Request refused."}}`
 * and never carry detail to the caller. The SAML ACS half (`complete` over a
 * POST binding) has no route here: T05.03 owns it.
 *
 * Production mounting arrives through createApp; until the assembly wires
 * `coworker.directory.companyAuth` the routes answer the closed adapter's
 * controlled 503, which is the honest degraded behaviour.
 */

import { Hono } from "hono";
import {
  COMPANY_AUTH_AUTH_REQUIRED,
  COMPANY_AUTH_NOT_READY,
  type CompanyAssurance,
  isCompanyAssuranceRefusal,
} from "./company-assurance";
import { isAuthorityRefusal } from "./directory/authority";
import {
  type SsoEvidenceRefusalCode,
  SsoEvidenceRefused,
} from "./sso-evidence";

/** How the route learns who is calling: the app's real session reader. */
export interface CompanyAuthRouteDeps {
  authenticate(request: Request): Promise<{
    userId: string;
    sessionId: string;
  } | null>;
  /**
   * The challenge seam the assembly wired. `complete` rides the assembled
   * factory when it provides one (closed and live adapters both carry it);
   * a seam typed challenge-only — app.ts's until the assembly task widens
   * it — keeps the callback on the controlled 503 rather than making the
   * assembly's declared surface lie about what it wired.
   */
  assurance: Pick<CompanyAssurance, "challenge"> & {
    complete?: CompanyAssurance["complete"];
  };
}

function refusalBody(code: string): {
  error: { code: string; message: string };
} {
  return { error: { code, message: "Request refused." } };
}

/**
 * How a bridge refusal answers over the wire: the protocol's own answer is a
 * bad request (the browser carried it), an unregistered provider a 404, and
 * an unreachable IdP (token endpoint, JWKS) a 503 — infrastructure, not the
 * caller's mistake.
 */
const SSO_REFUSAL_STATUS: Record<SsoEvidenceRefusalCode, 400 | 404 | 503> = {
  SSO_REQUEST_UNRECOGNIZED: 400,
  SSO_PROTOCOL_UNSUPPORTED: 400,
  SSO_CHALLENGE_MISSING_OR_CONSUMED: 400,
  SSO_CHALLENGE_EXPIRED: 400,
  SSO_CHALLENGE_PROVIDER_MISMATCH: 400,
  SSO_AUTHORIZATION_DENIED: 400,
  SSO_PROVIDER_UNKNOWN: 404,
  SSO_TOKEN_EXCHANGE_FAILED: 503,
  SSO_JWKS_UNAVAILABLE: 503,
  SSO_ID_TOKEN_MALFORMED: 400,
  SSO_ID_TOKEN_UNSIGNED: 400,
  SSO_ID_TOKEN_ALGORITHM_UNSUPPORTED: 400,
  SSO_ID_TOKEN_SIGNATURE_INVALID: 400,
  SSO_ID_TOKEN_ISSUER_MISMATCH: 400,
  SSO_ID_TOKEN_AUDIENCE_MISMATCH: 400,
  SSO_ID_TOKEN_TIME_INVALID: 400,
  SSO_ID_TOKEN_NONCE_MISMATCH: 400,
  SSO_ID_TOKEN_MISSING_CLAIM: 400,
  SSO_SAML_RESPONSE_MALFORMED: 400,
  SSO_SAML_ASSERTION_UNSIGNED: 400,
  SSO_SAML_ALGORITHM_UNSUPPORTED: 400,
  SSO_SAML_SIGNATURE_INVALID: 400,
  SSO_SAML_ISSUER_MISMATCH: 400,
  SSO_SAML_AUDIENCE_MISMATCH: 400,
  SSO_SAML_RECIPIENT_MISMATCH: 400,
  SSO_SAML_IN_RESPONSE_TO_MISMATCH: 400,
  SSO_SAML_RELAY_STATE_MISMATCH: 400,
  SSO_SAML_TIME_INVALID: 400,
  SSO_SAML_MISSING_CLAIM: 400,
};

export function createCompanyAuthRoutes(deps: CompanyAuthRouteDeps): Hono {
  const routes = new Hono();

  routes.post("/challenge", async (context) => {
    try {
      const identity = await deps.authenticate(context.req.raw);
      if (!identity?.userId || !identity?.sessionId) {
        return context.json(refusalBody(COMPANY_AUTH_AUTH_REQUIRED), 401);
      }
      let body: unknown;
      try {
        body = await context.req.json();
      } catch {
        return context.json(refusalBody("INVALID_REQUEST"), 400);
      }
      const tenantId = (body as { tenantId?: unknown })?.tenantId;
      const returnPath = (body as { returnPath?: unknown })?.returnPath;
      if (typeof tenantId !== "string" || typeof returnPath !== "string") {
        return context.json(refusalBody("INVALID_REQUEST"), 400);
      }
      const issued = await deps.assurance.challenge(
        {
          userId: identity.userId,
          principalId: null,
          sessionId: identity.sessionId,
          kind: "session",
          bindingId: null,
          provisioning: null,
        },
        { tenantId, returnPath },
      );
      return context.json(issued, 200);
    } catch (error) {
      if (isCompanyAssuranceRefusal(error)) {
        return context.json(refusalBody(error.code), error.status);
      }
      if (isAuthorityRefusal(error)) {
        return context.json(refusalBody(error.code), 503);
      }
      return context.json(
        { error: { code: "internal", message: "Request failed." } },
        500,
      );
    }
  });

  /*
   * The OIDC callback (T05.02 / #558). No session is required to ARRIVE —
   * the IdP sent the browser here — and the completion itself binds whatever
   * live session the request still carries to the challenge's original
   * company. Success continues where the caller left off (303 to the
   * challenge's site-local returnPath); every refusal is the controlled
   * body, never a redirect that would silently continue.
   */
  routes.get("/oidc/callback/:providerId", async (context) => {
    const complete = deps.assurance.complete;
    if (!complete) {
      return context.json(refusalBody(COMPANY_AUTH_NOT_READY), 503);
    }
    try {
      const done = await complete(context.req.raw);
      return context.redirect(done.returnPath, 303);
    } catch (error) {
      if (isCompanyAssuranceRefusal(error)) {
        return context.json(refusalBody(error.code), error.status);
      }
      if (error instanceof SsoEvidenceRefused) {
        return context.json(
          refusalBody(error.code),
          SSO_REFUSAL_STATUS[error.code],
        );
      }
      if (isAuthorityRefusal(error)) {
        return context.json(refusalBody(error.code), 503);
      }
      return context.json(
        { error: { code: "internal", message: "Request failed." } },
        500,
      );
    }
  });

  return routes;
}
