/*
 * The company-auth challenge route (T05.01 / #557, original task P11):
 * `POST /api/enterprise/company-auth/challenge` starts an additional company
 * authentication for a signed-in member of a company whose stored policy
 * demands one.
 *
 * The surface is thin by design — every decision lives in the assurance
 * (company-assurance.ts) — and it keeps the directory-surface error
 * discipline: refusal bodies are `{error:{code, message:"Request refused."}}`
 * and never carry detail to the caller. The callback half (`complete`) has no
 * route here: T05.02 owns it.
 *
 * Production mounting arrives through createApp; until the assembly wires
 * `coworker.directory.companyAuth` the route answers the closed adapter's
 * controlled 503, which is the honest degraded behaviour.
 */

import { Hono } from "hono";
import {
  COMPANY_AUTH_AUTH_REQUIRED,
  type CompanyAssurance,
  isCompanyAssuranceRefusal,
} from "./company-assurance";
import { isAuthorityRefusal } from "./directory/authority";

/** How the route learns who is calling: the app's real session reader. */
export interface CompanyAuthRouteDeps {
  authenticate(request: Request): Promise<{
    userId: string;
    sessionId: string;
  } | null>;
  assurance: Pick<CompanyAssurance, "challenge">;
}

function refusalBody(code: string): {
  error: { code: string; message: string };
} {
  return { error: { code, message: "Request refused." } };
}

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

  return routes;
}
