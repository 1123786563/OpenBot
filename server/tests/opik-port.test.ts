// Issue #14 / DAG T08 — the sole Opik port and its manifest-backed HTTP adapter.
//
// Every case here runs against an injected transport: serialization facts come from
// reference/opik-contract.md and the verified T04 manifest (loaded below — the same artifact the
// contract runner produced, so the tests cannot drift from what was actually verified), and
// every adversarial behavior — never-resolving fetch, timeout, 5xx, malformed JSON, partial
// envelopes, stale contract, ownership drift — is injected, never dialed. Live-instance
// acceptance against a real self-hosted Opik belongs to #43, not this file.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SafeRecord, SafeText } from "../../shared/ai-observability";
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import { ObservationScopeError } from "../src/ai-observability/contracts";
import {
  createOpikHttpPort,
  type OpikHttpPortDeps,
  runUpstreamIdentity,
  spanUpstreamId,
} from "../src/ai-observability/opik-http";
import {
  OpikPortError,
  type OpikPortResult,
  type VerifiedOpikContract,
} from "../src/ai-observability/opik-port";
import { MAX_SAFE_TEXT_BYTES } from "../src/ai-observability/redaction";
import {
  resolveObservationScope,
  resolveStorageLocator,
} from "../src/ai-observability/scope";
import { VERIFIED_TRACE_CREATE_BODY_KEYS } from "./support/opik-contract-fixtures";

const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);

const manifest = (await Bun.file(
  join(hereDir, "../src/ai-observability/opik-contract/47-manifest.json"),
).json()) as VerifiedOpikContract;

const trusted = resolveObservationScope({
  actorId: "user-a",
  botId: "agent-1",
  ownership: "owner",
  epoch: 1,
});
const otherScope = resolveObservationScope({
  actorId: "user-b",
  botId: "agent-1",
  ownership: "owner",
  epoch: 1,
});
const locator = resolveStorageLocator(trusted);

/** A binding shape this scope would have stored: locator fields copied from the live locator. */
const ownBinding = {
  scopeKey: trusted.key,
  runId: "run-1",
  attemptId: "attempt-1",
  locatorWorkspace: locator.workspace,
  locatorProject: locator.project,
  opikTraceId: null,
};

const okText = (text: string): SafeText => ({ state: "projected", text });

function port(
  overrides: Partial<OpikHttpPortDeps> = {},
): ReturnType<typeof createOpikHttpPort> {
  return createOpikHttpPort({
    baseUrl: "http://opik.test/api",
    contract: manifest,
    timeoutMs: 5_000,
    ...overrides,
  });
}

type Recorded = { url: string; init: RequestInit };

/** A transport that records every call and answers from a handler. */
function recorder(handler: (call: number) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const transport = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(handler(calls.length));
  }) as typeof fetch;
  return { calls, transport };
}

const json = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });

// Ids below are lifted from the manifest's verified idMapping, so even the fixtures inside
// the tests carry the shapes the real instance was observed to accept.
const derivedSpan = {
  traceId: "8ac709aae94a39a5032699e02e9475f7",
  spanId: "8f03361089adfb92",
  name: okText("agent-run"),
  startTimeUnixNano: "1760000000000000000",
};

function driftOf<T>(result: OpikPortResult<T>) {
  if (result.outcome !== "ownership_drift") {
    throw new Error(`expected ownership_drift, got ${result.outcome}`);
  }
  return result;
}

describe("the verified contract gates every operation before network I/O", () => {
  test("a manifest with any failing check refuses every operation", async () => {
    const stale = structuredClone(manifest);
    stale.checks.passed = stale.checks.total - 1;
    const { calls, transport } = recorder(
      () => new Response("", { status: 200 }),
    );
    const p = port({ contract: stale, fetch: transport });
    await expect(p.healthCheck()).rejects.toThrow(
      new OpikPortError("CONTRACT_UNVERIFIED"),
    );
    await expect(p.retrieveProject(trusted)).rejects.toThrow(
      new OpikPortError("CONTRACT_UNVERIFIED"),
    );
    expect(calls.length).toBe(0);
  });

  test("a manifest of an unknown shape is unverified, not best-effort", async () => {
    const future = structuredClone(manifest);
    future.manifestVersion = 2;
    const { calls, transport } = recorder(
      () => new Response("", { status: 200 }),
    );
    await expect(
      port({ contract: future, fetch: transport }).healthCheck(),
    ).rejects.toThrow(new OpikPortError("CONTRACT_UNVERIFIED"));
    expect(calls.length).toBe(0);
  });

  test("an operation without its verified capability is refused, others still run", async () => {
    const partial = structuredClone(manifest);
    partial.capabilities = partial.capabilities.filter(
      (capability) => capability.name !== "service-health",
    );
    const { calls, transport } = recorder(() =>
      json(200, JSON.stringify({ id: "01a13db5-256b-73a4-b213-d7b33c4fd2d4" })),
    );
    const p = port({ contract: partial, fetch: transport });
    await expect(p.healthCheck()).rejects.toThrow(
      new OpikPortError("OPERATION_UNSUPPORTED"),
    );
    expect((await p.retrieveProject(trusted)).outcome).toBe("ok");
    expect(calls.length).toBe(1);
  });

  test("the span read-back is gated on the parent-child link capability (T18-server)", async () => {
    const partial = structuredClone(manifest);
    partial.capabilities = partial.capabilities.filter(
      (capability) => capability.name !== "parent-child-query-link",
    );
    const { calls, transport } = recorder(() =>
      json(200, JSON.stringify({ page: 1, size: 0, total: 0, content: [] })),
    );
    const p = port({ contract: partial, fetch: transport });
    await expect(
      p.listSpans(trusted, {
        projectId: "01a13db5-256b-73a4-b213-d7b33c4fd2d4",
        traceId: "01a13db5-255e-7678-94cc-dcc4fad1c53a",
      }),
    ).rejects.toThrow(new OpikPortError("OPERATION_UNSUPPORTED"));
    expect(calls.length).toBe(0);
  });

  test("a capability recorded as not-ok is just as absent", async () => {
    const partial = structuredClone(manifest);
    const write = partial.capabilities.find(
      (capability) => capability.name === "otlp-write-parent-child",
    );
    write!.ok = false;
    const { calls, transport } = recorder(
      () => new Response("", { status: 200 }),
    );
    await expect(
      port({ contract: partial, fetch: transport }).writeSpans(trusted, {
        binding: ownBinding,
        spans: [derivedSpan],
      }),
    ).rejects.toThrow(new OpikPortError("OPERATION_UNSUPPORTED"));
    expect(calls.length).toBe(0);
  });

  test("writes need a verified body limit; an oversized body never leaves", async () => {
    // Both verified boundary facts absent: nothing about the cap is proven.
    const noLimit = structuredClone(manifest);
    noLimit.bodyLimit.cappedAtBytes = null;
    noLimit.bodyLimit.maxAcceptedBytes = null;
    noLimit.bodyLimit.minRejectedBytes = 999999;
    const { calls: none, transport: t1 } = recorder(() => new Response(""));
    await expect(
      port({ contract: noLimit, fetch: t1 }).writeSpans(trusted, {
        binding: ownBinding,
        spans: [derivedSpan],
      }),
    ).rejects.toThrow(new OpikPortError("BODY_LIMIT_UNVERIFIED"));
    expect(none.length).toBe(0);

    // A rejected byte is a floor, never a ceiling: with the cap and the largest
    // proven-accepted byte both absent, minRejectedBytes cannot stand in (OCR m149)
    // — noLimit above already carries that floor and still refuses.

    const tiny = structuredClone(manifest);
    tiny.bodyLimit.cappedAtBytes = 32;
    const { calls: still, transport: t2 } = recorder(() => new Response(""));
    await expect(
      port({ contract: tiny, fetch: t2 }).writeSpans(trusted, {
        binding: ownBinding,
        spans: [derivedSpan],
      }),
    ).rejects.toThrow(new OpikPortError("REQUEST_BODY_TOO_LARGE"));
    expect(still.length).toBe(0);
  });
});

