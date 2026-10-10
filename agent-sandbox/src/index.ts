/**
 * The sandbox process: write the config, stand up the per-bot runtime registry, proxy in front of it.
 *
 * Structured single-line JSON logs only (the deployment's log shipper parses this shape), and the
 * token never appears in any of them.
 */
import { serve } from "bun";
import { SANDBOX_VERSION } from "./version";
import { sandboxEnvFrom } from "./env";
import { writeOpencodeConfig } from "./opencode-config";
import { createProxyHandler } from "./proxy";
import { createBotRuntimes } from "./bot-runtimes";

const log = (type: string, detail: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ type, ...detail }));

const env = sandboxEnvFrom(process.env);
const configPath = await writeOpencodeConfig(env);

const runtimes = createBotRuntimes({ env });
const handler = createProxyHandler(env, runtimes);
const server = serve({ port: env.port, hostname: "0.0.0.0", fetch: handler });
log("sandbox-listening", { port: env.port, mode: "per-bot", version: SANDBOX_VERSION, configPath });

// 清扫循环：空闲回收 + 可选工作区 TTL
const sweep = setInterval(() => {
  const reaped = runtimes.reapIdle(Date.now());
  if (reaped.length > 0) log("sandbox-runtimes-reaped", { bots: reaped });
}, env.sweepIntervalMs);
sweep.unref?.();

process.on("SIGTERM", () => {
  log("sandbox-stopping");
  server.stop(true);
  void runtimes.stopAll().finally(() => process.exit(0));
});
