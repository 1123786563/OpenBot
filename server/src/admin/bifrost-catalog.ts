import { randomUUID } from "node:crypto";
import { z } from "zod";

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/);
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const tokens = z.number().int().positive().max(10_000_000);
const price = z.strictObject({
  inputPerMillion: z.number().int().nonnegative().max(1_000_000_000_000),
  outputPerMillion: z.number().int().nonnegative().max(1_000_000_000_000),
});
const route = z.strictObject({
  purpose: z.enum(["embedding", "rerank"]).optional(),
  provider: id,
  model: reference,
  gatewayRevision: reference,
  meteringRevision: reference,
  maxInputTokens: tokens,
  maxOutputTokens: z.number().int().nonnegative().max(10_000_000),
  tools: z.boolean(),
  price,
});
const harness = z
  .string()
  .regex(
    /^(?:[a-z0-9.-]+(?::[0-9]+)?\/)?(?:[a-z0-9._-]+\/)*(?:openbot-)?agent-langgraph-agui@sha256:[a-f0-9]{64}$/,
  );
const routes = z.record(id, route);
export const configuration = z
  .strictObject({ harnessImage: harness, routes })
  .refine(({ routes }) => {
    const entries = Object.values(routes);
    const chat = entries.filter(({ purpose }) => purpose === undefined);
    return (
      chat.length <= 2 &&
      entries.filter(({ purpose }) => purpose === "embedding").length <= 1 &&
      entries.filter(({ purpose }) => purpose === "rerank").length <= 1 &&
      entries.every((entry) =>
        entry.purpose !== undefined
          ? entry.maxOutputTokens === 0 &&
            entry.price.outputPerMillion === 0 &&
            !entry.tools
          : entry.maxOutputTokens > 0,
      ) &&
      new Set(chat.map(({ provider }) => provider)).size === chat.length &&
      new Set(chat.map(({ model }) => model)).size === chat.length
    );
  }, "The pilot supports two chat models on distinct providers one embedding route, and one rerank route.");

const evidenceIdentity = z.strictObject({
  revision: z.uuid(),
  harnessImage: harness,
  provider: id,
  model: reference,
  gatewayRevision: reference,
  meteringRevision: reference,
  source: z.literal("live-provider"),
  artifactDigest: sha256,
  gatewayImageDigest: sha256,
});

// Keep historical Price Versions readable after changing qualification.
const legacyEvidence = evidenceIdentity.extend({
  retryCount: z.literal(0),
  fallbacks: z.tuple([]),
  stream: z.strictObject({
    requestId: reference,
    outputChunks: z.number().int().min(2),
    upstreamRequestId: reference,
    inputTokens: tokens,
    outputTokens: tokens,
  }),
  cancellation: z.strictObject({
    requestId: reference,
    upstreamRequestId: reference,
    upstreamOutcome: z.literal("cancelled"),
  }),
  limits: z.strictObject({
    requestId: reference,
    rejectedRequestId: reference,
    upstreamRequestId: reference,
    inputCap: tokens,
    outputCap: tokens,
    oversizedInput: z.literal("rejected-before-upstream"),
    outputStop: z.literal("length"),
  }),
  tool: z
    .strictObject({
      requestId: reference,
      upstreamRequestId: reference,
      outcome: z.literal("structured-call-and-result"),
    })
    .optional(),
});

const traceUuid = z.uuid().toLowerCase();
const meterProof = z.strictObject({
  requestId: traceUuid,
  gatewayRevision: reference,
  meteringRevision: reference,
  requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  inputTokenUpperBound: z.number().int().nonnegative(),
});
const usage = z.strictObject({
  inputTokens: tokens,
  outputTokens: z.number().int().nonnegative().max(10_000_000),
});
const providerTrace = z.strictObject({
  requestId: reference,
  gatewayRequestId: traceUuid,
  provider: id,
  model: reference,
  outputCap: tokens,
});
const gatewayTrace = z.strictObject({
  requestId: traceUuid,
  runId: traceUuid,
  provider: id,
  model: reference,
  retryCount: z.literal(0),
  fallbackIndex: z.literal(0),
  fallbackCount: z.literal(0),
});
const step = z.strictObject({
  requestSha256: meterProof.shape.requestSha256,
  meter: meterProof,
  gateway: gatewayTrace,
  upstream: providerTrace,
});
const completedStep = step.extend({
  gateway: gatewayTrace.extend({ usage }),
  upstream: providerTrace.extend({ usage }),
});
const traceEvidenceV2 = evidenceIdentity.extend({
  version: z.literal(2),
  stream: completedStep.extend({
    outputChunks: z.number().int().min(2),
  }),
  cancellation: step.extend({
    outputChunks: z.number().int().min(1),
    clientAbortedAt: z.iso.datetime(),
    upstream: providerTrace.extend({
      outcome: z.literal("cancelled"),
      terminatedAt: z.iso.datetime(),
    }),
  }),
  inputLimit: z.strictObject({
    requestId: traceUuid,
    runId: traceUuid,
    requestSha256: meterProof.shape.requestSha256,
    meter: meterProof,
    gatewayRequests: z.literal(0),
    upstreamAttempts: z.literal(0),
  }),
  outputLimit: completedStep.extend({
    upstream: completedStep.shape.upstream.extend({
      stopReason: z.literal("length"),
    }),
  }),
  failure: step.extend({
    upstream: providerTrace.extend({ outcome: z.literal("failed") }),
  }),
  tool: z
    .strictObject({
      invocation: completedStep.extend({ toolCallId: reference }),
      result: completedStep.extend({ toolResultFor: reference }),
    })
    .optional(),
});

