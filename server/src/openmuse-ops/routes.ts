import { Hono, type MiddlewareHandler } from "hono";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { OpenMuseOpsSignal } from "./signals";

/**
 * `/signals` (mounted under `/api/admin/openmuse-ops` by the app seam): the
 * one route of O05 — §10's operator health surface, read-only, behind the
 * same requireUser + requireAdmin double layer every admin surface here
 * uses. The routes serialize only; every row, threshold and citation is the
 * aggregation's own.
 */
export function createOpenMuseOpsSignalsRoutes(deps: {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  signals: () => Promise<{ signals: OpenMuseOpsSignal[] }>;
}): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);

  routes.get("/signals", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json(await deps.signals());
  });

  return routes;
}
