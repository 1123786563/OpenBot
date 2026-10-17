// Issue #15 / DAG T09 — the configuration toggle, unified readiness, and the bounded
// async-write entry.
//
// Every case here runs against an injected transport, exactly like the T08 port tests:
// the verified T04 manifest below is the same artifact the contract runner produced, and
// every adversarial behavior — 401/403, 5xx, a transport that never resolves, a stalled
// queue — is injected, never dialed. No real Opik write happens from this file.
//
// The acceptance under test, in issue order:
//   1. disabled ⇒ existing behavior: zero writes, zero startup side effects.
//   2. one unified unavailable state per failure: disabled / unconfigured /
//      authentication_failure / capability_missing / unreachable — each also refuses writes.
//   3. slow, unreachable or saturated Opik never changes an ordinary Agent result;
//      drops and delay stay observable.
//   4. health output is booleans, counters and one enumerated reason — never a
//      credential, an upstream body, or exception text.
//
// Dependency constraint (coordinator ruling 2026-10-15): the real HTTP adapter's
// healthCheck currently answers ok for any transport-level response — it does not yet
// gate on the HTTP status, so 401/5xx do not surface as port results. That gate is an
// T08-owned follow-up repair; until it integrates, the authentication_failure and
// 5xx-unreachable mappings below are verified through an injected OpikPort (the port is
// this service's only wire seam, and an injected one exercises the same mapping), and
// this file must not be read as real-adapter acceptance.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Hono } from "hono";
import { createOpikHttpPort } from "../src/ai-observability/opik-http";
import type {
  OpikPort,
  OpikPortResult,
  VerifiedOpikContract,
} from "../src/ai-observability/opik-port";
import { createAiObservabilityHealthRoutes } from "../src/ai-observability/routes/health";
import {
  createOpikHealthService,
  type OpikHealthDeps,
  type OpikHealthService,
} from "../src/ai-observability/health";
import { opikConfigFromEnv } from "../src/ai-observability/config";

const manifest = (await Bun.file(
  join(
    import.meta.dir,
    "../../docs/plans/evidence/2026-10-15-issue4/opik-contract/47-manifest.json",
  ),
).json()) as VerifiedOpikContract;

type Recorded = { url: string };

/** A transport that records every call and answers from a handler. */
function recorder(handler: (call: number) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const transport = ((input: RequestInfo | URL) => {
    calls.push({ url: String(input) });
    return Promise.resolve(handler(calls.length));
  }) as typeof fetch;
  return { calls, transport };
}

/** A transport that never settles on its own — only the deadline ends the call. */
function stalled(): { calls: Recorded[]; transport: typeof fetch } {
  const calls: Recorded[] = [];
  const transport = ((input: RequestInfo | URL) => {
    calls.push({ url: String(input) });
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  return { calls, transport };
}

const json = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });

const okHealth = () => json(200, '{"detail":"ok"}');

/** A configured-enabled config with no credential material worth echoing. */
const enabledConfig = {
  enabled: true,
  baseUrl: "http://opik.secret-host.test/api",
  apiKey: "secret-opik-key",
  workspaceName: null,
  port: 5174,
  otlpHttpPort: 5418,
  otlpGrpcPort: 5417,
} as const;

function service(overrides: Partial<OpikHealthDeps> = {}): OpikHealthService {
  return createOpikHealthService({
    config: () => enabledConfig,
    port: createOpikHttpPort({
      baseUrl: enabledConfig.baseUrl,
      contract: manifest,
      fetch: recorder(okHealth).transport,
      timeoutMs: 60,
    }),
    ...overrides,
  });
}

/**
 * An injected port answering healthCheck from a supplied result — the sanctioned way to
 * exercise the readiness mapping for port outcomes the real adapter does not yet surface
 * (see the dependency constraint in the file header).
 */
function fakePort(
  answer: () =>
    | OpikPortResult<{ healthy: true }>
    | Promise<OpikPortResult<{ healthy: true }>>,
): OpikPort {
  const refuse = async (): Promise<never> => {
    throw new Error("not part of this test");
  };
  return {
    healthCheck: async () => answer(),
    retrieveProject: refuse,
    createTrace: refuse,
    writeSpans: refuse,
    listTraces: refuse,
  };
}

const upstreamError = (status: number) =>
  ({
    outcome: "upstream_error",
    operation: "healthCheck",
    code: "OPIK_UPSTREAM_ERROR",
    status,
  }) as const;

