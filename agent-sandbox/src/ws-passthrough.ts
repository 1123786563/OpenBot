import { connect } from "node:net";

/**
 * The websocket passthrough (B15b's sandbox half): bridge an upgraded Bun connection to the
 * Bot's dev server over a fresh websocket from this process.
 *
 * WHY NOT A RAW TCP PIPE. Bun's fetch-handler contract hands upgraded connections to the
 * `websocket` open/message handlers as websocket objects, not raw sockets — the raw socket
 * the upgrade arrived on is not exposed for piping. Rather than fight the runtime, the
 * bridge uses Bun's own websocket client (its RFC 6455, maintained by the runtime, not by
 * this file) to the dev server and shuttles TEXT/BINARY payloads between the two ends.
 *
 * WHAT THE BRIDGE DOES NOT DO: it never inspects, filters, or rewrites payloads. It decides
 * nothing — the decision (which Bot, which port) was made before the upgrade in the proxy,
 * and everything after `open` is bytes both ways. A bridge cannot misparse what it never
 * reads; it can only forward or close, and it closes when either side closes.
 */

export type BridgeSockets = {
  /** The caller's websocket (Bun's server-side object, with data already attached). */
  caller: {
    send(text: string): void;
    sendBinary(bytes: Uint8Array): void;
    close(): void;
    onMessage(handler: (kind: "text" | "binary", payload: string | Uint8Array) => void): void;
    onClose(handler: () => void): void;
  };
  /** A websocket client factory toward the dev server (Bun's `new WebSocket`, injected). */
  connectUpstream(url: string): {
    sendText(text: string): void;
    sendBytes(bytes: Uint8Array): void;
    close(): void;
    onOpen(handler: () => void): void;
    onMessage(handler: (kind: "text" | "binary", payload: string | Uint8Array) => void): void;
    onClose(handler: () => void): void;
  };
};

/** Bridge one caller websocket to `ws://127.0.0.1:<port><path>`. */
export function bridgeWebSocket(
  sockets: BridgeSockets,
  port: number,
  path: string,
): void {
  const upstream = sockets.connectUpstream(
    `ws://127.0.0.1:${port}${path.startsWith("/") ? path : `/${path}`}`,
  );
  let callerClosed = false;
  let upstreamClosed = false;
  const shutdown = () => {
    if (!callerClosed) {
      callerClosed = true;
      sockets.caller.close();
    }
    if (!upstreamClosed) {
      upstreamClosed = true;
      upstream.close();
    }
  };
  sockets.caller.onMessage((kind, payload) => {
    if (kind === "text") upstream.sendText(String(payload));
    else upstream.sendBytes(payload as Uint8Array);
  });
  upstream.onMessage((kind, payload) => {
    if (kind === "text") sockets.caller.send(String(payload));
    else sockets.caller.sendBinary(payload as Uint8Array);
  });
  sockets.caller.onClose(shutdown);
  upstream.onClose(shutdown);
  upstream.onOpen(() => {
    // The bridge is live only once the dev server answered its handshake; until then the
    // caller's messages queue on the client (Bun buffers on open by default).
  });
}

/** The TCP connect import stays for the dev-server probe below: a live port check. */
export async function devServerReachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect({ port, host: "127.0.0.1" });
    probe.on("connect", () => {
      probe.end();
      resolve(true);
    });
    probe.on("error", () => resolve(false));
  });
}
