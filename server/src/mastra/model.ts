import { randomUUID } from "node:crypto";
import type { LanguageModel } from "ai";
import { PlanModel } from "../agents/plan-model";
import type {
  ModelInvocationContext,
  PlatformScope,
  RunService,
} from "../enterprise/contracts";
import type {
  createRuntimeModelAdapter,
  RuntimeModelRoute,
} from "../enterprise/models/runtime-adapter";

type LanguageModelV3 = Extract<LanguageModel, { specificationVersion: "v3" }>;
type LanguageModelV3CallOptions = Parameters<LanguageModelV3["doGenerate"]>[0];

type EstimatorModelRoute = Omit<RuntimeModelRoute, "model"> & {
  model: Omit<RuntimeModelRoute["model"], "plan"> & {
    plan?: Omit<NonNullable<RuntimeModelRoute["model"]["plan"]>, "endpoint"> & {
      endpoint: string;
    };
  };
};

export type GovernedModelContext = {
  scope: PlatformScope;
  runId: string;
  attemptId: string;
  modelRouteRef: string;
  signal: AbortSignal;
};

export type GovernedMastraModel = LanguageModelV3;

export type GovernedModelDependencies = {
  runs: RunService;
  getAttemptGeneration(
    scope: PlatformScope,
    runId: string,
    attemptId: string,
  ): Promise<number>;
  adapter: ReturnType<typeof createRuntimeModelAdapter>;
  estimateInputTokenUpperBound(
    route: EstimatorModelRoute,
    options: LanguageModelV3CallOptions,
  ): Promise<number | undefined> | number | undefined;
  createModel?(
    route: RuntimeModelRoute,
    apiKey: string,
    environment: Record<string, string | undefined>,
  ): Promise<LanguageModelV3>;
  createPlanModel?(
    config: NonNullable<RuntimeModelRoute["model"]["plan"]>,
    botId: string,
    threadId: string,
    signal: AbortSignal,
  ): LanguageModelV3;
  environment?: Record<string, string | undefined>;
};

const publicFailure = () => new Error("MODEL_INVOCATION_FAILED");
type StreamPart =
  Awaited<
    ReturnType<LanguageModelV3["doStream"]>
  >["stream"] extends ReadableStream<infer T>
    ? T
    : never;
const totalUsage = (usage: {
  inputTokens?: { total?: number };
  outputTokens?: { total?: number };
}): number | undefined => {
  const input = usage.inputTokens?.total;
  const output = usage.outputTokens?.total;
  if (
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(output) ||
    (input as number) < 0 ||
    (output as number) < 0
  )
    return undefined;
  return (input as number) + (output as number);
};

function freezeRuntimeRoute(route: RuntimeModelRoute): RuntimeModelRoute {
  const plan = route.model.plan
    ? Object.freeze({
        ...route.model.plan,
        endpoint: new URL(route.model.plan.endpoint.href),
      })
    : undefined;
  const model = Object.freeze({
    provider: route.model.provider,
    defaultModel: route.model.defaultModel,
    ...(plan ? { plan } : {}),
  });
  return Object.freeze({
    model,
    credentialSecretRef: route.credentialSecretRef,
    ...(route.planBotId === undefined ? {} : { planBotId: route.planBotId }),
  });
}

function estimatorRouteView(
  route: RuntimeModelRoute,
  planEndpoint: string | undefined,
): EstimatorModelRoute {
  const plan = route.model.plan
    ? Object.freeze({ ...route.model.plan, endpoint: planEndpoint as string })
    : undefined;
  const model = Object.freeze({
    provider: route.model.provider,
    defaultModel: route.model.defaultModel,
    ...(plan ? { plan } : {}),
  });
  return Object.freeze({
    model,
    credentialSecretRef: route.credentialSecretRef,
    ...(route.planBotId === undefined ? {} : { planBotId: route.planBotId }),
  });
}

function redact(value: unknown, secret: string): unknown {
  if (typeof value === "string")
    return secret ? value.split(secret).join("[redacted]") : value;
  if (Array.isArray(value)) return value.map((part) => redact(part, secret));
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, part]) => [key, redact(part, secret)]),
    );
  }
  return value;
}