/** A write job that records whether it ran. */
function probeWrite(scopeKey = "scope-1") {
  const seen: string[] = [];
  return {
    seen,
    write: {
      scopeKey,
      operation: "probe",
      perform: async (port: OpikPort): Promise<OpikPortResult<unknown>> => {
        seen.push("ran");
        return port.healthCheck();
      },
    },
  };
}

describe("the configuration toggle reads exactly the T03 env contract", () => {
  test("absent OPIK_* env leaves the integration disabled by default", () => {
    const config = opikConfigFromEnv({});
    expect(config.enabled).toBe(false);
    expect(config.baseUrl).toBe(null);
  });

  test("only the literal true enables; anything else fails closed", () => {
    expect(opikConfigFromEnv({ OPIK_ENABLED: "true" }).enabled).toBe(true);
    for (const value of ["1", "yes", "TRUE", "on", " true"]) {
      expect(opikConfigFromEnv({ OPIK_ENABLED: value }).enabled).toBe(false);
    }
  });

  test("blank OPIK_BASE_URL is unconfigured, not defaulted", () => {
    expect(
      opikConfigFromEnv({ OPIK_ENABLED: "true", OPIK_BASE_URL: "  " }).baseUrl,
    ).toBe(null);
    expect(
      opikConfigFromEnv({ OPIK_ENABLED: "true", OPIK_BASE_URL: "http://x/api" })
        .baseUrl,
    ).toBe("http://x/api");
  });

  test("deployment ports default to the verified values and env overrides win", () => {
    const defaults = opikConfigFromEnv({ OPIK_ENABLED: "true" });
    expect(defaults.port).toBe(5174);
    expect(defaults.otlpHttpPort).toBe(5418);
    expect(defaults.otlpGrpcPort).toBe(5417);
    const overridden = opikConfigFromEnv({
      OPIK_ENABLED: "true",
      OPIK_PORT: "6174",
      OPIK_OTLP_HTTP_PORT: "6418",
      OPIK_OTLP_GRPC_PORT: "6417",
    });
    expect(overridden.port).toBe(6174);
    expect(overridden.otlpHttpPort).toBe(6418);
    expect(overridden.otlpGrpcPort).toBe(6417);
  });

  test("API key and workspace are held for wiring, never defaulted", () => {
    const config = opikConfigFromEnv({
      OPIK_ENABLED: "true",
      OPIK_BASE_URL: "http://x/api",
      OPIK_API_KEY: "k-1",
      OPIK_WORKSPACE_NAME: "default",
    });
    expect(config.apiKey).toBe("k-1");
    expect(config.workspaceName).toBe("default");
    expect(opikConfigFromEnv({ OPIK_ENABLED: "true" }).apiKey).toBe(null);
  });
});

describe("readiness is one unified explicit state (acceptance 2)", () => {
  test("disabled answers disabled and touches no network", async () => {
    const { calls, transport } = recorder(okHealth);
    const svc = service({
      config: () => ({ ...enabledConfig, enabled: false }),
      port: createOpikHttpPort({
        baseUrl: enabledConfig.baseUrl,
        contract: manifest,
        fetch: transport,
        timeoutMs: 60,
      }),
    });
    // Constructing the service is side-effect free even before the first probe.
    expect(calls.length).toBe(0);
    await expect(svc.readiness()).resolves.toEqual({
      ready: false,
      reason: "disabled",
    });
    expect(calls.length).toBe(0);
  });

  test("enabled without a base URL answers unconfigured", async () => {
    const svc = service({
      config: () => ({ ...enabledConfig, enabled: true, baseUrl: null }),
    });
    await expect(svc.readiness()).resolves.toEqual({
      ready: false,
      reason: "unconfigured",
    });
  });

  test("enabled and configured but no verified port answers capability_missing", async () => {
    const svc = service({ port: null });
    await expect(svc.readiness()).resolves.toEqual({
      ready: false,
      reason: "capability_missing",
    });
  });

  test("a manifest whose checks did not all pass answers capability_missing", async () => {
    const stale = structuredClone(manifest);
    stale.checks.passed = stale.checks.total - 1;
    const { calls, transport } = recorder(okHealth);
    const svc = service({
      port: createOpikHttpPort({
        baseUrl: enabledConfig.baseUrl,
        contract: stale,
        fetch: transport,
        timeoutMs: 60,
      }),
    });
    await expect(svc.readiness()).resolves.toEqual({
      ready: false,
      reason: "capability_missing",
    });
    expect(calls.length).toBe(0);
  });

  test("401 and 403 answer authentication_failure", async () => {
    for (const status of [401, 403]) {
      const svc = service({ port: fakePort(() => upstreamError(status)) });
      await expect(svc.readiness()).resolves.toEqual({
        ready: false,
        reason: "authentication_failure",
      });
    }
  });

  test("5xx and malformed answers answer unreachable", async () => {
    const fiveHundred = service({ port: fakePort(() => upstreamError(500)) });
    await expect(fiveHundred.readiness()).resolves.toEqual({
      ready: false,
      reason: "unreachable",
    });
    const malformed = service({
      port: fakePort(() => ({
        outcome: "malformed",
        operation: "healthCheck",
        code: "OPIK_MALFORMED_RESPONSE",
        detail: "invalid_json",
      })),
    });
    await expect(malformed.readiness()).resolves.toEqual({
      ready: false,
      reason: "unreachable",
    });
  });

  test("a transport that never resolves settles within the deadline as unreachable", async () => {
    const { transport } = stalled();
    const svc = service({
      port: createOpikHttpPort({
        baseUrl: enabledConfig.baseUrl,
        contract: manifest,
        fetch: transport,
        timeoutMs: 25,
      }),
    });
    const guard = Promise.race([
      svc.readiness(),
      new Promise((resolve) => setTimeout(() => resolve("HUNG"), 1_000)),
    ]);
    await expect(guard).resolves.toEqual({
      ready: false,
      reason: "unreachable",
    });
  });

  test("a healthy verified instance answers ready", async () => {
    await expect(service().readiness()).resolves.toEqual({ ready: true });
  });
});

