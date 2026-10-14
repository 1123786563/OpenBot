/**
 * The connect-app plugin's server-side delivery — the workspace-born half of
 * the handshake (the plugin source itself is
 * templates/connect-app.plugin.ts, ported verbatim from onyx's
 * `sandbox/image/opencode-plugins/connect-app.ts`).
 *
 * onyx bakes the plugin into its sandbox image; OpenBot cannot change the
 * agent-sandbox image, so the plugin ships per-session in the workspace beside
 * the turn-budget plugin (the established shape: written by workspace setup
 * and every config regenerate). Managed content is server-owned: the session's
 * permission rules deny the agent edit/write on the `.opencode/plugin/` tree
 * (PROTECTED_FILE_RULES in opencode-config.ts), so the tool schema the agent
 * calls is always the one this server shipped.
 */

import { readFile } from "node:fs/promises";
import type { CraftConfig } from "./config";
import { CONNECT_APP_PLUGIN_RELPATH } from "./session-plugins";
import { sessionDirectory } from "./workspace";

let cachedPluginSource: string | null = null;

/** The plugin's source, read once (the static asset every session workspace materializes). */
export async function connectAppPluginSource(): Promise<string> {
  if (cachedPluginSource === null) {
    cachedPluginSource = await readFile(
      new URL("./templates/connect-app.plugin.ts", import.meta.url),
      "utf8",
    );
  }
  return cachedPluginSource;
}

/** Write the plugin into a session workspace (idempotent, like every setup write). */
export async function writeConnectAppPlugin(
  api: { writeFile(path: string, content: string): Promise<void> },
  sessionId: string,
  config: CraftConfig,
): Promise<void> {
  await api.writeFile(
    `${sessionDirectory(sessionId, config.sessionDirectoryMode)}/${
      CONNECT_APP_PLUGIN_RELPATH
    }`,
    await connectAppPluginSource(),
  );
}
