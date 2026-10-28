/**
 * The creator's experiment comparison route (Issue #35 / DAG T29).
 *
 * Mounted inside createAiObservabilityRoutes at
 *
 *   routes.route(
 *     "/bots/:botId/experiment-comparisons",
 *     createExperimentComparisonRoutes({ ... }),
 *   )
 *
 * which puts the endpoint at
 * GET /api/ai-observability/bots/:botId/experiment-comparisons behind the root requireUser.
 * The comparison spans two experiments, so it cannot nest under one experiment's path; the
 * four ids arrive as query parameters and nothing else — no forged actor, bot, scope or
 * link can steer a read, and every link in the answer is minted server-side from the rows
 * the scope just read. Authorization is the management question (resolveObservationBot) and
 * the scope is derived from the authenticated context plus the injected ownership epoch,
 * exactly like the T10/T11/T28 seams; ownership is answered per request, so a transfer or
 * revocation is effective on the very next call. A missing query parameter is an input
 * refusal, never an empty side. Errors keep the house convention: the code is the contract.
 */
import { Hono } from "hono";
import type { AgentActor } from "../../agents/public";
import type { AppVariables } from "../../auth/public";
import {
  createExperimentComparisonService,
  ExperimentComparisonError,
} from "../comparison";
import {
  type BotManagementCheck,
  explicitObservationOwnership,
  OBSERVATION_BOT_NOT_FOUND,
  resolveObservationBot,
} from "../context";
import { ObservationScopeError } from "../contracts";
import type { ObservationDatasetStore } from "../datasets";
import { ExecutionError, type ObservationExecutionStore } from "../executions";
import type { ObservationExperimentStore } from "../experiments";
import { ExperimentResultsError, type WorkTicketState } from "../results";
import { resolveObservationScope } from "../scope";

export type ExperimentComparisonRouteDeps = Readonly<{
  canManageBot: BotManagementCheck;
  /** The ownership generation for the scope key; wiring supplies the live source. */
  scopeEpoch: (actor: AgentActor, botId: string) => Promise<number>;
  experiments: Pick<ObservationExperimentStore, "getExperiment">;
  executions: Pick<ObservationExecutionStore, "get">;
  datasets: Pick<ObservationDatasetStore, "getVersion">;
  /** The work-queue read for lease-recovery classification (T34's ticket table). */
  ticket: (executionId: string) => Promise<WorkTicketState | null>;
}>;

/** House convention: known errors map to their code, anything else rethrows. */
function classify(error: unknown): {
  body: { error: string };
  status: 400 | 401 | 402 | 403 | 404 | 409 | 500 | 502;
} {
  if (error instanceof ObservationScopeError) {
    return { body: { error: error.code }, status: error.status };
  }
  if (error instanceof ExperimentComparisonError) {
    return { body: { error: error.code }, status: error.status };
  }
  if (error instanceof ExperimentResultsError) {
    return { body: { error: error.code }, status: error.status };
  }
  if (error instanceof ExecutionError) {
    return { body: { error: error.code }, status: error.status };
  }
  throw error;
}

export function createExperimentComparisonRoutes(
  deps: ExperimentComparisonRouteDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const service = createExperimentComparisonService({
    experiments: deps.experiments,
    executions: deps.executions,
    datasets: deps.datasets,
    ticket: deps.ticket,
  });

  routes.get("/", async (context) => {
    try {
      // The manage gate first, then the live scope — the T11/T28 authorization block.
      const access = await resolveObservationBot(
        deps.canManageBot,
        context.var.actor,
        context.req.param("botId"),
      );
      if (!access.ok) {
        return Response.json(
          { error: access.error },
          { status: access.status },
        );
      }
      const actor = context.var.actor;
      // Explicit, never inferred (OCR h10/m182): a caller the seam refuses to mint
      // for is answered with the same unified not-found the manage gate uses.
      const ownership = explicitObservationOwnership(actor, access.profile);
      if (ownership === null) {
        return Response.json(
          { error: OBSERVATION_BOT_NOT_FOUND },
          { status: 404 },
        );
      }
      const epoch = await deps.scopeEpoch(actor, access.botId);
      const scope = resolveObservationScope({
        actorId: actor.id,
        botId: access.botId,
        ownership,
        epoch,
      });

      const comparison = await service.compare(scope, {
        // Query parameters; a missing one is a blank reference the service refuses.
        baseline: {
          experimentId: context.req.query("baselineExperimentId") ?? "",
          executionId: context.req.query("baselineExecutionId") ?? "",
        },
        candidate: {
          experimentId: context.req.query("candidateExperimentId") ?? "",
          executionId: context.req.query("candidateExecutionId") ?? "",
        },
      });
      return context.json(comparison);
    } catch (error) {
      const failure = classify(error);
      return context.json(failure.body, failure.status);
    }
  });

  return routes;
}
