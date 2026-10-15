/**
 * The creator's read-only run routes (Issue #17 / DAG T11).
 *
 * Mounting contract for the coordinator (this file is deliberately NOT wired into
 * routes/index.ts — that seam is T01-owned):
 *
 *   routes.route("/bots/:botId/runs", createRunsQueryRoutes({ ... }))
 *
 * inside createAiObservabilityRoutes, which puts the endpoints at
 * GET /api/ai-observability/bots/:botId/runs (list) and
 * GET /api/ai-observability/bots/:botId/runs/:runId (detail) behind the root
 * requireUser — coexisting with T10's POST-only reporting route on the same path.
 *
 * Authorization is the management question (resolveObservationBot) and the scope
 * is derived from the authenticated context plus the injected ownership epoch,
 * exactly like the T10 seam: the query string contributes a page size, a cursor
 * and nothing else, so no forged actor, bot, scope, locator or upstream filter
 * can steer a read. Ownership is answered per request — a transfer or revocation
 * is effective on the very next call — and the T07 binding table, never an
 * owner snapshot captured at collection time, decides which runs this scope may
 * see. Errors keep the house convention: the code is the contract.
 */
import { Hono } from "hono";
import type { AgentActor } from "../../agents/profile-types";
import type { AppVariables } from "../../auth/guards";
import type { RunBindingStore } from "../bindings";
import { RunBindingError } from "../bindings";
import type { OpikConfig } from "../config";
import { type BotManagementCheck, resolveObservationBot } from "../context";
import { ObservationScopeError } from "../contracts";
import type { OpikPort } from "../opik-port";
import {
  createRunsQueryService,
  MAX_RUNS_LIMIT,
  RunsQueryError,
} from "../queries/runs";
import { resolveObservationScope } from "../scope";

export type RunsQueryRouteDeps = Readonly<{
  canManageBot: BotManagementCheck;
  /** The ownership generation for the scope key; wiring supplies the live source. */
  scopeEpoch: (actor: AgentActor, botId: string) => Promise<number>;
  /** T07's authoritative ownership seam (Issue #13), injected. */
  bindings: Pick<RunBindingStore, "latestAttempt">;
  config: () => OpikConfig;
  /** The verified port, or null when no verified contract backs this deployment. */
  port: OpikPort | null;
  windowSize?: number;
  cacheTtlMs?: number;
  now?: () => Date;
}>;

const BAD_LIMIT = new RunsQueryError("RUNS_QUERY_INPUT_INVALID", 400);

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 20;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_RUNS_LIMIT) {
    throw BAD_LIMIT;
  }
  return parsed;
}

/** House convention: known errors map to their code, anything else rethrows. */
function classify(error: unknown): {
  body: { error: string };
  status: 400 | 401 | 402 | 403 | 404 | 502 | 503;
} {
  if (error instanceof ObservationScopeError) {
    return { body: { error: error.code }, status: error.status };
  }
  if (error instanceof RunsQueryError) {
    return { body: { error: error.code }, status: error.status };
  }
  if (error instanceof RunBindingError) {
    return { body: { error: error.code }, status: error.status };
  }
  throw error;
}

export function createRunsQueryRoutes(
  deps: RunsQueryRouteDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const query = createRunsQueryService({
    bindings: deps.bindings,
    config: deps.config,
    port: deps.port,
    windowSize: deps.windowSize,
    cacheTtlMs: deps.cacheTtlMs,
    now: deps.now,
  });

  /** The T10 authorization block, shared by list and detail: manage-gate, then scope. */
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
    // Ownership is answered from the same row the decision was made on; the
    // epoch is injected wiring, never a query value.
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

  routes.get("/", async (context) => {
    try {
      const resolved = await scopeFor(context);
      if (resolved instanceof Response) return resolved;
      const body = await query.list(resolved.scope, {
        cursor: context.req.query("cursor") || undefined,
        limit: parseLimit(context.req.query("limit")),
      });
      return context.json(body);
    } catch (error) {
      const failure = classify(error);
      return context.json(failure.body, failure.status);
    }
  });

  routes.get("/:runId", async (context) => {
    try {
      const resolved = await scopeFor(context);
      if (resolved instanceof Response) return resolved;
      const body = await query.detail(
        resolved.scope,
        context.req.param("runId"),
      );
      return context.json(body);
    } catch (error) {
      const failure = classify(error);
      return context.json(failure.body, failure.status);
    }
  });

  return routes;
}