describe("serialization follows the verified T04 contract exactly", () => {
  test("health check is a bare GET on the verified path", async () => {
    const { calls, transport } = recorder(
      () => new Response("", { status: 200 }),
    );
    const result = await port({ fetch: transport }).healthCheck();
    expect(result).toEqual({ outcome: "ok", value: { healthy: true } });
    expect(calls[0].url).toBe("http://opik.test/api/health-check");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.body).toBeUndefined();
  });

  test("project retrieval posts the name field the upstream reads", async () => {
    const { calls, transport } = recorder(() =>
      json(200, JSON.stringify({ id: "01a13db5-256b-73a4-b213-d7b33c4fd2d4" })),
    );
    const result = await port({ fetch: transport }).retrieveProject(trusted);
    expect(result).toEqual({
      outcome: "ok",
      value: { id: "01a13db5-256b-73a4-b213-d7b33c4fd2d4" },
    });
    expect(calls[0].url).toBe(
      "http://opik.test/api/v1/private/projects/retrieve",
    );
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      name: locator.project,
    });
  });

  test("a verified 404 answers 'no such project', not an error", async () => {
    const { transport } = recorder(() => new Response("", { status: 404 }));
    const result = await port({ fetch: transport }).retrieveProject(trusted);
    expect(result).toEqual({ outcome: "ok", value: null });
  });

  test("trace creation uses project_name, never project_id, and an ISO start_time", async () => {
    const { calls, transport } = recorder(
      () => new Response("", { status: 201 }),
    );
    const result = await port({ fetch: transport }).createTrace(trusted, {
      traceId: "01a13db5-220b-7681-8026-cdf30cacf2ca",
      threadId: "thread-1",
      // R4-16: the contract-verified creation body carries `name` (fixture
      // trace-b-rest-create, 201) — the wire mirrors that evidence.
      name: okText("agent run trace"),
      startTime: new Date("2026-10-15T03:57:39.074Z"),
      binding: ownBinding,
    });
    expect(result).toEqual({
      outcome: "ok",
      value: { traceId: "01a13db5-220b-7681-8026-cdf30cacf2ca" },
    });
    expect(calls[0].url).toBe("http://opik.test/api/v1/private/traces");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({
      id: "01a13db5-220b-7681-8026-cdf30cacf2ca",
      project_name: locator.project,
      name: "agent run trace",
      thread_id: "thread-1",
      start_time: "2026-10-15T03:57:39.074Z",
    });
    expect(Object.hasOwn(body, "project_id")).toBe(false);
    // The serialized body is exactly the contract-verified creation shape: every
    // key the T04 runner verified, none invented (the fixture is the pin).
    expect(Object.keys(body).sort()).toEqual(
      [...VERIFIED_TRACE_CREATE_BODY_KEYS].sort(),
    );
  });

  test("a withheld trace name is refused before any I/O (R4-16/R4-17)", async () => {
    // A name is what the contract's read-back locates; a withheld projection
    // cannot become wire text, the same discipline as span names.
    const { calls, transport } = recorder(
      () => new Response("", { status: 201 }),
    );
    await expect(
      port({ fetch: transport }).createTrace(trusted, {
        traceId: "01a13db5-220b-7681-8026-cdf30cacf2ca",
        name: { state: "omitted", reason: "unhandled_free_text" },
        startTime: new Date("2026-10-15T03:57:39.074Z"),
        binding: ownBinding,
      }),
    ).rejects.toThrow(new OpikPortError("OPERATION_INPUT_INVALID"));
    expect(calls.length).toBe(0);
  });

  test("derived-path spans serialize to OTLP JSON with hex ids and string nanos", async () => {
    const { calls, transport } = recorder(
      () => new Response("", { status: 200 }),
    );
    const result = await port({ fetch: transport }).writeSpans(trusted, {
      binding: ownBinding,
      spans: [derivedSpan],
      binding: ownBinding,
    });
    expect(result).toEqual({ outcome: "ok", value: { accepted: true } });
    expect(calls[0].url).toBe("http://opik.test/api/v1/private/otel/v1/traces");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.projectName).toBe(locator.project);
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "8ac709aae94a39a5032699e02e9475f7",
                  spanId: "8f03361089adfb92",
                  name: "agent-run",
                  startTimeUnixNano: "1760000000000000000",
                },
              ],
            },
          ],
        },
      ],
    });
  });

  test("a span write without a binding is refused before any bytes move (FREV-02)", async () => {
    const { calls, transport } = recorder(
      () => new Response("", { status: 200 }),
    );
    const p = port({ fetch: transport });
    // The port type still admits the absence; this is the runtime half that
    // refuses it — an unattributable business write, exactly the shape the
    // final review's recorder probe drove.
    await expect(
      p.writeSpans(trusted, { spans: [derivedSpan] }),
    ).rejects.toThrow(new OpikPortError("OPERATION_INPUT_INVALID"));
    expect(calls.length).toBe(0);
  });

  test("an explicit upstream trace id that disagrees with the recorded binding is drift (FREV-02)", async () => {
    const { calls, transport } = recorder(
      () => new Response("", { status: 200 }),
    );
    const p = port({ fetch: transport });
    const recorded = {
      ...ownBinding,
      opikTraceId: "01a13db5-220b-7681-8026-cdf30cacf2ca",
    };
    const result = await p.writeSpans(trusted, {
      binding: recorded,
      spans: [
        {
          ...derivedSpan,
          endTimeUnixNano: "1760000000000000001",
          opik: {
            traceId: "01a1405b-f832-70cf-b204-f4dd5138700",
            spanId: "01a1405b-f832-7c9a-8e2f-9a6b7c8d9e0f",
          },
        },
      ],
    });
    // A second upstream trace for one run is the silent duplication drift
    // exists to refuse; the first recorded claim stands. The drift suspends the
    // scope's writes, so the replay half below runs on a fresh port.
    const drift = driftOf(result);
    expect(drift.reason).toBe("binding_mismatch");
    expect(calls.length).toBe(0);

    // The same explicit id the binding recorded is an idempotent replay, not drift.
    const fresh = recorder(() => new Response("", { status: 200 }));
    const replay = await port({ fetch: fresh.transport }).writeSpans(trusted, {
      binding: recorded,
      spans: [
        {
          ...derivedSpan,
          endTimeUnixNano: "1760000000000000001",
          opik: {
            traceId: "01a13db5-220b-7681-8026-cdf30cacf2ca",
            spanId: "01a1405b-f832-7c9a-8e2f-9a6b7c8d9e0f",
          },
        },
      ],
    });
    expect(replay).toEqual({ outcome: "ok", value: { accepted: true } });
  });

  test("explicit-path spans carry opik.* overrides as hyphenated UUIDv7 attributes", async () => {
    const { calls, transport } = recorder(
      () => new Response("", { status: 200 }),
    );
    await port({ fetch: transport }).writeSpans(trusted, {
      binding: ownBinding,
      spans: [
        {
          traceId: "802441eacd7a6788824055d94e936c1a",
          spanId: "85c7a8f363def6ac",
          parentSpanId: "118aa9a8465a5f38",
          name: okText("agent-step"),
          startTimeUnixNano: "1760000000000000001",
          endTimeUnixNano: "1760000000000000999",
          opik: {
            traceId: "01a13db5-220b-7681-8026-cdf30cacf2ca",
            spanId: "01a13db5-220b-7cfe-80ac-9fb0b22bc59a",
            parentSpanId: "01a13db5-220b-73b4-848d-5e5c5d2acb9b",
          },
        },
      ],
    });
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent.resourceSpans[0].scopeSpans[0].spans[0]).toEqual({
      traceId: "802441eacd7a6788824055d94e936c1a",
      spanId: "85c7a8f363def6ac",
      parentSpanId: "118aa9a8465a5f38",
      name: "agent-step",
      startTimeUnixNano: "1760000000000000001",
      endTimeUnixNano: "1760000000000000999",
      attributes: [
        {
          key: "opik.trace_id",
          value: { stringValue: "01a13db5-220b-7681-8026-cdf30cacf2ca" },
        },
        {
          key: "opik.span_id",
          value: { stringValue: "01a13db5-220b-7cfe-80ac-9fb0b22bc59a" },
        },
        {
          key: "opik.parent_span_id",
          value: { stringValue: "01a13db5-220b-73b4-848d-5e5c5d2acb9b" },
        },
      ],
    });
  });

  test("span attributes consume only T05 projection outputs", async () => {
    const { calls, transport } = recorder(
      () => new Response("", { status: 200 }),
    );
    const attributes: SafeRecord = Object.assign(Object.create(null), {
      model: { state: "projected", value: "glm-5" },
      tokens_input: { state: "projected", value: 5 },
      ok: { state: "projected", value: true },
      ratio: { state: "projected", value: 0.5 },
      withheld: { state: "omitted", reason: "credential" },
      cut: { state: "truncated", value: "prefix", originalBytes: 9_999 },
    });
    await port({ fetch: transport }).writeSpans(trusted, {
      binding: ownBinding,
      spans: [{ ...derivedSpan, attributes }],
    });
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent.resourceSpans[0].scopeSpans[0].spans[0].attributes).toEqual([
      { key: "model", value: { stringValue: "glm-5" } },
      { key: "tokens_input", value: { intValue: "5" } },
      { key: "ok", value: { boolValue: true } },
      { key: "ratio", value: { doubleValue: 0.5 } },
      { key: "cut", value: { stringValue: "prefix" } },
    ]);
  });

  test("shape violations are refused before any bytes move", async () => {
    const { calls, transport } = recorder(
      () => new Response("", { status: 200 }),
    );
    const p = port({ fetch: transport });
    const cases: Array<Record<string, unknown>> = [
      {
        traceId: "not-hex-at-all-32-chars-xxxxxxxx",
        spanId: "8f03361089adfb92",
      },
      { traceId: "8ac709aae94a39a5032699e02e9475f7", spanId: "short" },
      {
        traceId: "8ac709aae94a39a5032699e02e9475f7",
        spanId: "8f03361089adfb92",
        parentSpanId: "bad",
      },
      {
        traceId: "8ac709aae94a39a5032699e02e9475f7",
        spanId: "8f03361089adfb92",
        startTimeUnixNano: "12.5",
      },
      {
        traceId: "8ac709aae94a39a5032699e02e9475f7",
        spanId: "8f03361089adfb92",
        endTimeUnixNano: "-1",
      },
    ];
    for (const spanPatch of cases) {
      await expect(
        p.writeSpans(trusted, {
          binding: ownBinding,
          spans: [{ ...derivedSpan, ...spanPatch } as never],
        }),
      ).rejects.toThrow(new OpikPortError("OPERATION_INPUT_INVALID"));
    }
    // A name the projection withheld cannot become a locatable span upstream.
    await expect(
      p.writeSpans(trusted, {
        binding: ownBinding,
        spans: [
          { ...derivedSpan, name: { state: "omitted", reason: "credential" } },
        ],
      }),
    ).rejects.toThrow(new OpikPortError("OPERATION_INPUT_INVALID"));
    // Explicit overrides must be hyphenated UUIDv7, verbatim upstream identity is not guessed.
    await expect(
      p.writeSpans(trusted, {
        binding: ownBinding,
        spans: [
          {
            ...derivedSpan,
            opik: {
              traceId: "not-a-uuid",
              spanId: "01a13db5-220b-7cfe-80ac-9fb0b22bc59a",
            },
          },
        ],
      }),
    ).rejects.toThrow(new OpikPortError("OPERATION_INPUT_INVALID"));
    // And a non-UUIDv7 trace id for REST creation, likewise.
    await expect(
      p.createTrace(trusted, {
        traceId: "8ac709aae94a39a5032699e02e9475f7",
        name: okText("agent run trace"),
        startTime: new Date("2026-10-15T03:57:39.074Z"),
        binding: ownBinding,
      }),
    ).rejects.toThrow(new OpikPortError("OPERATION_INPUT_INVALID"));
    expect(calls.length).toBe(0);
  });

  test("trace listing sends the verified snake_case query and types the page", async () => {
    const { calls, transport } = recorder(() =>
      json(
        200,
        JSON.stringify({
          page: 1,
          size: 10,
          total: 1,
          content: [
            {
              id: "01a13db5-255e-7678-94cc-dcc4fad1c53a",
              project_id: "01a13db5-256b-73a4-b213-d7b33c4fd2d4",
            },
          ],
        }),
      ),
    );
    const result = await port({ fetch: transport }).listTraces(trusted, {
      projectId: "01a13db5-256b-73a4-b213-d7b33c4fd2d4",
      size: 10,
    });
    expect(result).toEqual({
      outcome: "ok",
      value: {
        page: 1,
        size: 10,
        total: 1,
        content: [
          {
            id: "01a13db5-255e-7678-94cc-dcc4fad1c53a",
            project_id: "01a13db5-256b-73a4-b213-d7b33c4fd2d4",
          },
        ],
      },
    });
    expect(calls[0].url).toBe(
      "http://opik.test/api/v1/private/traces?project_id=01a13db5-256b-73a4-b213-d7b33c4fd2d4&size=10",
    );
    expect(calls[0].init.method).toBe("GET");
  });

  test("span listing sends the verified query and types the page (T18-server)", async () => {
    const { calls, transport } = recorder(() =>
      json(
        200,
        JSON.stringify({
          page: 1,
          size: 10,
          total: 1,
          content: [
            {
              id: "01a13db5-256b-73a4-b213-d7b33c4fd2d4",
              project_id: "01a13db5-256b-73a4-b213-d7b33c4fd2d4",
              name: "tool:web_search",
              parent_span_id: null,
            },
          ],
        }),
      ),
    );
    const result = await port({ fetch: transport }).listSpans(trusted, {
      projectId: "01a13db5-256b-73a4-b213-d7b33c4fd2d4",
      traceId: "01a13db5-255e-7678-94cc-dcc4fad1c53a",
      size: 10,
    });
    expect(result).toEqual({
      outcome: "ok",
      value: {
        page: 1,
        size: 10,
        total: 1,
        content: [
          {
            id: "01a13db5-256b-73a4-b213-d7b33c4fd2d4",
            project_id: "01a13db5-256b-73a4-b213-d7b33c4fd2d4",
            name: "tool:web_search",
            parent_span_id: null,
          },
        ],
      },
    });
    expect(calls[0].url).toBe(
      "http://opik.test/api/v1/private/spans?project_id=01a13db5-256b-73a4-b213-d7b33c4fd2d4&trace_id=01a13db5-255e-7678-94cc-dcc4fad1c53a&size=10",
    );
    expect(calls[0].init.method).toBe("GET");
  });
});

