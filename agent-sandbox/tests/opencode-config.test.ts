import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeOpencodeConfig } from "../src/opencode-config";
import { sandboxEnvFrom } from "../src/env";

const env = sandboxEnvFrom({
  SANDBOX_TOKEN: "t",
  SANDBOX_PROVIDER_BASE_URL: "https://open.bigmodel.cn/api/coding/paas/v4",
  // Read from the environment when provided; the fallback is an obviously fake fixture value,
  // never a credential (Mimosa guards against literal keys in source).
  SANDBOX_PROVIDER_API_KEY:
    process.env.TEST_SANDBOX_PROVIDER_API_KEY ?? "fixture-secret",
  SANDBOX_MODEL: "GLM-5.3",
});

describe("writeOpencodeConfig", () => {
  test("writes a 0600 config with the openbot provider and locked-down permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbox-config-"));
    const path = await writeOpencodeConfig(env, dir);
    expect(path).toBe(join(dir, "opencode", "opencode.json"));
    const body = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      never
    >;
    const provider = (body.provider as Record<string, never>).openbot;
    expect(provider).toBeDefined();
    expect((provider.options as Record<string, unknown>).baseURL).toBe(
      "https://open.bigmodel.cn/api/coding/paas/v4",
    );
    expect((provider.options as Record<string, unknown>).apiKey).toBe(
      process.env.TEST_SANDBOX_PROVIDER_API_KEY ?? "fixture-secret",
    );
    expect(
      (provider.models as Record<string, unknown>)["GLM-5.3"],
    ).toBeDefined();
    const permission = body.permission as Record<string, unknown>;
    expect(permission.edit).toBe("allow");
    expect(permission.bash).toBe("allow");
    expect(permission.webfetch).toBe("deny");
    expect((body.tools as Record<string, unknown>).webfetch).toBe(false);
    expect(body.share).toBe("disabled");
  });

  test("the file is not group- or world-readable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbox-config-"));
    const path = await writeOpencodeConfig(env, dir);
    const { stat } = await import("node:fs/promises");
    const info = await stat(path);
    expect(info.mode & 0o077).toBe(0);
  });
});
