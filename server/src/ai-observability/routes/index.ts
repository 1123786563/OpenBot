/**
 * The ONE mount point for every observation surface.
 *
 * Later tickets add their own sub-router here (`routes.route("/runs", ...)`) instead of
 * editing server/src/app.ts, so the 5000-line boot file keeps exactly one observation line.
 * `requireUser` is applied once, at the root, so a sub-router cannot forget it.
 *
 * T33 wired the epic's route backlog into this seam, each behind its own deps:
 * the runs query routes (T11/T12), the export routes (T34) and the admin
 * summary (T33). A sub-router whose deps are absent is simply not mounted —
 * the same "absent = not mounted" contract the boot file applies to this whole
 * module — and the runs routes stay mounted with `port: null` so a portless
 * deployment answers the honest 503 `capability_missing` rather than nothing.
 *
 * `capability` on the single access endpoint stays pinned to "none"
 * until the run-recording tickets can prove detailed coverage — a capability is claimed
 * only when it is verified, never by default.
 */
import { Hono, type MiddlewareHandler } from "hono";
import type { AgentActor, AgentProfile } from "../../agents/profile-types";
import type { AppVariables } from "../../auth/guards";
import type { Database } from "../../db/client";
import {
  type AdminSummaryService,
  createAdminSummaryService,
} from "../admin-summary";
import type { RunBindingStore } from "../bindings";
import type { OpikConfig } from "../config";
import { type BotManagementCheck, resolveObservationBot } from "../context";
import { createObservationDatasetStore } from "../datasets";
import { createObservationExecutionStore } from "../executions";
import { createObservationExperimentStore } from "../experiments";
import type { OpikHealthService } from "../health";
import type { OpikPort } from "../opik-port";
import type { RunsQueryService } from "../queries/runs";
import { createWorkTicketReader } from "../results";
import { createAdminSummaryRoutes } from "./admin-summary";
import { createExperimentComparisonRoutes } from "./comparison";
import { createExportRoutes } from "./exports";
import { createAiObservabilityHealthRoutes } from "./health";
import { createExperimentResultsRoutes } from "./results";
import { createRunsQueryRoutes } from "./runs";

export type AiObservabilityDeps = {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  canManageBot: BotManagementCheck;
  healthService?: OpikHealthService;
  /** The local tables the export and summary routes aggregate over. */
  database?: Database;
  /** The ownership generation for the scope key; wiring supplies the live source. */
  scopeEpoch?: (actor: AgentActor, botId: string) => Promise<number>;
  /** T07's authoritative ownership seam (Issue #13), injected. */
  bindings?: Pick<RunBindingStore, "latestAttempt"> &
    Partial<
      Pick<RunBindingStore, "capabilitiesByOpikTraceIds" | "countUnreconciled">
    >;
  config?: () => OpikConfig;
  /** The verified port, or null when no verified contract backs this deployment. */
  port?: OpikPort | null;
  /**
   * The shared runs query service: when present the runs routes serve from this
   * instance, so the retention worker's `invalidateReads` seam can drop the
   * very window the routes cache under. Absent = the routes build their own.
   */
  runsQuery?: RunsQueryService;
  /** The caller's bot listing, for the unfiltered admin summary. */
  listBots?: (actor: AgentActor) => Promise<readonly AgentProfile[]>;
  /** Override for tests; the assembly builds its own service from the deps above. */
  summary?: AdminSummaryService;
};

export function createAiObservabilityRoutes(
  deps: AiObservabilityDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);
  if (deps.healthService) {
    routes.route(
      "/health",
      createAiObservabilityHealthRoutes({ service: deps.healthService }),
    );
  }

  // The T12 leftover: the creator's run query routes, honestly 503 when the
  // deployment has no verified port.
  if (deps.scopeEpoch && deps.bindings && deps.config) {
    routes.route(
      "/bots/:botId/runs",
      createRunsQueryRoutes({
        canManageBot: deps.canManageBot,
        scopeEpoch: deps.scopeEpoch,
        bindings: deps.bindings,
        config: deps.config,
        port: deps.port ?? null,
        query: deps.runsQuery,
      }),
    );
  }

  // The T28/T29 experiment surfaces (this ticket's wiring obligation): the result read
  // and the comparison, both over the local tables only — a portless deployment answers
  // them honestly, because nothing here asks Opik anything. Built from the same database
  // the export routes aggregate over, behind the same manage gate and live epoch.
  if (deps.database && deps.scopeEpoch) {
    const experimentStores = {
      canManageBot: deps.canManageBot,
      scopeEpoch: deps.scopeEpoch,
      experiments: createObservationExperimentStore(deps.database),
      executions: createObservationExecutionStore(deps.database),
      datasets: createObservationDatasetStore(deps.database),
      ticket: createWorkTicketReader(deps.database),
    };
    routes.route(
      "/bots/:botId/experiments/:experimentId/results",
      createExperimentResultsRoutes(experimentStores),
    );
    routes.route(
      "/bots/:botId/experiment-comparisons",
      createExperimentComparisonRoutes(experimentStores),
    );
  }

  // The T34 report §6 mount contract: exports on the same per-bot seam.
  if (deps.database && deps.scopeEpoch) {
    routes.route(
      "/bots/:botId/exports",
      createExportRoutes({
        database: deps.database,
        canManageBot: deps.canManageBot,
        scopeEpoch: deps.scopeEpoch,
      }),
    );
  }

  // The admin summary (this ticket): authorized scopes first, aggregates after.
  // An injected summary service (tests) or the deps its real construction needs.
  if (
    deps.scopeEpoch &&
    deps.listBots &&
    (deps.summary ?? (deps.database && deps.config && deps.healthService)) !==
      undefined
  ) {
    routes.route(
      "/admin/summary",
      createAdminSummaryRoutes({
        canManageBot: deps.canManageBot,
        scopeEpoch: deps.scopeEpoch,
        listBots: deps.listBots,
        summary:
          deps.summary ??
          createAdminSummaryService({
            database: deps.database as Database,
            config: deps.config as () => OpikConfig,
            port: deps.port ?? null,
            healthService: deps.healthService as OpikHealthService,
          }),
      }),
    );
  }

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