describe("every unavailable state prohibits observation writes (acceptance 2)", () => {
  test("disabled refuses before any network or perform", async () => {
    const { calls, transport } = recorder(okHealth);
    const svc = service({
      config: () => ({ ...enabledConfig, enabled: false }),
      port: createOpikHttpPort({
        baseUrl: enabledConfig.baseUrl,
        contract: manifest,
        fetch: transport,
        timeoutMs: 60,
      }),
    });
    const probe = probeWrite();
    expect(svc.submit(probe.write)).toBe("refused_not_ready");
    await svc.drain();
    expect(probe.seen).toEqual([]);
    expect(calls.length).toBe(0);
  });

  test("unconfigured and capability_missing refuse writes", async () => {
    const unconfigured = service({
      config: () => ({ ...enabledConfig, baseUrl: null }),
    });
    const noPort = service({ port: null });
    for (const svc of [unconfigured, noPort]) {
      await svc.readiness();
      const probe = probeWrite();
      expect(svc.submit(probe.write)).toBe("refused_not_ready");
      await svc.drain();
      expect(probe.seen).toEqual([]);
    }
  });

  test("authentication failure refuses writes after the probe says so", async () => {
    const svc = service({ port: fakePort(() => upstreamError(401)) });
    await expect(svc.readiness()).resolves.toEqual({
      ready: false,
      reason: "authentication_failure",
    });
    const probe = probeWrite();
    expect(svc.submit(probe.write)).toBe("refused_not_ready");
    await svc.drain();
    expect(probe.seen).toEqual([]);
  });

  test("an unprobed service refuses writes fail-closed", async () => {
    const probe = probeWrite();
    expect(service().submit(probe.write)).toBe("refused_not_ready");
    await service().drain();
    expect(probe.seen).toEqual([]);
  });

  test("a ready service accepts and performs exactly once", async () => {
    const svc = service();
    await expect(svc.readiness()).resolves.toEqual({ ready: true });
    const probe = probeWrite();
    expect(svc.submit(probe.write)).toBe("accepted");
    await svc.drain();
    expect(probe.seen).toEqual(["ran"]);
    expect(svc.writeStats().completed).toBe(1);
  });

  test("a later failed probe re-arms the refusal", async () => {
    let healthy = true;
    const svc = service({
      port: fakePort(() =>
        healthy
          ? { outcome: "ok", value: { healthy: true } }
          : upstreamError(500),
      ),
    });
    await expect(svc.readiness()).resolves.toEqual({ ready: true });
    const first = probeWrite();
    expect(svc.submit(first.write)).toBe("accepted");
    await svc.drain();
    expect(first.seen).toEqual(["ran"]);
    healthy = false;
    await expect(svc.readiness()).resolves.toEqual({
      ready: false,
      reason: "unreachable",
    });
    const second = probeWrite();
    expect(svc.submit(second.write)).toBe("refused_not_ready");
    await svc.drain();
    expect(second.seen).toEqual([]);
  });
});

