/**
 * The sandbox process: write the config, stand up the per-bot runtime registry, proxy in front of it.
 *
 * Structured single-line JSON logs only (the deployment's log shipper parses this shape), and the
 * token never appears in any of them.
 */
import { serve, type WebSocketHandler } from "bun";
import type { Duplex } from "node:stream";
import { bridgeWebSocket } from "./ws-passthrough";
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
/**
 * The WS half of the passthrough: Bun hands the upgraded connection here with the upgrade's
 * `data` (which Bot, which dev-server port, which subprotocol and path — decided in the proxy
 * before the upgrade). The bridge is Bun's own websocket client to the dev server, shuttling
 * payloads both ways; see ws-passthrough.ts for why a parsed bridge is the honest shape here.
 */
const wsHandler: WebSocketHandler<{
  botId: string;
  port: number;
  subprotocol: string | null;
  path: string;
}> = {
  open(ws) {
    // The shim: Bun's ServerWebSocket is callback-driven (message/close on this handler),
    // while the bridge speaks a subscription shape. A small mutable-slot shim adapts the
    // two without either side learning the other's dialect.
    let onCallerMessage:
      | ((kind: "text" | "binary", payload: string | Uint8Array) => void)
      | null = null;
    let onCallerClose: (() => void) | null = null;
    const { port, path } = ws.data;
    bridgeWebSocket(
      {
        caller: {
          send: (text) => ws.send(text),
          sendBinary: (bytes) => ws.send(bytes),
          close: () => ws.close(1000),
          onMessage: (handler) => {
            onCallerMessage = handler;
          },
          onClose: (handler) => {
            onCallerClose = handler;
          },
        },
        connectUpstream: (url) => {
          const upstream = new WebSocket(url);
          return {
            sendText: (text: string) => upstream.send(text),
            sendBytes: (bytes: Uint8Array) => upstream.send(bytes),
            close: () => upstream.close(),
            onOpen: () => undefined,
            onMessage: (handler) => {
              upstream.addEventListener("message", (event: MessageEvent) => {
                const data = event.data;
                if (typeof data === "string") handler("text", data);
                else if (data instanceof ArrayBuffer)
                  handler("binary", new Uint8Array(data));
                else handler("binary", data as Uint8Array);
              });
            },
            onClose: (handler) => {
              upstream.addEventListener("close", () => handler());
            },
          };
        },
      },
      port,
      path,
    );
    // The handler-side wiring the shim feeds: message → bridge, close → shutdown.
    bridged.set(ws, { onMessage: () => onCallerMessage, onClose: () => onCallerClose });
  },
  message(ws, message) {
    bridged.get(ws)?.onMessage()?.(
      typeof message === "string" ? "text" : "binary",
      typeof message === "string" ? message : new Uint8Array(message as unknown as ArrayBuffer),
    );
  },
  close(ws) {
    bridged.get(ws)?.onClose()?.();
    bridged.delete(ws);
  },
};

/** The shim's slot table: one entry per live bridge. */
type BridgedWs = Parameters<
  NonNullable<WebSocketHandler<{ botId: string; port: number; subprotocol: string | null; path: string }>["open"]>
>[0];
const bridged = new Map<
  BridgedWs,
  { onMessage: () => ((kind: "text" | "binary", payload: string | Uint8Array) => void) | null; onClose: () => (() => void) | null }
>();

const server = serve({
  port: env.port,
  hostname: "0.0.0.0",
  fetch: (request, bunServer) => handler(request, bunServer),
  websocket: wsHandler,
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
