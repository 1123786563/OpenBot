import { bodyLimit } from "hono/body-limit";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { getLogger } from "../../../shared/logger";
import {
  CoworkerRoutingInputError,
  type HttpCoworkerRoutingService,
  MAX_ROUTING_TEXT_LENGTH,
} from "./service";

const log = getLogger("server");

export { defaultRoutingProfile } from "./service";

/**
 * Translate the shared coworker-routing result into the established HTTP contract.
 *
 * Choosing a coworker, applying visibility, invoking the intent model, and recording the canonical
 * audit row are deliberately owned by CoworkerRoutingService. This layer only validates HTTP input
 * and turns its outcome into status codes and JSON.
 */
export function createRoutingRoutes(
  routing: HttpCoworkerRoutingService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  // Every sibling message surface caps its body before reading it; without this, an oversized
  // body is fully read and parsed before the length check can refuse it.
  routes.use("*", bodyLimit({ maxSize: 256 * 1024 }));

  // The service's faults must not end as Hono's plain-text 500: this route answers JSON, so
  // every failure does too — the service's own input refusals as 400, the rest as a tagged 503.
  routes.onError(
    (error: unknown, context: Context<{ Variables: AppVariables }>) => {
      if (error instanceof CoworkerRoutingInputError)
        return context.json({ error: error.message }, 400);
      log.error(
        {
          type: "coworker-routing-route-error",
          errorType: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        "coworker-routing-route-error",
      );
      return context.json(
        { error: "Coworker routing is unavailable. Try again." },
        503,
      );
    },
  );

  routes.post("/", requireUser, async (context) => {
    const raw = await context.req.text().catch(() => null);
    let parsed: unknown = null;
    try {
      parsed = raw === null ? null : JSON.parse(raw);
    } catch {
      parsed = undefined; // not JSON at all — a different refusal than a missing field
    }
    const body = (parsed ?? null) as {
      text?: unknown;
      agentId?: unknown;
    } | null;
    if (parsed === undefined)
      return context.json({ error: "Supply a JSON body." }, 400);
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return context.json({ error: "A message is required." }, 400);
    if (text.length > MAX_ROUTING_TEXT_LENGTH) {
      return context.json(
        {
          error: `A message of at most ${MAX_ROUTING_TEXT_LENGTH} characters is required.`,
        },
        400,
      );
    }
    const agentId =
      typeof body?.agentId === "string" && body.agentId.trim()
        ? body.agentId.trim()
        : null;

    const detail = await routing.routeDetailed({
      actor: context.var.actor,
      text,
      agentId,
    });
    const { result } = detail;
    if (result.kind === "none") {
      return context.json(
        {
          error: agentId
            ? "That coworker is not on your roster."
            : "No coworker is available.",
        },
        agentId ? 404 : 409,
      );
    }
    if (result.kind === "ambiguous") {
      return context.json(
        {
          error: "More than one coworker matches that name.",
          names: result.names,
        },
        409,
      );
    }
    const response = {
      agentId: result.agentId,
      name: result.name,
      reason: result.reason,
      fallback: result.fallback,
      viaMention: result.viaMention,
    };
    // The composer chose this coworker directly, and the legacy response did not expose a model
    // fallback cause for that path. Keep the model-routed response shape unchanged below.
    return context.json(
      agentId ? response : { ...response, undecided: detail.undecided },
    );
  });

  return routes;
}
