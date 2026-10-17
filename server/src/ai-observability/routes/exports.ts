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
import type { ExportJobsResult } from "../../../../shared/ai-observability-admin";
import type { AgentActor } from "../../agents/profile-types";
import type { AppVariables } from "../../auth/guards";
import type { Database } from "../../db/client";
import type { BotManagementCheck } from "../context";
import {
  explicitObservationOwnership,
  OBSERVATION_BOT_NOT_FOUND,
  resolveObservationBot,
} from "../context";
import { ObservationScopeError } from "../contracts";
import {
  createObservationExportStore,
  ExportError,
  isTerminalExportJobState,
  type ObservationExportJob,
  type ObservationExportJobListItem,
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
/**
 * Exported for the m216 anti-drift test: the wire shapes the routes answer with,
 * against the shared contract types in shared/ai-observability-admin.ts.
 */
export function projectJob(job: ObservationExportJob) {
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
    // state the database lets carry one — and never as null: the schema's own
    // check makes a completed job's artifact an array, so a null (schema drift,
    // if it ever appeared) is not a value this projection repeats. The key is
    // absent rather than undefined on non-completed states, so the wire shape
    // and the shared ExportJobView's optional field are the same type.
    ...(isTerminalExportJobState(state) && state === "completed"
      ? { artifact: job.artifact ?? undefined }
      : {}),
  };
}

/** The list page's bounds: the same explicit cap, not a silent clamp, as the runs face. */
export const MAX_EXPORTS_LIMIT = 100;
const DEFAULT_EXPORTS_LIMIT = 20;

/**
 * The list projection (R2-40): the job's facts, and for a completed job where the
 * product lives — never the rows themselves. The list is what the frontend's 5-second
 * poll reads; a thousand jobs each carrying their artifact inline amplified every
 * poll to tens of megabytes. The detail endpoint is the one artifact carrier, and a
 * completed job's `artifactUrl` names it. The base is the request's own mounted path,
 * so the link lands wherever the coordinator mounts the routes.
 */
export function projectJobListItem(
  job: ObservationExportJobListItem,
  artifactUrlBase: string,
) {
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
    ...(state === "completed"
      ? { artifactUrl: `${artifactUrlBase}/${job.id}` }
      : {}),
  };
}

/** The list query's paging numbers, validated fail-closed: garbage is a 400, never a clamp. */
function pageOf(searchParams: URLSearchParams): {
  limit: number;
  offset: number;
} {
  const limitRaw = searchParams.get("limit") ?? String(DEFAULT_EXPORTS_LIMIT);
  const offsetRaw = searchParams.get("offset") ?? "0";
  const limit = Number.parseInt(limitRaw, 10);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_EXPORTS_LIMIT ||
    String(limit) !== limitRaw
  ) {
    throw new ExportError("EXPORT_INPUT_INVALID", 400);
  }
  const offset = Number.parseInt(offsetRaw, 10);
  if (!Number.isInteger(offset) || offset < 0 || String(offset) !== offsetRaw) {
    throw new ExportError("EXPORT_INPUT_INVALID", 400);
  }
  return { limit, offset };
}

/** House convention: known errors map to their code, anything else rethrows. */
function classify(error: unknown): {
  body: { error: string };
  status: 400 | 401 | 403 | 404 | 429 | 500 | 503;
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
    // Explicit, never inferred (OCR h10/m182, R4-36): the ownership comes off
    // the seam, not off this route's own guess — the inline `owner ? "owner"
    // : "admin"` minted any manage-passing non-owner an admin scope on the
    // data-egress face, exactly what the seam exists to fail closed against.
    // A null refusal answers the same unified not-found the manage gate uses.
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
      // R2-40: the poll face pages, and no artifact rides the list — the rows
      // live on the detail endpoint a completed job's artifactUrl names. The
      // scope filter stays the store's, so an out-of-range offset answers an
      // honest empty page and can never widen what this caller sees.
      const { limit, offset } = pageOf(new URL(context.req.url).searchParams);
      // R3-33: the page and its total are answered in SQL — limit/offset in
      // the list query, the envelope's total from a count — instead of
      // materializing this scope's whole history (artifact column and all)
      // to slice it in memory. The wire contract is unchanged (R2-40): same
      // ExportJobsResult envelope, same projection, honest empty pages.
      const [jobs, total] = await Promise.all([
        store.list(resolved.scope, { limit, offset }),
        store.count(resolved.scope),
      ]);
      // The annotation is the pin: the route's list answer IS the shared
      // ExportJobsResult, so contract drift here is a compile error.
      const body: ExportJobsResult = {
        jobs: jobs.map((job) => projectJobListItem(job, context.req.path)),
        pagination: {
          total,
          offset,
          limit,
          nextOffset: offset + limit < total ? offset + limit : null,
        },
      };
      return context.json(body);
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
