import { expect, test } from "bun:test";
import {
  configure,
  emptyCatalog,
  publish,
  verify,
  view,
} from "../src/admin/bifrost-catalog";

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

function report(revision: string, provider: string, model: string) {
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
  const evidence = report(a.revision, route.provider, route.model);
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
    report(b.revision, other.provider, other.model),
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