export const providerCancellationRecord = z.strictObject({
  requestId: reference,
  outcome: z.literal("cancelled"),
  terminatedAt: z.iso.datetime(),
});

export const qualificationReport = traceEvidenceV2.extend({
  version: z.literal(3),
  cancellation: traceEvidenceV2.shape.cancellation.extend({
    upstream: providerTrace.extend({
      terminal: providerCancellationRecord.extend({
        source: z.literal("provider-record"),
        recordRef: reference,
        recordDigest: sha256,
      }),
    }),
  }),
});

export const embeddingEvidence = evidenceIdentity.extend({
  version: z.literal(3),
  completed: z.strictObject({
    requestSha256: meterProof.shape.requestSha256,
    meter: meterProof,
    gateway: gatewayTrace.extend({
      inputTokens: tokens,
      vectors: z.number().int().positive(),
    }),
    upstream: providerTrace.omit({ outputCap: true }).extend({
      inputTokens: tokens,
    }),
  }),
  inputLimit: traceEvidenceV2.shape.inputLimit,
});

export const rerankEvidence = embeddingEvidence.extend({
  kind: z.literal("rerank"),
  completed: embeddingEvidence.shape.completed.extend({
    gateway: embeddingEvidence.shape.completed.shape.gateway
      .omit({ vectors: true })
      .extend({ scores: z.number().int().positive() }),
  }),
});

const configuredRoute = route.extend({
  revision: z.uuid(),
  verification: z
    .strictObject({
      report: z.union([
        qualificationReport,
        embeddingEvidence,
        rerankEvidence,
        traceEvidenceV2,
        legacyEvidence,
      ]),
      by: z.string(),
      at: z.iso.datetime(),
    })
    .optional(),
});
const releasedRoute = configuredRoute
  .required({ verification: true })
  .extend({ id, maxChargeMicrocredits: z.string().regex(/^\d+$/) });
export type ReleasedBifrostRoute = z.infer<typeof releasedRoute>;
export const pilotCatalogKey = "bifrost_pilot_catalog";
export const releaseSchema = z.strictObject({
  id: z.uuid(),
  by: z.string(),
  at: z.iso.datetime(),
  harnessImage: harness,
  defaultRoute: id.nullable(),
  routes: z.array(releasedRoute).min(1).max(4),
});
export const catalogSchema = z.strictObject({
  harnessImage: harness.nullable(),
  routes: z.record(id, configuredRoute),
  publication: releaseSchema.nullable(),
});
type Catalog = z.infer<typeof catalogSchema>;
type Configuration = z.infer<typeof configuration>;
export const emptyCatalog: Catalog = {
  harnessImage: null,
  routes: {},
  publication: null,
};

export class CatalogConflict extends Error {}

export function configure(current: Catalog, input: Configuration): Catalog {
  const proposed = configuration.parse(input);
  const nextRoutes = Object.fromEntries(
    Object.entries(proposed.routes).map(([id, entry]) => {
      const previous = Object.hasOwn(current.routes, id)
        ? current.routes[id]
        : undefined;
      const { price: _price, ...compatibility } = entry;
      const unchanged =
        current.harnessImage === proposed.harnessImage &&
        previous &&
        Object.entries(compatibility).every(([key, value]) =>
          Object.entries(previous).some(
            ([previousKey, previousValue]) =>
              previousKey === key && previousValue === value,
          ),
        );
      return [
        id,
        unchanged
          ? { ...previous, price: entry.price }
          : { ...entry, revision: randomUUID() },
      ];
    }),
  );
  return {
    ...current,
    harnessImage: proposed.harnessImage,
    routes: nextRoutes,
  };
}

