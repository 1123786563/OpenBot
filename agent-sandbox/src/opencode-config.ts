/**
 * The opencode config the sandbox generates at start-up.
 *
 * The provider id is `openbot`, never `glm`: a developer machine often carries a personal `glm`
 * provider in its global config, and plugins there resolve their own default model, which is how a
 * run died with ProviderModelNotFoundError during the 2026-10-10 smoke test. An id nothing else
 * uses plus an explicit model is the fix; the sandbox never relies on opencode's default
 * resolution.
 *
 * `webfetch: deny` because the sandbox's only sanctioned network route is the model endpoint, and
 * the model call goes through the provider, not through a tool. `share: disabled` because session
 * transcripts hold whatever the task's workspace held.
 *
 * The key is written literally (not `{env:}`): this file lives inside the container on a volume
 * whose permissions are the boundary, and the process env is not more secret than the file.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxEnv } from "./env";

export async function writeOpencodeConfig(
  env: SandboxEnv,
  configDir: string = env.configDir,
): Promise<string> {
  await mkdir(configDir, { recursive: true });
  const body = {
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    // Belt and suspenders: the permission gate asks, the tools map removes the tool entirely.
    // Craft does the same job with an env-driven disabled-tools list; a fixed deny is enough for
    // a sandbox whose only sanctioned network route is the model endpoint itself.
    permission: { edit: "allow", bash: "allow", webfetch: "deny" },
    tools: { webfetch: false },
    provider: {
      openbot: {
        npm: "@ai-sdk/openai-compatible",
        name: "OpenBot model gateway",
        options: {
          baseURL: env.providerBaseUrl,
          apiKey: env.providerApiKey,
        },
        models: { [env.model]: { name: env.model } },
      },
    },
    model: `openbot/${env.model}`,
  };
  // opencode reads its GLOBAL config from $XDG_CONFIG_HOME/opencode/opencode.json — one level
  // deeper than the file this volume's first version wrote, which is how a healthy-looking
  // /config/opencode.json left every model lookup answering "Model not found".
  const path = join(configDir, "opencode", "opencode.json");
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(join(configDir, "opencode"), { recursive: true });
  await writeFile(temporary, JSON.stringify(body, null, 2), { mode: 0o600 });
  await chmod(temporary, 0o600);
  // Rename over so a half-written file can never be the one opencode reads.
  await import("node:fs/promises").then((m) => m.rename(temporary, path));
  return path;
}
