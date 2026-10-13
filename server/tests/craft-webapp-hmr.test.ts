import { describe, expect, test } from "bun:test";
import { loadCraftConfig } from "../src/craft/config";
import type { CraftSessionRow, CraftStore } from "../src/craft/store";
import {
  type WebappHmrDeps,
  type WebappHmrSocketData,
  resolveWebappHmrUpgrade,
  webappHmrQueryString,
  webappHmrSessionIdFromPath,
  webappHmrSocketHandlers,
  webappHmrUpstreamUrl,
} from "../src/craft/webapp-proxy";

const SESSION_ID = "cs-aaaabbbbcccc";
const HMR_PATH = `/api/craft/sessions/${SESSION_ID}/webapp/_next/webpack-hmr`;

function sessionRow(nextjsPort: number | null): CraftSessionRow {
  return {
    id: SESSION_ID,
    userId: "u1",
    name: "app",
    status: "active",
    lastActivityAt: new Date(),
    createdAt: new Date(),
    nextjsPort,
    sharingScope: "private",
    origin: "INTERACTIVE",
    opencodeSessionId: null,
    agentProvider: null,
    agentModel: null,
    skillsHash: null,
    mcpConfigHash: null,
  };
}

function hmrDeps(input: {
  ownerUserId?: string;
  nextjsPort?: number | null;
  connBaseUrl?: string | null;
  gatewayBaseUrl?: string;
}): WebappHmrDeps {
  const owner = input.ownerUserId ?? "u1";
  const port = input.nextjsPort === undefined ? 3011 : input.nextjsPort;
  return {
    config: loadCraftConfig(
      input.gatewayBaseUrl
        ? { OPENBOT_CRAFT_SANDBOX_GATEWAY_URL: input.gatewayBaseUrl }
        : {},
    ),
    store: {
      async getSession(id: string, userId: string) {
        return id === SESSION_ID && userId === owner
          ? sessionRow(port)
          : undefined;
      },
      async updateSessionActivity() {},
    } as unknown as CraftStore,
    botIdFor: async () => "craft-bot",
    sandboxConnectionFor: () =>
      input.connBaseUrl === null
        ? null
        : { baseUrl: input.connBaseUrl ?? "http://sbox.internal:4300", token: null },
  };
}

describe("webappHmrSessionIdFromPath", () => {
  test("matches only the HMR endpoint under the session's webapp prefix", () => {
    expect(webappHmrSessionIdFromPath(HMR_PATH)).toBe(SESSION_ID);
    expect(
      webappHmrSessionIdFromPath(`/api/craft/sessions/${SESSION_ID}/webapp`),
    ).toBeNull();
    expect(
      webappHmrSessionIdFromPath(
        `/api/craft/sessions/${SESSION_ID}/webapp/_next/static/chunk.js`,
      ),
    ).toBeNull();
    expect(
      webappHmrSessionIdFromPath(`/api/craft/sessions/${SESSION_ID}/events`),
    ).toBeNull();
  });
});

describe("webappHmrQueryString / webappHmrUpstreamUrl (onyx _webapp_hmr_*)", () => {
  test("keeps only the id entries — every other query key is dropped", () => {
    // onyx parse_qsl(keep_blank_values=True) + key == "id" filter.
    expect(webappHmrQueryString("?id=abc&foo=1&bar=&id=def")).toBe(
      "?id=abc&id=def",
    );
    expect(webappHmrQueryString("?foo=1")).toBe("");
    expect(webappHmrQueryString("")).toBe("");
  });

  test("targets the dev server's own /_next/webpack-hmr on the sandbox host port", () => {
    expect(
      webappHmrUpstreamUrl({ host: "sbox.internal", port: 3011, query: "?id=x&z=1" }),
    ).toBe("ws://sbox.internal:3011/_next/webpack-hmr?id=x");
  });
});

describe("resolveWebappHmrUpgrade — the hand-applied webapp-proxy auth", () => {
  test("an unauthenticated upgrade is refused 401 before any session lookup", async () => {
    const decision = await resolveWebappHmrUpgrade(hmrDeps({}), {
      sessionId: SESSION_ID,
      actor: null,
      query: "",
    });
    expect(decision).toMatchObject({ ok: false, status: 401 });
  });

  test("another user's session is refused 404 — the HTTP proxy's indistinct absence", async () => {
    const decision = await resolveWebappHmrUpgrade(
      hmrDeps({ ownerUserId: "somebody-else" }),
      { sessionId: SESSION_ID, actor: { id: "u1" }, query: "" },
    );
    expect(decision).toMatchObject({ ok: false, status: 404 });

    const unknown = await resolveWebappHmrUpgrade(hmrDeps({}), {
      sessionId: "never-heard-of",
      actor: { id: "u1" },
      query: "",
    });
    expect(unknown).toMatchObject({ ok: false, status: 404 });
  });

  test("no sandbox connection is 503, and so is a session without a reserved port", async () => {
    const noConn = await resolveWebappHmrUpgrade(hmrDeps({ connBaseUrl: null }), {
      sessionId: SESSION_ID,
      actor: { id: "u1" },
      query: "",
    });
    expect(noConn).toMatchObject({ ok: false, status: 503 });

    const noPort = await resolveWebappHmrUpgrade(hmrDeps({ nextjsPort: null }), {
      sessionId: SESSION_ID,
      actor: { id: "u1" },
      query: "",
    });
    expect(noPort).toMatchObject({ ok: false, status: 503 });
  });

  test("the owner's upgrade resolves the sandbox host + reserved port with the id-only query", async () => {
    const decision = await resolveWebappHmrUpgrade(hmrDeps({}), {
      sessionId: SESSION_ID,
      actor: { id: "u1" },
      query: "?id=hmr-1&unrelated=drop",
    });
    expect(decision).toEqual({
      ok: true,
      upstreamUrl: "ws://sbox.internal:3011/_next/webpack-hmr?id=hmr-1",
    });
  });

  test("the config gateway URL wins over the connection baseUrl (F-E parity)", async () => {
    const decision = await resolveWebappHmrUpgrade(
      hmrDeps({ gatewayBaseUrl: "http://gateway.host:4300" }),
      { sessionId: SESSION_ID, actor: { id: "u1" }, query: "" },
    );
    expect(decision).toEqual({
      ok: true,
      upstreamUrl: "ws://gateway.host:3011/_next/webpack-hmr",
    });
  });
});

