/**
 * The craft webapp surface — ported from onyx `webapp_proxy.py` + the `webapp-info` /
 * `webapp-download` endpoints in `session/api.py`, Hono-shaped.
 *
 * Three endpoints:
 * - GET /sessions/:id/webapp-info    — has_webapp / webapp_url / status / ready
 * - GET /sessions/:id/webapp/*        — reverse-proxy the session's dev server
 * - GET /sessions/:id/webapp-download — the scaffolded webapp as a ZIP (T5: onyx parity)
 *
 * onyx points a Next.js dev server at a backend-reserved port and proxies to it with header
 * hygiene (hop-by-hop + credentials stripped, no set-cookie forwarding) and a relaxed CSP for
 * dev tooling. OpenBot's restored webapp tool runs the same shape: the session's dev server
 * is the script-managed process bound to the reserved `craft_sessions.nextjs_port` (see
 * nextjs-dev.ts), and this proxy ATTACHES to that port — status and preview report the same
 * port by construction, and a down server is an honest 503 (onyx's webapp_proxy refuses too)
 * rather than a second spawned process beside the managed one.
 */

import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import { DEV_CSP_ALLOW_LISTED } from "../workshop/preview";
import type { CraftConfig } from "./config";
import { isHiddenWorkspacePath } from "./directory-archive";
import { webappDevServerReady } from "./nextjs-dev";
import type { SandboxGateway } from "./sandbox-gateway";
import type { CraftStore } from "./store";
import { sessionDirectory } from "./workspace";
import {
  buildContentDisposition,
  sanitizeZipBasename,
  zipEntries,
} from "./zip-archive";

export type WebappProxyRoutesDeps = {
  config: CraftConfig;
  store: CraftStore;
  gateway: SandboxGateway;
  botIdFor: (sessionId: string) => Promise<string | null>;
  /** Connection facts for a Bot's sandbox gateway (baseUrl + token). */
  sandboxConnectionFor: (
    botId: string,
  ) => { baseUrl: string; token: string | null } | null;
};

const WEBAPP_PROBE_TIMEOUT_MS = 10_000;
/** The headless refusal: no reserved port, no webapp support (onyx parity). */
const WEBAPP_NO_SUPPORT_ERROR = "This session has no web-app support.";

/**
 * Request headers never forwarded to the LLM-authored app, matched by lowercase key — onyx's
 * `EXCLUDED_REQUEST_HEADERS`, plus the header the gateway itself uses for auth. Prefix
 * exclusions (sec-fetch-*, x-forwarded-*, …) keep browser context and ingress identity out.
 */
const EXCLUDED_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "cookie",
  "authorization",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "x-xsrf-token",
  "x-sandbox-token",
  "x-openbot-bot-id",
  "origin",
  "forwarded",
]);

const EXCLUDED_REQUEST_HEADER_PREFIXES = [
  "x-forwarded-",
  "x-real-ip",
  "x-client-ip",
  "cf-",
  "true-client-ip",
  "sec-fetch-",
  "x-onyx-",
];

/** Response headers never forwarded back: hop-by-hop, and set-cookie (an app must not set
 * cookies on the parent domain). */
const EXCLUDED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "set-cookie",
]);

function stripRequestHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const [key, value] of source.entries()) {
    const lowered = key.toLowerCase();
    if (EXCLUDED_REQUEST_HEADERS.has(lowered)) continue;
    if (
      EXCLUDED_REQUEST_HEADER_PREFIXES.some((prefix) =>
        lowered.startsWith(prefix),
      )
    ) {
      continue;
    }
    headers.set(key, value);
  }
  return headers;
}

export type ProxyWebappResult = {
  status: number;
  headers: Headers;
  body: BodyInit | null;
};

/**
 * One proxied request to a dev-server upstream. Returns a 504 on upstream timeout, 502 on a
 * connection failure, 503 when the upstream is not running — mirroring onyx's `_proxy_request`.
 */
