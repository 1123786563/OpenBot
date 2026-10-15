/**
 * The export request routes (Issue #40 / DAG T34).
 *
 * Mounting contract for the coordinator (this file is deliberately NOT wired into
 * routes/index.ts — that seam is T01-owned):
 *
 *   routes.route("/bots/:botId/exports", createExportRoutes({ ... }))
 *
 * inside createAiObservabilityRoutes, putting the endpoints at
 * POST /api/ai-observability/bots/:botId/exports (enqueue; 202, the job is
 * queued, nothing has run yet) and GET /api/ai-observability/bots/:botId/exports
 * (this scope's jobs, newest first) and
 * GET /api/ai-observability/bots/:botId/exports/:jobId (one job's status; the
 * projected artifact rides along exactly when the state is completed) — all
 * behind the root requireUser, exactly like the T11 runs routes.
 *
 * The request contributes nothing but its identity: no body field, query value
 * or header reaches the job — the row cap is the deployment's, the locator is
 * the scope's, and the artifact is what the worker projected. Cancellation is
 * not a route: revocation arrives through the control plane's cancel seam
 * (`cancelForActor`), which needs no request because the actor's authorization
 * is the thing that ended.
 */
import { Hono } from "hono";
import type { AgentActor } from "../../agents/profile-types";
import type { AppVariables } from "../../auth/guards";
import type { Database } from "../../db/client";
import type { BotManagementCheck } from "../context";
import { resolveObservationBot } from "../context";
import { ObservationScopeError } from "../contracts";
import {
  createObservationExportStore,
  ExportError,
  isTerminalExportJobState,
  type ObservationExportJob,
  parseExportJobState,
  resolveExportLimits,
} from "../exports";
import { resolveObservationScope } from "../scope";

export type ExportRouteDeps = Readonly<{
  database: Database;
  canManageBot: BotManagementCheck;
  /** The ownership generation for the scope key; wiring supplies the live source. */
  scopeEpoch: (actor: AgentActor, botId: string) => Promise<number>;
  /** The deployment's export row cap; the house resolver over process.env by default. */
  maxRows?: () => number;
}>;

/** What a route may say about a job. The state is parsed, never echoed raw. */
function projectJob(job: ObservationExportJob) {
  const state = parseExportJobState(job.state);
  return {
    jobId: job.id,
    state,
    rowLimit: job.rowLimit,
    rowCount: job.rowCount,
    errorCode: job.errorCode,
    redactionPolicyVersion: job.redactionPolicyVersion,
    createdAt: job.createdAt.toISOString(),
    settledAt: job.settledAt?.toISOString() ?? null,
    // The product rides along exactly when it exists — completed is the only
    // state the database lets carry one.
    artifact:
      isTerminalExportJobState(state) && state === "completed"
        ? job.artifact
        : undefined,
  };
}

/** House convention: known errors map to their code, anything else rethrows. */
function classify(error: unknown): {
  body: { error: string };
  status: 400 | 401 | 403 | 404 | 500 | 503;
} {
  if (error instanceof ObservationScopeError) {
    return { body: { error: error.code }, status: error.status };
  }
  if (error instanceof ExportError) {
    return { body: { error: error.code }, status: error.status };
  }
  throw error;
}

export function createExportRoutes(
  deps: ExportRouteDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const store = createObservationExportStore(deps.database);
  const maxRows =
    deps.maxRows ?? (() => resolveExportLimits(process.env).maxRows);

  /** The T10 authorization block, shared by every route: manage-gate, then scope. */
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
    const ownership =
      access.profile.ownerUserId === actor.id
        ? ("owner" as const)
        : ("admin" as const);
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

  routes.post("/", async (context) => {
    try {
      const resolved = await scopeFor(context);
      if (resolved instanceof Response) return resolved;
      // One queued row and its claim ticket, one transaction, no upstream I/O:
      // the request thread is already done.
      const job = await store.enqueue(resolved.scope, maxRows());
      return context.json({ job: projectJob(job) }, 202);
    } catch (error) {
      const failure = classify(error);
      return context.json(failure.body, failure.status);
    }
  });

  routes.get("/", async (context) => {
    try {
      const resolved = await scopeFor(context);
      if (resolved instanceof Response) return resolved;
      const jobs = await store.list(resolved.scope);
      return context.json({ jobs: jobs.map(projectJob) });
    } catch (error) {
      const failure = classify(error);
      return context.json(failure.body, failure.status);
    }
  });

  routes.get("/:jobId", async (context) => {
    try {
      const resolved = await scopeFor(context);
      if (resolved instanceof Response) return resolved;
      const job = await store.get(resolved.scope, context.req.param("jobId"));
      if (!job) {
        return context.json({ error: "EXPORT_NOT_FOUND" }, 404);
      }
      return context.json({ job: projectJob(job) });
    } catch (error) {
      const failure = classify(error);
      return context.json(failure.body, failure.status);
    }
  });

  return routes;
}