type TraceEvidence = z.infer<typeof qualificationReport>;
type ConfiguredRoute = z.infer<typeof configuredRoute>;

function matchesTrace(
  report: TraceEvidence,
  entry: ConfiguredRoute,
  harnessImage: Catalog["harnessImage"],
) {
  const { stream, cancellation, inputLimit, outputLimit, failure, tool } =
    report;
  const completed = tool
    ? [stream, outputLimit, tool.invocation, tool.result]
    : [stream, outputLimit];
  const steps = [...completed, cancellation, failure];
  const runIds = [
    stream.gateway.runId,
    cancellation.gateway.runId,
    inputLimit.runId,
    outputLimit.gateway.runId,
    failure.gateway.runId,
    ...(tool ? [tool.invocation.gateway.runId] : []),
  ];
  const gatewayIds = [
    ...steps.map(({ gateway }) => gateway.requestId),
    inputLimit.requestId,
  ];
  const upstreamIds = steps.map(({ upstream }) => upstream.requestId);
  const matchesMeter = (
    {
      meter,
      requestSha256,
    }: Pick<z.infer<typeof step>, "meter" | "requestSha256">,
    requestId: string,
  ) =>
    meter.requestId === requestId &&
    meter.requestSha256 === requestSha256 &&
    meter.gatewayRevision === entry.gatewayRevision &&
    meter.meteringRevision === entry.meteringRevision;

  return (
    entry.purpose === undefined &&
    report.revision === entry.revision &&
    report.harnessImage === harnessImage &&
    report.provider === entry.provider &&
    report.model === entry.model &&
    report.gatewayRevision === entry.gatewayRevision &&
    report.meteringRevision === entry.meteringRevision &&
    Boolean(tool) === entry.tools &&
    (!tool ||
      (tool.invocation.gateway.runId === tool.result.gateway.runId &&
        tool.invocation.toolCallId === tool.result.toolResultFor)) &&
    cancellation.upstream.terminal.requestId ===
      cancellation.upstream.requestId &&
    Date.parse(cancellation.upstream.terminal.terminatedAt) >=
      Date.parse(cancellation.clientAbortedAt) &&
    matchesMeter(inputLimit, inputLimit.requestId) &&
    inputLimit.meter.inputTokenUpperBound > entry.maxInputTokens &&
    new Set(runIds).size === runIds.length &&
    new Set(gatewayIds).size === gatewayIds.length &&
    new Set(upstreamIds).size === upstreamIds.length &&
    steps.every(
      (sample) =>
        matchesMeter(sample, sample.gateway.requestId) &&
        sample.meter.inputTokenUpperBound <= entry.maxInputTokens &&
        sample.gateway.provider === entry.provider &&
        sample.gateway.model === entry.model &&
        sample.upstream.gatewayRequestId === sample.gateway.requestId &&
        sample.upstream.provider === entry.provider &&
        sample.upstream.model === entry.model &&
        sample.upstream.outputCap === entry.maxOutputTokens,
    ) &&
    completed.every(
      ({ meter, gateway, upstream }) =>
        gateway.usage.inputTokens === upstream.usage.inputTokens &&
        gateway.usage.outputTokens === upstream.usage.outputTokens &&
        upstream.usage.inputTokens <= meter.inputTokenUpperBound &&
        upstream.usage.outputTokens <= upstream.outputCap,
    ) &&
    stream.upstream.usage.outputTokens > 0 &&
    outputLimit.upstream.usage.outputTokens > 0
  );
}

function matchesInputOnly(
  report: z.infer<typeof embeddingEvidence> | z.infer<typeof rerankEvidence>,
  entry: ConfiguredRoute,
  harnessImage: Catalog["harnessImage"],
) {
  const { completed, inputLimit } = report;
  const { gateway, meter, upstream } = completed;
  return (
    entry.purpose === ("kind" in report ? "rerank" : "embedding") &&
    entry.maxOutputTokens === 0 &&
    entry.price.outputPerMillion === 0 &&
    !entry.tools &&
    report.revision === entry.revision &&
    report.harnessImage === harnessImage &&
    report.provider === entry.provider &&
    report.model === entry.model &&
    report.gatewayRevision === entry.gatewayRevision &&
    report.meteringRevision === entry.meteringRevision &&
    gateway.provider === entry.provider &&
    gateway.model === entry.model &&
    upstream.provider === entry.provider &&
    upstream.model === entry.model &&
    upstream.gatewayRequestId === gateway.requestId &&
    gateway.requestId !== inputLimit.requestId &&
    gateway.runId !== inputLimit.runId &&
    meter.requestId === gateway.requestId &&
    meter.requestSha256 === completed.requestSha256 &&
    inputLimit.meter.requestId === inputLimit.requestId &&
    inputLimit.meter.requestSha256 === inputLimit.requestSha256 &&
    [meter, inputLimit.meter].every(
      (proof) =>
        proof.gatewayRevision === entry.gatewayRevision &&
        proof.meteringRevision === entry.meteringRevision,
    ) &&
    upstream.inputTokens === gateway.inputTokens &&
    gateway.inputTokens <= meter.inputTokenUpperBound &&
    meter.inputTokenUpperBound <= entry.maxInputTokens &&
    inputLimit.meter.inputTokenUpperBound > entry.maxInputTokens
  );
}

