import { describe, expect, test } from "bun:test";
import {
  type HindsightPrivacyEnv,
  loadHindsightConfig,
  parseHindsightPrivacy,
  validateHindsightPrivacy,
} from "../src/hindsight/config";

/** A privacy block that satisfies every rule the spec pins down. */
const compliantPrivacy: HindsightPrivacyEnv = {
  HINDSIGHT_PRIVACY_LLM_TRACE_ENABLED: "false",
  HINDSIGHT_PRIVACY_OPERATION_RETENTION_DAYS: "1",
  HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS: "30",
};

describe("parseHindsightPrivacy", () => {
  test("parses a compliant declaration", () => {
    const privacy = parseHindsightPrivacy(compliantPrivacy);
    expect(privacy.llmTraceEnabled).toBe(false);
    expect(privacy.operationRetentionDays).toBe(1);
    expect(privacy.backupRetentionDays).toBe(30);
    expect(validateHindsightPrivacy(privacy).compliant).toBe(true);
  });

  test("missing privacy settings parse to an unconfigured block, not defaults", () => {
    const privacy = parseHindsightPrivacy({});
    expect(privacy.llmTraceEnabled).toBeNull();
    expect(privacy.operationRetentionDays).toBeNull();
    expect(privacy.backupRetentionDays).toBeNull();
    const result = validateHindsightPrivacy(privacy);
    expect(result.compliant).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  test("rejects values that are not whole numbers of days", () => {
    for (const bad of ["0.5", "-1", "abc", ""]) {
      const privacy = parseHindsightPrivacy({
        ...compliantPrivacy,
        HINDSIGHT_PRIVACY_OPERATION_RETENTION_DAYS: bad,
      });
      expect(privacy.operationRetentionDays).toBeNull();
    }
  });
});

describe("validateHindsightPrivacy", () => {
  test("tracing enabled is noncompliant", () => {
    const result = validateHindsightPrivacy(
      parseHindsightPrivacy({
        ...compliantPrivacy,
        HINDSIGHT_PRIVACY_LLM_TRACE_ENABLED: "true",
      }),
    );
    expect(result.compliant).toBe(false);
    expect(result.violations).toContain("llm_trace_enabled");
  });

  test("operation payload retention above one day is noncompliant", () => {
    const result = validateHindsightPrivacy(
      parseHindsightPrivacy({
        ...compliantPrivacy,
        HINDSIGHT_PRIVACY_OPERATION_RETENTION_DAYS: "2",
      }),
    );
    expect(result.compliant).toBe(false);
    expect(result.violations).toContain("operation_retention_days");
  });

  test("zero-day operation retention keeps no payloads at all and is compliant", () => {
    const result = validateHindsightPrivacy(
      parseHindsightPrivacy({
        ...compliantPrivacy,
        HINDSIGHT_PRIVACY_OPERATION_RETENTION_DAYS: "0",
      }),
    );
    expect(result.compliant).toBe(true);
  });

  test("backup retention above thirty days is noncompliant", () => {
    const result = validateHindsightPrivacy(
      parseHindsightPrivacy({
        ...compliantPrivacy,
        HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS: "31",
      }),
    );
    expect(result.compliant).toBe(false);
    expect(result.violations).toContain("backup_retention_days");
  });

  test("zero-day backup retention is noncompliant, matching backup.sh's 0 refusal", () => {
    const result = validateHindsightPrivacy(
      parseHindsightPrivacy({
        ...compliantPrivacy,
        HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS: "0",
      }),
    );
    expect(result.compliant).toBe(false);
    expect(result.violations).toContain("backup_retention_days");
  });

  test("each missing declaration is reported separately", () => {
    const result = validateHindsightPrivacy(parseHindsightPrivacy({}));
    expect(result.violations).toContain("llm_trace_enabled");
    expect(result.violations).toContain("operation_retention_days");
    expect(result.violations).toContain("backup_retention_days");
  });
});

describe("loadHindsightConfig", () => {
  const baseEnv = {
    HINDSIGHT_API_URL: "http://127.0.0.1:8888",
    HINDSIGHT_API_TOKEN: "secret-token",
    HINDSIGHT_MODEL_GATEWAY_URL: "http://127.0.0.1:9100",
    HINDSIGHT_MODEL_GATEWAY_API_KEY: "gateway-key",
    ...compliantPrivacy,
  };

  test("loads a fully declared compliant config", () => {
    const config = loadHindsightConfig(baseEnv);
    expect(config.apiUrl).toBe("http://127.0.0.1:8888");
    expect(config.apiToken).toBe("secret-token");
    expect(config.modelGatewayUrl).toBe("http://127.0.0.1:9100");
    expect(config.modelGatewayApiKey).toBe("gateway-key");
    expect(config.bankId).toBe("default");
    expect(config.privacy.llmTraceEnabled).toBe(false);
    expect(validateHindsightPrivacy(config.privacy).compliant).toBe(true);
  });

  test("refuses an API URL that is not http(s)", () => {
    expect(() =>
      loadHindsightConfig({ ...baseEnv, HINDSIGHT_API_URL: "ftp://hindsight" }),
    ).toThrow(/HINDSIGHT_API_URL/);
    expect(() =>
      loadHindsightConfig({ ...baseEnv, HINDSIGHT_API_URL: "not a url" }),
    ).toThrow(/HINDSIGHT_API_URL/);
  });

  test("refuses a gateway URL carrying credentials or a path", () => {
    expect(() =>
      loadHindsightConfig({
        ...baseEnv,
        HINDSIGHT_MODEL_GATEWAY_URL: "http://key@127.0.0.1:9100",
      }),
    ).toThrow(/HINDSIGHT_MODEL_GATEWAY_URL/);
    expect(() =>
      loadHindsightConfig({
        ...baseEnv,
        HINDSIGHT_MODEL_GATEWAY_URL: "http://127.0.0.1:9100/v1",
      }),
    ).toThrow(/HINDSIGHT_MODEL_GATEWAY_URL/);
  });

  test("refuses a missing or partial connection declaration", () => {
    expect(() => loadHindsightConfig({})).toThrow(/HINDSIGHT_API_URL/);
    expect(() =>
      loadHindsightConfig({ ...baseEnv, HINDSIGHT_API_TOKEN: "" }),
    ).toThrow(/HINDSIGHT_API_TOKEN/);
    expect(() =>
      loadHindsightConfig({
        ...baseEnv,
        HINDSIGHT_MODEL_GATEWAY_URL: "",
        HINDSIGHT_MODEL_GATEWAY_API_KEY: "gateway-key",
      }),
    ).toThrow(/HINDSIGHT_MODEL_GATEWAY_URL/);
  });

  test("compliance violations name the rule, never the configured value", () => {
    const result = validateHindsightPrivacy(
      parseHindsightPrivacy({
        ...compliantPrivacy,
        HINDSIGHT_PRIVACY_LLM_TRACE_ENABLED: "true",
      }),
    );
    expect(result.violations).toEqual(["llm_trace_enabled"]);
  });
});
