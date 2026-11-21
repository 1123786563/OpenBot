import type { z } from "zod";
import type { configuration } from "../../src/admin/bifrost-catalog";

type Route = z.infer<typeof configuration>["routes"][string];

export function fixtureTraceReport(
  harnessImage: string,
  route: Route & { revision: string },
) {
  const { provider, model, gatewayRevision, meteringRevision } = route;
  const target = { provider, model };
  const meter = (
    requestId: string,
    requestSha256: string,
    inputTokenUpperBound: number,
  ) => ({
    requestId,
    requestSha256,
    inputTokenUpperBound,
    gatewayRevision,
    meteringRevision,
  });

  function completed(runId = crypto.randomUUID()) {
    const requestId = crypto.randomUUID();
    const requestSha256 = Bun.CryptoHasher.hash("sha256", requestId, "hex");
    const usage = { inputTokens: 1, outputTokens: 2 };
    return {
      requestSha256,
      meter: meter(requestId, requestSha256, route.maxInputTokens),
      gateway: {
        ...target,
        requestId,
        runId,
        retryCount: 0,
        fallbackIndex: 0,
        fallbackCount: 0,
        usage: { ...usage },
      },
      upstream: {
        ...target,
        requestId: crypto.randomUUID(),
        gatewayRequestId: requestId,
        outputCap: route.maxOutputTokens,
        usage: { ...usage },
      },
    };
  }

  function interrupted() {
    const sample = completed();
    const { usage: _gatewayUsage, ...gateway } = sample.gateway;
    const { usage: _providerUsage, ...upstream } = sample.upstream;
    return { ...sample, gateway, upstream };
  }

  const cancellation = interrupted();
  const outputLimit = completed();
  const failure = interrupted();
  const rejected = completed();
  const toolRunId = crypto.randomUUID();
  return {
    version: 2,
    revision: route.revision,
    harnessImage,
    ...target,
    gatewayRevision,
    meteringRevision,
    source: "live-provider",
    artifactDigest: `sha256:${"c".repeat(64)}`,
    gatewayImageDigest: `sha256:${"d".repeat(64)}`,
    stream: { ...completed(), outputChunks: 2 },
    cancellation: {
      ...cancellation,
      outputChunks: 1,
      clientAbortedAt: "2026-01-01T01:00:00Z",
      upstream: {
        ...cancellation.upstream,
        terminatedAt: "2026-01-01T01:00:01Z",
        outcome: "cancelled",
      },
    },
    inputLimit: {
      requestId: rejected.gateway.requestId,
      runId: rejected.gateway.runId,
      requestSha256: rejected.requestSha256,
      meter: meter(
        rejected.gateway.requestId,
        rejected.requestSha256,
        route.maxInputTokens + 1,
      ),
      gatewayRequests: 0,
      upstreamAttempts: 0,
    },
    outputLimit: {
      ...outputLimit,
      upstream: { ...outputLimit.upstream, stopReason: "length" },
    },
    failure: {
      ...failure,
      upstream: { ...failure.upstream, outcome: "failed" },
    },
    ...(route.tools && {
      tool: {
        invocation: { ...completed(toolRunId), toolCallId: "fixture-call" },
        result: { ...completed(toolRunId), toolResultFor: "fixture-call" },
      },
    }),
  };
}

export function fixtureEmbeddingReport(
  harnessImage: string,
  route: Route & { revision: string },
) {
  const trace = fixtureTraceReport(harnessImage, route);
  const { provider, model, gatewayRevision, meteringRevision } = route;
  const { requestSha256, meter, gateway, upstream } = trace.stream;
  const { usage: _usage, ...gatewayTrace } = gateway;
  const inputTokens = Math.min(10, route.maxInputTokens);
  return {
    version: 3,
    source: "live-provider",
    revision: route.revision,
    harnessImage,
    provider,
    model,
    gatewayRevision,
    meteringRevision,
    artifactDigest: trace.artifactDigest,
    gatewayImageDigest: trace.gatewayImageDigest,
    completed: {
      requestSha256,
      meter,
      gateway: { ...gatewayTrace, inputTokens, vectors: 2 },
      upstream: {
        requestId: upstream.requestId,
        gatewayRequestId: upstream.gatewayRequestId,
        provider,
        model,
        inputTokens,
      },
    },
    inputLimit: trace.inputLimit,
  };
}
