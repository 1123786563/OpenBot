import { expect, test } from "bun:test";
import {
  catalogSchema,
  configure,
  emptyCatalog,
  publish,
  releaseSchema,
  verify,
  view,
} from "../src/admin/bifrost-catalog";
import { fixtureTraceReport } from "./support/bifrost-evidence";

const route = {
  provider: "openai",
  model: "fixture-a",
  gatewayRevision: "gateway-r1",
  meteringRevision: "meter-r1",
  maxInputTokens: 1000,
  maxOutputTokens: 100,
  tools: true,
  price: { inputPerMillion: 10_000, outputPerMillion: 20_000 },
};
const other = { ...route, provider: "anthropic", model: "fixture-b" };
const harnessImage = `agent-langgraph-agui@sha256:${"a".repeat(64)}`;

function legacyReport(revision: string, provider: string, model: string) {
  return {
    revision,
    harnessImage,
    provider,
    model,
    gatewayRevision: "gateway-r1",
    meteringRevision: "meter-r1",
    source: "live-provider",
    artifactDigest: `sha256:${"c".repeat(64)}`,
    gatewayImageDigest: `sha256:${"d".repeat(64)}`,
    retryCount: 0,
    fallbacks: [],
    stream: {
      requestId: `${model}-stream`,
      upstreamRequestId: "upstream-stream",
      outputChunks: 2,
      inputTokens: 100,
      outputTokens: 10,
    },
    cancellation: {
      requestId: `${model}-cancel`,
      upstreamRequestId: "upstream-cancel",
      upstreamOutcome: "cancelled",
    },
    limits: {
      requestId: `${model}-limits`,
      upstreamRequestId: "upstream-limits",
      rejectedRequestId: "input-rejected",
      inputCap: 1000,
      outputCap: 100,
      oversizedInput: "rejected-before-upstream",
      outputStop: "length",
    },
    tool: {
      requestId: `${model}-tool`,
      upstreamRequestId: "upstream-tool",
      outcome: "structured-call-and-result",
    },
  };
}

test("publication requires matching trusted evidence and changes invalidate only the affected route", () => {
  const initial = configure(emptyCatalog, {
    harnessImage,
    routes: { a: route, b: other },
  });
  expect(() => publish(initial, ["a", "b"], "a", "admin")).toThrow(
    "verification",
  );
  const a = initial.routes.a!;
  const b = initial.routes.b!;
  const evidence = fixtureTraceReport(harnessImage, a);
  expect(() =>
    verify(initial, "a", { ...evidence, source: "fixture" }, "admin"),
  ).toThrow("evidence");
  expect(() =>
    verify(initial, "a", { ...evidence, provider: "anthropic" }, "admin"),
  ).toThrow("evidence");
  expect(() =>
    verify(initial, "a", { ...evidence, tool: undefined }, "admin"),
  ).toThrow("evidence");
  const verified = verify(
    verify(initial, "a", evidence, "admin"),
    "b",
    fixtureTraceReport(harnessImage, b),
    "admin",
  );
  const release = publish(verified, ["a", "b"], "a", "admin");
  const changed = configure(release.catalog, {
    harnessImage,
    routes: { a: { ...route, meteringRevision: "meter-r2" }, b: other },
  });
  expect(view(changed).defaultRoute).toBeNull();
  expect(view(changed).options.map((option) => option.id)).toEqual(["b"]);
  expect(release.release.routes.map((option) => option.id)).toEqual(["a", "b"]);
  expect(() => verify(changed, "a", evidence, "admin")).toThrow("evidence");
  const repriced = configure(release.catalog, {
    harnessImage,
    routes: {
      a: { ...route, price: { ...route.price, inputPerMillion: 50_000 } },
      b: other,
    },
  });
  expect(view(repriced).options[0]?.price).toEqual(route.price);
  const next = publish(repriced, ["a", "b"], "a", "admin");
  expect(next.release.id).not.toBe(release.release.id);
  expect(next.release.routes[0]?.price.inputPerMillion).toBe(50_000);
});

test("legacy evidence stays readable and cannot qualify a route", () => {
  const initial = configure(emptyCatalog, {
    harnessImage,
    routes: { a: route },
  });
  const a = initial.routes.a!;
  const report = legacyReport(a.revision, route.provider, route.model);
  expect(() => verify(initial, "a", report, "admin")).toThrow("evidence");
  const verification = { report, by: "admin", at: new Date().toISOString() };
  const oldRelease = releaseSchema.parse({
    id: crypto.randomUUID(),
    by: verification.by,
    at: verification.at,
    harnessImage,
    defaultRoute: "a",
    routes: [{ ...a, id: "a", verification, maxChargeMicrocredits: "12" }],
  });
  const stored = catalogSchema.parse({
    ...initial,
    routes: { a: { ...a, verification } },
    publication: oldRelease,
  });
  expect(view(stored)).toMatchObject({ options: [], defaultRoute: null });
  expect(() => publish(stored, ["a"], "a", "admin")).toThrow("verification");
});

