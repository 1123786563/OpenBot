import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  configure,
  emptyCatalog,
  publish,
  verify,
} from "../src/admin/bifrost-catalog";
import { createBifrostEmbeddingExecutor } from "../src/billing/test-credit-embedding-bifrost";
import { fixtureEmbeddingReport } from "./support/bifrost-evidence";

const harnessImage = `agent-langgraph-agui@sha256:${"a".repeat(64)}`;
const routeConfiguration = {
  purpose: "embedding" as const,
  provider: "zhipu",
  model: "embedding-3",
  gatewayRevision: "gateway-r1",
  meteringRevision: "meter-r1",
  maxInputTokens: 100,
  maxOutputTokens: 0,
  tools: false,
  price: { inputPerMillion: 10_000, outputPerMillion: 0 },
};
const initial = configure(emptyCatalog, {
  harnessImage,
  routes: { embedding: routeConfiguration },
});
const report = fixtureEmbeddingReport(harnessImage, initial.routes.embedding!);
const verified = verify(initial, "embedding", report, "operator");
const route = publish(verified, ["embedding"], null, "operator").release
  .routes[0]!;

function startFixture({
  meterOverride = {},
  gatewayOverride = {},
}: {
  meterOverride?: Record<string, unknown>;
  gatewayOverride?: Record<string, unknown>;
} = {}) {
  const calls: { path: string; id: string | null; body: string }[] = [];
  const steps: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const id = req.headers.get("x-request-id");
      const body = await req.text();
      const digest = createHash("sha256").update(body).digest("hex");
      calls.push({ path, id, body });
      steps.push(path);
      if (path === "/meter") {
        expect(req.headers.get("authorization")).toBe("Bearer meter-token");
        expect(req.headers.get("x-openbot-bifrost-gateway-revision")).toBe(
          route.gatewayRevision,
        );
        expect(req.headers.get("x-openbot-bifrost-metering-revision")).toBe(
          route.meteringRevision,
        );
        return Response.json({
          requestId: id,
          requestSha256: digest,
          gatewayRevision: route.gatewayRevision,
          meteringRevision: route.meteringRevision,
          inputTokenUpperBound: 30,
          ...meterOverride,
        });
      }
      expect(req.headers.get("authorization")).toBe("Bearer gateway-token");
      expect(req.headers.get("x-bf-lh-openbot-request-sha256")).toBe(digest);
      expect(req.headers.get("x-bf-lh-openbot-operation-id")).toBe(
        "operation-a",
      );
      return Response.json({
        object: "list",
        model: route.model,
        usage: { prompt_tokens: 24, total_tokens: 24 },
        data: [
          { index: 1, embedding: [3, 4] },
          { index: 0, embedding: [1, 2] },
        ],
        ...gatewayOverride,
      });
    },
  });
  const execute = createBifrostEmbeddingExecutor({
    endpoint: new URL("/v1/embeddings", server.url),
    meterEndpoint: new URL("/meter", server.url),
    gatewayRevision: route.gatewayRevision,
    meteringRevision: route.meteringRevision,
    gatewayImageDigest: report.gatewayImageDigest,
    gatewayToken: "gateway-token",
    meterToken: "meter-token",
  });
  return {
    server,
    calls,
    steps,
    execute,
    request: {
      route,
      input: ["position one", "位置二"],
      operationId: "operation-a",
      async beforeDispatch() {
        steps.push("dispatch");
        return true;
      },
    },
  };
}

test("meters the exact canonical batch before durable dispatch and restores input order", async () => {
  const { calls, execute, request, server, steps } = startFixture();
  try {
    expect(await execute(request)).toEqual({
      outcome: "complete",
      vectors: [
        [1, 2],
        [3, 4],
      ],
      usage: { inputTokens: 24, outputTokens: 0 },
    });
    expect(steps).toEqual(["/meter", "dispatch", "/v1/embeddings"]);
    expect(calls[0]?.body).toBe(
      '{"model":"zhipu/embedding-3","input":["position one","位置二"],"encoding_format":"float"}',
    );
    expect(calls[0]?.body).toBe(calls[1]?.body);
    expect(calls[0]?.id).toBe(calls[1]?.id);
    expect(calls[0]?.id).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    await expect(
      execute({ ...request, beforeDispatch: async () => false }),
    ).rejects.toThrow("route_unavailable");
    expect(calls[2]?.id).toBe(calls[0]?.id);
    expect(calls).toHaveLength(3);
  } finally {
    await server.stop(true);
  }
});

test.each([
  [{ requestSha256: "a".repeat(64) }, "route_unavailable"],
  [{ requestId: crypto.randomUUID() }, "route_unavailable"],
  [{ meteringRevision: "meter-r2" }, "route_unavailable"],
  [{ inputTokenUpperBound: 101 }, "execution_limit"],
] as const)(
  "rejects a bad meter proof %j before the dispatch callback",
  async (meterOverride, reason) => {
    const { execute, request, server, steps } = startFixture({ meterOverride });
    try {
      await expect(execute(request)).rejects.toThrow(reason);
      expect(steps).toEqual(["/meter"]);
    } finally {
      await server.stop(true);
    }
  },
);

test("refuses a route whose admitted revision no longer matches the evidence", async () => {
  const { execute, request, server, steps } = startFixture();
  try {
    await expect(
      execute({
        ...request,
        route: { ...route, revision: crypto.randomUUID() },
      }),
    ).rejects.toThrow("route_unavailable");
    expect(steps).toEqual([]);
  } finally {
    await server.stop(true);
  }
});

test("keeps trusted usage for malformed vectors and attempts dispatch only once", async () => {
  const { execute, request, server, steps } = startFixture({
    gatewayOverride: {
      data: [
        { index: 0, embedding: [1] },
        { index: 0, embedding: [2] },
      ],
    },
  });
  try {
    expect(await execute(request)).toEqual({
      outcome: "partial",
      usage: { inputTokens: 24, outputTokens: 0 },
    });
    expect(steps).toEqual(["/meter", "dispatch", "/v1/embeddings"]);
  } finally {
    await server.stop(true);
  }
});

test.each([
  { model: "different-model" },
  { usage: { prompt_tokens: 24, total_tokens: 23 } },
  { usage: { prompt_tokens: 31, total_tokens: 31 } },
  { usage: { prompt_tokens: 0, total_tokens: 0 } },
])(
  "treats untrustworthy terminal usage as unreconciled %j",
  async (gatewayOverride) => {
    const { execute, request, server, steps } = startFixture({
      gatewayOverride,
    });
    try {
      await expect(execute(request)).rejects.toThrow("terminal usage");
      expect(steps).toEqual(["/meter", "dispatch", "/v1/embeddings"]);
    } finally {
      await server.stop(true);
    }
  },
);
