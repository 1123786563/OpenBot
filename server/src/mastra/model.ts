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
const totalUsage = (usage: unknown): number | undefined => {
  try {
    if (usage === null || typeof usage !== "object" || Array.isArray(usage))
      return undefined;
    const inputTokens = (usage as { inputTokens?: unknown }).inputTokens;
    const outputTokens = (usage as { outputTokens?: unknown }).outputTokens;
    if (
      inputTokens === null ||
      typeof inputTokens !== "object" ||
      Array.isArray(inputTokens) ||
      outputTokens === null ||
      typeof outputTokens !== "object" ||
      Array.isArray(outputTokens)
    )
      return undefined;
    const input = (inputTokens as { total?: unknown }).total;
    const output = (outputTokens as { total?: unknown }).total;
    if (
      !Number.isSafeInteger(input) ||
      !Number.isSafeInteger(output) ||
      (input as number) < 0 ||
      (output as number) < 0
    )
      return undefined;
    const total = (input as number) + (output as number);
    return Number.isSafeInteger(total) ? total : undefined;
  } catch {
    return undefined;
  }
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

function replacementMetadataKey(
  key: string,
  secrets: readonly string[],
  reserved: Set<string>,
  emitted: Set<string>,
  headerName: boolean,
): string {
  const containsSecret = secrets.some((secret) =>
    key.toLowerCase().includes(secret.toLowerCase()),
  );
  const validHeaderName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key);
  if (
    !containsSecret &&
    (!headerName || validHeaderName) &&
    !emitted.has(headerName ? key.toLowerCase() : key)
  ) {
    emitted.add(headerName ? key.toLowerCase() : key);
    return key;
  }

  for (let index = 0; index < 256; index += 1) {
    const candidate = `ob-r-${index.toString(36)}`;
    const normalizedCandidate = headerName
      ? candidate.toLowerCase()
      : candidate;
    if (
      secrets.some((secret) =>
        normalizedCandidate.toLowerCase().includes(secret.toLowerCase()),
      ) ||
      reserved.has(normalizedCandidate) ||
      emitted.has(normalizedCandidate)
    )
      continue;
    emitted.add(normalizedCandidate);
    return normalizedCandidate;
  }
  throw publicFailure();
}

function selectTextSentinel(secrets: readonly string[]): string | undefined {
  const isAbsentFromCredentials = (candidate: string) =>
    secrets.every((secret) => !secret.includes(candidate));
  for (let codePoint = 0x2580; codePoint <= 0x259f; codePoint += 1) {
    const candidate = String.fromCodePoint(codePoint);
    if (isAbsentFromCredentials(candidate)) return candidate;
  }
  for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint += 1) {
    const candidate = String.fromCodePoint(codePoint);
    if (isAbsentFromCredentials(candidate)) return candidate;
  }
  return undefined;
}

function selectHeaderTextSentinel(
  secrets: readonly string[],
): string | undefined {
  for (let codePoint = 0x21; codePoint <= 0x7e; codePoint += 1) {
    const candidate = String.fromCharCode(codePoint);
    if (secrets.every((secret) => !secret.includes(candidate)))
      return candidate;
  }
  return undefined;
}

function headerSafeRedactedValue(
  original: unknown,
  value: string,
  secrets: readonly string[],
): string {
  if (typeof original !== "string" || !containsCredential(original, secrets))
    return value;
  const sentinel = selectHeaderTextSentinel(secrets);
  if (!sentinel) throw publicFailure();
  const redacted = redactStringWithSentinel(original, secrets, sentinel);
  if (containsCredential(redacted, secrets)) throw publicFailure();
  return redacted;
}

type TextInterval = { start: number; end: number };

function credentialIntervals(
  value: string,
  secrets: readonly string[],
): TextInterval[] {
  const intervals: TextInterval[] = [];
  for (const secret of secrets) {
    if (!secret) continue;
    let start = value.indexOf(secret);
    while (start !== -1) {
      intervals.push({ start, end: start + secret.length });
      start = value.indexOf(secret, start + 1);
    }
  }
  intervals.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const merged: TextInterval[] = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end)
      previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

function containsCredential(
  value: string,
  secrets: readonly string[],
): boolean {
  return secrets.some((secret) => secret.length > 0 && value.includes(secret));
}