describe("every serialized body respects the verified cap and the projection ceiling", () => {
  test("a trace body beyond the verified cap never leaves", async () => {
    const tiny = structuredClone(manifest);
    tiny.bodyLimit.cappedAtBytes = 64;
    const { calls, transport } = recorder(
      () => new Response("", { status: 201 }),
    );
    await expect(
      port({ contract: tiny, fetch: transport }).createTrace(trusted, {
        traceId: "01a13db5-220b-7681-8026-cdf30cacf2ca",
        name: okText("agent run trace"),
        threadId: "x".repeat(200),
        startTime: new Date("2026-10-15T03:57:39.074Z"),
        binding: ownBinding,
      }),
    ).rejects.toThrow(new OpikPortError("REQUEST_BODY_TOO_LARGE"));
    expect(calls.length).toBe(0);
  });

  test("a project-retrieval body beyond the cap is refused the same way", async () => {
    const tiny = structuredClone(manifest);
    tiny.bodyLimit.cappedAtBytes = 8;
    const { calls, transport } = recorder(() => new Response(""));
    await expect(
      port({ contract: tiny, fetch: transport }).retrieveProject(trusted),
    ).rejects.toThrow(new OpikPortError("REQUEST_BODY_TOO_LARGE"));
    expect(calls.length).toBe(0);
  });

  test("a threadId no T05 projection could have produced is refused before I/O", async () => {
    const { calls, transport } = recorder(
      () => new Response("", { status: 201 }),
    );
    await expect(
      port({ fetch: transport }).createTrace(trusted, {
        traceId: "01a13db5-220b-7681-8026-cdf30cacf2ca",
        name: okText("agent run trace"),
        threadId: "x".repeat(MAX_SAFE_TEXT_BYTES + 1),
        startTime: new Date("2026-10-15T03:57:39.074Z"),
        binding: ownBinding,
      }),
    ).rejects.toThrow(new OpikPortError("OPERATION_INPUT_INVALID"));
    expect(calls.length).toBe(0);
  });
});

