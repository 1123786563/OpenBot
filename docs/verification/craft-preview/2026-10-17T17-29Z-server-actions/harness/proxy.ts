// #414 evidence harness: drives the REAL OpenBot preview-proxy code path
// (server/src/craft/webapp-proxy.ts -> proxyWebappRequest, with its own
// stripRequestHeaders / EXCLUDED_* tables) against a REAL next dev 16.2.9
// upstream. No sandbox, no DB, no ticket — the header-hygiene question lives
// entirely at this seam.
//
// MODE:
//   asis             — ship behavior: hygiene strips origin + x-forwarded-* + cookie
//   keep_origin      — candidate fix 1: re-add the browser's Origin upstream
//   keep_origin_xfh  — candidate fix 2: Origin + x-forwarded-host/proto = preview authority
import { proxyWebappRequest } from "/Users/wuyongjun/trea/OpenBot/server/src/craft/webapp-proxy.ts";

const UPSTREAM = process.env.UPSTREAM ?? "http://127.0.0.1:3399";
const MODE = process.env.MODE ?? "asis";
const PORT = Number(process.env.PORT ?? 3299);
const PREVIEW_AUTHORITY = `127.0.0.1:${PORT}`;

const captures: Record<string, unknown>[] = [];

async function handle(req: Request) {
  const url = new URL(req.url);
  const browserHeaders = new Headers(req.headers);
  const bodyless = req.method === "GET" || req.method === "HEAD";
  const body = bodyless ? undefined : await req.arrayBuffer();

  const cap: Record<string, unknown> = {
    mode: MODE,
    method: req.method,
    path: `${url.pathname}${url.search}`,
    browser_origin: browserHeaders.get("origin") ?? "ABSENT",
    browser_cookie_names:
      browserHeaders
        .get("cookie")
        ?.split(";")
        .map((c) => c.trim().split("=")[0])
        .join(",") ?? "NONE",
    browser_sec_fetch_site: browserHeaders.get("sec-fetch-site") ?? "ABSENT",
  };

  const result = await proxyWebappRequest({
    upstreamBaseUrl: UPSTREAM,
    path: url.pathname,
    query: url.search,
    method: req.method,
    requestHeaders: browserHeaders,
    body,
    fetchImpl: async (target, init) => {
      const h = new Headers(init.headers as HeadersInit | undefined);
      cap.after_hygiene_names = [...h.keys()].sort();
      cap.after_hygiene_origin = h.get("origin") ?? "STRIPPED";
      cap.after_hygiene_xfh = h.get("x-forwarded-host") ?? "STRIPPED";
      cap.after_hygiene_cookie = h.get("cookie") ?? "STRIPPED";
      cap.after_hygiene_secfetch = [...h.keys()].filter((k) =>
        k.startsWith("sec-fetch-"),
      );
      if (MODE === "keep_origin" || MODE === "keep_origin_xfh") {
        const o = browserHeaders.get("origin");
        if (o) h.set("origin", o);
      }
      if (MODE === "keep_origin_xfh") {
        h.set("x-forwarded-host", PREVIEW_AUTHORITY);
        h.set("x-forwarded-proto", url.protocol.replace(":", ""));
      }
      cap.sent_origin = h.get("origin") ?? "ABSENT";
      cap.sent_xfh = h.get("x-forwarded-host") ?? "ABSENT";
      const upstream = await fetch(target, { ...init, headers: h });
      cap.upstream_status = upstream.status;
      cap.upstream_set_cookie = upstream.headers.getSetCookie();
      cap.upstream_x_action_redirect =
        upstream.headers.get("x-action-redirect") ?? "NONE";
      return upstream;
    },
  });

  cap.proxy_status = result.status;
  cap.proxy_set_cookie = result.headers.getSetCookie();
  cap.proxy_x_action_redirect =
    result.headers.get("x-action-redirect") ?? "NONE";
  cap.proxy_csp = result.headers
    .get("content-security-policy")
    ?.slice(0, 120);
  captures.push(cap);
  console.log(`[#${captures.length}] ${JSON.stringify(cap)}`);

  return new Response(result.body, {
    status: result.status,
    headers: result.headers,
  });
}

Bun.serve({
  port: PORT,
  // The dev-form HMR channel is bridged (the real proxy does this in #363);
  // without it Turbopack's client never settles and the page stays un-hydrated,
  // which would look like "Server Actions are broken" but is a harness gap.
  websocket: {
    open(ws: any) {
      const up = new WebSocket(ws.data.target);
      ws.data.up = up;
      ws.data.queue = [] as unknown[];
      up.addEventListener("message", (e: any) => ws.send(e.data));
      up.addEventListener("close", () => ws.close());
      up.addEventListener("error", () => ws.close());
      up.addEventListener("open", () => {
        for (const m of ws.data.queue) up.send(m as any);
        ws.data.queue = [];
      });
    },
    message(ws: any, msg: any) {
      const up = ws.data.up as WebSocket;
      if (up && up.readyState === WebSocket.OPEN) up.send(msg);
      else (ws.data.queue ??= []).push(msg);
    },
    close(ws: any) {
      try {
        (ws.data.up as WebSocket | undefined)?.close();
      } catch {}
    },
  },
  fetch(req: Request, server: any) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/webpack-hmr")) {
      const target = `${UPSTREAM.replace(/^http/, "ws")}${url.pathname}${url.search}`;
      if (server.upgrade(req, { data: { target } })) return;
      return new Response("upgrade failed", { status: 426 });
    }
    return handle(req);
  },
});
console.log(
  `harness on http://127.0.0.1:${PORT} mode=${MODE} upstream=${UPSTREAM} preview_authority=${PREVIEW_AUTHORITY}`,
);

const dump = () => {
  const file = process.env.OUT ?? `/Users/wuyongjun/.cache/craft414-harness/out/harness-${MODE}.json`;
  Bun.write(file, JSON.stringify(captures, null, 2));
  console.log(`wrote ${captures.length} captures to ${file}`);
  process.exit(0);
};
process.on("SIGTERM", dump);
process.on("SIGINT", dump);
