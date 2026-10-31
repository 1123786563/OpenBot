/**
 * The authenticated HTTP entry over the Hindsight evidence seam (#387).
 *
 * #732: this family shrank to the evidence seam alone. The old memory operations —
 * judgment review, revocation, cleanup progress, restores, backup registration and
 * the memory listing — were the old engine's write faces and left with the old
 * paths; what stays is the read the chat's answer basis still needs: expanding the
 * {id} pointers an answer carried into the rows behind them, availability
 * re-decided per row against the person's CURRENT authorization, so an answer can
 * never show what the person can no longer see. The evidence correction left too —
 * it wrote the old chain's preference rows and its sync queue.
 *
 * The identity discipline is unchanged:
 *
 *   - IDENTITY. The route resolves its scope through the deployment's
 *     `ScopeResolver` — the same server-issued scope the enterprise entry mints,
 *     with the same tenancy membership checks. A tenant id, workspace id, principal
 *     id or bank id arriving in a body or query string has no entry point here: the
 *     seam re-derives the placement from the trusted scope
 *     (`resolveHindsightBankScope`), so a forged field is not refused, it is simply
 *     never read. The route carries `requireUser`.
 */

import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppVariables } from "../auth/guards";
import type { ScopeResolver } from "../enterprise/contracts";
import {
  type AnswerEvidenceService,
  EvidenceNotFoundError,
  EvidenceRefusedError,
} from "./answer-evidence";

export class HindsightRouteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HindsightRouteRefusedError";
  }
}

/** The seam these routes front, narrowed to the method the family actually calls. */
export type HindsightRouteServices = {
  /** Trusted identity: the only thing that turns a request into a server-issued scope. */
  scopes: ScopeResolver;
  /**
   * The evidence chain's read half: `inspectEvidence` expands what an answer cited.
   */
  evidence: Pick<AnswerEvidenceService, "inspectEvidence">;
};

type RouteContext = Context<{ Variables: AppVariables }>;

/** Read a JSON object body; every misuse names what the route needed. */
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new HindsightRouteRefusedError(
      "Supply JSON settings for this operation.",
    );
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new HindsightRouteRefusedError("Supply JSON for this operation.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new HindsightRouteRefusedError(
      "Supply a JSON object for this operation.",
    );
  return parsed as Record<string, unknown>;
}

export function createHindsightRoutes(
  deps: HindsightRouteServices & {
    requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  },
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser, bodyLimit({ maxSize: 65_536 }));
  routes.onError((error, context) => {
    // The seam's own refusal vocabulary (a malformed request, a row the caller
    // cannot see) answers 400/404; a deployment failure is the 503 branch.
    if (
      error instanceof EvidenceRefusedError ||
      error instanceof HindsightRouteRefusedError
    )
      return context.json({ error: error.message }, 400);
    if (error instanceof EvidenceNotFoundError)
      return context.json({ error: error.message }, 404);
    return context.json(
      { error: "The memory evidence service is unavailable." },
      503,
    );
  });

  const scopeFor = async (context: RouteContext) =>
    deps.scopes.resolve(context.req.raw);

  /*
   * The chat answer-basis inspection (#387 AC2): the ids an answer carried, expanded
   * into the rows behind them with availability re-decided per row. Foreign ids answer
   * `available: false` rather than leaking that they exist.
   */
  routes.post("/evidence", async (context) => {
    const scope = await scopeFor(context);
    const input = await body(context.req.raw);
    if (!Array.isArray(input.ids))
      throw new HindsightRouteRefusedError("Supply the ids to inspect.");
    if (input.ids.some((id) => typeof id !== "string"))
      throw new HindsightRouteRefusedError("Evidence ids are strings.");
    return context.json({
      evidence: await deps.evidence.inspectEvidence(scope, { ids: input.ids }),
    });
  });

  return routes;
}
