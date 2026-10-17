import { describe, expect, test } from "bun:test";
import pino from "pino";
import type { GatewayEndpointConfig } from "../src/gateway/endpoint-config";
import {
  createGatewayProbeService,
  GATEWAY_PROBE_MANAGEMENT_PATH,
  type GatewayProbeRecord,
  type GatewayProbeResult,
  type GatewayProbeResultStore,
  type GatewayProbeRun,
} from "../src/gateway/probe";
import {
  type FakeGateway,
  type FakeGatewayPlan,
  startFakeGateway,
  upstreamSecretMarker,
} from "./support/fake-gateway";

/*
 * Bifrost 01.5 — the gateway connection and authentication probe, at the seams
 * that need no database: one authenticated GET against the gateway's management
 * surface, classified into five statuses a person can tell apart (timeout is
 * not "unreachable" is not "unauthorized" is not "unexpected"), with the
 * upstream's bytes — bodies, headers, error messages — never echoed into a
 * result or a log line.
 *
 * The database-backed half (persistence, restart display, "a failed probe
 * changes no saved configuration") lives in gateway-probe.integration.test.ts;
 * this file pins the classification and the redaction, which is where a probe
 * quietly becomes a leak.
 */

const ADMIN_KEY = "probe-test-admin-key-4f2b91cd";
const CONFIG: GatewayEndpointConfig = {
  baseUrl: "http://bifrost.internal",
  requestTimeoutMs: 5_000,
  configVersion: 7,
};

/** A store that records what a probe persisted, in memory (the seam's shape only). */
function recordingStore() {
  const saved: GatewayProbeRecord[] = [];
  const store: GatewayProbeResultStore = {
    async saveGatewayProbeResult(record) {
      saved.push(record);
    },
    async readGatewayProbeResult() {
      return saved.at(-1);
    },
  };
  return { store, saved };
}

/** A log that captures every serialized line, the way the credential tests do. */
function capturingLog() {
  const chunks: string[] = [];
  const log = pino({ level: "trace" }, {
    write(chunk: string) {
      chunks.push(chunk);
    },
  } as pino.DestinationStream);
  return { log, lines: () => chunks.join("\n") };
}

/** A fetch that never answers on its own; it rejects only when aborted. */
function hangingFetch(): typeof fetch {
  return ((_input, init) => {
    const signal = init?.signal;
    if (!signal) {
      return Promise.reject(new TypeError("test fetch needs a signal"));
    }
    return new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  }) as typeof fetch;
}

/** A fetch whose rejection message carries whatever the test wants to leak-check. */
function rejectingFetch(error: unknown): typeof fetch {
  return (() => Promise.reject(error)) as typeof fetch;
}

/** The service against a real local fake gateway, plus the handles a test needs. */
async function probeAgainstFake(options: {
  config?: GatewayEndpointConfig;
  plan: FakeGatewayPlan;
}): Promise<{
  service: ReturnType<typeof createGatewayProbeService>;
  gateway: FakeGateway;
  saved: GatewayProbeRecord[];
  logLines: () => string;
  stop: () => Promise<void>;
}> {
  const config = options.config ?? CONFIG;
  const gateway = await startFakeGateway(options.plan);
  const { store, saved } = recordingStore();
  const { log, lines } = capturingLog();
  const service = createGatewayProbeService({
    store,
    readGatewayEndpoint: async () => ({ ...config, baseUrl: gateway.baseUrl }),
    resolveGatewayAdminCredential: async () => ({ adminKey: ADMIN_KEY }),
    fetchImpl: globalThis.fetch,
    log,
  });
  return {
    service,
    gateway,
    saved,
    logLines: lines,
    stop: () => gateway.stop(),
  };
}