const currentEvidence = z.union([
  qualificationReport,
  embeddingEvidence,
  rerankEvidence,
]);

function matchesEvidence(
  report: z.infer<typeof currentEvidence>,
  entry: ConfiguredRoute,
  harnessImage: Catalog["harnessImage"],
) {
  return "completed" in report
    ? matchesInputOnly(report, entry, harnessImage)
    : matchesTrace(report, entry, harnessImage);
}

export function verify(
  current: Catalog,
  id: string,
  input: unknown,
  by: string,
): Catalog {
  const entry = Object.hasOwn(current.routes, id)
    ? current.routes[id]
    : undefined;
  const parsed = currentEvidence.safeParse(input);
  if (!entry || !parsed.success)
    throw new CatalogConflict("Missing valid live-provider evidence.");
  const report = parsed.data;
  if (!matchesEvidence(report, entry, current.harnessImage)) {
    throw new CatalogConflict(
      "Live-provider evidence does not match the configured route and capabilities.",
    );
  }
  return {
    ...current,
    routes: {
      ...current.routes,
      [id]: {
        ...entry,
        verification: { report, by, at: new Date().toISOString() },
      },
    },
  };
}

export const publication = z
  .strictObject({
    routes: z.array(id).min(1).max(4),
    defaultRoute: id.nullable(),
  })
  .refine(
    ({ routes, defaultRoute }) =>
      new Set(routes).size === routes.length &&
      (defaultRoute === null || routes.includes(defaultRoute)),
  );

export function publish(
  current: Catalog,
  ids: string[],
  defaultRoute: string | null,
  by: string,
) {
  if (
    !current.harnessImage ||
    !publication.safeParse({ routes: ids, defaultRoute }).success
  ) {
    throw new CatalogConflict(
      "Choose distinct routes and a default from those routes.",
    );
  }
  const routes = ids.map((id) => {
    const entry = Object.hasOwn(current.routes, id)
      ? current.routes[id]
      : undefined;
    if (!entry)
      throw new CatalogConflict("Each published route requires verification.");
    const million = 1_000_000n;
    const scaledCharge =
      BigInt(entry.maxInputTokens) * BigInt(entry.price.inputPerMillion) +
      BigInt(entry.maxOutputTokens) * BigInt(entry.price.outputPerMillion);
    const maxChargeMicrocredits = (
      (scaledCharge + million - 1n) /
      million
    ).toString();
    return {
      ...entry,
      id,
      maxChargeMicrocredits,
      verification: entry.verification,
    };
  });
  const chat = routes.filter(({ purpose }) => purpose === undefined);
  if (
    chat.length > 0
      ? !chat.some(({ id }) => id === defaultRoute)
      : defaultRoute !== null
  )
    throw new CatalogConflict(
      "Choose a chat default when publishing chat routes.",
    );
  const release = {
    id: randomUUID(),
    by,
    at: new Date().toISOString(),
    harnessImage: current.harnessImage,
    defaultRoute,
    routes,
  };
  return { release, catalog: { ...current, publication: release } };
}

export function view(current: Catalog) {
  const options = (current.publication?.routes ?? []).filter(
    (option) =>
      Object.hasOwn(current.routes, option.id) &&
      current.routes[option.id]?.revision === option.revision &&
      "version" in option.verification.report &&
      option.verification.report.version === 3 &&
      matchesEvidence(option.verification.report, option, current.harnessImage),
  );
  const defaultRoute = current.publication?.defaultRoute;
  return {
    harnessImage: current.harnessImage,
    priceVersion: current.publication?.id ?? null,
    options,
    defaultRoute: options.some(
      ({ id, purpose }) => id === defaultRoute && purpose === undefined,
    )
      ? defaultRoute
      : null,
  };
}
