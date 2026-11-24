import { expect, test } from "bun:test";
import {
  configure,
  emptyCatalog,
  publish,
  verify,
} from "../src/admin/bifrost-catalog";
import {
  createBifrostLogProxy,
  loadBifrostEvidenceReader,
} from "../src/billing/bifrost-evidence";
import {
  bifrostRouteProof,
  createBifrostCreditExecutor,
} from "../src/billing/test-credit-bifrost";
import { fixtureTraceReport } from "./support/bifrost-evidence";

const digest = "f".repeat(64);
const token = "isolated-reader";
const operationId = "fixture-operation";

function fixtureRoute() {
  const harnessImage = `agent-langgraph-agui@sha256:${"a".repeat(64)}`;
  const draft = configure(emptyCatalog, {
    harnessImage,
    routes: {
      fixture: {
        provider: "zhipu",
        model: "glm-5.3-flash",
        gatewayRevision: "fixture-gateway",
        meteringRevision: "fixture-meter",
        maxInputTokens: 3,
        maxOutputTokens: 3,
        tools: false,
        price: { inputPerMillion: 1, outputPerMillion: 1 },
      },
    },
  });
  const route = draft.routes.fixture;
  if (!route) throw new Error("Missing fixture route");
  const { catalog } = publish(
    verify(
      draft,
      "fixture",
      fixtureTraceReport(harnessImage, route),
      "fixture",
    ),
    ["fixture"],
    "fixture",
    "fixture",
  );
  const released = catalog.publication?.routes.find(
    (published) => published.id === "fixture",
  );
  if (!released) throw new Error("Missing fixture publication");
  return released;
}

function reader(origin: string, route = fixtureRoute()) {
  const read = loadBifrostEvidenceReader({
    TEST_CREDIT_BIFROST_LOG_ORIGIN: origin,
    TEST_CREDIT_BIFROST_LOG_TOKEN: token,
    TEST_CREDIT_GATEWAY_REVISION: route.gatewayRevision,
    TEST_CREDIT_METERING_REVISION: route.meteringRevision,
    TEST_CREDIT_GATEWAY_IMAGE_DIGEST:
      route.verification.report.gatewayImageDigest,
  });
  if (!read) throw new Error("Missing fixture reader");
  return read;
}

test("the evidence proxy scopes its credential to exact GETs and rejects oversized or redirected logs", async () => {
  const route = fixtureRoute();
  const requestId = crypto.randomUUID();
  const path = `/api/logs/${requestId}`;
  let foreignReads = 0;
  let upstreamReads = 0;
  let oversized = true;
  const foreign = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      foreignReads++;
      return new Response();
    },
  });
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      upstreamReads++;
      expect(request.method).toBe("GET");
      expect(request.headers.get("authorization")).toBeNull();
      expect(new URL(request.url).pathname).toBe(path);
      return oversized
        ? Response.json({ filler: "x".repeat(256 * 1024) })
        : Response.redirect(foreign.url);
    },
  });
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createBifrostLogProxy({
      BIFROST_LOG_PROXY_UPSTREAM_ORIGIN: upstream.url.origin,
      TEST_CREDIT_BIFROST_LOG_TOKEN: token,
    }),
  });
  try {
    const headers = { authorization: `Bearer ${token}` };
    const exact = new URL(path, proxy.url);
    expect((await fetch(exact)).status).toBe(401);
    expect((await fetch(exact, { headers, method: "DELETE" })).status).toBe(
      404,
    );
    expect(
      (await fetch(new URL("/api/logs", proxy.url), { headers })).status,
    ).toBe(404);
    expect(
      (await fetch(new URL(`${path}?limit=5`, proxy.url), { headers })).status,
    ).toBe(404);
    expect(upstreamReads).toBe(0);
    const read = reader(proxy.url.origin, route);
    const candidate = {
      accountId: crypto.randomUUID(),
      operationId,
      requestId,
      digest,
      route,
    };
    expect(
      await read({
        ...candidate,
        route: { ...route, meteringRevision: "wrong" },
      }),
    ).toBeUndefined();
    expect(upstreamReads).toBe(0);
    expect(await read(candidate)).toBeUndefined();
    oversized = false;
    await expect(read(candidate)).rejects.toThrow("log read failed");
    expect(upstreamReads).toBe(2);
    expect(foreignReads).toBe(0);
  } finally {
    await Promise.all([
      proxy.stop(true),
      upstream.stop(true),
      foreign.stop(true),
    ]);
  }
});

const gatewayOrigin = process.env.TEST_PINNED_BIFROST_ORIGIN;
test.skipIf(!gatewayOrigin)(
  "recovers a dropped reply from the pinned Bifrost log store",
  async () => {
    if (!gatewayOrigin) throw new Error("Missing pinned fixture gateway");
    const route = fixtureRoute();
    let dispatches = 0;
    const relay = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        dispatches++;
        const response = await fetch(
          new URL("/v1/chat/completions", gatewayOrigin),
          {
            method: request.method,
            headers: request.headers,
            body: await request.text(),
            redirect: "error",
          },
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          usage: { prompt_tokens: 2, completion_tokens: 3 },
        });
        return new Response(null, { status: 502 });
      },
    });
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: createBifrostLogProxy({
        BIFROST_LOG_PROXY_UPSTREAM_ORIGIN: gatewayOrigin,
        TEST_CREDIT_BIFROST_LOG_TOKEN: token,
      }),
    });
    try {
      const executor = createBifrostCreditExecutor({
        endpoint: relay.url,
        gatewayRevision: route.gatewayRevision,
        meteringRevision: route.meteringRevision,
        limitField: "max_completion_tokens",
        countInputTokens: async () => 3,
      });
      const requests: { requestId: string; digest: string }[] = [];
      await expect(
        executor({
          route,
          operationId,
          routeProof: bifrostRouteProof(route),
          messages: [{ role: "user", content: "Synthetic prompt." }],
          bindGatewayRequest: async (request) => {
            requests.push(request);
            return true;
          },
        }),
      ).rejects.toThrow("gateway request failed");
      const [request] = requests;
      if (!request) throw new Error("Missing gateway binding");
      const candidate = {
        ...request,
        operationId,
        route,
        accountId: crypto.randomUUID(),
      };
      const read = reader(proxy.url.origin, route);
      let evidence: Awaited<ReturnType<typeof read>>;
      for (let attempt = 0; attempt < 40; attempt++) {
        evidence = await read(candidate);
        if (evidence) break;
        await Bun.sleep(250);
      }
      expect(evidence).toEqual({
        evidenceId: `bifrost:${request.requestId}`,
        gatewayRequestId: request.requestId,
        outcome: "completed",
        inputTokens: 2n,
        outputTokens: 3n,
        resultText: "Recovered isolated reply.",
      });
      expect(await read({ ...candidate, digest })).toBeUndefined();
      expect(dispatches).toBe(1);
    } finally {
      await Promise.all([proxy.stop(true), relay.stop(true)]);
    }
  },
  20_000,
);
