/**
 * The craft webapp surface — ported from onyx `webapp_proxy.py` + the `webapp-info` /
 * `webapp-download` endpoints in `session/api.py`, Hono-shaped.
 *
 * Three endpoints:
 * - GET /sessions/:id/webapp-info    — has_webapp / webapp_url / status / ready
 * - ANY /sessions/:id/webapp/*        — reverse-proxy the session's dev server
 * - GET /sessions/:id/webapp-download — the scaffolded webapp as a ZIP (T5: onyx parity)
 *
 * onyx points a Next.js dev server at a backend-reserved port and proxies to it with header
 * hygiene (hop-by-hop + credentials stripped, no set-cookie forwarding) and a relaxed CSP for
 * dev tooling. OpenBot's restored webapp tool runs the same shape: the session's dev server
 * is the script-managed process bound to the reserved `craft_sessions.nextjs_port` (see
 * nextjs-dev.ts), and this proxy ATTACHES to that port — status and preview report the same
 * port by construction, and a down server is an honest 503 (onyx's webapp_proxy refuses too)
 * rather than a second spawned process beside the managed one.
 *
 * WHERE THE PORT LIVES (finding F-E): the dev server listens INSIDE the sandbox (the
 * container the agent-sandbox gateway fronts), not on the API server's own loopback —
 * dialing `http://127.0.0.1:{port}` from the server never reached it in the host-server +
 * docker-sandbox topology (live: in-container 200, host 000 → ready永false / preview 503).
 * The reachability paths (the ready probe and the proxy upstream) therefore dial the
 * SANDBOX host — the gateway connection's host (config.sandboxGatewayBaseUrl, else the
 * per-bot connection baseUrl), the one machine every craft file call already reaches and
 * the one the reserved port range is published from. The tool/status semantics are
 * untouched: the webapp tool still reports the same reserved port from the sandbox's own
 * script/pid state.
 */

import { type Context, Hono, type MiddlewareHandler } from "hono";
import { getLogger } from "../../../shared/logger";
import type { AppVariables } from "../auth/guards";
import type { CraftConfig } from "./config";
import {
  collectWorkspaceFiles,
  type WorkspaceFileEntry,
  WorkspaceListingError,
} from "./directory-archive";
import { webappDevServerReady, webappUpstreamHost } from "./nextjs-dev";
import {
  holdsPreviewSessionPass,
  PREVIEW_PASS_REFUSAL,
  type ServePreview,
} from "./preview-origin";
import {
  createPreviewTickets,
  defaultPreviewOrigin,
  type PreviewTickets,
} from "./preview-ticket";
import type { SandboxGateway } from "./sandbox-gateway";
import type { CraftStore } from "./store";
import { readWebappGeneration } from "./webapp-generation";
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
  /**
   * The ticket table behind the issuing route below — one per process by
   * default; injectable so tests drive the TTL clock without sleeping. #361's
   * host routing redeems against the SAME instance.
   */
  previewTickets?: PreviewTickets;
  /** The preview origin a ticket's host binding is minted against (#361/#362
   * own the real host decision; D5's dev default until then). */
  previewOriginFor?: (sessionId: string) => string;
  /**
   * The preview origin's admission (#361/#362): closed means NO address may
   * exist — webapp-info surfaces the reason (m-5) and the issuing route
   * refuses to mint (503). Defaults to the dev-form PORT/SERVER_PORT judgment
   * (preview-ticket's previewPortFromEnv — serverPort's rules).
   */
  previewOriginAdmission?: () => { ok: true } | { ok: false; reason: string };
  /** The env the defaults above read; tests pin PORT/SERVER_PORT with it. */
  env?: Record<string, string | undefined>;
  /** The fetch behind the ready probe; tests intercept the dial. */
  fetchImpl?: typeof fetch;
};

const WEBAPP_PROBE_TIMEOUT_MS = 10_000;
/** The headless refusal: no reserved port, no webapp support (onyx parity). */
const WEBAPP_NO_SUPPORT_ERROR = "This session has no web-app support.";
const WEBAPP_NOT_RUNNING_ERROR =
  "The web app is not running. Ask the agent to call the webapp tool with action 'start'.";

/**
 * The caller's request body, or undefined when there is nothing to forward.
 * GET and HEAD may not carry one at all (fetch rejects it outright), and an
 * empty buffer on the remaining verbs is dropped so the proxy never invents a
 * content-length the caller did not send. The raw-Request form is shared by the
 * main-site route handler and the preview proxy below (#362).
 */