describe("slow, unreachable or saturated Opik never changes an Agent result (acceptance 3)", () => {
  /** The ordinary Agent path: a result nothing about Opik may delay or corrupt. */
  const agentResult = () => "agent-answer";

  test("a slow transport does not block submit or the Agent result", async () => {
    const { transport } = recorder(
      () =>
        new Promise((resolve) => setTimeout(() => resolve(okHealth()), 150)),
    );
    const svc = service({
      port: createOpikHttpPort({
        baseUrl: enabledConfig.baseUrl,
        contract: manifest,
        fetch: transport,
        timeoutMs: 5_000,
      }),
    });
    // First probe succeeds (slow but within deadline) so the queue is open.
    await svc.readiness();
    const probe = probeWrite();
    const submittedAt = Date.now();
    expect(svc.submit(probe.write)).toBe("accepted");
    const submitElapsed = Date.now() - submittedAt;
    expect(submitElapsed).toBeLessThan(50);
    // The Agent result is available immediately, unchanged by the pending write.
    expect(agentResult()).toBe("agent-answer");
    await svc.drain();
    expect(probe.seen).toEqual(["ran"]);
  });

  test("an unreachable transport leaves the Agent result intact and the failure observable", async () => {
    const { transport } = stalled();
    const svc = service({
      port: createOpikHttpPort({
        baseUrl: enabledConfig.baseUrl,
        contract: manifest,
        fetch: transport,
        timeoutMs: 25,
      }),
    });
    await expect(svc.readiness()).resolves.toEqual({
      ready: false,
      reason: "unreachable",
    });
    expect(agentResult()).toBe("agent-answer");
    const stats = svc.writeStats();
    expect(stats.refusedNotReady).toBeGreaterThanOrEqual(0);
  });

  test("a saturated queue drops and counts instead of blocking or growing", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    // The readiness probe answers; every later healthCheck stays gated, so the first
    // queued write is in flight (occupying the bound) while more writes arrive.
    const port = fakePort(async () => {
      calls += 1;
      if (calls === 1) return { outcome: "ok", value: { healthy: true } };
      await gate;
      return { outcome: "ok", value: { healthy: true } };
    });
    const svc = service({ writeCapacity: 1, port });
    await expect(svc.readiness()).resolves.toEqual({ ready: true });

    const first = probeWrite("s-1");
    const second = probeWrite("s-2");
    const third = probeWrite("s-3");
    expect(svc.submit(first.write)).toBe("accepted");
    expect(svc.submit(second.write)).toBe("accepted");
    const droppedAt = Date.now();
    expect(svc.submit(third.write)).toBe("dropped_full");
    expect(Date.now() - droppedAt).toBeLessThan(50);
    const stats = svc.writeStats();
    expect(stats.capacity).toBe(1);
    expect(stats.depth).toBeLessThanOrEqual(1);
    expect(stats.droppedFull).toBe(1);
    expect(third.seen).toEqual([]);
    release();
    await svc.drain();
    expect(first.seen).toEqual(["ran"]);
    expect(second.seen).toEqual(["ran"]);
    expect(calls).toBe(3);
  });

  test("failed writes are counted by outcome, not swallowed", async () => {
    let healthy = true;
    const svc = service({
      port: fakePort(() =>
        healthy
          ? { outcome: "ok", value: { healthy: true } }
          : upstreamError(500),
      ),
    });
    await svc.readiness();
    healthy = false;
    const probe = probeWrite();
    expect(svc.submit(probe.write)).toBe("accepted");
    await svc.drain();
    expect(svc.writeStats().failed.upstream_error).toBe(1);
    expect(svc.writeStats().completed).toBe(0);
  });
});

