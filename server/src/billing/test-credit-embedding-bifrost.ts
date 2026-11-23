import { createHash } from "node:crypto";
import { z } from "zod";
import type { ReleasedBifrostRoute } from "../admin/bifrost-catalog";
import { measureInput } from "./input-meter";
import { UnsentBifrostRequest } from "./test-credit-bifrost";

const tokens = z.number().int().positive();
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/);
const batch = z.array(z.string().min(1)).min(1);
const terminal = z.object({
  object: z.literal("list"),
  model: identity,
  usage: z.object({
    prompt_tokens: tokens,
    total_tokens: tokens,
    completion_tokens: z.literal(0).optional(),
  }),
  data: z.unknown(),
});
const embeddings = z.array(
  z.object({
    index: z.number().int().nonnegative(),
    embedding: z.array(z.number()).min(1),
  }),
);

function checkedEndpoint(endpoint: URL) {
  const url = new URL(endpoint);
  const loopback =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !loopback) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid Test Credit embedding endpoint.");
  }
  return url;
}

function requestUuid(
  scope: string,
  operationId: string,
  revision: string,
  digest: string,
) {
  // UUIDv8 with the first 122 usable bits of the request identity hash.
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        "weknora-embedding",
        scope,
        operationId,
        revision,
        digest,
      ]),
    )
    .digest("hex");
  const variant = ((Number.parseInt(hash.slice(16, 17), 16) & 3) | 8).toString(
    16,
  );
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export type BifrostEmbeddingDispatchProof = {
  requestId: string;
  requestSha256: string;
  inputTokenUpperBound: number;
};

export function createBifrostEmbeddingExecutor({
  endpoint,
  meterEndpoint,
  gatewayRevision,
  meteringRevision,
  gatewayImageDigest,
  gatewayToken,
  meterToken,
}: {
  endpoint: URL;
  meterEndpoint: URL;
  gatewayRevision: string;
  meteringRevision: string;
  gatewayImageDigest: string;
  gatewayToken: string;
  meterToken: string;
}) {
  const gateway = checkedEndpoint(endpoint);
  const meter = checkedEndpoint(meterEndpoint);
  if (!gateway.pathname.endsWith("/embeddings")) {
    throw new Error(
      "The Test Credit gateway must use the embeddings endpoint.",
    );
  }

  return async ({
    route,
    input,
    operationId,
    authorizationId,
    beforeDispatch,
    signal,
  }: {
    route: ReleasedBifrostRoute;
    input: readonly string[];
    operationId: string;
    authorizationId: string;
    beforeDispatch(proof: BifrostEmbeddingDispatchProof): Promise<boolean>;
    signal?: AbortSignal;
  }) => {
    const { report } = route.verification;
    if (
      signal?.aborted ||
      route.purpose !== "embedding" ||
      route.maxOutputTokens !== 0 ||
      route.price.outputPerMillion !== 0 ||
      route.tools ||
      !("version" in report) ||
      report.version !== 3 ||
      !("completed" in report) ||
      report.revision !== route.revision ||
      report.provider !== route.provider ||
      report.model !== route.model ||
      report.gatewayRevision !== gatewayRevision ||
      route.gatewayRevision !== gatewayRevision ||
      report.meteringRevision !== meteringRevision ||
      route.meteringRevision !== meteringRevision ||
      report.gatewayImageDigest !== gatewayImageDigest ||
      !identity.safeParse(operationId).success
    ) {
      throw new UnsentBifrostRequest("route_unavailable");
    }

    const parsedInput = batch.safeParse(input);
    if (!parsedInput.success) {
      throw new UnsentBifrostRequest("execution_limit");
    }
    const { model, maxInputTokens } = route;
    const qualifiedModel = `${route.provider}/${model}`;
    const body = JSON.stringify({
      model: qualifiedModel,
      input: parsedInput.data,
      encoding_format: "float",
    });
    const requestSha256 = createHash("sha256").update(body).digest("hex");
    const requestId = requestUuid(
      authorizationId,
      operationId,
      route.revision,
      requestSha256,
    );
    const requestHeaders = {
      "content-type": "application/json",
      "x-request-id": requestId,
      "x-openbot-operation-id": operationId,
    };

    const meterTimeout = AbortSignal.timeout(5_000);
    const inputTokenUpperBound = await measureInput({
      endpoint: meter,
      token: meterToken,
      request: { body, operationId, requestId, digest: requestSha256 },
      revision: { gatewayRevision, meteringRevision },
      signal: signal ? AbortSignal.any([signal, meterTimeout]) : meterTimeout,
    });
    if (inputTokenUpperBound === 0)
      throw new UnsentBifrostRequest("route_unavailable");
    if (inputTokenUpperBound > maxInputTokens) {
      throw new UnsentBifrostRequest("execution_limit");
    }

    const accepted = await beforeDispatch({
      requestId,
      requestSha256,
      inputTokenUpperBound,
    });
    if (!accepted || signal?.aborted) {
      throw new UnsentBifrostRequest("route_unavailable");
    }

    // The verified gateway revision disables retries, fallbacks and model overrides.
    const gatewayTimeout = AbortSignal.timeout(85_000);
    const response = await fetch(gateway, {
      method: "POST",
      redirect: "error",
      keepalive: false,
      signal: signal
        ? AbortSignal.any([signal, gatewayTimeout])
        : gatewayTimeout,
      headers: {
        ...requestHeaders,
        authorization: `Bearer ${gatewayToken}`,
        "x-bf-lh-openbot-operation-id": operationId,
        "x-bf-lh-openbot-request-sha256": requestSha256,
      },
      body,
    });
    if (!response.ok) throw new Error("Test Credit embedding gateway failed.");

    const result = terminal.safeParse(await response.json());
    if (
      !result.success ||
      (result.data.model !== model && result.data.model !== qualifiedModel) ||
      result.data.usage.prompt_tokens !== result.data.usage.total_tokens ||
      result.data.usage.prompt_tokens > inputTokenUpperBound
    ) {
      throw new Error("Test Credit embedding terminal usage is invalid.");
    }

    const usage = {
      inputTokens: result.data.usage.prompt_tokens,
      outputTokens: 0,
    } as const;
    const data = embeddings.safeParse(result.data.data);
    if (data.success && data.data.length === parsedInput.data.length) {
      const ordered = data.data.sort((left, right) => left.index - right.index);
      if (
        ordered.every(
          ({ index, embedding }, position) =>
            index === position &&
            embedding.length === ordered[0]?.embedding.length,
        )
      ) {
        return {
          outcome: "complete" as const,
          vectors: ordered.map(({ embedding }) => embedding),
          usage,
        };
      }
    }
    return { outcome: "partial" as const, usage };
  };
}
