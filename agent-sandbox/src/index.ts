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
// idleTimeout 0 disables Bun's default request timeout: an /events response is deliberately
// unbounded — it lives as long as its listener does, with our own 15s keepalives proving the
// connection is alive from the inside. Bun's 10s default would cut every quiet stream off at
// the knees while the client still held it open.
const server = serve({
  port: env.port,
  hostname: "0.0.0.0",
  fetch: handler,
  idleTimeout: 0,
});
log("sandbox-listening", { port: env.port, mode: "per-bot", version: SANDBOX_VERSION, configPath });

// 清扫循环：空闲回收 + 可选工作区 TTL + 活动超时（静默流回收）
const sweep = setInterval(() => {
  const now = Date.now();
  const { idle, stalled } = runtimes.reapIdle(now);
  if (idle.length > 0) log("sandbox-runtimes-reaped", { bots: idle });
  // A stalled stop is a failure to report, not housekeeping: each one names the Bot and how
  // long its stream had been silent, so a deployment can tell a hung turn from a quiet one.
  for (const botId of stalled) {
    log("sandbox-runtime-stalled", { botId });
  }
}, env.sweepIntervalMs);
sweep.unref?.();

process.on("SIGTERM", () => {
  log("sandbox-stopping");
  server.stop(true);
  void runtimes.stopAll().finally(() => process.exit(0));
});
