import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

/*
 * The billing configuration is an all-or-nothing block: everything here asserts either the block
 * absent (a free deployment), or the block whole and refused where it is half-shaped. The base
 * environment is the one config.test.ts uses, so a case that fails on something besides LAGO_* is
 * a case about the base, and gets fixed in the base.
 */
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
  COPILOTKIT_LICENSE_TOKEN: "license-token",
  MANAGED_AGENT_AG_UI_URL: " http://localhost:4200/ag-ui ",
  MANAGED_AGENT_TOKEN: "managed-agent-token",
};

describe("billing configuration", () => {
  test("no LAGO_* variables at all means no billing surface", () => {
    const config = loadConfig(baseEnvironment);
    expect(config.billing).toBeUndefined();
  });

  test("a URL without a key stops the server", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com",
      }),
    ).toThrow(/LAGO_API_URL and LAGO_API_KEY must be set together/);
  });

  test("a key without a URL stops the server", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_KEY: "provider-bearer-key",
      }),
    ).toThrow(/LAGO_API_URL and LAGO_API_KEY must be set together/);
  });

  test("a URL ending in /api/v1 is refused with the origin-only reminder", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com/api/v1",
        LAGO_API_KEY: "provider-bearer-key",
      }),
    ).toThrow(/origin.*the client adds the \/api\/v1 prefix itself/s);
  });

  test("a URL with any other path is refused too", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com/lago",
        LAGO_API_KEY: "provider-bearer-key",
      }),
    ).toThrow(/provider origin only, without a path/);
  });

  test("a URL with a query or fragment is refused", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com?x=1",
        LAGO_API_KEY: "provider-bearer-key",
      }),
    ).toThrow(/provider origin only/);
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com/#here",
        LAGO_API_KEY: "provider-bearer-key",
      }),
    ).toThrow(/provider origin only/);
  });

  test("a non-http(s) URL is refused, matching the outbound policy's scheme allow-list", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "ftp://api.getlago.com",
        LAGO_API_KEY: "provider-bearer-key",
      }),
    ).toThrow(/http or https/);
  });

  test("credentials in the URL are refused; the key has its own variable", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://user:pass@api.getlago.com",
        LAGO_API_KEY: "provider-bearer-key",
      }),
    ).toThrow(/must not carry credentials/);
  });

  test("both webhook keys together stop the server", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com",
        LAGO_API_KEY: "provider-bearer-key",
        LAGO_WEBHOOK_SECRET: "hmac-token",
        LAGO_WEBHOOK_PUBLIC_KEY:
          "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----",
      }),
    ).toThrow(/exactly one/);
  });

  test("malformed plan entitlements JSON stops the server", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com",
        LAGO_API_KEY: "provider-bearer-key",
        LAGO_PLAN_ENTITLEMENTS: "{pro",
      }),
    ).toThrow(/LAGO_PLAN_ENTITLEMENTS must be valid JSON/);
  });

  test("plan entitlements of the wrong shape stop the server", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com",
        LAGO_API_KEY: "provider-bearer-key",
        LAGO_PLAN_ENTITLEMENTS: '["pro"]',
      }),
    ).toThrow(/must be a JSON object/);
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com",
        LAGO_API_KEY: "provider-bearer-key",
        LAGO_PLAN_ENTITLEMENTS: '{"pro": "intelligence"}',
      }),
    ).toThrow(/must be a list of non-empty entitlement codes/);
  });

  test("a request timeout that is not a positive whole number stops the server", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com",
        LAGO_API_KEY: "provider-bearer-key",
        LAGO_REQUEST_TIMEOUT_MS: "zero",
      }),
    ).toThrow(/whole number of milliseconds/);
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LAGO_API_URL: "https://api.getlago.com",
        LAGO_API_KEY: "provider-bearer-key",
        LAGO_REQUEST_TIMEOUT_MS: "-5",
      }),
    ).toThrow(/whole number of milliseconds/);
  });

  test("the minimal legal pair resolves with every field in its default shape", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
    });
    expect(config.billing).toEqual({
      apiUrl: "https://api.getlago.com",
      apiKey: "provider-bearer-key",
      webhookMode: "off",
      webhookKey: undefined,
      allowPrivateHosts: false,
      planEntitlements: new Map(),
    });
  });

  test("the jwt webhook key selects jwt mode and is carried verbatim", () => {
    const pem = "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----";
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
      LAGO_WEBHOOK_PUBLIC_KEY: pem,
    });
    expect(config.billing?.webhookMode).toBe("jwt");
    expect(config.billing?.webhookKey).toEqual({
      mode: "jwt",
      publicKeyPem: pem,
    });
  });

  test("the hmac webhook key selects hmac mode", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
      LAGO_WEBHOOK_SECRET: "endpoint-hmac-token",
    });
    expect(config.billing?.webhookMode).toBe("hmac");
    expect(config.billing?.webhookKey).toEqual({
      mode: "hmac",
      key: "endpoint-hmac-token",
    });
  });

  test("the plan map resolves into plan code → entitlement codes", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
      LAGO_PLAN_ENTITLEMENTS: '{"pro": ["intelligence", "teams"], "trial": []}',
    });
    expect(config.billing?.planEntitlements).toEqual(
      new Map([
        ["pro", ["intelligence", "teams"]],
        ["trial", []],
      ]),
    );
  });

  test("a legal timeout and the private-host opt-in are carried", () => {
    const config = loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://api.getlago.com",
      LAGO_API_KEY: "provider-bearer-key",
      LAGO_REQUEST_TIMEOUT_MS: "25000",
      LAGO_ALLOW_PRIVATE_HOSTS: "true",
    });
    expect(config.billing?.requestTimeoutMs).toBe(25_000);
    expect(config.billing?.allowPrivateHosts).toBe(true);
  });
});
