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
  provider: id,
  model: reference,
  gatewayRevision: reference,
  meteringRevision: reference,
  maxInputTokens: tokens,
  maxOutputTokens: tokens,
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
    return (
      entries.length <= 2 &&
      new Set(entries.map(({ provider }) => provider)).size ===
        entries.length &&
      new Set(entries.map(({ model }) => model)).size === entries.length
    );
  }, "The pilot supports two distinct models on distinct providers.");

const evidence = z.strictObject({
  revision: z.uuid(),
  harnessImage: harness,
  provider: id,
  model: reference,
  gatewayRevision: reference,
  meteringRevision: reference,
  source: z.literal("live-provider"),
  artifactDigest: sha256,
  gatewayImageDigest: sha256,
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

const configuredRoute = route.extend({
  revision: z.uuid(),
  verification: z
    .strictObject({
      report: evidence,
      by: z.string(),
      at: z.iso.datetime(),
    })
    .optional(),
});
const releasedRoute = configuredRoute
  .required({ verification: true })
  .extend({ id, maxChargeMicrocredits: z.string().regex(/^\d+$/) });
export const releaseSchema = z.strictObject({
  id: z.uuid(),
  by: z.string(),
  at: z.iso.datetime(),
  harnessImage: harness,
  defaultRoute: id,
  routes: z.array(releasedRoute).min(1).max(2),
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

export function verify(
  current: Catalog,
  id: string,
  input: unknown,
  by: string,
): Catalog {
  const entry = Object.hasOwn(current.routes, id)
    ? current.routes[id]
    : undefined;
  const parsed = evidence.safeParse(input);
  if (!entry || !parsed.success)
    throw new CatalogConflict("Missing valid live-provider evidence.");
  const report = parsed.data;
  const requests = [
    report.stream.requestId,
    report.cancellation.requestId,
    report.limits.requestId,
    report.limits.rejectedRequestId,
  ];
  if (report.tool) requests.push(report.tool.requestId);
  if (
    report.revision !== entry.revision ||
    report.harnessImage !== current.harnessImage ||
    report.provider !== entry.provider ||
    report.model !== entry.model ||
    report.gatewayRevision !== entry.gatewayRevision ||
    report.meteringRevision !== entry.meteringRevision ||
    report.limits.inputCap !== entry.maxInputTokens ||
    report.limits.outputCap !== entry.maxOutputTokens ||
    report.stream.inputTokens > entry.maxInputTokens ||
    report.stream.outputTokens > entry.maxOutputTokens ||
    (entry.tools && !report.tool) ||
    new Set(requests).size !== requests.length
  ) {
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
    routes: z.array(id).min(1).max(2),
    defaultRoute: id,
  })
  .refine(
    ({ routes, defaultRoute }) =>
      new Set(routes).size === routes.length && routes.includes(defaultRoute),
  );

export function publish(
  current: Catalog,
  ids: string[],
  defaultRoute: string,
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
    if (!entry?.verification)
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
    ({ id, revision }) =>
      Object.hasOwn(current.routes, id) &&
      current.routes[id]?.revision === revision,
  );
  const defaultRoute = current.publication?.defaultRoute;
  return {
    harnessImage: current.harnessImage,
    priceVersion: current.publication?.id ?? null,
    options,
    defaultRoute: options.some(({ id }) => id === defaultRoute)
      ? defaultRoute
      : null,
  };
}
