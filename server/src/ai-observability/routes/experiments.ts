/**
 * The creator's experiment WRITE routes (the T-routes closure ticket).
 *
 * Mounted inside createAiObservabilityRoutes at
 *
 *   routes.route("/bots/:botId/experiments", createExperimentWriteRoutes({ ... }))
 *
 * which puts the two URL faces the T30 page already consumes behind the root
 * requireUser:
 *
 *   POST /api/ai-observability/bots/:botId/experiments
 *     body: ExperimentSubmitInput → 200 SubmittedExperimentResult | 4xx { error }
 *   POST /api/ai-observability/bots/:botId/experiments/:experimentId/executions/:executionId/cancel
 *     → 200 CancelledExecutionResult | 4xx { error }
 *
 * The shapes are the ones shared/ai-observability-experiments.ts pinned — the page is
 * the existing consumer and this file does not move the contract; it mounts the T22
 * audited freeze and the T23 billing-gated start under one POST (the freeze is
 * idempotent on the frozen-configuration key, so a retry hits the same experiment and
 * starts a fresh execution of it), and the audited scope-keyed cancel under the other.
 *
 * Authorization is the management question (resolveObservationBot) and the scope is
 * derived from the authenticated context plus the injected ownership epoch, exactly
 * like the T28/T29 seams; nothing in a body or path can name a scope. The billing
 * gate is the execution-start precheck: a deployment that injects none has no metering
 * machinery to answer "may this run", so the start refuses fail-closed (the T25
 * doctrine — a gate that cannot read the ledger refuses rather than admits) while the
 * freeze itself stays durable and the funded retry replays it. Errors keep the house
 * convention: the code is the contract.
 */
import { type Context, Hono } from "hono";
import type { AuditStore } from "../../audit";
import { type BotManagementCheck, resolveObservationBot } from "../context";
import { ObservationScopeError } from "../contracts";
import {
  createExecutionCancelService,
  createExperimentExecutionService,
  type ExecutionBudgetPrecheck,
  ExecutionError,
  type ObservationExecutionStore,
} from "../executions";
import {
  createExperimentSubmitService,
  ExperimentStoreError,
  type ObservationExperimentStore,
  type SaveExperimentInput,
} from "../experiments";
import { resolveObservationScope } from "../scope";
import type { AiObservabilityDeps } from "./index";

/**
 * MOD18（#638）：两条身份类型边改走组内签名提取（MOD05-08 先例），M11 的
 * 直连 import 移除——`agents/profile-types` 的 `AgentActor` 经 context.ts 既有
 * `BotManagementCheck` 合同的首参收拢（M03 边）；`auth/guards` 的
 * `AppVariables` 经 routes/index.ts 既有 `AiObservabilityDeps` 的 requireUser
 * 中间件签名收拢（Context 泛型反解，M01 边）。两者都是类型级引用：运行时
 * 零边、零新合同，形状漂移由 typecheck 红。
 */
type AgentActor = Parameters<BotManagementCheck>[0];
type RouteEnv =
  Parameters<AiObservabilityDeps["requireUser"]>[0] extends Context<infer E>
    ? E
    : never;
type AppVariables = NonNullable<RouteEnv["Variables"]>;

export type ExperimentWriteRouteDeps = Readonly<{
  canManageBot: BotManagementCheck;
  /** The ownership generation for the scope key; wiring supplies the live source. */
  scopeEpoch: (actor: AgentActor, botId: string) => Promise<number>;
  experiments: Pick<ObservationExperimentStore, "submit">;
  executions: Pick<
    ObservationExecutionStore,
    "enqueue" | "get" | "settleCancelled"
  >;
  /** The governance channel: the freeze and the cancel each leave their trail. */
  audit: Pick<AuditStore, "insert">;
  /**
   * The execution-start billing gate (T23's start seam, T25's precheck). Absent means
   * the deployment has no metering machinery — the start refuses fail-closed, the
   * freeze does not.
   */
  billing?: Readonly<{ precheck: ExecutionBudgetPrecheck }>;
}>;

/** House convention: known errors map to their code, anything else rethrows. */
function classify(error: unknown): {
  body: { error: string };
  status: 400 | 401 | 402 | 403 | 404 | 409 | 500;
} {
  if (error instanceof ObservationScopeError) {
    return { body: { error: error.code }, status: error.status };
  }
  if (error instanceof ExperimentStoreError) {
    return { body: { error: error.code }, status: error.status };
  }
  if (error instanceof ExecutionError) {
    return { body: { error: error.code }, status: error.status };
  }
  throw error;
}

/** The submitted body's outer shape; field-level validation stays in the T22 store. */
function isSubmitBody(value: unknown): value is SaveExperimentInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (
    typeof body.name !== "string" ||
    typeof body.datasetVersionId !== "string"
  )
    return false;
  const config = body.config;
  return !!config && typeof config === "object" && !Array.isArray(config);
}

export function createExperimentWriteRoutes(
  deps: ExperimentWriteRouteDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const submitService = createExperimentSubmitService({
    experiments: deps.experiments,
    audit: deps.audit,
  });
  const startService = createExperimentExecutionService({
    executions: deps.executions,
    // No injected gate is a deployment without metering: refuse fail-closed.
    billing: deps.billing ?? {
      precheck: async () => ({
        allowed: false as const,
        reason: "billing_not_configured",
      }),
    },
  });
  const cancelService = createExecutionCancelService({
    executions: deps.executions,
    audit: deps.audit,
  });

  /** The shared authorization block: manage-gate first, then the live scope. */
  const scopeFor = async (context: {
    var: { actor: AgentActor };
    req: { param: (name: string) => string };
  }) => {
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
      const raw: unknown = await context.req.json().catch(() => null);
      if (!isSubmitBody(raw)) {
        return context.json({ error: "EXPERIMENT_INPUT_INVALID" }, 400);
      }
      // Freeze first (idempotent on the frozen-configuration key), then start the
      // execution the submission means: one POST, one new run of the frozen config.
      const { experiment, replayed, canaryFindings } =
        await submitService.submit(resolved.scope, raw);
      const execution = await startService.start(resolved.scope, experiment.id);
      return context.json({
        experimentId: experiment.id,
        executionId: execution.id,
        name: experiment.name,
        datasetVersionId: experiment.datasetVersionId,
        datasetContentHash: experiment.datasetContentHash,
        configHash: experiment.configHash,
        replayed,
        canaryFindings,
      });
    } catch (error) {
      const failure = classify(error);
      return context.json(failure.body, failure.status);
    }
  });

  routes.post(
    "/:experimentId/executions/:executionId/cancel",
    async (context) => {
      try {
        const resolved = await scopeFor(context);
        if (resolved instanceof Response) return resolved;
        const settled = await cancelService.cancel(resolved.scope, {
          // Path params; a missing one is a blank reference the service refuses.
          experimentId: context.req.param("experimentId") ?? "",
          executionId: context.req.param("executionId") ?? "",
        });
        return context.json({
          executionId: settled.id,
          state: "cancelled" as const,
        });
      } catch (error) {
        const failure = classify(error);
        return context.json(failure.body, failure.status);
      }
    },
  );

  return routes;
}
