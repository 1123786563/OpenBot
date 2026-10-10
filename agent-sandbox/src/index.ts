/**
 * The sandbox process: write the config, start opencode, stand in front of it.
 *
 * Structured single-line JSON logs only (the deployment's log shipper parses this shape), and the
 * token never appears in any of them.
 */
import { serve } from "bun";
import { SANDBOX_VERSION } from "./version";
import { sandboxEnvFrom } from "./env";
import { writeOpencodeConfig } from "./opencode-config";
import { createProxyHandler } from "./proxy";
import { startOpencodeServe } from "./upstream";

const log = (type: string, detail: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ type, ...detail }));

const env = sandboxEnvFrom(process.env);
const configPath = await writeOpencodeConfig(env);
const upstream = startOpencodeServe({
  bin: process.env.SANDBOX_OPENCODE_BIN?.trim() || "opencode",
  port: env.upstreamPort,
  cwd: env.workspaceDir,
  configDir: env.configDir,
});
await upstream.ready;
log("sandbox-upstream-ready", { version: SANDBOX_VERSION, model: env.model, configPath });

const handler = createProxyHandler(env, env.upstreamPort);
const server = serve({ port: env.port, hostname: "0.0.0.0", fetch: handler });
log("sandbox-listening", { port: env.port });

process.on("SIGTERM", () => {
  log("sandbox-stopping");
  upstream.kill("SIGTERM");
  server.stop(true);
  process.exit(0);
});
upstream.exited.then((code) => {
  log("sandbox-upstream-exited", { code });
  server.stop(true);
  process.exit(code === 0 ? 0 : 1);
});