describe("probeGateway — the five answers, never one blur of failure", () => {
  test("a healthy authorized gateway answers ok, bound to the config it used", async () => {
    const probe = await probeAgainstFake({
      plan: { kind: "response", status: 200, body: '{"config":{}}' },
    });
    const run = await probe.service.probeGateway();
    await probe.stop();

    expect(run.ready).toBe(true);
    if (!run.ready) return;
    const result: GatewayProbeResult = run.result;
    expect(result.status).toBe("ok");
    expect(result.reasonCode).toBe("gateway_probe_ok");
    expect(result.configVersion).toBe(CONFIG.configVersion);
    expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    // The result is exactly the contract's five fields — no room for an echo.
    expect(Object.keys(result).sort()).toEqual([
      "checkedAt",
      "configVersion",
      "durationMs",
      "reasonCode",
      "status",
    ]);
  });

  test("the probe speaks to the management endpoint and authenticates with the admin key", async () => {
    const probe = await probeAgainstFake({
      plan: { kind: "response", status: 200, body: '{"config":{}}' },
    });
    await probe.service.probeGateway();
    await probe.stop();

    expect(probe.gateway.requests).toHaveLength(1);
    const request = probe.gateway.requests[0];
    expect(request.method).toBe("GET");
    expect(request.path).toBe(GATEWAY_PROBE_MANAGEMENT_PATH);
    expect(request.authorization).toBe(`Bearer ${ADMIN_KEY}`);
  });

  test("401 and 403 are unauthenticated — a credential answer, not a network one", async () => {
    for (const status of [401, 403]) {
      const probe = await probeAgainstFake({
        plan: { kind: "response", status, body: '{"error":"Unauthorized"}' },
      });
      const run = await probe.service.probeGateway();
      await probe.stop();
      expect(run.ready).toBe(true);
      if (!run.ready) continue;
      expect(run.result.status).toBe("unauthenticated");
      expect(run.result.reasonCode).toBe("gateway_probe_unauthorized");
    }
  });

  test("a deadline is a timeout, distinct from every other failure", async () => {
    const { store, saved } = recordingStore();
    const { log } = capturingLog();
    const service = createGatewayProbeService({
      store,
      readGatewayEndpoint: async () => ({ ...CONFIG, requestTimeoutMs: 50 }),
      resolveGatewayAdminCredential: async () => ({ adminKey: ADMIN_KEY }),
      fetchImpl: hangingFetch(),
      log,
    });
    const run = await service.probeGateway();
    expect(run.ready).toBe(true);
    if (!run.ready) return;
    expect(run.result.status).toBe("timeout");
    expect(run.result.reasonCode).toBe("gateway_probe_timeout");
    expect(run.result.durationMs).toBeLessThan(5_000);
    // A completed attempt persists, even a failed one.
    expect(saved).toHaveLength(1);
    expect(saved[0]?.status).toBe("timeout");
  });

  test("a peer that answers but never finishes the body still meets the deadline", async () => {
    const { store } = recordingStore();
    const { log } = capturingLog();
    // Headers arrive at once; the body stream never produces a byte.
    const stallingBody = new ReadableStream<Uint8Array>({ start() {} });
    const fetchImpl: typeof fetch = (() =>
      Promise.resolve(new Response(stallingBody, { status: 200 }))) as typeof fetch;
    const service = createGatewayProbeService({
      store,
      readGatewayEndpoint: async () => ({ ...CONFIG, requestTimeoutMs: 60 }),
      resolveGatewayAdminCredential: async () => ({ adminKey: ADMIN_KEY }),
      fetchImpl,
      log,
    });
    const run = await service.probeGateway();
    expect(run.ready).toBe(true);
    if (!run.ready) return;
    expect(run.result.status).toBe("timeout");
    expect(run.result.reasonCode).toBe("gateway_probe_timeout");
  });

  test("a refused connection is unreachable, and the fetch error's text stays out", async () => {
    const marker = upstreamSecretMarker();
    const { store, saved } = recordingStore();
    const { log, lines } = capturingLog();
    const service = createGatewayProbeService({
      store,
      readGatewayEndpoint: async () => CONFIG,
      resolveGatewayAdminCredential: async () => ({ adminKey: ADMIN_KEY }),
      // Bun's real connect errors name the URL; make the fake do the same, plus a secret.
      fetchImpl: rejectingFetch(
        new TypeError(
          `Unable to connect to ${CONFIG.baseUrl}${GATEWAY_PROBE_MANAGEMENT_PATH}: ${marker.secret}`,
        ),
      ),
      log,
    });
    const run = await service.probeGateway();
    expect(run.ready).toBe(true);
    if (!run.ready) return;
    expect(run.result.status).toBe("unreachable");
    expect(run.result.reasonCode).toBe("gateway_probe_connection_failed");
    // Neither the internal address nor the error's own text may surface.
    const rendered = JSON.stringify(run.result);
    for (const variant of marker.variants) {
      expect(rendered).not.toContain(variant);
      expect(lines()).not.toContain(variant);
    }
    expect(rendered).not.toContain(CONFIG.baseUrl);
    expect(lines()).not.toContain(CONFIG.baseUrl);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.status).toBe("unreachable");
  });

  test("statuses outside the distinguished classes are an unexpected response", async () => {
    for (const status of [302, 404, 429, 500, 503]) {
      const probe = await probeAgainstFake({
        plan: { kind: "response", status, body: "no matter what this says" },
      });
      const run = await probe.service.probeGateway();
      await probe.stop();
      expect(run.ready).toBe(true);
      if (!run.ready) continue;
      expect(run.result.status).toBe("invalid_response");
      expect(run.result.reasonCode).toBe("gateway_probe_unexpected_status");
    }
  });

  test("a 200 whose body is not a JSON object is an invalid response", async () => {
    for (const body of ["<html>not json</html>", '["an","array"]', ""]) {
      const probe = await probeAgainstFake({
        plan: { kind: "response", status: 200, body },
      });
      const run = await probe.service.probeGateway();
      await probe.stop();
      expect(run.ready).toBe(true);
      if (!run.ready) continue;
      expect(run.result.status).toBe("invalid_response");
      expect(run.result.reasonCode).toBe("gateway_probe_invalid_body");
    }
  });

  test("a body beyond the read cap is refused, not swallowed whole", async () => {
    const probe = await probeAgainstFake({
      plan: {
        kind: "response",
        status: 200,
        body: JSON.stringify({ pad: "x".repeat(600_000) }),
      },
    });
    const run = await probe.service.probeGateway();
    await probe.stop();
    expect(run.ready).toBe(true);
    if (!run.ready) return;
    expect(run.result.status).toBe("invalid_response");
    expect(run.result.reasonCode).toBe("gateway_probe_response_too_large");
  });
});