export async function proxyWebappRequest(input: {
  upstreamBaseUrl: string;
  path: string;
  query: string;
  requestHeaders: Headers;
  fetchImpl?: typeof fetch;
}): Promise<ProxyWebappResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const path = input.path.replace(/^\/+/, "");
  const target = `${input.upstreamBaseUrl}/${path}${input.query}`;
  const headers = stripRequestHeaders(input.requestHeaders);

  let upstream: Response;
  try {
    upstream = await fetchImpl(target, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(WEBAPP_PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return timedOut
      ? { status: 504, headers: new Headers(), body: null }
      : { status: 502, headers: new Headers(), body: null };
  }

  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    if (EXCLUDED_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    responseHeaders.set(key, value);
  }
  responseHeaders.set(
    "content-type",
    upstream.headers.get("content-type") ?? "text/html",
  );
  responseHeaders.set("content-security-policy", DEV_CSP_ALLOW_LISTED);
  return {
    status: upstream.status,
    headers: responseHeaders,
    body: upstream.body,
  };
}

function hasWebappScaffold(paths: string[]): boolean {
  return paths.some(
    (path) => path.endsWith("/package.json") || path.endsWith("package.json"),
  );
}

export function createWebappProxyRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  deps: WebappProxyRoutesDeps,
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  /** Ownership-checked session + its sandbox connection facts. */
  const resolve = async (sessionId: string, userId: string) => {
    const session = await deps.store.getSession(sessionId, userId);
    if (!session) return { session: null, botId: null, conn: null };
    const botId = await deps.botIdFor(sessionId);
    const conn = botId ? deps.sandboxConnectionFor(botId) : null;
    return { session, botId, conn };
  };

  // ── GET /sessions/:id/webapp-info ───────────────────────────────────────────
  app.get("/sessions/:sessionId/webapp-info", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    const { session, botId, conn } = await resolve(sessionId, actor.id);
    if (!session) return context.json({ error: "Session not found" }, 404);

    if (!botId || !conn) {
      // Sandbox unavailable: existence cannot be inspected — onyx's `status: no_sandbox`.
      return context.json({
        has_webapp: null,
        webapp_url: null,
        status: "no_sandbox",
        ready: false,
      });
    }

    const directory = sessionDirectory(
      sessionId,
      deps.config.sessionDirectoryMode,
    );
    const fileApi = deps.gateway.fileApiFor(botId);
    const listing = await fileApi
      ?.listFiles(`${directory}/outputs/web`)
      .catch(() => [] as string[]);
    const hasWebapp =
      (listing?.length ?? 0) > 0 && hasWebappScaffold(listing ?? []);

    // onyx's ready judgment (manager.py:1570-1593): any answer on the managed
    // port counts — the same port the webapp tool reports and the proxy below
    // routes to, so status and preview can never disagree.
    const ready =
      hasWebapp &&
      session.nextjsPort !== null &&
      (await webappDevServerReady(session.nextjsPort as number));

    return context.json({
      has_webapp: hasWebapp,
      webapp_url: `/api/craft/sessions/${sessionId}/webapp`,
      status: "running",
      ready,
    });
  });

  // ── GET /sessions/:id/webapp/* — the reverse proxy ──────────────────────────
  // `:path{.+}` not `*`: Hono 4.13's bare wildcard matches but `param("*")` reads null;
  // the named regex param is the readable multi-segment shape (see artifact-routes). The
  // bare `/webapp` registration keeps the iframe's root URL (webapp-info answers exactly
  // that shape) served — a regex param alone would 404 the empty path.
  const proxyWebapp = async (
    context: Context<{ Variables: AppVariables }, string>,
  ) => {
    const actor = context.var.actor;
    // The shared handler serves both route shapes, so the params are read by name with a
    // fallback (a matched route always carries the session id; "" degrades to the 404 below).
    const sessionId = context.req.param("sessionId") ?? "";
    const rel = context.req.param("path") ?? "";
    const { session, botId, conn } = await resolve(sessionId, actor.id);
    if (!session) return context.json({ error: "Session not found" }, 404);
    if (!botId || !conn) {
      return context.json({ error: "The sandbox is not available." }, 503);
    }

    // Attach, never spawn: the session's reserved port is the managed process's
    // routing contract — the webapp tool's start-webapp.sh owns the one process
    // per session, and the preview refuses rather than double-spawning beside it.
    const port = session.nextjsPort;
    if (port === null) {
      return context.json({ error: WEBAPP_NO_SUPPORT_ERROR }, 503);
    }
    if (!(await webappDevServerReady(port))) {
      return context.json(
        {
          error:
            "The web app is not running. Ask the agent to call the webapp tool with action 'start'.",
        },
        503,
      );
    }

    const result = await proxyWebappRequest({
      upstreamBaseUrl: `http://127.0.0.1:${port}`,
      path: rel,
      query: context.req.url.includes("?")
        ? context.req.url.slice(context.req.url.indexOf("?"))
        : "",
      requestHeaders: context.req.raw.headers,
    });
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  };
  app.get("/sessions/:sessionId/webapp/:path{.+}", proxyWebapp);
  app.get("/sessions/:sessionId/webapp", proxyWebapp);

  // ── GET /sessions/:id/webapp-download — the scaffolded webapp as a ZIP ──────
  // onyx api.py:681-708 + manager.py:1595-1636: every None shape (no session, no
  // sandbox, no outputs/web) answers the same 404 "Webapp not found" — an
  // ownership probe reads as absence, exactly onyx's indistinct refusal.
  app.get("/sessions/:sessionId/webapp-download", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    const { session, botId } = await resolve(sessionId, actor.id);
    if (!session) return context.json({ error: "Webapp not found" }, 404);
    if (!botId) return context.json({ error: "Webapp not found" }, 404);

    const directory = sessionDirectory(
      sessionId,
      deps.config.sessionDirectoryMode,
    );
    const fileApi = deps.gateway.fileApiFor(botId);
    if (!fileApi) return context.json({ error: "Webapp not found" }, 404);

    const root = `${directory}/outputs/web`;
    let listing: string[];
    try {
      listing = await fileApi.listFiles(root);
    } catch {
      // outputs/web doesn't exist — onyx's list_directory ValueError → None → 404.
      return context.json({ error: "Webapp not found" }, 404);
    }
    const prefix = root.endsWith("/") ? root : `${root}/`;

    // The gateway answers recursive FULL paths (absolute in directory mode, bot-rooted
    // otherwise), so containment is the anchor prefix — the same discipline as
    // packDirectoryZip. (The route used to skip anything starting with "/", which
    // silently emptied the archive whenever the listing was absolute — a latent bug
    // the T5 route test caught.)
    const entries: { path: string; bytes: Uint8Array }[] = [];
    for (const path of listing) {
      if (!path.startsWith(prefix)) continue;
      if (isHiddenWorkspacePath(path)) continue;
      const relPath = path.slice(prefix.length);
      if (!relPath || relPath.startsWith("/") || relPath.includes("../"))
        continue;
      const bytes = await fileApi.readFileBytes(path).catch(() => null);
      if (bytes === null) continue; // unreadable: skipped, not fatal (onyx parity)
      entries.push({ path: relPath, bytes });
    }
    // A directory whose visible files are all filtered away is an EMPTY zip, not a
    // 404 — onyx distinguishes "outputs/web is missing" (None) from "holds nothing
    // downloadable" (a zero-entry archive).

    const archive = zipEntries(entries);
    // manager.py:1634-1636: the session's name (or a session-{id[:8]} stem),
    // sanitized with allow_dots=False — dots are unsafe in a download's stem there.
    const stem = session.name || `session-${sessionId.slice(0, 8)}`;
    const filename = `${sanitizeZipBasename(stem, { allowDots: false })}-webapp.zip`;
    return new Response(archive as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-length": String(archive.byteLength),
        "content-disposition": buildContentDisposition(filename),
      },
    });
  });

  return app;
}
