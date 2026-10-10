import { describe, expect, test } from "bun:test";

import { enterpriseRuntimeConfig } from "../../src/enterprise/runtime/config";

const BASE_DB = "postgres://run_writer:pw@localhost:5434/openbot_test";
const RUNTIME_DB = "postgres://runtime_writer:pw@localhost:5434/openbot_test";

const ENABLED_ENV: Record<string, string | undefined> = {
  ENTERPRISE_RUNTIME_SERVICE_CREDENTIAL: "shared-secret",
  ENTERPRISE_RUNTIME_EXECUTION_URL: "http://127.0.0.1:4202/internal/enterprise/v1/runtime/execution",
  ENTERPRISE_RUNTIME_CANCEL_URL: "http://127.0.0.1:4202/internal/enterprise/v1/runtime/cancel",
  ENTERPRISE_RUNTIME_RUN_WRITER_DATABASE_URL: BASE_DB,
  ENTERPRISE_RUNTIME_RUNTIME_WRITER_DATABASE_URL: RUNTIME_DB,
  ENTERPRISE_RUNTIME_MODEL_BASE_URL: "https://open.bigmodel.cn/api/paas/v4",
  ENTERPRISE_RUNTIME_MODEL_ALIAS: "GLM-5.3",
  ENTERPRISE_RUNTIME_MODEL_ROUTE_REF: "glm-53-default",
  ENTERPRISE_RUNTIME_EXPERT: "assistant-v1=/srv/experts/assistant-v1.txt",
};

describe("enterpriseRuntimeConfig", () => {
  test("no runtime keys at all means the candidate is disabled", () => {
    expect(enterpriseRuntimeConfig({})).toBeUndefined();
    // An empty string is "not set", same as absent.
    expect(
      enterpriseRuntimeConfig({ ENTERPRISE_RUNTIME_SERVICE_CREDENTIAL: "  " }),
    ).toBeUndefined();
  });

  test("a fully configured block parses with documented defaults", () => {
    const config = enterpriseRuntimeConfig(ENABLED_ENV);
    expect(config).toBeDefined();
    expect(config?.serviceCredential).toBe("shared-secret");
    expect(config?.serviceId).toBe("runtime-go-1");
    expect(config?.expertVersion).toBe("assistant-v1");
    expect(config?.expertInstructionPath).toBe("/srv/experts/assistant-v1.txt");
    expect(config?.governedTools).toEqual([]);
    expect(config?.budgetCapMicros).toBe(2_000_000);
    expect(config?.budgetCurrency).toBe("USD");
    expect(config?.leaseTtlMs).toBe(600_000);
    expect(config?.capabilityTtlMs).toBe(300_000);
    expect(config?.modelCredential).toBeUndefined();
  });

  test("a partial block is a boot failure naming every missing key", () => {
    const partial = { ...ENABLED_ENV } as Record<string, string | undefined>;
    delete partial.ENTERPRISE_RUNTIME_EXECUTION_URL;
    delete partial.ENTERPRISE_RUNTIME_EXPERT;
    expect(() => enterpriseRuntimeConfig(partial)).toThrow(
      /missing ENTERPRISE_RUNTIME_EXECUTION_URL, ENTERPRISE_RUNTIME_EXPERT/,
    );
  });

  test("governed tools parse as pinned pairs and refuse duplicates", () => {
    const withTools = {
      ...ENABLED_ENV,
      ENTERPRISE_RUNTIME_GOVERNED_TOOLS: "enterprise_echo=v1, lookup=2026.1.0",
    };
    expect(enterpriseRuntimeConfig(withTools)?.governedTools).toEqual([
      { name: "enterprise_echo", installationVersion: "v1" },
      { name: "lookup", installationVersion: "2026.1.0" },
    ]);

    const duplicated = {
      ...ENABLED_ENV,
      ENTERPRISE_RUNTIME_GOVERNED_TOOLS: "a=v1,a=v2",
    };
    expect(() => enterpriseRuntimeConfig(duplicated)).toThrow(/names a twice/);
  });

  test("execution and model endpoints must be credential-free absolute http(s) URLs", () => {
    const badUrl = {
      ...ENABLED_ENV,
      ENTERPRISE_RUNTIME_EXECUTION_URL: "127.0.0.1:4202/exec",
    };
    expect(() => enterpriseRuntimeConfig(badUrl)).toThrow(
      /EXECUTION_URL must be an absolute/,
    );

    const withPassword = {
      ...ENABLED_ENV,
      ENTERPRISE_RUNTIME_MODEL_BASE_URL: "https://user:pw@bigmodel.example/api",
    };
    expect(() => enterpriseRuntimeConfig(withPassword)).toThrow(
      /without credentials/,
    );
  });

  test("expert must be exactly one version=path pair", () => {
    expect(() =>
      enterpriseRuntimeConfig({ ...ENABLED_ENV, ENTERPRISE_RUNTIME_EXPERT: "assistant" }),
    ).toThrow(/exactly one version=instruction-path pair/);
    expect(() =>
      enterpriseRuntimeConfig({ ...ENABLED_ENV, ENTERPRISE_RUNTIME_EXPERT: "a=b=c" }),
    ).toThrow(/exactly one version=instruction-path pair/);
  });

  test("numeric bounds are refused rather than coerced", () => {
    expect(() =>
      enterpriseRuntimeConfig({ ...ENABLED_ENV, ENTERPRISE_RUNTIME_LEASE_TTL_MS: "soon" }),
    ).toThrow(/LEASE_TTL_MS must be a whole number/);
    expect(() =>
      enterpriseRuntimeConfig({ ...ENABLED_ENV, ENTERPRISE_RUNTIME_BUDGET_CURRENCY: "usd" }),
    ).toThrow(/three-letter currency code/);
  });
});
