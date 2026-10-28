/**
 * The creator's experiment result routes (Issue #34 / DAG T28).
 *
 * Mounting contract for the coordinator (this file is deliberately NOT wired into
 * routes/index.ts — that seam is integration-owned, like T10/T11/T20's):
 *
 *   routes.route(
 *     "/bots/:botId/experiments/:experimentId/results",
 *     createExperimentResultsRoutes({ ... }),
 *   )
 *
 * inside createAiObservabilityRoutes, which puts the endpoint at
 * GET /api/ai-observability/bots/:botId/experiments/:experimentId/results/:executionId
 * behind the root requireUser.
 *
 * Authorization is the management question (resolveObservationBot) and the scope is
 * derived from the authenticated context plus the injected ownership epoch, exactly like
 * the T10/T11 seams: the path contributes an experiment id and an execution id, and
 * nothing else — no forged actor, bot, scope or link can steer a read, and the report's
 * result link is minted server-side from the row the scope just read. Ownership is
 * answered per request — a transfer or revocation is effective on the very next call.
 * Errors keep the house convention: the code is the contract.
 */
import { Hono } from "hono";
import type { AgentActor } from "../../agents/public";
import type { AppVariables } from "../../auth/public";
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
import {
  createExperimentResultService,
  ExperimentResultsError,
  type WorkTicketState,
} from "../results";
import { resolveObservationScope } from "../scope";

export type ExperimentResultsRouteDeps = Readonly<{
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
  status: 400 | 401 | 402 | 403 | 404 | 409 | 500;
} {
  if (error instanceof ObservationScopeError) {
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

export function createExperimentResultsRoutes(
  deps: ExperimentResultsRouteDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const service = createExperimentResultService({
    experiments: deps.experiments,
    executions: deps.executions,
    datasets: deps.datasets,
    ticket: deps.ticket,
  });

  /** The shared authorization block: manage-gate first, then the scope. */
  const scopeFor = async (context: {
    var: { actor: AgentActor };
    req: { param: (name: string) => string };
  }): Promise<
    { scope: ReturnType<typeof resolveObservationScope> } | Response
  > => {
    const access = await resolveObservationBot(
      deps.canManageBot,
      context.var.actor,
      context.req.param("botId"),
    );
    if (!access.ok) {
      return Response.json({ error: access.error }, { status: access.status });
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
    return {
      scope: resolveObservationScope({
        actorId: actor.id,
        botId: access.botId,
        ownership,
        epoch,
      }),
    };
  };

  routes.get("/:executionId", async (context) => {
    try {
      const resolved = await scopeFor(context);
      if (resolved instanceof Response) return resolved;
      const report = await service.query(resolved.scope, {
        // Path params; a missing one is a blank reference the service refuses.
        experimentId: context.req.param("experimentId") ?? "",
        executionId: context.req.param("executionId") ?? "",
      });
      return context.json(report);
    } catch (error) {
      const failure = classify(error);
      return context.json(failure.body, failure.status);
    }
  });

  return routes;
}