function redactString(
  value: string,
  secrets: readonly string[],
  leftContext = "",
): string {
  const selectedSecrets = secrets.filter((secret) => secret.length > 0);
  const intervals = credentialIntervals(value, selectedSecrets);
  if (intervals.length === 0) return value;
  const sentinel = selectTextSentinel(selectedSecrets);
  if (!sentinel) throw publicFailure();

  const output = redactStringWithSentinel(value, selectedSecrets, sentinel);
  if (containsCredential(output, selectedSecrets)) throw publicFailure();
  if (containsCredential(leftContext + output, selectedSecrets))
    throw publicFailure();
  return output;
}

function redactStringWithSentinel(
  value: string,
  secrets: readonly string[],
  sentinel: string,
): string {
  const intervals = credentialIntervals(value, secrets);
  let cursor = 0;
  let output = "";
  for (const interval of intervals) {
    output += value.slice(cursor, interval.start);
    output += sentinel;
    cursor = interval.end;
  }
  output += value.slice(cursor);
  return output;
}

function redact(
  value: unknown,
  secrets: readonly string[],
  rejectedStreams?: Set<ReadableStream<unknown>>,
): unknown {
  const selectedSecrets = secrets.filter((secret) => secret.length > 0);
  if (value instanceof Error) return publicFailure();
  if (typeof value === "string") return redactString(value, selectedSecrets);
  if (Array.isArray(value))
    return value.map((part) => redact(part, selectedSecrets, rejectedStreams));
  if (value && typeof value === "object") {
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
    if (value instanceof ReadableStream) {
      if (!rejectedStreams) throw publicFailure();
      rejectedStreams.add(value);
      return undefined;
    }
    if (value instanceof Headers) {
      const entries = [...value.entries()];
      const safeNames = new Set(
        entries
          .map(([key]) => key)
          .filter(
            (key) =>
              !selectedSecrets.some((secret) =>
                key.toLowerCase().includes(secret.toLowerCase()),
              ),
          ),
      );
      const emitted = new Set<string>();
      const headers = new Headers();
      for (const [key, part] of entries) {
        const redactedPart = redact(part, selectedSecrets, rejectedStreams);
        if (typeof redactedPart !== "string") throw publicFailure();
        headers.set(
          replacementMetadataKey(
            key,
            selectedSecrets,
            safeNames,
            emitted,
            true,
          ),
          headerSafeRedactedValue(part, redactedPart, selectedSecrets),
        );
      }
      return headers;
    }
    const entries = Object.entries(value);
    const safeNames = new Set(
      entries
        .map(([key]) => key)
        .filter(
          (key) =>
            !selectedSecrets.some((secret) =>
              key.toLowerCase().includes(secret.toLowerCase()),
            ),
        ),
    );
    const emitted = new Set<string>();
    return Object.fromEntries(
      entries.map(([key, part]) => [
        replacementMetadataKey(key, selectedSecrets, safeNames, emitted, false),
        redact(part, selectedSecrets, rejectedStreams),
      ]),
    );
  }
  return value;
}

function snapshotProviderStreamPart(
  value: unknown,
  secrets: readonly string[],
): { type: string; part: Record<string, unknown> } {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw publicFailure();

  let typeDescriptor: PropertyDescriptor | undefined;
  try {
    typeDescriptor = Object.getOwnPropertyDescriptor(value, "type");
  } catch {
    throw publicFailure();
  }
  if (
    !typeDescriptor ||
    !("value" in typeDescriptor) ||
    typeof typeDescriptor.value !== "string" ||
    containsCredential(typeDescriptor.value, secrets)
  )
    throw publicFailure();

  const type = typeDescriptor.value;
  const entries: [string, unknown][] = [];
  let typeIncluded = false;
  try {
    for (const key of Object.keys(value)) {
      if (key === "type") {
        entries.push([key, type]);
        typeIncluded = true;
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) throw publicFailure();
      entries.push([
        key,
        "value" in descriptor ? descriptor.value : Reflect.get(value, key),
      ]);
    }
  } catch {
    throw publicFailure();
  }
  if (!typeIncluded) entries.push(["type", type]);
  return { type, part: Object.fromEntries(entries) };
}

