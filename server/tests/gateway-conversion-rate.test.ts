import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { parseConversionRateInput } from "../src/gateway/conversion-rate";

/*
 * The start-up path cases use the base environment config.test.ts / billing-config.test.ts use, so
 * a failure on something besides BIFROST_CONVERSION_RATE_PER_USD is a case about the base.
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

describe("parseConversionRateInput", () => {
  test("accepts a plain decimal and keeps it exact", () => {
    const r = parseConversionRateInput("7.5");
    if (!r.ok) throw new Error(r.error);
    expect(r.value.numerator).toBe(75n);
    expect(r.value.denominator).toBe(10n);
  });
  test("rejects unset, zero, negative, non-numeric, and over-precision", () => {
    for (const bad of [undefined, "", "0", "0.0", "-1", "abc", "1.2345678"]) {
      const r = parseConversionRateInput(bad);
      expect(r.ok).toBe(false);
      expect(typeof r.error).toBe("string");
    }
  });
  test("a tiny rate survives a round trip without float error", () => {
    const r = parseConversionRateInput("0.300001");
    if (!r.ok) throw new Error(r.error);
    expect(r.value.numerator).toBe(300001n);
    expect(r.value.denominator).toBe(1000000n);
  });
});

describe("BIFROST_CONVERSION_RATE_PER_USD at start-up", () => {
  test("absent means billing not enabled (undefined), never a default", () => {
    expect(loadConfig(baseEnvironment).bifrostConversionRate).toBeUndefined();
  });

  test("a valid value lands on the config exactly as the parser read it", () => {
    const config = loadConfig({ ...baseEnvironment, BIFROST_CONVERSION_RATE_PER_USD: "7.5" });
    expect(config.bifrostConversionRate).toEqual({ numerator: 75n, denominator: 10n });
  });

  test("an invalid value stops the server with the parser's reason", () => {
    expect(() => loadConfig({ ...baseEnvironment, BIFROST_CONVERSION_RATE_PER_USD: "0" })).toThrow(
      /BIFROST_CONVERSION_RATE_PER_USD: .*/,
    );
    expect(() => loadConfig({ ...baseEnvironment, BIFROST_CONVERSION_RATE_PER_USD: "1.2345678" })).toThrow(
      /at most 6 places/,
    );
  });
});