describe("probeGateway — redaction", () => {
  test("an upstream body and headers full of secrets reach neither the result nor the log", async () => {
    const marker = upstreamSecretMarker();
    const probe = await probeAgainstFake({
      plan: {
        kind: "response",
        status: 401,
        body: JSON.stringify({
          error: `denied for ${marker.secret}`,
          echo: marker.secret,
        }),
        headers: { "x-bf-debug": marker.secret },
      },
    });
    const run = await probe.service.probeGateway();
    await probe.stop();

    expect(run.ready).toBe(true);
    if (!run.ready) return;
    expect(run.result.status).toBe("unauthenticated");
    const rendered = JSON.stringify(run.result);
    for (const variant of marker.variants) {
      expect(rendered).not.toContain(variant);
      expect(probe.logLines()).not.toContain(variant);
    }
    // The fake served the secret bytes; the probe still said nothing about them.
    expect(probe.gateway.servedBodies.join("\n")).toContain(marker.secret);
  });

  test("the admin key itself never lands in a result or a log line", async () => {
    const adminKey = `admin-${upstreamSecretMarker().secret}`;
    const { store, saved } = recordingStore();
    const { log, lines } = capturingLog();
    const service = createGatewayProbeService({
      store,
      readGatewayEndpoint: async () => CONFIG,
      resolveGatewayAdminCredential: async () => ({ adminKey }),
      fetchImpl: rejectingFetch(new TypeError("Unable to connect")),
      log,
    });
    const run = await service.probeGateway();
    expect(run.ready).toBe(true);
    for (const variant of [
      adminKey,
      Buffer.from(adminKey).toString("base64"),
      Buffer.from(adminKey).toString("hex"),
    ]) {
      expect(JSON.stringify(run)).not.toContain(variant);
      expect(lines()).not.toContain(variant);
    }
    expect(saved).toHaveLength(1);
    expect(saved[0]?.status).toBe("unreachable");
    expect(JSON.stringify(saved[0])).not.toContain(adminKey);
  });

  test("an unusable credential resolver refuses the probe without inventing an answer", async () => {
    const marker = upstreamSecretMarker();
    const { store, saved } = recordingStore();
    const { log, lines } = capturingLog();
    const service = createGatewayProbeService({
      store,
      readGatewayEndpoint: async () => CONFIG,
      resolveGatewayAdminCredential: async () => {
        throw new Error(`decrypt failed: ${marker.secret}`);
      },
      fetchImpl: rejectingFetch(new TypeError("unreached")),
      log,
    });
    const run = await service.probeGateway();
    expect(run.ready).toBe(false);
    if (run.ready) return;
    expect(run.reasonCode).toBe("gateway_probe_credential_unavailable");
    // Not a probe, so nothing was persisted, and the resolver's own words stay buried.
    expect(saved).toHaveLength(0);
    for (const variant of marker.variants) {
      expect(lines()).not.toContain(variant);
    }
  });

  test("an unconfigured endpoint is not a probe failure at all", async () => {
    const { store, saved } = recordingStore();
    const { log } = capturingLog();
    let fetchCalls = 0;
    const service = createGatewayProbeService({
      store,
      readGatewayEndpoint: async () => undefined,
      resolveGatewayAdminCredential: async () => ({ adminKey: ADMIN_KEY }),
      fetchImpl: (() => {
        fetchCalls += 1;
        return Promise.reject(new TypeError("must not be called"));
      }) as typeof fetch,
      log,
    });
    const run = await service.probeGateway();
    expect(run.ready).toBe(false);
    if (run.ready) return;
    expect(run.reasonCode).toBe("gateway_probe_endpoint_not_configured");
    expect(fetchCalls).toBe(0);
    expect(saved).toHaveLength(0);
  });

  test("an unconfigured credential is named as its own not-ready reason", async () => {
    const { GatewayAdminCredentialNotConfiguredError } = await import(
      "../src/gateway/admin-credential"
    );
    const { store, saved } = recordingStore();
    const { log } = capturingLog();
    const service = createGatewayProbeService({
      store,
      readGatewayEndpoint: async () => CONFIG,
      resolveGatewayAdminCredential: async () => {
        throw new GatewayAdminCredentialNotConfiguredError(
          "The gateway admin credential is not configured.",
        );
      },
      fetchImpl: rejectingFetch(new TypeError("must not be called")),
      log,
    });
    const run = await service.probeGateway();
    expect(run.ready).toBe(false);
    if (run.ready) return;
    expect(run.reasonCode).toBe("gateway_probe_credential_not_configured");
    expect(saved).toHaveLength(0);
  });
});