// ── the socket bridge: real sockets both ways, real close propagation ──────────

describe("webappHmrSocketHandlers — the client↔upstream bridge", () => {
  /**
   * A real front server wired exactly the way the boot file wires it (upgrade with
   * WebappHmrSocketData, the shared handlers), in front of a real upstream socket server
   * that echoes text and closes on demand.
   */
  async function withBridge(
    run: (input: { port: number; upstream: URL }) => Promise<void>,
    upstreamBehavior?: "echo-and-close",
  ) {
    const upstream = Bun.serve<{ echo: boolean }>({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req, { data: { echo: true } })) return undefined;
        return new Response("nope", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          ws.send(String(raw));
          if (upstreamBehavior === "echo-and-close" && String(raw) === "die") {
            ws.close(1000, "upstream done");
          }
        },
      },
    });
    const front = Bun.serve<WebappHmrSocketData>({
      port: 0,
      fetch(req, server) {
        const url = new URL(req.url);
        // The front server is handed the upstream the way index.ts's dispatcher resolves it.
        const target = `ws://127.0.0.1:${upstream.port}/_next/webpack-hmr${url.search}`;
        if (server.upgrade(req, { data: { upstream: target, hmr: true } })) {
          return undefined;
        }
        return new Response("nope", { status: 400 });
      },
      websocket: webappHmrSocketHandlers,
    });
    try {
      await run({
        port: front.port,
        upstream: new URL(`ws://127.0.0.1:${upstream.port}`),
      });
    } finally {
      front.stop(true);
      upstream.stop(true);
    }
  }

  test("frames forward in both directions, unbuffered and unaltered", async () => {
    await withBridge(async ({ port }) => {
      const client = new WebSocket(`ws://127.0.0.1:${port}/hmr?id=1`);
      const received: string[] = [];
      const opened = new Promise<void>((resolve, reject) => {
        client.onopen = () => resolve();
        client.onerror = () => reject(new Error("client failed to connect"));
      });
      client.onmessage = (event) => received.push(String(event.data));
      await opened;

      // Client → upstream → back.
      client.send("hello hmr");
      await Bun.sleep(100);
      expect(received).toEqual(["hello hmr"]);
      client.close();
    });
  });

  test("an upstream close ends the client socket", async () => {
    await withBridge(async ({ port }) => {
      const client = new WebSocket(`ws://127.0.0.1:${port}/hmr?id=1`);
      const opened = new Promise<void>((resolve, reject) => {
        client.onopen = () => resolve();
        client.onerror = () => reject(new Error("client failed to connect"));
      });
      const closed = new Promise<number>((resolve) => {
        client.onclose = (event) => resolve(event.code);
      });
      await opened;
      client.send("die");
      const code = await closed;
      expect(code).toBe(1000);
    }, "echo-and-close");
  });

  test("a client close closes the upstream socket", async () => {
    let upstreamClosed = false;
    const upstream = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response("nope", { status: 400 });
      },
      websocket: {
        open() {},
        message() {},
        close() {
          upstreamClosed = true;
        },
      },
    });
    const front = Bun.serve<WebappHmrSocketData>({
      port: 0,
      fetch(req, server) {
        const target = `ws://127.0.0.1:${upstream.port}/_next/webpack-hmr`;
        if (server.upgrade(req, { data: { upstream: target, hmr: true } })) {
          return undefined;
        }
        return new Response("nope", { status: 400 });
      },
      websocket: webappHmrSocketHandlers,
    });
    try {
      const client = new WebSocket(`ws://127.0.0.1:${front.port}/hmr`);
      await new Promise<void>((resolve, reject) => {
        client.onopen = () => resolve();
        client.onerror = () => reject(new Error("client failed to connect"));
      });
      client.close();
      // The bridge's close handler runs synchronously on the client close; give the
      // inward close a tick to land on the upstream server.
      for (let i = 0; i < 50 && !upstreamClosed; i++) await Bun.sleep(20);
      expect(upstreamClosed).toBe(true);
    } finally {
      front.stop(true);
      upstream.stop(true);
    }
  });

  test("an unreachable upstream fails the client socket instead of hanging it", async () => {
    const front = Bun.serve<WebappHmrSocketData>({
      port: 0,
      fetch(req, server) {
        // Nothing listens on this port — the inward dial must error and close the client.
        if (
          server.upgrade(req, {
            data: { upstream: "ws://127.0.0.1:1/_next/webpack-hmr", hmr: true },
          })
        ) {
          return undefined;
        }
        return new Response("nope", { status: 400 });
      },
      websocket: webappHmrSocketHandlers,
    });
    try {
      const client = new WebSocket(`ws://127.0.0.1:${front.port}/hmr`);
      const closed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("client socket was left hanging")),
          5000,
        );
        client.onclose = () => {
          clearTimeout(timer);
          resolve();
        };
        client.onerror = () => {
          /* the close that follows is the assertion */
        };
      });
      await closed;
    } finally {
      front.stop(true);
    }
  });
});
