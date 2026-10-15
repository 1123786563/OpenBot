/**
 * The ONE mount point for every observation surface.
 *
 * Later tickets add their own sub-router here (`routes.route("/runs", ...)`) instead of
 * editing server/src/app.ts, so the 5000-line boot file keeps exactly one observation line.
 * `requireUser` is applied once, at the root, so a sub-router cannot forget it.
 *
 * The single endpoint in this ticket exists to make the seam observable: it answers the
 * authorization question over HTTP and nothing else. `capability` is pinned to "none"
 * until the run-recording tickets can prove detailed coverage — a capability is claimed
 * only when it is verified, never by default.
 */
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../../auth/guards";
import { resolveObservationBot, type BotManagementCheck } from "../context";

export type AiObservabilityDeps = {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  canManageBot: BotManagementCheck;
};

export function createAiObservabilityRoutes(
  deps: AiObservabilityDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);

  routes.get("/bots/:botId/access", async (context) => {
    const access = await resolveObservationBot(
      deps.canManageBot,
      context.var.actor,
      context.req.param("botId"),
    );
    if (!access.ok) return context.json({ error: access.error }, access.status);
    return context.json({
      botId: access.botId,
      observationAccess: true,
      capability: "none",
    });
  });

  return routes;
}