async function rawRequestBody(
  request: Request,
): Promise<ArrayBuffer | undefined> {
  const method = request.method;
  if (method === "GET" || method === "HEAD") return undefined;
  const bytes = await request.arrayBuffer();
  return bytes.byteLength > 0 ? bytes : undefined;
}

async function requestBody(
  context: Context<{ Variables: AppVariables }, string>,
): Promise<ArrayBuffer | undefined> {
  return rawRequestBody(context.req.raw);
}

/**
 * A refusal an iframe can land on. The preview pane gates on `ready` now, but the
 * proxy URL is handed to the client unconditionally and a browser can still reach
 * it (a stale frame, a reload race, a shared link) — and raw JSON in an iframe is
 * exactly the `{"error":"The web app is not running…"}` page this used to show.
 * A caller that accepts HTML gets a readable page; a programmatic caller keeps the
 * JSON shape it parses.
 *
 * #362: the raw-Request twin `refuseResponse` below is the exported one — the
 * preview origin's own gates (its 401 pass refusal) land on iframes too and use
 * the SAME dual shape.
 */
function refuse(
  context: Context<{ Variables: AppVariables }, string>,
  message: string,
) {
  return refuseResponse(context.req.raw, message);
}

/** The request-shaped refusal: an iframe-facing page for HTML callers, JSON otherwise. */
export function refuseResponse(
  request: Request,
  message: string,
  status = 503,
): Response {
  const accepts = request.headers.get("accept") ?? "";
  const wantsHtml =
    accepts.includes("text/html") || accepts.includes("application/xhtml+xml");
  if (!wantsHtml) return Response.json({ error: message }, { status });
  // Escaped, because the message is server-authored today but this is an HTML
  // sink and a caller-supplied string must never become script here.
  const safe = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>Web app unavailable</title>` +
      `<style>body{margin:0;display:flex;min-height:100vh;align-items:center;` +
      `justify-content:center;background:#fff;color:#18181b;` +
      `font:13px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif}` +
      `p{max-width:34ch;margin:0;padding:24px;text-align:center}` +
      `@media (prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}` +
      `}</style></head><body><p>${safe}</p></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

const logger = getLogger("server");

/**
 * Request headers never forwarded to the LLM-authored app, matched by lowercase key — onyx's
 * `EXCLUDED_REQUEST_HEADERS`, plus the header the gateway itself uses for auth. Prefix
 * exclusions (sec-fetch-*, x-forwarded-*, …) keep browser context and ingress identity out.
 * `accept-encoding` is stripped so the upstream answers uncompressed: the response side drops
 * `content-encoding` (see EXCLUDED_RESPONSE_HEADERS), and a gzip body without that header is
 * binary garbage in the preview iframe.
 */
const EXCLUDED_REQUEST_HEADERS = new Set([
  "host",
  "accept-encoding",
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

/**
 * The dev preview's CSP. The workshop's DEV_CSP_ALLOW_LISTED is 'self'-only scripts,
 * which kills Next.js dev hydration stone dead: the RSC payload rides inline
 * scripts (self.__next_f.push) and the refresh/turbopack runtimes need eval. A
 * dev preview of LLM-authored code is exactly the 'unsafe-inline' + 'unsafe-eval'
 * shape; everything else stays as tight as the workshop's.
 *
 * #362 re-derived `connect-src` for the preview origin: there `'self'` IS the
 * preview origin itself, and that is exactly right — the app's own fetches and
 * Server Actions (POST to its own paths) ride the same host through the proxy,
 * same-origin under the CSP as in the browser; `ws:`/`wss:` stay for the dev
 * server's HMR channel. Nothing here may reach back to the main site's origin,
 * and nothing needs to: the platform's cookies are not in scope on this host
 * (that is the whole point of the origin split — spec F2/D1).
 */
const WEBAPP_DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self' data:; object-src 'none'; base-uri 'none'";

export type ProxyWebappResult = {
  status: number;
  headers: Headers;
  body: BodyInit | null;
};

/**
 * One proxied request to a dev-server upstream. Returns a 504 on upstream timeout, 502 on a
 * connection failure, 503 when the upstream is not running — mirroring onyx's `_proxy_request`.
 *
 * `method` is required, not defaulted: a hardcoded GET here is what made the preview a
 * picture of an app rather than an app (see WEBAPP_METHODS).
 */
export async function proxyWebappRequest(input: {
  upstreamBaseUrl: string;
  path: string;
  query: string;
  method: string;
  requestHeaders: Headers;
  /** The caller's request body, when it carried one. Omitted for a bodyless verb. */
  body?: BodyInit | null;
  fetchImpl?: typeof fetch;
}): Promise<ProxyWebappResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const path = input.path.replace(/^\/+/, "");
  const target = `${input.upstreamBaseUrl}/${path}${input.query}`;
  const headers = stripRequestHeaders(input.requestHeaders);

  let upstream: Response;
  try {
    upstream = await fetchImpl(target, {
      method: input.method,
      headers,
      // Only a verb that may carry one gets a body: fetch rejects a body on
      // GET/HEAD outright, and an empty buffer on DELETE/OPTIONS would invent a
      // content-length the caller never sent.
      ...(input.body === undefined || input.body === null
        ? {}
        : { body: input.body }),
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
  responseHeaders.set("content-security-policy", WEBAPP_DEV_CSP);
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

/**
 * The LEGACY session's preview address (#367, D10): the same-origin mount the
 * pre-preview-origin regime served, exactly as it was — the app self-mounts
 * this prefix via its template's cwd fallback (env unset: the #367 gate keeps
 * the start script root-path), the route below is still registered, and the
 * same-origin HMR dispatcher still answers its upgrades. Relative by purpose:
 * same-origin is what "the old path" means, and the pane iframes it with the
 * platform's own cookies, as it did before #362.
 */
export const legacyWebappPreviewPath = (sessionId: string): string =>
  `/api/craft/sessions/${sessionId}/webapp`;

/**
 * The preview origin's serving half (#362, the ServePreview seam preview-origin.ts
 * calls after its cookie gate): the request already carries the preview pass and
 * the app-relative path — this module finds the session's row (BY ID: the pass is
 * the authentication, there is no actor id to ownership-check against), resolves
 * the same sandbox facts the main-site proxy uses, ATTACHES (probe, never spawn),
 * and forwards through proxyWebappRequest with the same header hygiene, CSP and
 * refusal shapes as the same-origin route. A restart-deleted session is an honest
 * 404; a down dev server is the same not-running sentence the pane already shows.
 */
export function createPreviewProxy(deps: {
  config: CraftConfig;
  /** The by-id row lookup (no activity bump — routing, not use). */
  store: Pick<CraftStore, "findSessionById">;
  botIdFor: (sessionId: string) => Promise<string | null>;
  sandboxConnectionFor: (
    botId: string,
  ) => { baseUrl: string; token: string | null } | null;
  fetchImpl?: typeof fetch;
}): ServePreview {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return async ({ sessionId, request, appPath, query }) => {
    const session = await deps.store.findSessionById(sessionId);
    if (!session) {
      return refuseResponse(
        request,
        "This preview session no longer exists.",
        404,
      );
    }
    const botId = await deps.botIdFor(sessionId);
    const conn = botId ? deps.sandboxConnectionFor(botId) : null;
    if (!botId || !conn) {
      return refuseResponse(request, "The sandbox is not available.");
    }
    // Attach, never spawn — the same contract as the same-origin route: the
    // webapp tool's start-webapp.sh owns the one process per session.
    const port = session.nextjsPort;
    if (port === null) {
      return refuseResponse(request, WEBAPP_NO_SUPPORT_ERROR);
    }
    const upstreamHost = webappUpstreamHost(
      deps.config.sandboxGatewayBaseUrl || conn.baseUrl,
    );
    if (
      !(await webappDevServerReady({ host: upstreamHost, port }, fetchImpl))
    ) {
      return refuseResponse(request, WEBAPP_NOT_RUNNING_ERROR);
    }
    const result = await proxyWebappRequest({
      upstreamBaseUrl: `http://${upstreamHost}:${port}`,
      // appPath is the upstream-resolvable path as the origin derived it — the
      // pathname verbatim in both forms: the dev form's label INCLUDED (the
      // dev server is basePath-mounted at /<label>, F-2/#365), the host form's
      // root-path app by definition. Same shape as the same-origin route's
      // full-mount forward.
      path: appPath,
      query,
      method: request.method,
      // Read AFTER the gates, so a refused request never pays for it.
      body: await rawRequestBody(request),
      requestHeaders: request.headers,
      fetchImpl,
    });
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  };
}

