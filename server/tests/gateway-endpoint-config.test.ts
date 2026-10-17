import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import {
  createGatewayEndpointService,
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  type GatewayEndpointConfig,
  type GatewayEndpointRowStore,
  validateGatewayEndpointInput,
} from "../src/gateway/endpoint-config";

/**
 * The gateway endpoint configuration, unit-level: the shared refusal semantics both entry points
 * (boot environment and administrator save) must agree on, the save result's refusal statuses, and
 * the shape of what a read may carry — never a credential field, because 01.2's secrets never
 * travel through this path and the type has nowhere to put one.
 *
 * The database-backed half (restart consistency, strict version increase, the serialized save —
 * including the first save on an empty table) is in gateway-endpoint-config.integration.test.ts.
 */

/** A store stand-in: the service only needs member(), and the row read/write pair. */
function fakeStore(overrides: Partial<GatewayEndpointRowStore> = {}) {
  const store: GatewayEndpointRowStore = {
    member: async () => ({ role: "admin", groups: [] }),
    readGatewayEndpointRow: async () => ({ state: "absent" as const }),
    writeGatewayEndpointRow: async (settings) => ({
      ...settings,
      configVersion: 1,
    }),
    ...overrides,
  };
  return store;
}

describe("gateway endpoint input validation", () => {
  test("an empty or missing baseUrl is refused with a reason that names it", () => {
    expect(validateGatewayEndpointInput({})).toMatchObject({
      ok: false,
      error: expect.stringMatching(/baseUrl/i) as unknown,
    });
    expect(validateGatewayEndpointInput({ baseUrl: "   " })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/baseUrl/i) as unknown,
    });
  });

  test("a non-URL baseUrl is refused", () => {
    const result = validateGatewayEndpointInput({
      baseUrl: "gateway.internal",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/valid.*URL|URL.*valid/i);
  });

  test("a non-http(s) scheme is refused", () => {
    for (const baseUrl of [
      "ftp://gateway.internal",
      "ws://gateway.internal",
      "file:///etc/passwd",
    ]) {
      const result = validateGatewayEndpointInput({ baseUrl });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/http/i);
    }
  });

  test("credentials inside the URL are refused", () => {
    const result = validateGatewayEndpointInput({
      baseUrl: "http://admin:secret@gateway.internal:8080",
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatch(/credential|user info|password/i);
  });

  test("a path, query or fragment is refused: the origin is the whole address", () => {
    for (const baseUrl of [
      "https://gateway.internal/v1",
      "https://gateway.internal/?x=1",
      "https://gateway.internal#fragment",
    ]) {
      const result = validateGatewayEndpointInput({ baseUrl });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/path|query|fragment/i);
    }
  });

  test("an origin with a port, a trailing slash, or a bare localhost is accepted", () => {
    for (const baseUrl of [
      "http://localhost:8090",
      "https://bifrost.internal",
      "https://gateway.internal/",
      "http://127.0.0.1:9090",
    ]) {
      expect(validateGatewayEndpointInput({ baseUrl })).toMatchObject({
        ok: true,
        settings: { baseUrl },
      });
    }
  });

  test("a configVersion in the input is refused: the server assigns the version", () => {
    const result = validateGatewayEndpointInput({
      baseUrl: "https://gateway.internal",
      configVersion: 7,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/configVersion/i);
  });

  test("an unknown field is refused rather than dropped, so nothing rides along", () => {
    const result = validateGatewayEndpointInput({
      baseUrl: "https://gateway.internal",
      adminToken: "should-not-ride-along",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/adminToken/);
  });

  test("a requestTimeoutMs that is not a positive whole number is refused", () => {
    for (const requestTimeoutMs of [0, -1, 2.5, "10000", null]) {
      const result = validateGatewayEndpointInput({
        baseUrl: "https://gateway.internal",
        requestTimeoutMs,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/requestTimeoutMs/i);
    }
  });

  test("an absent requestTimeoutMs means the documented default", () => {
    const result = validateGatewayEndpointInput({
      baseUrl: "https://gateway.internal",
    });
    expect(result).toMatchObject({
      ok: true,
      settings: {
        baseUrl: "https://gateway.internal",
        requestTimeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
      },
    });
  });

  test("non-object input is refused", () => {
    for (const input of [null, "https://gateway.internal", 42, []]) {
      expect(validateGatewayEndpointInput(input).ok).toBe(false);
    }
  });
});

describe("gateway endpoint boot configuration", () => {
  const baseEnvironment = {
    DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
    KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
    BETTER_AUTH_SECRET: "a-long-enough-local-development-auth-secret",
    BETTER_AUTH_URL: "http://localhost:3001",
    INITIAL_ADMIN_EMAILS: "admin@openbot.test",
    INTELLIGENCE_API_URL: "http://localhost:7100",
    INTELLIGENCE_GATEWAY_WS_URL: "ws://localhost:7103",
    INTELLIGENCE_API_KEY: "tenant-api-key",
  };

  test("no BIFROST_GATEWAY_* variables means no gateway configuration", () => {
    expect(loadConfig(baseEnvironment).gateway).toBeUndefined();
  });

  test("a valid URL configures the gateway with the default timeout", () => {
    const config = loadConfig({
      ...baseEnvironment,
      BIFROST_GATEWAY_URL: "http://localhost:8090",
    });
    expect(config.gateway).toEqual({
      baseUrl: "http://localhost:8090",
      requestTimeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
    });
  });

  test("the timeout is read and honoured", () => {
    const config = loadConfig({
      ...baseEnvironment,
      BIFROST_GATEWAY_URL: "http://localhost:8090",
      BIFROST_GATEWAY_REQUEST_TIMEOUT_MS: "2500",
    });
    expect(config.gateway).toEqual({
      baseUrl: "http://localhost:8090",
      requestTimeoutMs: 2500,
    });
  });

  test("an invalid gateway URL stops the server naming the variable", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        BIFROST_GATEWAY_URL: "http://admin:secret@gateway.internal:8080",
      }),
    ).toThrow(/BIFROST_GATEWAY_URL/);
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        BIFROST_GATEWAY_URL: "https://gateway.internal/v1",
      }),
    ).toThrow(/BIFROST_GATEWAY_URL/);
  });

  test("an invalid timeout stops the server naming the variable", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        BIFROST_GATEWAY_URL: "http://localhost:8090",
        BIFROST_GATEWAY_REQUEST_TIMEOUT_MS: "soon",
      }),
    ).toThrow(/BIFROST_GATEWAY_REQUEST_TIMEOUT_MS/);
  });
});