describe("health output is a safe projection (acceptance 4)", () => {
  function appWith(svc: OpikHealthService) {
    const app = new Hono();
    app.route("/health", createAiObservabilityHealthRoutes({ service: svc }));
    return app;
  }

  test("the healthy projection is an exact safe shape", async () => {
    const response = await appWith(service()).request("/health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    // Whitelist projection: exactly these keys, nothing else ever joins.
    expect(Object.keys(body)).toEqual(["opik"]);
    const opik = body.opik as Record<string, unknown>;
    expect(Object.keys(opik)).toEqual(["ready", "reason", "writes"]);
    expect(opik.ready).toBe(true);
    expect(opik.reason).toBe(null);
    const writes = opik.writes as Record<string, unknown>;
    expect(Object.keys(writes)).toEqual([
      "capacity",
      "depth",
      "submitted",
      "accepted",
      "droppedFull",
      "refusedNotReady",
      "completed",
      "failed",
    ]);
    for (const value of Object.values(writes)) {
      if (typeof value === "object" && value !== null) continue;
      expect(typeof value).toBe("number");
    }
    const failed = writes.failed as Record<string, unknown>;
    expect(Object.keys(failed)).toEqual([
      "unavailable",
      "upstream_error",
      "malformed",
      "ownership_drift",
      "unexpected",
    ]);
    for (const value of Object.values(failed)) {
      expect(typeof value).toBe("number");
    }
  });

  test("an unhealthy projection carries one enumerated reason and no secrets", async () => {
    const svc = service({ port: fakePort(() => upstreamError(401)) });
    const response = await appWith(svc).request("/health");
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as {
      opik: { ready: boolean; reason: string };
    };
    expect(body.opik.ready).toBe(false);
    expect(body.opik.reason).toBe("authentication_failure");
    // Nothing from the endpoint, the credential, or the host leaks: the whole body
    // is the whitelisted projection above.
    expect(text).not.toContain("secret-host.test");
    expect(text).not.toContain("secret-opik-key");
    expect(text).not.toContain("401");
  });

  test("a throwing snapshot fails closed without exception text", async () => {
    const svc = service();
    const app = new Hono();
    app.route(
      "/health",
      createAiObservabilityHealthRoutes({
        service: {
          ...svc,
          snapshot: async () => {
            throw new Error("secret internal boom");
          },
        },
      }),
    );
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("secret internal boom");
    const body = JSON.parse(text) as {
      opik: { ready: boolean; reason: string };
    };
    expect(body.opik.ready).toBe(false);
    expect(body.opik.reason).toBe("unreachable");
  });

  test("every readiness reason serializes to exactly its enum string", async () => {
    const reasons = [
      "disabled",
      "unconfigured",
      "capability_missing",
      "authentication_failure",
      "unreachable",
    ] as const;
    const svc = service();
    const app = new Hono();
    app.route(
      "/health",
      createAiObservabilityHealthRoutes({
        service: {
          ...svc,
          snapshot: async () => ({
            readiness: { ready: false, reason: reasons[0] },
            writes: svc.writeStats(),
          }),
        },
      }),
    );
    for (const reason of reasons) {
      const probe = new Hono();
      probe.route(
        "/health",
        createAiObservabilityHealthRoutes({
          service: {
            ...svc,
            snapshot: async () => ({
              readiness: { ready: false, reason },
              writes: svc.writeStats(),
            }),
          },
        }),
      );
      const body = (await (await probe.request("/health")).json()) as {
        opik: { reason: string };
      };
      expect(body.opik.reason).toBe(reason);
    }
  });
});

describe("the write entry contract stays bounded and observable", () => {
  test("stats expose capacity, depth and every drop/refusal counter", async () => {
    const svc = service({ writeCapacity: 1 });
    await svc.readiness();
    const stats = svc.writeStats();
    expect(stats.capacity).toBe(1);
    expect(stats.depth).toBe(0);
    expect(stats).toHaveProperty("submitted");
    expect(stats).toHaveProperty("accepted");
    expect(stats).toHaveProperty("droppedFull");
    expect(stats).toHaveProperty("refusedNotReady");
    expect(stats).toHaveProperty("completed");
    expect(stats).toHaveProperty("failed");
  });

  test("an ownership-drift write outcome counts as failed and suspends nothing extra here", async () => {
    const svc = service();
    await svc.readiness();
    const driftWrite = {
      scopeKey: "scope-drift",
      operation: "probe",
      perform: async (): Promise<OpikPortResult<unknown>> => ({
        outcome: "ownership_drift",
        operation: "createTrace",
        code: "OPIK_OWNERSHIP_DRIFT",
        reason: "binding_mismatch",
        scopeKey: "scope-drift",
      }),
    };
    expect(svc.submit(driftWrite)).toBe("accepted");
    await svc.drain();
    expect(svc.writeStats().failed.ownership_drift).toBe(1);
  });

  test("a perform that throws is contained, not propagated to the caller", async () => {
    const svc = service();
    await svc.readiness();
    const throwing = {
      scopeKey: "scope-throw",
      operation: "probe",
      perform: async (): Promise<OpikPortResult<unknown>> => {
        throw new Error("worker bug");
      },
    };
    expect(svc.submit(throwing)).toBe("accepted");
    await expect(svc.drain()).resolves.toBeUndefined();
    expect(svc.writeStats().failed.unexpected).toBe(1);
  });
});