function cancelRejectedStreams(streams: Set<ReadableStream<unknown>>): void {
  for (const stream of streams) {
    try {
      void stream.cancel().catch(() => {
        // Keep provider cancellation details private and continue cleanup.
      });
    } catch {
      // Keep provider cancellation details private and continue cleanup.
    }
  }
  streams.clear();
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

/**
 * Create a governed model whose callers must explicitly set a positive
 * `maxOutputTokens` cap on every generation or stream request. No cap is
 * supplied by default.
 */
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
    secrets: string[];
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

    let generation: number;
    try {
      generation = await deps.getAttemptGeneration(
        context.scope,
        context.runId,
        context.attemptId,
      );
    } catch {
      throw publicFailure();
    }
    const modelRequestId = randomUUID();
    let capability: string | undefined;
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
      const planEndpoint = selectedPlanEndpoint;
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
        model = createPlan(
          { ...selectedPlan, endpoint: new URL(planEndpoint as string) },
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
      return {
        value,
        secrets: [apiKey, selectedPlan?.token ?? ""],
        confirmUsage,
        markUnknown,
      };
    } catch {
      if (capability) {
        try {
          await markUnknown();
        } catch {
          // The claim remains conservatively charged and provider diagnostics stay private.
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
      const { value, secrets, confirmUsage, markUnknown } = await invoke(
        options,
        (model, callOptions) => Promise.resolve(model.doGenerate(callOptions)),
      );
      const result = value as Awaited<
        ReturnType<LanguageModelV3["doGenerate"]>
      >;
      let prepared: typeof result;
      try {
        prepared = redact(result, secrets) as typeof result;
      } catch {
        try {
          await markUnknown();
        } catch {
          // Preserve the generic failure and keep the claim conservatively charged.
        }
        throw publicFailure();
      }
      let used: number | undefined;
      try {
        used = totalUsage(result.usage);
      } catch {
        used = undefined;
      }
      if (used === undefined) {
        try {
          await markUnknown();
        } catch {
          throw publicFailure();
        }
      } else {
        await confirmUsage(used);
      }
      return prepared;
    },
    async doStream(options) {
      const { value, secrets, confirmUsage, markUnknown } = await invoke(
        options,
        (model, callOptions) => Promise.resolve(model.doStream(callOptions)),
      );
      const result = value as Awaited<ReturnType<LanguageModelV3["doStream"]>>;
      let reader: ReadableStreamDefaultReader<StreamPart>;
      try {
        reader = result.stream.getReader();
      } catch {
        try {
          await markUnknown();
        } catch {
          // Keep the provider failure generic and the claim conservatively charged.
        }
        throw publicFailure();
      }
      let finishSeen = false;
      let finishTokens: number | undefined;
      const rejectedNestedStreams = new Set<ReadableStream<unknown>>();
      const streamIds = new Map<string, string>();
      const safeStreamId = (id: string): string => {
        if (!streamIds.has(id)) streamIds.set(id, redactString(id, secrets));
        return streamIds.get(id) as string;
      };
      const redactStreamPart = (part: StreamPart): StreamPart => {
        const sourcePart = part as unknown as Record<string, unknown>;
        const type = sourcePart.type;
        const id = sourcePart.id;
        const value =
          typeof id === "string"
            ? { ...sourcePart, id: safeStreamId(id) }
            : part;
        const sanitized = redact(
          value,
          secrets,
          rejectedNestedStreams,
        ) as StreamPart;
        if (rejectedNestedStreams.size > 0) throw publicFailure();
        // The fixed protocol discriminant must remain usable by stream readers;
        // provider-controlled values, including delta text and IDs, are redacted.
        return { ...sanitized, type } as StreamPart;
      };
      const lookbehind = Math.max(
        0,
        ...secrets
          .filter((secret) => secret.length > 0)
          .map((secret) => secret.length - 1),
      );
      let pendingText = "";
      let pendingTextId = "";
      let pendingTextPart: Record<string, unknown> | undefined;
      let emittedTail = "";
      let flushedSourceTail = "";
      const trackEmittedText = (delta: string) => {
        const combined = emittedTail + delta;
        if (secrets.some((secret) => secret && combined.includes(secret)))
          throw publicFailure();
        emittedTail = lookbehind > 0 ? combined.slice(-lookbehind) : "";
      };
      const flushPendingText = () => {
        if (!pendingText) return;
        flushedSourceTail = pendingText.slice(-lookbehind);
        const delta = redactString(pendingText, secrets, emittedTail);
        trackEmittedText(delta);
        output.push({
          ...pendingTextPart,
          type: "text-delta",
          id: pendingTextId,
          delta,
        } as StreamPart);
        pendingText = "";
        pendingTextId = "";
        pendingTextPart = undefined;
      };
      const output: StreamPart[] = [];
      let safeMetadata: Omit<typeof result, "stream">;
      try {
        const { stream: _providerStream, ...metadata } = result;
        safeMetadata = redact(
          metadata,
          secrets,
          rejectedNestedStreams,
        ) as typeof metadata;
        if (rejectedNestedStreams.size > 0) throw publicFailure();
      } catch {
        cancelRejectedStreams(rejectedNestedStreams);
        try {
          void reader.cancel().catch(() => {
            // Keep provider cancellation details private.
          });
        } catch {
          // Keep provider cancellation details private.
        }
        try {
          await markUnknown();
        } catch {
          // The maximum remains conservatively charged.
        }
        throw publicFailure();
      }
      const stream = new ReadableStream<StreamPart>({
        async pull(controller) {
          try {
            while (output.length === 0) {
              const next = await reader.read();
              if (next.done) {
                pendingText = "";
                pendingTextPart = undefined;
                if (!finishSeen) {
                  await markUnknown();
                  controller.error(publicFailure());
                  return;
                }
                if (finishTokens === undefined) await markUnknown();
                else await confirmUsage(finishTokens);
                controller.close();
                return;
              }
              const { type: partType, part } = snapshotProviderStreamPart(
                next.value,
                secrets,
              );
              if (partType === "finish") {
                if (finishSeen) throw publicFailure();
                finishSeen = true;
                const used = totalUsage(part.usage);
                const finishPart = redactStreamPart(part as StreamPart);
                flushPendingText();
                finishTokens = used;
                if (used === undefined) await markUnknown();
                else await confirmUsage(used);
                output.push(finishPart);
                continue;
              }
              if (finishSeen) throw publicFailure();
              if (partType === "text-delta") {
                const { delta: sourceDelta, ...sourceFields } = part;
                if (
                  flushedSourceTail.length > 0 &&
                  containsCredential(flushedSourceTail + sourceDelta, secrets)
                )
                  throw publicFailure();
                flushedSourceTail = "";
                if (typeof sourceFields.id === "string")
                  sourceFields.id = safeStreamId(sourceFields.id);
                const safeSourceFields = redact(
                  sourceFields,
                  secrets,
                  rejectedNestedStreams,
                ) as Record<string, unknown>;
                if (rejectedNestedStreams.size > 0) throw publicFailure();
                const safePart = {
                  ...safeSourceFields,
                  type: partType,
                  delta: sourceDelta,
                } as Extract<StreamPart, { type: "text-delta" }>;
                const safeId = safePart.id;
                // Keep this buffer in original source coordinates. Masking may
                // change its length, so source offsets must never slice output.
                const delta = pendingText + safePart.delta;
                const safePartFields = safePart as unknown as Record<
                  string,
                  unknown
                >;
                let safeLength = Math.max(0, delta.length - lookbehind);
                for (const interval of credentialIntervals(delta, secrets)) {
                  if (
                    interval.start < safeLength &&
                    interval.end > safeLength
                  ) {
                    safeLength = interval.start;
                    break;
                  }
                }
                if (safeLength === 0 && containsCredential(delta, secrets))
                  redactString(delta, secrets, emittedTail);
                if (safeLength > 0) {
                  const safeDelta = redactString(
                    delta.slice(0, safeLength),
                    secrets,
                    emittedTail,
                  );
                  trackEmittedText(safeDelta);
                  output.push({
                    ...pendingTextPart,
                    ...safePart,
                    id: pendingText ? pendingTextId : safeId,
                    delta: safeDelta,
                  } as StreamPart);
                }
                pendingText = delta.slice(safeLength);
                if (pendingText) {
                  pendingTextId ||= safeId;
                  if (!pendingTextId) pendingTextId = safeId;
                  pendingTextPart = {
                    ...pendingTextPart,
                    ...safePartFields,
                    id: pendingTextId,
                    delta: pendingText,
                  };
                } else {
                  pendingTextId = "";
                  pendingTextPart = undefined;
                }
                continue;
              }
              flushPendingText();
              output.push(redactStreamPart(part as StreamPart));
            }
            controller.enqueue(output.shift() as StreamPart);
          } catch {
            pendingText = "";
            output.length = 0;
            cancelRejectedStreams(rejectedNestedStreams);
            try {
              void reader.cancel().catch(() => {
                // Keep provider cancellation details private.
              });
            } catch {
              // Keep provider cancellation details private.
            }
            try {
              await markUnknown();
            } catch {
              /* Preserve only the safe public error. */
            }
            controller.error(publicFailure());
          }
        },
        async cancel(reason) {
          pendingText = "";
          output.length = 0;
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
      return { ...safeMetadata, stream };
    },
  };
}