function matchingCapability(
  resolved: ModelInvocationContext,
  context: GovernedModelContext,
  generation: number,
  maximumTokens: number,
): boolean {
  return (
    resolved.tenantId === context.scope.tenantId &&
    resolved.workspaceId === context.scope.workspaceId &&
    resolved.principalId === context.scope.principalId &&
    resolved.runId === context.runId &&
    resolved.attemptId === context.attemptId &&
    resolved.generation === generation &&
    resolved.modelRouteRef === context.modelRouteRef &&
    resolved.maximumTokens === maximumTokens
  );
}

export async function createGovernedMastraModel(
  deps: GovernedModelDependencies,
  context: GovernedModelContext,
): Promise<GovernedMastraModel> {
  const environment = deps.environment ?? process.env;
  const adapter = deps.adapter;

  const invoke = async <T>(
    options: LanguageModelV3CallOptions,
    call: (
      model: LanguageModelV3,
      options: LanguageModelV3CallOptions,
    ) => Promise<T>,
  ): Promise<{
    value: T;
    apiKey: string;
    confirmUsage(usedTokens: number): Promise<void>;
    markUnknown(): Promise<void>;
  }> => {
    if (context.signal.aborted || options.abortSignal?.aborted)
      throw publicFailure();
    const outputTokens = options.maxOutputTokens;
    if (!Number.isSafeInteger(outputTokens) || (outputTokens as number) <= 0)
      throw publicFailure();

    let route: RuntimeModelRoute;
    let selectedPlanEndpoint: string | undefined;
    let inputUpperBound: number | undefined;
    try {
      const selected = await adapter.selectModel(context.modelRouteRef);
      if (!selected) throw publicFailure();
      route = freezeRuntimeRoute(selected);
      selectedPlanEndpoint = route.model.plan?.endpoint.href;
      const estimatorRoute = estimatorRouteView(route, selectedPlanEndpoint);
      inputUpperBound = await deps.estimateInputTokenUpperBound(
        estimatorRoute,
        options,
      );
    } catch {
      throw publicFailure();
    }
    if (
      !Number.isSafeInteger(inputUpperBound) ||
      (inputUpperBound as number) < 0
    )
      throw publicFailure();
    const maximumTokens =
      (outputTokens as number) + (inputUpperBound as number);
    if (!Number.isSafeInteger(maximumTokens)) throw publicFailure();

    const generation = await deps.getAttemptGeneration(
      context.scope,
      context.runId,
      context.attemptId,
    );
    const modelRequestId = randomUUID();
    let capability: string | undefined;
    let consumed = false;
    let settlement: Promise<void> | undefined;
    const markUnknown = async () => {
      if (!capability || settlement) return settlement;
      settlement = deps.runs.markModelInvocationUnknown(
        context.scope,
        capability,
      );
      return settlement;
    };
    const confirmUsage = async (usedTokens: number) => {
      if (!capability) throw publicFailure();
      if (settlement) return settlement;
      settlement = deps.runs.confirmModelInvocationUsage(
        context.scope,
        capability,
        usedTokens,
      );
      try {
        await settlement;
      } catch {
        settlement = deps.runs.markModelInvocationUnknown(
          context.scope,
          capability,
        );
        try {
          await settlement;
        } catch {
          /* The reserved maximum remains charged. */
        }
        throw publicFailure();
      }
    };
    try {
      const issued = await deps.runs.issueModelInvocationCapability(
        context.scope,
        {
          runId: context.runId,
          attemptId: context.attemptId,
          generation,
          modelRequestId,
          maximumTokens,
        },
      );
      capability = issued.capability;
      // A lost response from resolve is ambiguous: unknown safely retains the
      // maximum charge whether the database consumed the claim or not.
      consumed = true;
      const resolved = await deps.runs.resolveModelInvocationCapability(
        context.scope,
        capability,
      );
      if (!matchingCapability(resolved, context, generation, maximumTokens)) {
        await markUnknown();
        throw publicFailure();
      }

      // The route lookup and secret read happen only after the one-use DB capability
      // has consumed under the active-attempt and database-time lease fence.
      const runtime = adapter.runtimeModel(route, environment);
      let model: LanguageModelV3;
      let apiKey = "";
      const selectedPlan = route.model.plan;
      if (selectedPlan) {
        if (
          !runtime.plan ||
          runtime.plan.provider !== selectedPlan.provider ||
          runtime.plan.token !== selectedPlan.token ||
          runtime.plan.endpoint.toString() !== selectedPlan.endpoint.toString()
        )
          throw publicFailure();
        const createPlan =
          deps.createPlanModel ??
          ((config, botId, threadId, signal) =>
            new PlanModel(
              config,
              botId,
              { threadId },
              new Set(),
              signal,
            ) as LanguageModelV3);
        const planEndpoint = selectedPlanEndpoint as string;
        model = createPlan(
          { ...selectedPlan, endpoint: new URL(planEndpoint) },
          route.planBotId ?? context.runId,
          context.runId,
          context.signal,
        );
      } else {
        if (
          runtime.provider !== route.model.provider ||
          runtime.defaultModel !== route.model.defaultModel
        )
          throw publicFailure();
        const resolvedApiKey = await adapter.resolveApiKey(
          route,
          route.model.provider,
          environment,
        );
        if (!resolvedApiKey) throw publicFailure();
        apiKey = resolvedApiKey;
        model = deps.createModel
          ? await deps.createModel(route, apiKey, environment)
          : adapter.createNativeModel(route, apiKey, environment);
      }
      const combined =
        options.abortSignal === context.signal
          ? context.signal
          : AbortSignal.any([
              context.signal,
              ...(options.abortSignal ? [options.abortSignal] : []),
            ]);
      const value = await call(model, { ...options, abortSignal: combined });
      return { value, apiKey, confirmUsage, markUnknown };
    } catch {
      if (capability) {
        try {
          if (consumed) await markUnknown();
          else
            await deps.runs.releaseModelInvocation(context.scope, capability);
        } catch {
          // A failed release or settlement is deliberately not retried: the claim
          // remains conservatively charged and provider diagnostics stay private.
        }
      }
      throw publicFailure();
    }
  };

  return {
    specificationVersion: "v3",
    provider: "openbot-governed",
    modelId: context.modelRouteRef,
    supportedUrls: {},
    async doGenerate(options) {
      const { value, apiKey, confirmUsage, markUnknown } = await invoke(
        options,
        (model, callOptions) => Promise.resolve(model.doGenerate(callOptions)),
      );
      const result = value as Awaited<
        ReturnType<LanguageModelV3["doGenerate"]>
      >;
      const used = totalUsage(result.usage);
      if (used === undefined) {
        try {
          await markUnknown();
        } catch {
          throw publicFailure();
        }
      } else {
        await confirmUsage(used);
      }
      return redact(result, apiKey) as typeof result;
    },
    async doStream(options) {
      const { value, apiKey, confirmUsage, markUnknown } = await invoke(
        options,
        (model, callOptions) => Promise.resolve(model.doStream(callOptions)),
      );
      const result = value as Awaited<ReturnType<LanguageModelV3["doStream"]>>;
      const reader = result.stream.getReader();
      let finishSeen = false;
      let finishTokens: number | undefined;
      const stream = new ReadableStream<StreamPart>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              if (!finishSeen || finishTokens === undefined)
                await markUnknown();
              else await confirmUsage(finishTokens);
              controller.close();
              return;
            }
            if (next.value.type === "finish") {
              if (finishSeen) throw publicFailure();
              finishSeen = true;
              const used = totalUsage(next.value.usage);
              finishTokens = used;
              if (used === undefined) throw publicFailure();
              await confirmUsage(used);
            } else if (finishSeen) {
              throw publicFailure();
            }
            controller.enqueue(redact(next.value, apiKey) as typeof next.value);
          } catch {
            try {
              await markUnknown();
            } catch {
              /* Preserve only the safe public error. */
            }
            controller.error(publicFailure());
          }
        },
        async cancel(reason) {
          try {
            await markUnknown();
          } catch {
            /* The maximum remains conservatively charged. */
          }
          try {
            await reader.cancel(reason);
          } catch {
            // Preserve the safe cancellation surface.
          }
        },
      });
      return { ...result, stream };
    },
  };
}
