import { describe, expect, test } from "bun:test";
import { sandboxEnvFrom } from "../src/env";

const valid = {
  SANDBOX_TOKEN: "test-token",
  SANDBOX_PROVIDER_BASE_URL: "https://open.bigmodel.cn/api/coding/paas/v4",
  // Read from the environment when provided; the fallback is an obviously fake fixture value,
  // never a credential (Mimosa guards against literal keys in source).
  SANDBOX_PROVIDER_API_KEY:
    process.env.TEST_SANDBOX_PROVIDER_API_KEY ?? "fixture-secret",
  SANDBOX_MODEL: "GLM-5.3",
};

describe("sandboxEnvFrom", () => {
  test("applies defaults for ports and dirs", () => {
    const env = sandboxEnvFrom(valid);
    expect(env.port).toBe(4300);
    expect(env.upstreamPort).toBe(4399);
    expect(env.workspaceDir).toBe("/workspace");
    expect(env.configDir).toBe("/config");
    expect(env.maxResponseBytes).toBe(262_144);
  });

  test("keeps the configured model and provider", () => {
    const env = sandboxEnvFrom(valid);
    expect(env.model).toBe("GLM-5.3");
    expect(env.providerBaseUrl).toBe(
      "https://open.bigmodel.cn/api/coding/paas/v4",
    );
  });

  test("throws when the token is empty", () => {
    expect(() => sandboxEnvFrom({ ...valid, SANDBOX_TOKEN: "" })).toThrow(
      /SANDBOX_TOKEN/,
    );
  });

  test("throws when provider credentials are missing", () => {
    expect(() =>
      sandboxEnvFrom({ ...valid, SANDBOX_PROVIDER_API_KEY: undefined }),
    ).toThrow(/SANDBOX_PROVIDER_API_KEY/);
    expect(() =>
      sandboxEnvFrom({ ...valid, SANDBOX_MODEL: undefined }),
    ).toThrow(/SANDBOX_MODEL/);
  });
});