test("retained v2 reports stay readable without qualifying as provider cancellation", async () => {
  for (const filename of [
    "e2fd40ab-313f-45a0-acbc-7cab7bb98894.json",
    "d13818f8-1290-468d-9577-c1cfa60677de.json",
  ]) {
    const report = await Bun.file(
      new URL(
        `../../docs/evidence/bifrost-publication/${filename}`,
        import.meta.url,
      ),
    ).json();
    const initial = configure(emptyCatalog, {
      harnessImage: report.harnessImage,
      routes: {
        a: {
          ...route,
          provider: report.provider,
          model: report.model,
          gatewayRevision: report.gatewayRevision,
          meteringRevision: report.meteringRevision,
          maxInputTokens: 4096,
          maxOutputTokens: 64,
        },
      },
    });
    const draft = { ...initial.routes.a!, revision: report.revision };
    const verification = {
      report,
      by: "admin",
      at: report.cancellation.clientAbortedAt,
    };
    const oldRelease = releaseSchema.parse({
      id: crypto.randomUUID(),
      by: verification.by,
      at: verification.at,
      harnessImage: report.harnessImage,
      defaultRoute: "a",
      routes: [
        { ...draft, id: "a", verification, maxChargeMicrocredits: "4160" },
      ],
    });
    const stored = catalogSchema.parse({
      ...initial,
      routes: { a: { ...draft, verification } },
      publication: oldRelease,
    });
    expect(() => verify(stored, "a", report, "admin")).toThrow("evidence");
    expect(() => publish(stored, ["a"], "a", "admin")).toThrow("verification");
    expect(view(stored)).toMatchObject({ options: [], defaultRoute: null });
  }
});

test.each([
  [
    "substituted upstream model",
    (report) => {
      report.stream.upstream.model = "different-model";
    },
  ],
  [
    "unreconciled token usage",
    (report) => {
      report.stream.upstream.usage.outputTokens += 1;
    },
  ],
  [
    "postflight input above the meter bound",
    (report) => {
      report.stream.meter.inputTokenUpperBound = 0;
    },
  ],
  [
    "meter proof from a different request",
    (report) => {
      report.stream.meter.requestId = crypto.randomUUID();
    },
  ],
  [
    "meter proof for different bytes",
    (report) => {
      report.stream.meter.requestSha256 = "f".repeat(64);
    },
  ],
  [
    "resent upstream request ID",
    (report) => {
      report.outputLimit.upstream.requestId = report.stream.upstream.requestId;
    },
  ],
  [
    "reused gateway request UUID with different casing",
    (report) => {
      const requestId =
        "abcdef12-3456-4789-8abc-def123456789" as `${string}-${string}-${string}-${string}-${string}`;
      report.stream.gateway.requestId = requestId;
      report.stream.meter.requestId = requestId;
      report.stream.upstream.gatewayRequestId = requestId;
      const duplicate =
        requestId.toUpperCase() as `${string}-${string}-${string}-${string}-${string}`;
      report.outputLimit.gateway.requestId = duplicate;
      report.outputLimit.meter.requestId = duplicate;
      report.outputLimit.upstream.gatewayRequestId = duplicate;
    },
  ],
  [
    "provider trace linked to a different gateway request",
    (report) => {
      report.stream.upstream.gatewayRequestId =
        report.failure.gateway.requestId;
    },
  ],
  [
    "missing provider cancellation",
    (report) => {
      report.cancellation.upstream.terminal.outcome = "disconnected";
    },
  ],
  [
    "a provider terminal record for a different request",
    (report) => {
      report.cancellation.upstream.terminal.requestId =
        report.stream.upstream.requestId;
    },
  ],
  [
    "provider termination before the client abort",
    (report) => {
      report.cancellation.upstream.terminal.terminatedAt =
        "2026-01-01T00:59:59Z";
    },
  ],
  [
    "gateway finalization as the terminal record source",
    (report) => {
      report.cancellation.upstream.terminal.source = "gateway-log";
    },
  ],
  [
    "fallback after failure",
    (report) => {
      report.failure.gateway.fallbackCount = 1;
    },
  ],
  [
    "failed probe retry",
    (report) => {
      report.failure.gateway.retryCount = 1;
    },
  ],
  [
    "rejected request reaching the gateway",
    (report) => {
      report.inputLimit.gatewayRequests = 1;
    },
  ],
  [
    "an altered upstream cap",
    (report) => {
      report.outputLimit.upstream.outputCap += 1;
    },
  ],
  [
    "tool result for a different invocation",
    (report) => {
      if (!report.tool) throw new Error("Expected tool proof");
      report.tool.result.toolResultFor = "different-call";
    },
  ],
] satisfies [
  string,
  (report: ReturnType<typeof fixtureTraceReport>) => void,
][])("route qualification rejects %s", (_name, alterReport) => {
  const initial = configure(emptyCatalog, {
    harnessImage,
    routes: { a: route },
  });
  const report = fixtureTraceReport(harnessImage, initial.routes.a!);
  alterReport(report);
  expect(() => verify(initial, "a", report, "admin")).toThrow("evidence");
});