/**
 * Every verb the preview carries. The route used to register GET alone, and the
 * helper below hardcoded it: POST/PUT/PATCH/DELETE/OPTIONS then answered 404
 * from Hono and never reached the dev server (measured live against the route).
 * That silently killed every Next.js Server Action (POST), every API-route
 * mutation, every `<form method="POST">` and every preflighted fetch — which is
 * to say the whole of "open the preview and actually use the app". A preview
 * that cannot POST is a screenshot.
 *
 * OPTIONS is in the list rather than answered locally on purpose: the app owns
 * its own CORS story, and a proxy that invents a 204 preflight answer would
 * advertise permissions the app never granted.
 */
const WEBAPP_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

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

  // ── POST /sessions/:id/preview-ticket — the #360 issuing route ─────────────
  //
  // The main-site cookie (requireUser above) exchanges for a short-lived,
  // single-use ticket the preview origin redeems (D4). The binding's host
  // element is the returned origin's host — a HOST, never a port-only origin
  // (F2: ports do not isolate cookies). The refusal shapes are this surface's
  // own: 401 from requireUser, 404 a session that is not the actor's, 503 a
  // sandbox that cannot back the preview. No sandbox probe runs yet — a ticket
  // outlives a dev server boot inside its 30s window by design.
  const previewTickets =
    deps.previewTickets ?? createPreviewTickets({ store: deps.store });
  const previewOriginAdmission =
    deps.previewOriginAdmission ??
    (() => {
      const parsed = defaultPreviewOrigin(deps.env ?? process.env);
      return "reason" in parsed
        ? { ok: false as const, reason: parsed.reason }
        : { ok: true as const };
    });
  const previewOriginFor =
    deps.previewOriginFor ??
    (() => {
      // Unreachable while admission is closed — every caller checks the gate
      // first; a direct call still refuses loudly rather than guessing a port
      // (the #362 convergence: serverPort's rules, never a silent preference).
      const parsed = defaultPreviewOrigin(deps.env ?? process.env);
      if ("reason" in parsed) {
        throw new Error(`The preview origin is closed: ${parsed.reason}`);
      }
      return parsed.origin;
    });
  app.post("/sessions/:sessionId/preview-ticket", async (context) => {
    // Never mint into a closed origin: the ticket's host element is the very
    // address that must not exist while the gate refuses (AC6 — a closed origin
    // is not a fallback target, and a bound-but-dead ticket is worse than 503).
    const admission = previewOriginAdmission();
    if (!admission.ok) {
      return context.json({ error: admission.reason }, 503);
    }
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    const { session, botId, conn } = await resolve(sessionId, actor.id);
    if (!session) return context.json({ error: "Session not found" }, 404);
    if (!botId || !conn) {
      return context.json({ error: "The sandbox is not available." }, 503);
    }
    const origin = previewOriginFor(sessionId);
    const { ticket, expiresAt } = previewTickets.issuePreviewTicket({
      sessionId,
      userId: actor.id,
      previewHost: new URL(origin).host,
    });
    // A bearer credential's only appearance: this response, never a log line.
    return context.json({
      ticket,
      expiresAt: expiresAt.toISOString(),
      origin,
    });
  });

  // ── GET /sessions/:id/webapp-info ───────────────────────────────────────────
  app.get("/sessions/:sessionId/webapp-info", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    const { session, botId, conn } = await resolve(sessionId, actor.id);
    if (!session) return context.json({ error: "Session not found" }, 404);

    if (!botId || !conn) {
      // Sandbox unavailable: existence cannot be inspected — onyx's `status: no_sandbox`.
      // The address fields stay null with it: a preview with no sandbox behind it
      // is not an addressable thing, whatever the admission gate says.
      const closed = previewOriginAdmission();
      return context.json({
        has_webapp: null,
        webapp_url: null,
        previewOrigin: null,
        previewOriginClosedReason: closed.ok ? null : closed.reason,
        // With no sandbox the marker cannot be read — the conservative answer,
        // though the pane never iframes anything in this state anyway.
        webappGeneration: "legacy" as const,
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
    // routes to, so status and preview can never disagree. The dial goes to the
    // SANDBOX host (F-E): the reserved port lives inside the sandbox, not on this
    // server's loopback.
    const ready =
      hasWebapp &&
      session.nextjsPort !== null &&
      (await webappDevServerReady(
        {
          host: webappUpstreamHost(
            deps.config.sandboxGatewayBaseUrl || conn.baseUrl,
          ),
          port: session.nextjsPort as number,
        },
        deps.fetchImpl,
      ));

    // #367 (D10): WHICH preview a session gets is its app's assembly
    // generation (webapp-generation.ts), not the deployment's mood. A legacy
    // app keeps the OLD same-origin path — the preview origin's address would
    // 404 it (its mount is the old prefix), which is the silent-404 middle
    // state this ticket exists to prevent. The old route is still registered
    // below, the same-origin HMR dispatcher still answers it, and the pane
    // iframes it with the platform's cookies exactly as it did before #362 —
    // until the session ends naturally (D10) or the app is rebuilt (the fresh
    // template copy stamps the marker and the session walks the new shape).
    const generation = await readWebappGeneration(fileApi, directory);
    if (generation === "legacy") {
      return context.json({
        has_webapp: hasWebapp,
        webapp_url: legacyWebappPreviewPath(sessionId),
        // No preview-origin address is in play for a legacy session, and no
        // closed reason either: the old path needs no origin, so a disabled
        // preview origin must not take a working legacy preview down with it.
        previewOrigin: null,
        previewOriginClosedReason: null,
        webappGeneration: "legacy" as const,
        status: ready ? "running" : "stopped",
        ready,
      });
    }

    // #362 (m-5/D11): `webapp_url` is the ABSOLUTE preview address (D11 — the
    // same-origin path is retired), mirrored as `previewOrigin`; a closed origin
    // answers no address and the displayable reason instead. The pane gates on
    // `ready` before ever pointing a frame at the address, unchanged.
    const admission = previewOriginAdmission();
    const previewAddress = admission.ok ? previewOriginFor(sessionId) : null;

    return context.json({
      has_webapp: hasWebapp,
      webapp_url: previewAddress,
      previewOrigin: previewAddress,
      previewOriginClosedReason: admission.ok ? null : admission.reason,
      webappGeneration: "current" as const,
      // Honest, and the distinction the preview pane gates on: `has_webapp` is
      // "a scaffold exists", `ready` is "a server is serving it". A hardcoded
      // "running" beside `ready: false` is the contradiction that let the pane
      // iframe the proxy's 503 — nothing downstream could tell the two apart.
      status: ready ? "running" : "stopped",
      ready,
    });
  });

  // ── ANY /sessions/:id/webapp/* — the reverse proxy ──────────────────────────
  // `:path{.+}` not `*`: Hono 4.13's bare wildcard matches but `param("*")` reads null;
  // the named regex param is the readable multi-segment shape (see artifact-routes). The
  // bare `/webapp` registration keeps the iframe's root URL (webapp-info answers exactly
  // that shape) served — a regex param alone would 404 the empty path. Every verb rides
  // the same handler: see WEBAPP_METHODS for why a GET-only preview is a screenshot.
  const proxyWebapp = async (
    context: Context<{ Variables: AppVariables }, string>,
  ) => {
    const actor = context.var.actor;
    // The shared handler serves both route shapes, so the params are read by name with a
    // fallback (a matched route always carries the session id; "" degrades to the 404 below).
    const sessionId = context.req.param("sessionId") ?? "";
    const { session, botId, conn } = await resolve(sessionId, actor.id);
    if (!session) return context.json({ error: "Session not found" }, 404);
    if (!botId || !conn) {
      return refuse(context, "The sandbox is not available.");
    }

    // Attach, never spawn: the session's reserved port is the managed process's
    // routing contract — the webapp tool's start-webapp.sh owns the one process
    // per session, and the preview refuses rather than double-spawning beside it.
    const port = session.nextjsPort;
    if (port === null) {
      return refuse(context, WEBAPP_NO_SUPPORT_ERROR);
    }
    // The reserved port lives INSIDE the sandbox: the probe and the proxy both
    // dial the sandbox host (the gateway connection's host), never this server's
    // own loopback (F-E).
    const upstreamHost = webappUpstreamHost(
      deps.config.sandboxGatewayBaseUrl || conn.baseUrl,
    );
    if (!(await webappDevServerReady({ host: upstreamHost, port }))) {
      return refuse(context, WEBAPP_NOT_RUNNING_ERROR);
    }

    const result = await proxyWebappRequest({
      upstreamBaseUrl: `http://${upstreamHost}:${port}`,
      // The full mount path, not the bare suffix: the scaffold's basePath equals
      // this route's mount (/api/craft/sessions/<id>/webapp), so the dev server
      // resolves the same URL the browser asked for. Forwarding the suffix alone
      // maps the iframe's root entry to the upstream "/" — whose basePath
      // redirect points right back here, a 307 loop.
      path: context.req.path,
      query: context.req.url.includes("?")
        ? context.req.url.slice(context.req.url.indexOf("?"))
        : "",
      method: context.req.method,
      // Buffered, not streamed: a preview is driven by a person clicking through
      // an app, so the payloads are JSON-sized, and a forwarded stream can only
      // be consumed once — which a retry after the ready probe would find already
      // disturbed. Read AFTER the gate, so a refused request never pays for it.
      body: await requestBody(context),
      requestHeaders: context.req.raw.headers,
    });
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  };
  app.on(
    [...WEBAPP_METHODS],
    "/sessions/:sessionId/webapp/:path{.+}",
    proxyWebapp,
  );
  app.on([...WEBAPP_METHODS], "/sessions/:sessionId/webapp", proxyWebapp);

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
    // The same recursive walk the download-directory route packs with (F6 §C): the
    // gateway's listing is one level, so `collectWorkspaceFiles` rebuilds onyx's
    // outputs/web walk over repeated listings — hidden subtrees pruned whole,
    // unreadable files skipped, arcnames relative to outputs/web.
    let entries: WorkspaceFileEntry[];
    try {
      entries = await collectWorkspaceFiles(fileApi, root);
    } catch (error) {
      // outputs/web doesn't exist — onyx's list_directory ValueError → None → 404.
      // Only the listing's own failure wears that mask; a walk that could not be
      // completed says so (502), because the directory DID answer.
      if (error instanceof WorkspaceListingError) {
        return context.json({ error: "Webapp not found" }, 404);
      }
      logger.warn(
        {
          sessionId,
          err: error instanceof Error ? error.message : String(error),
        },
        "[craft] webapp archive failed",
      );
      return context.json(
        { error: "The webapp archive could not be built." },
        502,
      );
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

// ── HMR websocket proxy (onyx webapp_proxy.py:235-321, 387-398) ────────────────
//
// Next.js dev's hot-reload channel is a websocket, and an upgrade is not a request/response —
// Hono never sees it, so this half lives beside the boot file's upgrade dispatcher (the same
// place the computer-stream proxy terminates) rather than in the routes above. The auth is the
// HTTP proxy's own, applied by hand: the signed-in actor plus the session's ownership lookup.
//
// The upgrade header stays in EXCLUDED_REQUEST_HEADERS above — that blacklist guards the HTTP
// fetch proxy, where forwarding a stray upgrade ask would be a smuggling vector. The HMR socket
// is a deliberately separate endpoint, exactly onyx's split between `_proxy_request` and
// `_proxy_webapp_hmr_websocket`.

/** onyx's websocket route shape under OpenBot's mount: /api/craft/sessions/:id/webapp/_next/webpack-hmr. */
const WEBAPP_HMR_PATH =
  /^\/api\/craft\/sessions\/([^/]+)\/webapp\/_next\/webpack-hmr$/;

/** The session id an HMR upgrade names, or null when the path is not the HMR endpoint. */
export function webappHmrSessionIdFromPath(pathname: string): string | null {
  return WEBAPP_HMR_PATH.exec(pathname)?.[1] ?? null;
}

/**
 * onyx `_webapp_hmr_query_string`: only the `id` entries survive to the dev server — the rest of
 * the client's query is HMR-unrelated and never crosses the trust boundary.
 */
export function webappHmrQueryString(query: string): string {
  const kept = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(query).entries()) {
    if (key === "id") kept.append(key, value);
  }
  const encoded = kept.toString();
  return encoded ? `?${encoded}` : "";
}

/**
 * onyx `_webapp_hmr_websocket_url`, and the one place this port had it wrong.
 *
 * The upstream path is the inbound path VERBATIM, for the same reason the HTTP proxy
 * forwards `context.req.path` rather than the bare suffix: the scaffold's `basePath`
 * (web-template/next.config.ts) IS this route's mount, so a Next dev server serves
 * `/_next/webpack-hmr` UNDER that basePath and not at the port root. This function used
 * to hardcode the port root — measured live against a running session, that socket timed
 * out with zero frames while the basePath-joined one opened and streamed. Turbopack's dev
 * client gates its chunk loading on the HMR channel, so a silent socket left the preview
 * permanently un-hydrated: 17 scripts and then nothing for 90s, where the same page loaded
 * straight from the dev server pulls 187 and hydrates. The HTML was byte-identical either
 * way, which is why nothing on the response side ever showed it.
 *
 * Not an open relay: `path` only ever arrives from a pathname WEBAPP_HMR_PATH matched,
 * which pins it to exactly this endpoint.
 */
export function webappHmrUpstreamUrl(input: {
  host: string;
  port: number;
  path: string;
  query: string;
}): string {
  return `ws://${input.host}:${input.port}${input.path}${webappHmrQueryString(input.query)}`;
}

export type WebappHmrDeps = Pick<
  WebappProxyRoutesDeps,
  "config" | "store" | "botIdFor" | "sandboxConnectionFor"
>;

export type WebappHmrResolution =
  | { ok: true; upstreamUrl: string }
  | { ok: false; status: 401 | 404 | 503; error: string };

/**
 * The HMR upgrade's authorization + target resolution — the same refusal shapes the HTTP proxy
 * answers, checked before `server.upgrade` commits the connection (onyx `_check_webapp_access`
 * → `WebSocketException(1008)`; an HTTP refusal before the upgrade is the Bun-shaped equivalent).
 */
export async function resolveWebappHmrUpgrade(
  deps: WebappHmrDeps,
  input: {
    sessionId: string;
    actor: { id: string } | null;
    /** The inbound upgrade's pathname — forwarded verbatim, see webappHmrUpstreamUrl. */
    path: string;
    query: string;
  },
): Promise<WebappHmrResolution> {
  if (!input.actor) {
    return { ok: false, status: 401, error: "Sign in first." };
  }
  const session = await deps.store.getSession(input.sessionId, input.actor.id);
  if (!session) {
    return { ok: false, status: 404, error: "Session not found" };
  }
  const botId = await deps.botIdFor(input.sessionId);
  const conn = botId ? deps.sandboxConnectionFor(botId) : null;
  if (!botId || !conn) {
    return { ok: false, status: 503, error: "The sandbox is not available." };
  }
  if (session.nextjsPort === null) {
    return { ok: false, status: 503, error: WEBAPP_NO_SUPPORT_ERROR };
  }
  // The reserved port lives INSIDE the sandbox (F-E): dial the sandbox host, never loopback.
  return {
    ok: true,
    upstreamUrl: webappHmrUpstreamUrl({
      host: webappUpstreamHost(
        deps.config.sandboxGatewayBaseUrl || conn.baseUrl,
      ),
      port: session.nextjsPort,
      path: input.path,
      query: input.query,
    }),
  };
}

/**
 * The HMR endpoint as the APP itself addresses it (#363, F-2/#365): the
 * upstream-resolvable pathname — the host form's verbatim
 * `/_next/webpack-hmr` at the origin root, the dev form's
 * `/<label>/_next/webpack-hmr` under the basePath mount the start script
 * injected (the label is part of the path Next serves, exactly like the
 * same-origin mount's own prefix). Session identity rides the HOST on a
 * preview origin, never this path.
 */
const WEBAPP_HMR_APP_PATH = /^\/(?:[^/]+\/)?_next\/webpack-hmr$/;

/**
 * Whether an upstream-resolvable pathname is the HMR endpoint — the
 * preview-origin dispatcher's branch gate (#363). One optional leading label
 * segment (the dev form's mount) or none (the host form's root); anything
 * deeper is not this endpoint. The same-origin mount (WEBAPP_HMR_PATH, with
 * the session id IN the path) is the other dispatcher's shape and never
 * matches: on a preview host the session comes from Host resolution, and a
 * path that still names a session is not one this branch answers.
 */
export function webappHmrIsAppPath(appPath: string): boolean {
  return WEBAPP_HMR_APP_PATH.test(appPath);
}

/**
 * The preview-origin resolver's deps (#363): the by-id row the preview seam reads
 * (the pass IS the authentication — there is no actor id to ownership-check
 * against) plus the sandbox facts every upstream resolution shares.
 */
export type PreviewWebappHmrDeps = {
  config: CraftConfig;
  store: Pick<CraftStore, "findSessionById">;
  botIdFor: (sessionId: string) => Promise<string | null>;
  /** Connection facts for a Bot's sandbox gateway (baseUrl + token). */
  sandboxConnectionFor: (
    botId: string,
  ) => { baseUrl: string; token: string | null } | null;
};

/**
 * The HMR upgrade's authorization + target resolution ON A PREVIEW HOST (#363) —
 * the host-routed twin of resolveWebappHmrUpgrade. The authorization is the
 * preview pass (the D9 cookie the redemption hop planted): the SAME judgment the
 * HTTP proxy applies — present, and naming THIS host's session. A platform
 * session is never in scope on these hosts (that is the origin split's whole
 * point), and a ticket in the query is not a credential: the redemption hop
 * consumed it, and its only legal lifetime was that one 302. Refusals keep the
 * proxy's 401/404/503 shapes and land BEFORE the caller commits `server.upgrade`.
 */
export async function resolvePreviewWebappHmrUpgrade(
  deps: PreviewWebappHmrDeps,
  input: {
    sessionId: string;
    request: Request;
    /** The upstream-resolvable inbound pathname — label included (dev form). */
    path: string;
    query: string;
  },
): Promise<WebappHmrResolution> {
  if (!holdsPreviewSessionPass(input.sessionId, input.request)) {
    return { ok: false, status: 401, error: PREVIEW_PASS_REFUSAL };
  }
  const session = await deps.store.findSessionById(input.sessionId);
  if (!session) {
    return {
      ok: false,
      status: 404,
      error: "This preview session no longer exists.",
    };
  }
  const botId = await deps.botIdFor(input.sessionId);
  const conn = botId ? deps.sandboxConnectionFor(botId) : null;
  if (!botId || !conn) {
    return { ok: false, status: 503, error: "The sandbox is not available." };
  }
  if (session.nextjsPort === null) {
    return { ok: false, status: 503, error: WEBAPP_NO_SUPPORT_ERROR };
  }
  // The reserved port lives INSIDE the sandbox (F-E): dial the sandbox host, never loopback.
  return {
    ok: true,
    upstreamUrl: webappHmrUpstreamUrl({
      host: webappUpstreamHost(
        deps.config.sandboxGatewayBaseUrl || conn.baseUrl,
      ),
      port: session.nextjsPort,
      path: input.path,
      query: input.query,
    }),
  };
}

/** What an upgraded HMR socket carries: where to connect inward, and the socket once opened. */
export type WebappHmrSocketData = {
  upstream: string;
  hmr: true;
  inward?: WebSocket;
  /**
   * Frames the client sent while the inward dial was still connecting. onyx accepts the client
   * socket only AFTER the upstream connects, so this situation cannot arise there; Bun completes
   * the client handshake at `server.upgrade`, so the equivalent is to hold those early frames
   * and flush them on inward open rather than drop them.
   */
  pending?: (string | Buffer)[];
};

type WebappHmrSocket = {
  data: WebappHmrSocketData;
  send(data: string | ArrayBuffer): unknown;
  close(): unknown;
};

/**
 * The client↔upstream bridge, onyx's `_pump_webapp_to_upstream` / `_pump_upstream_to_webapp`:
 * frames forward unbuffered in both directions, and either side's close or error ends the other
 * (onyx's FIRST_COMPLETED + cancel pairing). A failed inward dial surfaces as the client's
 * socket closing, onyx's refusal-with-1011 shape.
 */
export const webappHmrSocketHandlers = {
  open(ws: WebappHmrSocket) {
    const inward = new WebSocket(ws.data.upstream);
    ws.data.inward = inward;
    ws.data.pending = [];
    inward.onopen = () => {
      const pending = ws.data.pending ?? [];
      ws.data.pending = undefined;
      for (const frame of pending) inward.send(frame);
    };
    inward.onmessage = (event) => {
      try {
        ws.send(event.data as string | ArrayBuffer);
      } catch {
        inward.close();
      }
    };
    inward.onclose = () => ws.close();
    inward.onerror = () => ws.close();
  },
  message(ws: WebappHmrSocket, raw: string | Buffer) {
    const inward = ws.data.inward;
    if (inward?.readyState === 1) {
      inward.send(raw);
    } else if (inward?.readyState === 0) {
      ws.data.pending?.push(raw);
    }
  },
  close(ws: WebappHmrSocket) {
    ws.data.pending = undefined;
    ws.data.inward?.close();
  },
};
