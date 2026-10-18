import { describe, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { GatewayAdminCredentialNotConfiguredError } from "../src/gateway/admin-credential";
import {
  CREDIT_ADMISSION_EXTENSION_NAME,
  CREDIT_ADMISSION_SUPPORTED_RANGE,
  createGatewayCapabilityNegotiationService,
  fetchGatewayExtensionManifest,
  GATEWAY_EXTENSIONS_MANAGEMENT_PATH,
  gatewayNegotiationRecordFromStored,
  type GatewayCapabilityNegotiation,
  type GatewayCapabilityNegotiationRun,
  type GatewayNegotiationResultStore,
} from "../src/gateway/capability-negotiation";
import { GATEWAY_PROBE_MANAGEMENT_PATH } from "../src/gateway/probe";
import {
  startFakeGateway,
  upstreamSecretMarker,
  type FakeGateway,
  type FakeGatewayPlan,
} from "./support/fake-gateway";

/*
 * Bifrost 01.6 — the credit-admission capability negotiation, at the seams
 * that need no database. A health probe's 200 is a precondition, never a
 * readiness verdict: readiness's extension branch completes only when the
 * auth-gated extension manifest names `openbot-credit-admission` at a
 * compatible version, and the whole negotiation is bound to the endpoint
 * snapshot's configVersion so a configuration change retires it.
 *
 * The database-backed half (persistence, restart reads, "a failed
 * negotiation damages no saved configuration") lives in
 * gateway-capability-negotiation.integration.test.ts; this file pins the
 * verdicts, the refusal classifications, the version rule and the redaction.
 */

const ADMIN_KEY = `negotiation-test-admin-key-${randomUUID().slice(0, 8)}`;

/** What a healthy probe answers (01.5 accepts any JSON object). */
const PROBE_OK_BODY = '{"authConfig":{"admin":{"exists":true}}}';

/** A manifest entry that is not ours, so the list is never trivially empty. */
const OTHER_PLUGIN = { name: "bifrost-anthropic", version: "1.2.3" };

function manifestBody(entries: Array<{ name: string; version: string }>) {
  return JSON.stringify({ plugins: entries });
}

function extensionEntry(version: string) {
  return { name: CREDIT_ADMISSION_EXTENSION_NAME, version };
}

/** A store that records what a negotiation persisted, in memory (the seam's shape only). */
function recordingStore() {
  const saved: GatewayCapabilityNegotiation[] = [];
  const store: GatewayNegotiationResultStore = {
    async saveGatewayNegotiationResult(record) {
      saved.push(
        JSON.parse(JSON.stringify(record)) as GatewayCapabilityNegotiation,
      );
    },
    async readGatewayNegotiationResult() {
      const latest = saved.at(-1);
      return latest
        ? (JSON.parse(JSON.stringify(latest)) as GatewayCapabilityNegotiation)
        : undefined;
    },
  };
  return { store, saved };
}

/** A log that captures every serialized line, the way the probe tests do. */
function capturingLog() {
  const chunks: string[] = [];
  const log = pino({ level: "trace" }, {
    write(chunk: string) {
      chunks.push(chunk);
    },
  } as pino.DestinationStream);
  return { log, lines: () => chunks.join("\n") };
}

const captured = capturingLog();

type ServiceOptions = {
  /** undefined = this deployment has no endpoint configured at all. */
  endpointVersion?: number;
  timeoutMs?: number;
  store?: GatewayNegotiationResultStore;
  resolveCredential?: () => Promise<{ adminKey: string }>;
};

function makeService(
  gateway: FakeGateway | null,
  options: ServiceOptions = {},
) {
  const recording = recordingStore();
  const store: GatewayNegotiationResultStore = options.store ?? recording.store;
  const service = createGatewayCapabilityNegotiationService({
    store,
    readGatewayEndpoint: async () =>
      options.endpointVersion === undefined
        ? undefined
        : {
            baseUrl: gateway?.baseUrl ?? "http://127.0.0.1:1",
            requestTimeoutMs: options.timeoutMs ?? 5_000,
            configVersion: options.endpointVersion,
          },
    resolveGatewayAdminCredential:
      options.resolveCredential ?? (async () => ({ adminKey: ADMIN_KEY })),
    log: captured.log,
  });
  return { saved: recording.saved, store, service };
}

function expectNegotiated(
  run: GatewayCapabilityNegotiationRun,
): GatewayCapabilityNegotiation {
  expect(run.negotiated).toBe(true);
  if (!run.negotiated) throw new Error("expected a negotiation, got a refusal");
  return run.negotiation;
}

async function stop(gateway: FakeGateway) {
  await gateway.stop();
}

describe("the three manifest verdicts (the ticket's core table)", () => {
  test("a healthy gateway without the extension negotiates absent — health 200 is not readiness", async () => {
    const gateway = await startFakeGateway(
      { kind: "response", status: 200, body: PROBE_OK_BODY },
      {
        [GATEWAY_EXTENSIONS_MANAGEMENT_PATH]: {
          kind: "response",
          status: 200,
          body: manifestBody([OTHER_PLUGIN]),
        },
      },
    );
    const { saved, service } = makeService(gateway, { endpointVersion: 7 });
    const run = await service.negotiateGatewayCapabilities();
    await stop(gateway);

    const negotiation = expectNegotiated(run);
    expect(negotiation.creditAdmissionExtension).toBe("absent");
    expect(negotiation.reasonCode).toBe("gateway_capability_extension_absent");
    expect(negotiation.extensionVersion).toBeNull();
    expect(negotiation.supportedRange).toBeNull();
    expect(negotiation.configVersion).toBe(7);
    expect(Number.isNaN(Date.parse(negotiation.checkedAt))).toBe(false);

    // Both hops ran, authenticated, probe first and manifest second.
    expect(gateway.requests.map((request) => request.path)).toEqual([
      GATEWAY_PROBE_MANAGEMENT_PATH,
      GATEWAY_EXTENSIONS_MANAGEMENT_PATH,
    ]);
    expect(
      gateway.requests.every(
        (request) => request.authorization === `Bearer ${ADMIN_KEY}`,
      ),
    ).toBe(true);

    // A completed negotiation is exactly what got persisted.
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual(negotiation);
  });

  test("an out-of-range extension version is incompatible and names the supported range", async () => {
    const gateway = await startFakeGateway(
      { kind: "response", status: 200, body: PROBE_OK_BODY },
      {
        [GATEWAY_EXTENSIONS_MANAGEMENT_PATH]: {
          kind: "response",
          status: 200,
          body: manifestBody([OTHER_PLUGIN, extensionEntry("0.9.1")]),
        },
      },
    );
    const { saved, service } = makeService(gateway, { endpointVersion: 7 });
    const run = await service.negotiateGatewayCapabilities();
    await stop(gateway);

    const negotiation = expectNegotiated(run);
    expect(negotiation.creditAdmissionExtension).toBe("incompatible");
    expect(negotiation.reasonCode).toBe(
      "gateway_capability_extension_version_incompatible",
    );
    expect(negotiation.extensionVersion).toBe("0.9.1");
    expect(negotiation.supportedRange).toBe(CREDIT_ADMISSION_SUPPORTED_RANGE);
    expect(saved).toEqual([negotiation]);
  });

  test("a compatible extension is present — the only state readiness's extension branch accepts", async () => {
    const gateway = await startFakeGateway(
      { kind: "response", status: 200, body: PROBE_OK_BODY },
      {
        [GATEWAY_EXTENSIONS_MANAGEMENT_PATH]: {
          kind: "response",
          status: 200,
          body: manifestBody([OTHER_PLUGIN, extensionEntry("1.4.2")]),
        },
      },
    );
    const { saved, service } = makeService(gateway, { endpointVersion: 7 });
    const run = await service.negotiateGatewayCapabilities();
    await stop(gateway);

    const negotiation = expectNegotiated(run);
    expect(negotiation.creditAdmissionExtension).toBe("present");
    expect(negotiation.reasonCode).toBe("gateway_capability_extension_present");
    expect(negotiation.extensionVersion).toBe("1.4.2");
    expect(negotiation.supportedRange).toBeNull();
    expect(saved).toEqual([negotiation]);
  });
});

describe("negotiations that never complete persist nothing", () => {
  test("a probe refusal refuses the negotiation before any manifest is requested", async () => {
    const gateway = await startFakeGateway({
      kind: "response",
      status: 401,
      body: '{"error":"bad key"}',
    });
    const { saved, service } = makeService(gateway, { endpointVersion: 7 });
    const run = await service.negotiateGatewayCapabilities();
    await stop(gateway);

    expect(run).toEqual({
      negotiated: false,
      reasonCode: "gateway_probe_unauthorized",
    });
    expect(gateway.requests.map((request) => request.path)).toEqual([
      GATEWAY_PROBE_MANAGEMENT_PATH,
    ]);
    expect(saved).toHaveLength(0);
  });

  test("without an endpoint configuration no negotiation runs", async () => {
    const { saved, service } = makeService(null);
    const run = await service.negotiateGatewayCapabilities();
    expect(run).toEqual({
      negotiated: false,
      reasonCode: "gateway_probe_endpoint_not_configured",
    });
    expect(saved).toHaveLength(0);
  });

  test("without a usable admin credential no negotiation runs — each gap named", async () => {
    const config = {
      baseUrl: "http://127.0.0.1:1",
      requestTimeoutMs: 1_000,
      configVersion: 0,
    };
    const notConfigured = makeService(null, {
      endpointVersion: 0,
      resolveCredential: async () => {
        throw new GatewayAdminCredentialNotConfiguredError();
      },
    });
    expect(await notConfigured.service.negotiateGatewayCapabilities()).toEqual({
      negotiated: false,
      reasonCode: "gateway_probe_credential_not_configured",
    });
    expect(notConfigured.saved).toHaveLength(0);

    const unavailable = createGatewayCapabilityNegotiationService({
      store: recordingStore().store,
      readGatewayEndpoint: async () => config,
      resolveGatewayAdminCredential: async () => {
        throw new Error("decrypt failed: bad vault key");
      },
      log: captured.log,
    });
    expect(await unavailable.negotiateGatewayCapabilities()).toEqual({
      negotiated: false,
      reasonCode: "gateway_probe_credential_unavailable",
    });
  });
});

describe("the manifest hop classifies every failure it can meet", () => {
  async function negotiateWithPluginsRoute(
    plan: FakeGatewayPlan,
    options: ServiceOptions = {},
  ) {
    const gateway = await startFakeGateway(
      { kind: "response", status: 200, body: PROBE_OK_BODY },
      { [GATEWAY_EXTENSIONS_MANAGEMENT_PATH]: plan },
    );
    const { saved, service } = makeService(gateway, {
      endpointVersion: 7,
      ...options,
    });
    const run = await service.negotiateGatewayCapabilities();
    await stop(gateway);
    return { saved, run };
  }

  test("a manifest refusal is the manifest's own reason, not the probe's", async () => {
    const { saved, run } = await negotiateWithPluginsRoute({
      kind: "response",
      status: 401,
      body: '{"error":"nope"}',
    });
    expect(run).toEqual({
      negotiated: false,
      reasonCode: "gateway_negotiation_manifest_unauthorized",
    });
    expect(saved).toHaveLength(0);
  });

  test("a non-2xx, non-401 manifest answer is an unexpected status", async () => {
    const { run } = await negotiateWithPluginsRoute({
      kind: "response",
      status: 404,
      body: '{"error":"gone"}',
    });
    expect(run).toEqual({
      negotiated: false,
      reasonCode: "gateway_negotiation_manifest_unexpected_status",
    });
  });

  test("a manifest peer that stalls past the deadline is a timeout", async () => {
    const { saved, run } = await negotiateWithPluginsRoute(
      { kind: "hang" },
      { timeoutMs: 150 },
    );
    expect(run).toEqual({
      negotiated: false,
      reasonCode: "gateway_negotiation_manifest_timeout",
    });
    expect(saved).toHaveLength(0);
  });

  test("a manifest body over the cap is too large, never read whole", async () => {
    const padded = JSON.stringify({
      plugins: [extensionEntry("1.4.2")],
      padding: "a".repeat(600 * 1024),
    });
    const { run } = await negotiateWithPluginsRoute({
      kind: "response",
      status: 200,
      body: padded,
    });
    expect(run).toEqual({
      negotiated: false,
      reasonCode: "gateway_negotiation_manifest_response_too_large",
    });
  });

  test("a dead endpoint on the manifest hop is a connection failure", async () => {
    const gateway = await startFakeGateway({
      kind: "response",
      status: 200,
      body: manifestBody([extensionEntry("1.4.2")]),
    });
    const deadUrl = gateway.baseUrl;
    await stop(gateway); // nothing listens there now
    const manifest = await fetchGatewayExtensionManifest({
      config: {
        baseUrl: deadUrl,
        requestTimeoutMs: 2_000,
        configVersion: 7,
      },
      adminKey: ADMIN_KEY,
    });
    expect(manifest).toEqual({
      ok: false,
      reasonCode: "gateway_negotiation_manifest_connection_failed",
    });
  });

  test("a manifest that is not JSON is an invalid body", async () => {
    const { run } = await negotiateWithPluginsRoute({
      kind: "response",
      status: 200,
      body: "not json at all",
    });
    expect(run).toEqual({
      negotiated: false,
      reasonCode: "gateway_negotiation_manifest_invalid_body",
    });
  });
});

describe("an untrusted manifest shape fails closed as invalid", () => {
  const brokenManifests: Array<[string, string]> = [
    ["no plugins key", '{"extensions":[{"name":"x","version":"1.0.0"}]}'],
    ["plugins not an array", '{"plugins":{}}'],
    ["entry not an object", '{"plugins":["openbot-credit-admission"]}'],
    ["entry without version", '{"plugins":[{"name":"x"}]}'],
    ["version not a string", '{"plugins":[{"name":"x","version":1}]}'],
    [
      "the same extension named twice",
      JSON.stringify({
        plugins: [
          { name: "a", version: "1.0.0" },
          { name: "a", version: "2.0.0" },
        ],
      }),
    ],
  ];

  for (const [what, body] of brokenManifests) {
    test(`a manifest with ${what} is refused wholesale`, async () => {
      const gateway = await startFakeGateway(
        { kind: "response", status: 200, body: PROBE_OK_BODY },
        {
          [GATEWAY_EXTENSIONS_MANAGEMENT_PATH]: {
            kind: "response",
            status: 200,
            body,
          },
        },
      );
      const { saved, service } = makeService(gateway, { endpointVersion: 7 });
      const run = await service.negotiateGatewayCapabilities();
      await stop(gateway);
      expect(run).toEqual({
        negotiated: false,
        reasonCode: "gateway_negotiation_manifest_invalid_body",
      });
      expect(saved).toHaveLength(0);
    });
  }
});

describe("the version rule", () => {
  test("a version that is not strict X.Y.Z is incompatible with the version withheld", async () => {
    for (const version of ["1.0", "v1.0.0", "1.0.0-beta"]) {
      const gateway = await startFakeGateway(
        { kind: "response", status: 200, body: PROBE_OK_BODY },
        {
          [GATEWAY_EXTENSIONS_MANAGEMENT_PATH]: {
            kind: "response",
            status: 200,
            body: manifestBody([extensionEntry(version)]),
          },
        },
      );
      const { saved, service } = makeService(gateway, { endpointVersion: 7 });
      const run = await service.negotiateGatewayCapabilities();
      await stop(gateway);

      const negotiation = expectNegotiated(run);
      expect(negotiation.creditAdmissionExtension).toBe("incompatible");
      expect(negotiation.reasonCode).toBe(
        "gateway_capability_extension_version_unparseable",
      );
      expect(negotiation.extensionVersion).toBeNull();
      expect(negotiation.supportedRange).toBe(CREDIT_ADMISSION_SUPPORTED_RANGE);
      expect(saved).toEqual([negotiation]);
    }
  });
});

describe("a negotiation belongs to the configuration it decided against", () => {
  test("a saved negotiation answers only while the config version stands (AC04)", async () => {
    const gateway = await startFakeGateway(
      { kind: "response", status: 200, body: PROBE_OK_BODY },
      {
        [GATEWAY_EXTENSIONS_MANAGEMENT_PATH]: {
          kind: "response",
          status: 200,
          body: manifestBody([extensionEntry("1.4.2")]),
        },
      },
    );
    const { saved, store, service } = makeService(gateway, {
      endpointVersion: 7,
    });
    const negotiation = expectNegotiated(
      await service.negotiateGatewayCapabilities(),
    );
    expect(saved).toEqual([negotiation]);
    expect(await service.readLastGatewayNegotiation()).toEqual(negotiation);

    // The configuration moved underneath: the same stored row now answers
    // nothing — the next gate must renegotiate, not trust version 7's answer.
    const moved = createGatewayCapabilityNegotiationService({
      store,
      readGatewayEndpoint: async () => ({
        baseUrl: gateway.baseUrl,
        requestTimeoutMs: 5_000,
        configVersion: 8,
      }),
      resolveGatewayAdminCredential: async () => ({ adminKey: ADMIN_KEY }),
      log: captured.log,
    });
    expect(await moved.readLastGatewayNegotiation()).toBeUndefined();
    // Invalidated, not deleted: the history stays on file.
    expect(await store.readGatewayNegotiationResult()).toEqual(negotiation);
    await stop(gateway);
  });

  test("a damaged persisted row reads as absent, never as an answer", () => {
    const valid: GatewayCapabilityNegotiation = {
      creditAdmissionExtension: "present",
      extensionVersion: "1.4.2",
      reasonCode: "gateway_capability_extension_present",
      supportedRange: null,
      checkedAt: "2026-10-16T12:00:00.000Z",
      configVersion: 3,
    };
    expect(gatewayNegotiationRecordFromStored(valid)).toEqual(valid);
    const broken: Array<unknown> = [
      null,
      "present",
      3,
      [],
      { creditAdmissionExtension: "absent" },
      { ...valid, creditAdmissionExtension: "ready" },
      { ...valid, extensionVersion: "1.0" },
      { ...valid, extensionVersion: 1 },
      { ...valid, extensionVersion: " 1.4.2" },
      { ...valid, reasonCode: "gateway_probe_ok" },
      { ...valid, supportedRange: "" },
      { ...valid, checkedAt: "yesterday" },
      { ...valid, configVersion: -1 },
      { ...valid, configVersion: 1.5 },
    ];
    for (const stored of broken) {
      expect(gatewayNegotiationRecordFromStored(stored)).toBeUndefined();
    }
  });
});

describe("redaction: upstream bytes never survive a negotiation", () => {
  test("a manifest refusal carrying upstream secrets stores and logs none of them", async () => {
    const marker = upstreamSecretMarker();
    const gateway = await startFakeGateway(
      { kind: "response", status: 200, body: PROBE_OK_BODY },
      {
        [GATEWAY_EXTENSIONS_MANAGEMENT_PATH]: {
          kind: "response",
          status: 401,
          body: JSON.stringify({
            error: `denied: ${marker.secret}`,
            detail: marker.secret,
          }),
          headers: { "x-bf-trace": marker.secret },
        },
      },
    );
    const { saved, service } = makeService(gateway, { endpointVersion: 7 });
    const run = await service.negotiateGatewayCapabilities();
    await stop(gateway);

    expect(run).toEqual({
      negotiated: false,
      reasonCode: "gateway_negotiation_manifest_unauthorized",
    });
    expect(saved).toHaveLength(0);
    for (const content of [JSON.stringify(run), captured.lines()]) {
      for (const variant of marker.variants) {
        expect(content).not.toContain(variant);
      }
    }
  });

  test("an unparseable version carrying upstream bytes is withheld everywhere", async () => {
    const marker = upstreamSecretMarker();
    const gateway = await startFakeGateway(
      { kind: "response", status: 200, body: PROBE_OK_BODY },
      {
        [GATEWAY_EXTENSIONS_MANAGEMENT_PATH]: {
          kind: "response",
          status: 200,
          body: manifestBody([extensionEntry(`1.0-${marker.secret}`)]),
        },
      },
    );
    const { saved, service } = makeService(gateway, { endpointVersion: 7 });
    const run = await service.negotiateGatewayCapabilities();
    await stop(gateway);

    const negotiation = expectNegotiated(run);
    expect(negotiation.creditAdmissionExtension).toBe("incompatible");
    expect(negotiation.reasonCode).toBe(
      "gateway_capability_extension_version_unparseable",
    );
    expect(negotiation.extensionVersion).toBeNull();
    expect(saved).toEqual([negotiation]);
    for (const content of [
      JSON.stringify(run),
      JSON.stringify(saved),
      captured.lines(),
    ]) {
      for (const variant of marker.variants) {
        expect(content).not.toContain(variant);
      }
    }
  });
});

test("the result carries exactly the contract's fields", async () => {
  const gateway = await startFakeGateway(
    { kind: "response", status: 200, body: PROBE_OK_BODY },
    {
      [GATEWAY_EXTENSIONS_MANAGEMENT_PATH]: {
        kind: "response",
        status: 200,
        body: manifestBody([extensionEntry("1.4.2")]),
      },
    },
  );
  const { service } = makeService(gateway, { endpointVersion: 7 });
  const negotiation = expectNegotiated(
    await service.negotiateGatewayCapabilities(),
  );
  await stop(gateway);
  expect(Object.keys(negotiation).sort()).toEqual([
    "checkedAt",
    "configVersion",
    "creditAdmissionExtension",
    "extensionVersion",
    "reasonCode",
    "supportedRange",
  ]);
});

test("the log identifies the negotiation without the address or the credential", async () => {
  const rendered = captured.lines();
  expect(rendered).not.toContain(ADMIN_KEY);
  for (const line of captured.lines().split("\n").filter(Boolean)) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.baseUrl).toBeUndefined();
    expect(line).not.toMatch(/127\.0\.0\.1:\d+/);
  }
  expect(rendered.length).toBeGreaterThan(0);
});