describe("gateway endpoint service", () => {
  const actor = { userId: "user-1", email: "admin@openbot.test" };

  test("a read with no saved row and no environment default is unconfigured", async () => {
    const service = createGatewayEndpointService({ store: fakeStore() });
    expect(await service.readGatewayEndpoint()).toBeUndefined();
  });

  test("a read falls back to the boot environment default at version 0", async () => {
    const service = createGatewayEndpointService({
      store: fakeStore(),
      envDefault: {
        baseUrl: "http://env-gateway:8090",
        requestTimeoutMs: 5000,
        configVersion: 0,
      },
    });
    expect(await service.readGatewayEndpoint()).toEqual({
      baseUrl: "http://env-gateway:8090",
      requestTimeoutMs: 5000,
      configVersion: 0,
    });
  });

  test("a saved row wins over the environment default", async () => {
    const saved: GatewayEndpointConfig = {
      baseUrl: "http://saved-gateway:8090",
      requestTimeoutMs: 6000,
      configVersion: 3,
    };
    const service = createGatewayEndpointService({
      store: fakeStore({
        readGatewayEndpointRow: async () => ({
          state: "configured",
          config: saved,
        }),
      }),
      envDefault: {
        baseUrl: "http://env-gateway:8090",
        requestTimeoutMs: 5000,
        configVersion: 0,
      },
    });
    expect(await service.readGatewayEndpoint()).toEqual(saved);
  });

  test("a corrupted stored row reads as unconfigured, not as the environment default", async () => {
    // A consumer that has seen version N must not be handed 0 by a damaged row: the fallback to
    // the environment's address is for "never saved", never for "saved and broken".
    const service = createGatewayEndpointService({
      store: fakeStore({
        readGatewayEndpointRow: async () => ({ state: "corrupted" }),
      }),
      envDefault: {
        baseUrl: "http://env-gateway:8090",
        requestTimeoutMs: 5000,
        configVersion: 0,
      },
    });
    expect(await service.readGatewayEndpoint()).toBeUndefined();
  });

  test("a non-administrator is refused and nothing is written", async () => {
    let wrote = false;
    const service = createGatewayEndpointService({
      store: fakeStore({
        member: async () => ({ role: "user", groups: [] }),
        writeGatewayEndpointRow: async (settings) => {
          wrote = true;
          return { ...settings, configVersion: 1 };
        },
      }),
    });
    const result = await service.saveGatewayEndpoint(
      { baseUrl: "https://gateway.internal" },
      actor,
    );
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(wrote).toBe(false);
  });

  test("a member lookup that fails refuses the save rather than skipping the check", async () => {
    const service = createGatewayEndpointService({
      store: fakeStore({
        member: async () => {
          throw new Error("database unavailable");
        },
      }),
    });
    const result = await service.saveGatewayEndpoint(
      { baseUrl: "https://gateway.internal" },
      actor,
    );
    expect(result).toMatchObject({ ok: false, status: 503 });
  });

  test("an administrator's save returns the stored configuration", async () => {
    const service = createGatewayEndpointService({
      store: fakeStore({
        writeGatewayEndpointRow: async (settings) => ({
          ...settings,
          configVersion: 4,
        }),
      }),
    });
    const result = await service.saveGatewayEndpoint(
      { baseUrl: "https://gateway.internal", requestTimeoutMs: 2000 },
      actor,
    );
    expect(result).toEqual({
      ok: true,
      config: {
        baseUrl: "https://gateway.internal",
        requestTimeoutMs: 2000,
        configVersion: 4,
      },
    });
  });

  test("an invalid input is a 400 carrying the explainable reason", async () => {
    const service = createGatewayEndpointService({ store: fakeStore() });
    const result = await service.saveGatewayEndpoint(
      { baseUrl: "ftp://gateway.internal" },
      actor,
    );
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) expect(result.error).toMatch(/http/i);
  });

  test("the read result carries no credential or secret field", async () => {
    const saved: GatewayEndpointConfig = {
      baseUrl: "https://gateway.internal",
      requestTimeoutMs: 6000,
      configVersion: 2,
    };
    const service = createGatewayEndpointService({
      store: fakeStore({
        readGatewayEndpointRow: async () => ({
          state: "configured",
          config: saved,
        }),
      }),
    });
    const read = await service.readGatewayEndpoint();
    expect(Object.keys(read as object).sort()).toEqual([
      "baseUrl",
      "configVersion",
      "requestTimeoutMs",
    ]);
    const serialized = JSON.stringify(read);
    expect(serialized).not.toMatch(/secret|credential|token|key|password/i);
  });
});