describe("a hostile or dead upstream settles within the deadline", () => {
  test("a never-resolving transport times out instead of hanging", async () => {
    const { calls, transport } = recorder(
      () => new Promise<Response>(() => {}) as Promise<Response>,
    );
    const started = Date.now();
    const result = await port({
      fetch: transport,
      timeoutMs: 25,
    }).healthCheck();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toEqual({
      outcome: "unavailable",
      operation: "healthCheck",
      code: "OPIK_TIMEOUT",
    });
    expect(calls.length).toBe(1);
  });

  test("headers that resolve but a body that never completes still settles within the deadline", async () => {
    // A dribbling proxy or a half-open connection: the verified 200 and its headers
    // arrive, the stream enqueues half an object, then stalls forever. Reading the
    // body is part of the exchange — the deadline, not the stream's good behavior,
    // must bound it. `settle` turns a hang into a RED failure instead of a stuck run.
    const stalled = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"id": "abc",'));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const settle = <T>(call: Promise<T>) =>
      Promise.race([
        call,
        new Promise<"HUNG">((resolve) =>
          setTimeout(() => resolve("HUNG"), 500),
        ),
      ]);
    const p = port({
      fetch: (() => Promise.resolve(stalled())) as typeof fetch,
      timeoutMs: 25,
    });
    const started = Date.now();
    const retrieved = await settle(p.retrieveProject(trusted));
    const listed = await settle(
      p.listTraces(trusted, {
        projectId: "01a13db5-256b-73a4-b213-d7b33c4fd2d4",
      }),
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(retrieved).toEqual({
      outcome: "unavailable",
      operation: "retrieveProject",
      code: "OPIK_TIMEOUT",
    });
    expect(listed).toEqual({
      outcome: "unavailable",
      operation: "listTraces",
      code: "OPIK_TIMEOUT",
    });
  });

  test("a refused connection is unavailable, not an error", async () => {
    const transport = (() =>
      Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    const result = await port({ fetch: transport }).healthCheck();
    expect(result).toEqual({
      outcome: "unavailable",
      operation: "healthCheck",
      code: "OPIK_UNREACHABLE",
    });
  });

  test("a TypeError raised inside the reader is reader_failed, never the transport disguise (R3-42)", async () => {
    // The transport call itself resolved fine; the TypeError is thrown while a
    // readBody closure works on what it was handed. The retry lane is the
    // transport's, so a reader's TypeError — even one wearing the exact name
    // the lane matches on — must settle as malformed reader_failed instead.
    const hostile = () =>
      Promise.resolve(
        new Proxy(
          {},
          {
            get(_target, property) {
              // `then` must stay inert so the transport handoff itself succeeds
              // and the defect genuinely fires inside the readBody closure.
              if (property === "then") return undefined;
              if (property === "status") {
                throw new TypeError("reader defect surfaced mid-read");
              }
              throw new TypeError("unexpected response access");
            },
          },
        ) as unknown as Response,
      ) as Promise<Response>;
    const { transport } = recorder(hostile);
    const result = await port({ fetch: transport }).retrieveProject(trusted);
    expect(result).toEqual({
      outcome: "malformed",
      operation: "retrieveProject",
      code: "OPIK_MALFORMED_RESPONSE",
      detail: "reader_failed",
    });
  });

  test("an injected 401 on the health endpoint is a typed failure, never healthy", async () => {
    const { transport } = recorder(() => new Response("", { status: 401 }));
    const result = await port({ fetch: transport }).healthCheck();
    expect(result).toEqual({
      outcome: "upstream_error",
      operation: "healthCheck",
      code: "OPIK_CLIENT_ERROR",
      status: 401,
    });
  });

  test("an injected 500 on the health endpoint is an upstream failure, never healthy", async () => {
    const { transport } = recorder(() => new Response("", { status: 500 }));
    const result = await port({ fetch: transport }).healthCheck();
    expect(result).toEqual({
      outcome: "upstream_error",
      operation: "healthCheck",
      code: "OPIK_UPSTREAM_ERROR",
      status: 500,
    });
  });

  test("a health failure carries only the status, never the body or credentials", async () => {
    const secret = "sk-live-abcdef0123456789abcdef";
    const { transport } = recorder(() =>
      json(401, JSON.stringify({ error: secret, bearer: `Bearer ${secret}` })),
    );
    const result = await port({ fetch: transport }).healthCheck();
    expect(result).toEqual({
      outcome: "upstream_error",
      operation: "healthCheck",
      code: "OPIK_CLIENT_ERROR",
      status: 401,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("Bearer");
  });

  test("5xx is an upstream failure carrying only the status, never the body", async () => {
    const secret = "sk-live-abcdef0123456789abcdef";
    const { transport } = recorder(() =>
      json(503, JSON.stringify({ error: secret, bearer: `Bearer ${secret}` })),
    );
    const result = await port({ fetch: transport }).retrieveProject(trusted);
    expect(result).toEqual({
      outcome: "upstream_error",
      operation: "retrieveProject",
      code: "OPIK_UPSTREAM_ERROR",
      status: 503,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("Bearer");
  });

  test("an unexpected non-error status is malformed, not success", async () => {
    // The verified trace-creation answer is 201; a 200 means the upstream is not the
    // verified service, and pretending the trace exists would be invented success.
    const { transport } = recorder(() => new Response("", { status: 200 }));
    const result = await port({ fetch: transport }).createTrace(trusted, {
      traceId: "01a13db5-220b-7681-8026-cdf30cacf2ca",
      name: okText("agent run trace"),
      startTime: new Date("2026-10-15T03:57:39.074Z"),
      binding: ownBinding,
    });
    expect(result).toEqual({
      outcome: "malformed",
      operation: "createTrace",
      code: "OPIK_MALFORMED_RESPONSE",
      detail: "unexpected_status:200",
    });
  });
});

describe("malformed and partial responses are never converted to success", () => {
  test("invalid JSON is reported without echoing the body", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const { transport } = recorder(() => json(200, `{"id": "${secret}`));
    const result = await port({ fetch: transport }).retrieveProject(trusted);
    expect(result).toEqual({
      outcome: "malformed",
      operation: "retrieveProject",
      code: "OPIK_MALFORMED_RESPONSE",
      detail: "invalid_json",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("a body stream that breaks mid-flight is unavailable, never malformed invalid_json (R3-43)", async () => {
    // The upstream died between the verified 200 headers and the end of the
    // body: response.text() rejects mid-read. That is a transport fact — the
    // retry lane's whole point — and must not fossilize into the permanent
    // invalid_json verdict reserved for bytes that arrived and meant nothing.
    const broken = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"id": "abc"'));
            queueMicrotask(() =>
              controller.error(new Error("connection reset mid-body")),
            );
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const { transport } = recorder(broken);
    const result = await port({ fetch: transport }).retrieveProject(trusted);
    expect(result).toEqual({
      outcome: "unavailable",
      operation: "retrieveProject",
      code: "OPIK_UNREACHABLE",
    });
  });

  test("an envelope read whose body breaks mid-flight is unavailable too (R3-43)", async () => {
    const broken = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"page": 1, "size":'));
            queueMicrotask(() =>
              controller.error(new Error("connection reset mid-body")),
            );
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const { transport } = recorder(broken);
    const result = await port({ fetch: transport }).listTraces(trusted, {
      projectId: "01a13db5-256b-73a4-b213-d7b33c4fd2d4",
    });
    expect(result).toEqual({
      outcome: "unavailable",
      operation: "listTraces",
      code: "OPIK_UNREACHABLE",
    });
  });

  test("a project answer without an id is not a project", async () => {
    const { transport } = recorder(() =>
      json(200, JSON.stringify({ name: "x" })),
    );
    const result = await port({ fetch: transport }).retrieveProject(trusted);
    expect(result).toMatchObject({
      outcome: "malformed",
      detail: "field:id",
    });
  });

  test("a trace page missing the envelope's verified fields is partial, not empty", async () => {
    const { transport } = recorder(() =>
      json(200, JSON.stringify({ page: 1, size: 10 })),
    );
    const result = await port({ fetch: transport }).listTraces(trusted, {
      projectId: "01a13db5-256b-73a4-b213-d7b33c4fd2d4",
    });
    expect(result).toMatchObject({
      outcome: "malformed",
      detail: "field:total",
    });
  });

  test("an envelope count that is not a whole non-negative number is malformed, never a page (OCR R5-38)", async () => {
    // page/size/total are page arithmetic, not decorative JSON numbers: a
    // fractional total makes `rows.length >= total` never true (the steps walk
    // burns its MAX_SPAN_PAGES budget chasing it) and a negative page is a shape
    // the contract never verified. "Never arrives whole is malformed" — a typeof
    // check alone lets 10.5 and -1 wear a 200.
    const cases: readonly [Record<string, unknown>, string][] = [
      [{ page: 1.5, size: 10, total: 3, content: [] }, "field:page"],
      [{ page: -2, size: 10, total: 3, content: [] }, "field:page"],
      [{ page: 1, size: -1, total: 3, content: [] }, "field:size"],
      [{ page: 1, size: 2.5, total: 3, content: [] }, "field:size"],
      [
        {
          page: 1,
          size: 10,
          total: 10.5,
          content: [{ id: "0192f0c0-0000-7000-8000-000000000001" }],
        },
        "field:total",
      ],
      [
        {
          page: 1,
          size: 10,
          total: -5,
          content: [{ id: "0192f0c0-0000-7000-8000-000000000001" }],
        },
        "field:total",
      ],
    ];
    for (const [envelope, detail] of cases) {
      const { transport } = recorder(() => json(200, JSON.stringify(envelope)));
      const result = await port({ fetch: transport }).listTraces(trusted, {
        projectId: "01a13db5-256b-73a4-b213-d7b33c4fd2d4",
      });
      expect(result).toMatchObject({ outcome: "malformed", detail });
    }
  });

  test("content rows must each carry the id the contract reads back by", async () => {
    const { transport } = recorder(() =>
      json(
        200,
        JSON.stringify({
          page: 1,
          size: 10,
          total: 1,
          content: [{ name: "x" }],
        }),
      ),
    );
    const result = await port({ fetch: transport }).listTraces(trusted, {
      projectId: "01a13db5-256b-73a4-b213-d7b33c4fd2d4",
    });
    expect(result).toMatchObject({
      outcome: "malformed",
      detail: "field:content.id",
    });
  });
});

describe("ownership drift fails closed and stops the writes behind it", () => {
  test("a response naming another project is drift, and suspends this scope's writes", async () => {
    const { calls, transport } = recorder((call) =>
      call === 1
        ? json(
            200,
            JSON.stringify({ id: "abc", name: "someone-elses-project" }),
          )
        : new Response("", { status: 200 }),
    );
    const p = port({ fetch: transport });
    const drift = driftOf(await p.retrieveProject(trusted));
    expect(drift.reason).toBe("response_name_mismatch");
    expect(drift.code).toBe("OPIK_OWNERSHIP_DRIFT");
    expect(drift.scopeKey).toBe(trusted.key);

    // The follow-on write never reaches the transport.
    const suspended = driftOf(
      await p.writeSpans(trusted, {
        binding: ownBinding,
        spans: [derivedSpan],
      }),
    );
    expect(suspended.reason).toBe("writes_suspended");
    expect(calls.length).toBe(1);
  });

  test("trace rows attesting a different project are drift too", async () => {
    const { calls, transport } = recorder(() =>
      json(
        200,
        JSON.stringify({
          page: 1,
          size: 10,
          total: 1,
          content: [{ id: "t1", project_id: "another-project" }],
        }),
      ),
    );
    const p = port({ fetch: transport });
    const drift = driftOf(
      await p.listTraces(trusted, {
        projectId: "01a13db5-256b-73a4-b213-d7b33c4fd2d4",
      }),
    );
    expect(drift.reason).toBe("response_project_mismatch");
    driftOf(
      await p.createTrace(trusted, {
        traceId: "01a13db5-220b-7681-8026-cdf30cacf2ca",
        name: okText("agent run trace"),
        startTime: new Date(),
        binding: ownBinding,
      }),
    );
    expect(calls.length).toBe(1);
  });

  test("a REST creation without a binding is refused before any I/O (OCR m154)", async () => {
    const { calls, transport } = recorder(
      () => new Response("", { status: 201 }),
    );
    const p = port({ fetch: transport });
    await expect(
      p.createTrace(trusted, {
        traceId: "01a13db5-220b-7681-8026-cdf30cacf2ca",
        name: okText("agent run trace"),
        startTime: new Date(),
        binding: undefined,
      }),
    ).rejects.toThrow(new OpikPortError("OPERATION_INPUT_INVALID"));
    expect(calls.length).toBe(0);
  });

  test("a creation whose trace id disagrees with the binding's recorded upstream id is drift (OCR R5-16)", async () => {
    // The binding's opikTraceId is an identity field, not garnish: once the
    // binding names an upstream trace, a creation carrying a DIFFERENT id would
    // mint a second upstream trace for one run — exactly the silent duplication
    // the write guard exists to refuse. The same id is an idempotent replay and
    // passes; a null recorded id is the first creation and passes.
    const linkedBinding = {
      ...ownBinding,
      opikTraceId: "01a13db5-220b-7681-8026-cdf30cacf2ca",
    };
    const { calls, transport } = recorder(
      () => new Response("", { status: 201 }),
    );
    const drifted = driftOf(
      await port({ fetch: transport }).createTrace(trusted, {
        traceId: "01a13db5-220b-7681-8026-cdf30cacf2cb",
        name: okText("agent run trace"),
        startTime: new Date(),
        binding: linkedBinding,
      }),
    );
    expect(drifted.reason).toBe("binding_mismatch");
    expect(drifted.scopeKey).toBe(trusted.key);
    expect(calls.length).toBe(0);

    // The matching-id replay and the first (null) creation are not drift.
    const replayRecorder = recorder(() => new Response("", { status: 201 }));
    const firstRecorder = recorder(() => new Response("", { status: 201 }));
    const replay = await port({ fetch: replayRecorder.transport }).createTrace(
      trusted,
      {
        traceId: "01a13db5-220b-7681-8026-cdf30cacf2ca",
        name: okText("agent run trace"),
        startTime: new Date(),
        binding: linkedBinding,
      },
    );
    expect(replay.outcome).toBe("ok");
    const first = await port({ fetch: firstRecorder.transport }).createTrace(
      trusted,
      {
        traceId: "01a13db5-220b-7681-8026-cdf30cacf2cb",
        name: okText("agent run trace"),
        startTime: new Date(),
        binding: ownBinding,
      },
    );
    expect(first.outcome).toBe("ok");
  });

  test("an epoch bump no longer drifts the Bot's own binding; another Bot's binding is drift before any I/O", async () => {
    // FREV-03: the data address is the Bot's stable key, so an epoch bump leaves
    // this binding matching the scope — the write proceeds on the same address.
    const bumped = resolveObservationScope({
      actorId: "user-a",
      botId: "agent-1",
      ownership: "owner",
      epoch: 2,
    });
    const { calls, transport } = recorder(
      () => new Response("", { status: 200 }),
    );
    const p = port({ fetch: transport });
    const fine = await p.writeSpans(bumped, {
      spans: [derivedSpan],
      binding: ownBinding,
    });
    expect(fine).toEqual({ outcome: "ok", value: { accepted: true } });
    expect(calls.length).toBe(1);

    // A binding from the same Bot but under another actor's scope is the SAME
    // range now — no drift either. (Checked before any drift is recorded: a
    // recorded drift suspends the whole range, which the next test pins.)
    const sameRange = await p.writeSpans(otherScope, {
      spans: [derivedSpan],
      binding: ownBinding,
    });
    expect(sameRange).toEqual({ outcome: "ok", value: { accepted: true } });
    expect(calls.length).toBe(2);

    // A binding minted for ANOTHER BOT's range is the refusal that stays.
    const otherBot = resolveObservationScope({
      actorId: "user-a",
      botId: "agent-2",
      ownership: "owner",
      epoch: 1,
    });
    const otherLocator = resolveStorageLocator(otherBot);
    const foreignBinding = {
      scopeKey: otherBot.key,
      runId: "run-1",
      attemptId: "attempt-1",
      locatorWorkspace: otherLocator.workspace,
      locatorProject: otherLocator.project,
      opikTraceId: null,
    };
    const drift = driftOf(
      await p.createTrace(trusted, {
        traceId: "01a13db5-220b-7681-8026-cdf30cacf2ca",
        name: okText("agent run trace"),
        startTime: new Date(),
        binding: foreignBinding,
      }),
    );
    expect(drift.reason).toBe("binding_mismatch");
    expect(drift.scopeKey).toBe(trusted.key);
    expect(calls.length).toBe(2);
  });

  test("suspension is per data range: the same Bot's other scope is suspended, another Bot's writes flow", async () => {
    let answer = json(200, JSON.stringify({ id: "abc", name: "wrong" }));
    const { calls, transport } = recorder(() => {
      const current = answer;
      answer = new Response("", { status: 200 });
      return current;
    });
    const p = port({ fetch: transport });
    expect(driftOf(await p.retrieveProject(trusted)).reason).toBe(
      "response_name_mismatch",
    );
    // FREV-03: drift suspends the Bot's data range, so another actor's scope for
    // the same Bot is suspended too — the suspicious answer was about THAT range.
    expect(
      driftOf(
        await p.writeSpans(otherScope, {
          binding: ownBinding,
          spans: [derivedSpan],
        }),
      ).reason,
    ).toBe("writes_suspended");
    // ...while another Bot's range answers independently.
    const otherBot = resolveObservationScope({
      actorId: "user-a",
      botId: "agent-2",
      ownership: "owner",
      epoch: 1,
    });
    const fine = await p.writeSpans(otherBot, {
      binding: {
        ...ownBinding,
        scopeKey: otherBot.key,
        locatorWorkspace: resolveStorageLocator(otherBot).workspace,
        locatorProject: resolveStorageLocator(otherBot).project,
      },
      spans: [derivedSpan],
    });
    expect(fine).toEqual({ outcome: "ok", value: { accepted: true } });
    expect(calls.length).toBe(2);
  });
});

describe("a configured credential rides every request; no key means no header (R3-41)", () => {
  test("every exchange carries the configured Authorization credential", async () => {
    // The parsed-and-held OPIK_API_KEY must reach the wire: a key-authenticating
    // deployment 401s every request without it, and that 401 would otherwise be
    // silent (OPIK_CLIENT_ERROR, still enabled). Health, reads and writes alike.
    const { calls, transport } = recorder((call) =>
      call === 2
        ? json(200, JSON.stringify({ id: "abc", name: locator.project }))
        : new Response("", { status: 200 }),
    );
    const p = port({ fetch: transport, apiKey: "opik-api-key-1" });
    expect((await p.healthCheck()).outcome).toBe("ok");
    expect((await p.retrieveProject(trusted)).outcome).toBe("ok");
    expect(
      await p.writeSpans(trusted, {
        binding: ownBinding,
        spans: [derivedSpan],
      }),
    ).toEqual({
      outcome: "ok",
      value: { accepted: true },
    });
    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(
        (call.init.headers as Record<string, string> | undefined)
          ?.authorization,
      ).toBe("opik-api-key-1");
    }
  });

  test("without a configured key no Authorization header is attached at all", async () => {
    // Zero behavior change for the compose loopback: absent (or blank) key means
    // the request goes out exactly as before, header-less.
    const { calls, transport } = recorder(() =>
      json(200, JSON.stringify({ id: "abc", name: locator.project })),
    );
    const keyedBlank = port({ fetch: transport, apiKey: "" });
    expect((await keyedBlank.retrieveProject(trusted)).outcome).toBe("ok");
    const keyless = port({ fetch: transport });
    expect((await keyless.healthCheck()).outcome).toBe("ok");
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(
        (call.init.headers as Record<string, string> | undefined)
          ?.authorization,
      ).toBeUndefined();
    }
  });
});

describe("the port trusts scopes only from T06's issuing process", () => {
  test("a spread copy of a real scope is forged and refused before I/O", async () => {
    const forged = { ...trusted };
    const { calls, transport } = recorder(
      () => new Response("", { status: 200 }),
    );
    const p = port({ fetch: transport });
    await expect(p.retrieveProject(forged)).rejects.toThrow(
      new ObservationScopeError("OWNERSHIP_REQUIRED", 403),
    );
    await expect(
      p.writeSpans(forged, { spans: [derivedSpan] }),
    ).rejects.toThrow(new ObservationScopeError("OWNERSHIP_REQUIRED", 403));
    expect(calls.length).toBe(0);
  });
});

describe("the explicit-id identity strategy (F5E1-F3)", () => {
  const chain = "8ac709aae94a39a5032699e02e9475f7";
  const identity = runUpstreamIdentity(chain);
  const reconciledBinding = {
    ...ownBinding,
    opikTraceId: identity.opikTraceId,
  };

  test("the derivation is deterministic, UUIDv7-shaped, and internally distinct", () => {
    expect(runUpstreamIdentity(chain)).toEqual(identity);
    expect(identity.opikTraceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(identity.rootOpikSpanId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(identity.rootSpanId).toMatch(/^[0-9a-f]{16}$/);
    // One chain, three distinct ids: the trace, the root span's upstream id, and
    // the root's own W3C id (which must never equal the trace id, 32 vs 16 hex).
    expect(
      new Set([
        identity.opikTraceId,
        identity.rootOpikSpanId,
        identity.rootSpanId,
      ]).size,
    ).toBe(3);
    // Another chain derives another identity: the mapping never collides runs.
    expect(runUpstreamIdentity("0123456789abcdef0123456789abcdef")).not.toEqual(
      identity,
    );
  });

  test("a reconciled binding completes an override-less span onto its trace and root", async () => {
    const { calls, transport } = recorder(
      () => new Response("", { status: 200 }),
    );
    const result = await port({ fetch: transport }).writeSpans(trusted, {
      binding: reconciledBinding,
      spans: [derivedSpan],
    });
    expect(result).toEqual({ outcome: "ok", value: { accepted: true } });
    const body = JSON.parse(String(calls[0].init.body));
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).toBe(chain);
    expect(span.spanId).toBe(derivedSpan.spanId);
    // Both parent channels name the run root this deployment wrote.
    expect(span.parentSpanId).toBe(identity.rootSpanId);
    const overrides = Object.fromEntries(
      span.attributes
        .filter((attribute: { key: string }) =>
          attribute.key.startsWith("opik."),
        )
        .map((attribute: { key: string; value: { stringValue: string } }) => [
          attribute.key,
          attribute.value.stringValue,
        ]),
    );
    expect(overrides).toEqual({
      "opik.trace_id": identity.opikTraceId,
      "opik.span_id": spanUpstreamId(chain, derivedSpan.spanId),
      "opik.parent_span_id": identity.rootOpikSpanId,
    });
  });

  test("the completed ids are stable: a retried write asks for the same upstream row", async () => {
    // Pure derivation both ways: same inputs, same id — a retried write lands on the
    // same upstream span, never a duplicate; a different span id never collides.
    expect(spanUpstreamId(chain, derivedSpan.spanId)).toBe(
      spanUpstreamId(chain, derivedSpan.spanId),
    );
    expect(spanUpstreamId(chain, derivedSpan.spanId)).not.toBe(
      spanUpstreamId(chain, "0000000000000001"),
    );
    expect(spanUpstreamId(chain, derivedSpan.spanId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("a span of another chain under a reconciled binding is drift, not a silent second trace", async () => {
    const { calls, transport } = recorder(
      () => new Response("", { status: 200 }),
    );
    const p = port({ fetch: transport });
    const foreign = {
      ...derivedSpan,
      traceId: "ffffffffffffffffffffffffffffffff",
    };
    const result = await p.writeSpans(trusted, {
      binding: reconciledBinding,
      spans: [foreign],
    });
    expect(driftOf(result).reason).toBe("binding_mismatch");
    expect(calls.length).toBe(0);
    // Drift suspends the scope — per adapter instance, like every drift verdict
    // here: a later write for the same scope answers without touching the
    // transport.
    const second = await p.writeSpans(trusted, {
      binding: reconciledBinding,
      spans: [derivedSpan],
    });
    expect(second.outcome).toBe("ownership_drift");
    expect(calls.length).toBe(0);
  });

  test("completion preserves a carried same-chain parent instead of flattening to the root (C5)", async () => {
    const { calls, transport } = recorder(
      () => new Response("", { status: 200 }),
    );
    const carried = "118aa9a8465a5f38";
    const result = await port({ fetch: transport }).writeSpans(trusted, {
      binding: reconciledBinding,
      spans: [{ ...derivedSpan, parentSpanId: carried }],
    });
    expect(result).toEqual({ outcome: "ok", value: { accepted: true } });
    const span = JSON.parse(String(calls[0].init.body)).resourceSpans[0]
      .scopeSpans[0].spans[0];
    // Both parent channels name the carried parent — the W3C id verbatim, and the
    // Opik id derived from the same chain, never the run root.
    expect(span.parentSpanId).toBe(carried);
    const overrides = Object.fromEntries(
      span.attributes
        .filter((attribute: { key: string }) =>
          attribute.key.startsWith("opik."),
        )
        .map((attribute: { key: string; value: { stringValue: string } }) => [
          attribute.key,
          attribute.value.stringValue,
        ]),
    );
    expect(overrides).toEqual({
      "opik.trace_id": identity.opikTraceId,
      "opik.span_id": spanUpstreamId(chain, derivedSpan.spanId),
      "opik.parent_span_id": spanUpstreamId(chain, carried),
    });
    expect(overrides["opik.parent_span_id"]).not.toBe(identity.rootOpikSpanId);
  });

  test("a carried parent that names nothing verifiable falls back to the run root (C5)", async () => {
    // Self-referential, all-zero, and malformed parents carry no provable chain
    // position: each falls back to the root, the same outcome a missing parent gets.
    for (const parentSpanId of [
      derivedSpan.spanId,
      "0000000000000000",
      "not-a-span-id",
    ]) {
      const { calls, transport } = recorder(
        () => new Response("", { status: 200 }),
      );
      const result = await port({ fetch: transport }).writeSpans(trusted, {
        binding: reconciledBinding,
        spans: [{ ...derivedSpan, parentSpanId }],
      });
      expect(result).toEqual({ outcome: "ok", value: { accepted: true } });
      const span = JSON.parse(String(calls[0].init.body)).resourceSpans[0]
        .scopeSpans[0].spans[0];
      expect(span.parentSpanId).toBe(identity.rootSpanId);
      const overrides = Object.fromEntries(
        span.attributes
          .filter((attribute: { key: string }) =>
            attribute.key.startsWith("opik."),
          )
          .map(
            (attribute: { key: string; value: { stringValue: string } }) => [
              attribute.key,
              attribute.value.stringValue,
            ],
          ),
      );
      expect(overrides["opik.parent_span_id"]).toBe(identity.rootOpikSpanId);
    }
  });

  test("a carried parent cannot rescue a span of another chain: cross-chain stays drift (C5)", async () => {
    const { calls, transport } = recorder(
      () => new Response("", { status: 200 }),
    );
    const foreign = {
      ...derivedSpan,
      traceId: "ffffffffffffffffffffffffffffffff",
      parentSpanId: "118aa9a8465a5f38",
    };
    const result = await port({ fetch: transport }).writeSpans(trusted, {
      binding: reconciledBinding,
      spans: [foreign],
    });
    expect(driftOf(result).reason).toBe("binding_mismatch");
    expect(calls.length).toBe(0);
  });

  test("a caller-supplied explicit id stays authoritative and untouched", async () => {
    const { calls, transport } = recorder(
      () => new Response("", { status: 200 }),
    );
    await port({ fetch: transport }).writeSpans(trusted, {
      binding: reconciledBinding,
      spans: [
        {
          ...derivedSpan,
          opik: {
            traceId: identity.opikTraceId,
            spanId: "01a1405b-f832-70cf-b204-f4dd51387044",
          },
        },
      ],
    });
    const span = JSON.parse(String(calls[0].init.body)).resourceSpans[0]
      .scopeSpans[0].spans[0];
    const overrides = Object.fromEntries(
      span.attributes
        .filter((attribute: { key: string }) =>
          attribute.key.startsWith("opik."),
        )
        .map((attribute: { key: string; value: { stringValue: string } }) => [
          attribute.key,
          attribute.value.stringValue,
        ]),
    );
    expect(overrides).toEqual({
      "opik.trace_id": identity.opikTraceId,
      "opik.span_id": "01a1405b-f832-70cf-b204-f4dd51387044",
    });
    // And the OTel parent is the caller's own, not rewritten.
    expect(span.parentSpanId).toBeUndefined();
  });

  test("creation replay against a trace the backend already holds is observed, not failed (F5E1-F3)", async () => {
    const { calls, transport } = recorder((call) =>
      call === 1
        ? json(409, "{}") // the create's ambiguity: "already exists" is one 4xx among others
        : call === 2
          ? json(200, JSON.stringify({ id: "proj-1", name: locator.project }))
          : json(200, JSON.stringify({ id: identity.opikTraceId })),
    );
    const result = await port({ fetch: transport }).createTrace(trusted, {
      traceId: identity.opikTraceId,
      name: okText("run"),
      startTime: new Date("2026-10-15T03:57:39.074Z"),
      binding: ownBinding,
    });
    // The read-back observed the very trace the retry asked for: the
    // materialization succeeded, by observation rather than by a guessed status.
    expect(result).toEqual({
      outcome: "ok",
      value: { traceId: identity.opikTraceId },
    });
    expect(calls[2].url).toBe(
      `http://opik.test/api/v1/private/traces/${identity.opikTraceId}?project_id=proj-1`,
    );
  });

  test("a deterministic 4xx with the project present is the refusal it was, never polled (C4)", async () => {
    // 400/422 are permanent client refusals, not "already exists": the port must
    // answer them as themselves — no project resolution, no presence read-back,
    // and never a retryable OPIK_TIMEOUT.
    for (const status of [400, 422]) {
      const { calls, transport } = recorder((call) =>
        call === 1
          ? json(status, "{}")
          : json(200, JSON.stringify({ id: "proj-1", name: locator.project })),
      );
      const result = await port({ fetch: transport }).createTrace(trusted, {
        traceId: identity.opikTraceId,
        name: okText("run"),
        startTime: new Date("2026-10-15T03:57:39.074Z"),
        binding: ownBinding,
      });
      expect(result).toEqual({
        outcome: "upstream_error",
        operation: "createTrace",
        code: "OPIK_CLIENT_ERROR",
        status,
      });
      // One exchange: the create. Nothing else was asked.
      expect(calls).toHaveLength(1);
    }
  });

  test("a conflict whose trace never reads back keeps its 409, never a retryable timeout (C4)", async () => {
    const { transport } = recorder((call) =>
      call === 1
        ? json(409, "{}")
        : call === 2
          ? json(200, JSON.stringify({ id: "proj-1", name: locator.project }))
          : json(404, "{}"),
    );
    const result = await port({
      fetch: transport,
      timeoutMs: 100,
    }).createTrace(trusted, {
      traceId: identity.opikTraceId,
      name: okText("run"),
      startTime: new Date("2026-10-15T03:57:39.074Z"),
      binding: ownBinding,
    });
    // The window closed without observing the trace: the conflict stands as the
    // permanent refusal it was, not a timeout a caller would retry.
    expect(result).toEqual({
      outcome: "upstream_error",
      operation: "createTrace",
      code: "OPIK_CLIENT_ERROR",
      status: 409,
    });
  });

  test("a create refused outright is the client error it was, without a corroboration round trip", async () => {
    const { calls, transport } = recorder(() => json(404, "{}"));
    const result = await port({ fetch: transport }).createTrace(trusted, {
      traceId: identity.opikTraceId,
      name: okText("run"),
      startTime: new Date("2026-10-15T03:57:39.074Z"),
      binding: ownBinding,
    });
    // A 404 has no "already exists" reading: the failure stands as itself and no
    // presence read-back is even attempted.
    expect(result).toEqual({
      outcome: "upstream_error",
      operation: "createTrace",
      code: "OPIK_CLIENT_ERROR",
      status: 404,
    });
    expect(calls).toHaveLength(1);
  });
});