describe("probeGateway — which configuration a result belongs to", () => {
  test("a save racing the probe does not re-label the result", async () => {
    const { store, saved } = recordingStore();
    const { log } = capturingLog();
    let currentConfig: GatewayEndpointConfig = CONFIG;
    const fetchImpl: typeof fetch = (async (input, init) => {
      // The save lands while the request is in flight.
      currentConfig = { ...CONFIG, configVersion: 8 };
      void input;
      void init;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const service = createGatewayProbeService({
      store,
      readGatewayEndpoint: async () => currentConfig,
      resolveGatewayAdminCredential: async () => ({ adminKey: ADMIN_KEY }),
      fetchImpl,
      log,
    });
    const run = await service.probeGateway();
    expect(run.ready).toBe(true);
    if (!run.ready) return;
    // The probe dialed with version 7's snapshot and stays bound to it.
    expect(run.result.configVersion).toBe(CONFIG.configVersion);
    expect(currentConfig.configVersion).toBe(8);
    expect(saved[0]?.configVersion).toBe(CONFIG.configVersion);
  });
});

describe("the service surface — what 01.6 and 01.8 consume", () => {
  test("readLastGatewayProbe answers what the last probe persisted", async () => {
    const probe = await probeAgainstFake({
      plan: { kind: "response", status: 200, body: '{"config":{}}' },
    });
    const run = await probe.service.probeGateway();
    const last = await probe.service.readLastGatewayProbe();
    await probe.stop();
    expect(run.ready).toBe(true);
    const typedRun: GatewayProbeRun = run;
    expect(typedRun.ready).toBe(true);
    expect(last).toEqual(run.ready ? run.result : undefined);
  });
});
