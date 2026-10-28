/**
 * The Opik health route (Issue #15 / DAG T09).
 *
 * Mounting contract for the coordinator (this file is deliberately NOT wired into
 * routes/index.ts — that seam is T01-owned):
 *
 *   routes.route("/health", createAiObservabilityHealthRoutes({ service }))
 *
 * inside createAiObservabilityRoutes, which puts the endpoint at
 * GET /api/ai-observability/health behind the root requireUser.
 *
 * The response is a safe projection of the readiness state and the write counters:
 * booleans, numbers and one enumerated reason. No endpoint, credential, upstream
 * body or exception text ever rides along — a snapshot that throws answers the
 * same enumerated `unreachable` shape instead of leaking its error.
 *
 * The status code is deliberately always 200: Opik is bypass observability, so its
 * being unreachable must not read as this API being down. A load balancer or
 * orchestrator that wants Opik's readiness must read `opik.ready` in the body, not
 * the status code — do not wire this path into liveness/readiness probes.
 */
import { Hono } from "hono";
import { getLogger } from "../../../../shared/logger";
import type { AppVariables } from "../../auth/public";
import type { OpikHealthService, OpikHealthSnapshot } from "../health";

const log = getLogger("server");

export type AiObservabilityHealthDeps = Readonly<{
  service: OpikHealthService;
}>;

export function createAiObservabilityHealthRoutes(
  deps: AiObservabilityHealthDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/", async (context) => {
    let snapshot: OpikHealthSnapshot;
    try {
      snapshot = await deps.service.snapshot();
    } catch (error) {
      // Fail closed with the same safe shape; the counters are still readable. The
      // body never carries the error, but the server log says a probe crashed —
      // reason=unreachable alone cannot distinguish an Opik outage from a bug here.
      log.warn(
        { type: "opik-health-route-snapshot-failed", error: String(error) },
        "opik-health-route-snapshot-failed",
      );
      snapshot = {
        readiness: { ready: false, reason: "unreachable" as const },
        writes: deps.service.writeStats(),
      };
    }
    return context.json({
      opik: {
        ready: snapshot.readiness.ready,
        reason: snapshot.readiness.ready ? null : snapshot.readiness.reason,
        writes: snapshot.writes,
      },
    });
  });

  return routes;
}
