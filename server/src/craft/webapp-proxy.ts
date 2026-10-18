/**
 * The craft webapp surface — ported from onyx `webapp_proxy.py` + the `webapp-info` /
 * `webapp-download` endpoints in `session/api.py`, Hono-shaped.
 *
 * Four endpoints:
 * - GET /sessions/:id/webapp-info    — has_webapp / webapp_url / status / ready
 * - ANY /sessions/:id/webapp/*        — reverse-proxy the session's dev server
 * - GET /sessions/:id/webapp-download — the scaffolded webapp as a ZIP (T5: onyx parity)
 * - GET /sessions/:id/preview-origin-live — the pane's same-origin liveness probe (fix-ocr13)
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
import {
  webappDevServerReady,
  webappUpstreamHost,
  WEBAPP_MOUNT_MARKER,
} from "./nextjs-dev";
import { refuseResponse } from "./refusal";
import {
  PREVIEW_PASS_REFUSAL,
  type ServePreview,
} from "./preview-origin";
import {
  createPreviewTickets,
  defaultPreviewOrigin,
  type PreviewTickets,
} from "./preview-ticket";
import type { AgentSandboxFileApi, SandboxGateway } from "./sandbox-gateway";
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
  /**
   * The registry half of the same-origin liveness probe (fix-ocr13): whether
   * the session's label currently sits in the preview origin's registry —
   * false is the restart verdict (M-2: the registry is in-process). The boot
   * file wires preview-origin's hasSession; unset fails closed (503), which
   * self-heals: re-entry re-registers the label through originFor.
   */
  previewOriginHas?: (sessionId: string) => boolean;
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
 * The rebuild-window refusal (review-367 H): the generation marker reads
 * current, but the running script's mount record does not name the address's
 * path — the dev server is not mounted where the preview address points, so
 * handing the address out would be a silent, non-self-healing 404 on every
 * request. The address is withheld and this displayable sentence rides the
 * same channel a closed origin uses (the pane's closedReason state).
 */
const WEBAPP_MOUNT_STALE_REASON =
  "The web app was started by an older start script: its dev server is not mounted on the preview address. Refresh the session's start script (repair or regenerate the session), then start the web app again.";

/**
 * The same-origin liveness probe's restart sentence (fix-ocr13): the session
 * row is durable but its preview label is not (the registry is in-process,
 * M-2) — the pane reads this 503 as "drop the entry and re-enter through the
 * main site", the documented recovery path.
 */
const PREVIEW_ORIGIN_RESTARTED_ERROR =
  "The preview origin restarted; re-enter the preview.";

/**
 * The D10 legacy refusal on the ticket face (fix-ocr24 #5): a legacy app is
 * mounted on the OLD same-origin prefix, so a preview-origin address minted
 * for it would 404 after redemption — the silent-404 middle state #367 exists
 * to prevent, previously reachable by calling this API directly even though
 * webapp-info answers the old path. Refused with a displayable sentence, in
 * the same family as this surface's other refusals.
 */
const PREVIEW_TICKET_LEGACY_ERROR =
  "This session's web app predates the preview origin and is served on its legacy in-app path; there is no preview-origin ticket to issue for it.";

/**
 * The unverifiable-generation refusal (fix-ocr26 #8): the mint's generation
 * read THREW — a gateway flake, no verdict. 503 with a retryable sentence,
 * deliberately NOT the legacy 409 (that is a generational FACT a flake never
 * established) and not a mint against an unjudged workspace.
 */
const PREVIEW_TICKET_UNVERIFIABLE_ERROR =
  "The session's web app generation could not be verified just now (the sandbox workspace did not answer); try again in a moment.";

/**
 * The .webapp-mount record the RUNNING script left beside .nextjs-port
 * (review-367 H's second signal) — the ONE read behind three verdicts
 * (fix-ocr28 #4): the preview-ticket mint's legacy-heal mirror and
 * webapp-info's legacy and current branches each used to spell the
 * readFile + trim + null-fold + catch verbatim, and any one site drifting
 * its fold would make the two mirrored surfaces disagree about the SAME
 * session's record. null means ONLY "cannot vouch" — no fileApi
 * (undefined) or a thrown read (a gateway flake); readFile's null (the
 * record was never written) folds to "" and keeps comparing as the empty
 * mount, a real answer (the root mount), never a refusal (fix-ocr29 #3:
 * this sentence previously counted readFile's null among the nulls —
 * drifting from the code the comment documents). A READ record answers
 * its trimmed content, "" included. The consumers' judgments
 * stay at their own seams on purpose: the mint needs a non-empty exact
 * match, the legacy branch reads an empty record as the true legacy
 * answer, the current branch compares against the expected mount — same
 * read, different verdicts, exactly the part that must NOT be merged.
 */
async function readMountRecord(
  fileApi: AgentSandboxFileApi | null | undefined,
  directory: string,
): Promise<string | null> {
  try {
    const raw = await fileApi?.readFile(`${directory}/${WEBAPP_MOUNT_MARKER}`);
    return raw === undefined ? null : (raw?.trim() ?? "");
  } catch {
    return null;
  }
}

/**
 * The mount a preview address's own path names (fix-ocr28 #4): the address
 * path with the bare "/" folded to "" — the start script's record shape
 * (nextjs-dev.ts writes the empty mount for a root-path script). The mint's
 * mirror and webapp-info's two branches each used to hand-copy the fold;
 * one derivation keeps the ticket route and webapp-info comparing the same
 * session's record the same way.
 */
function expectedMountFor(previewAddress: string): string {
  const addressPath = new URL(previewAddress).pathname;
  return addressPath === "/" ? "" : addressPath;
}

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
 * The raw-Request form is `refuseResponse` in ./refusal.ts — the preview origin's
 * own gates (its 401 pass refusal) land on iframes too and use the SAME dual
 * shape; the leaf module keeps this module and preview-origin from importing
 * each other (review-367 L1).
 */
function refuse(
  context: Context<{ Variables: AppVariables }, string>,
  message: string,
) {
  return refuseResponse(context.req.raw, message);
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
 *
 * F-1（codex 重审）closed the two reach-back channels `connect-src` does not
 * cover. The preview iframe keeps `allow-forms` (preview-tab.tsx) and the
 * preview host is SAME-SITE with the main site (same eTLD+1) — SameSite is
 * judged per site, so a form POST from `<label>.preview.example.com` to
 * `app.example.com` would carry the platform's session cookies, and no
 * `connect-src` constrains form submissions. `form-action 'self'` walls the
 * submission target to the preview origin itself. The same reach-back class
 * exists through nested browsing contexts — an embedded main-site document is
 * a live, cookie-carrying frame (and a UI-redress surface) the app chooses —
 * so `frame-src 'self'` pins embedding to the preview origin too. What NEITHER
 * directive covers is recorded in docs: a direct top-level self-navigation
 * (`location.href = main-site-write-GET`) has no shipped CSP directive
 * (`navigate-to` was dropped from CSP3) — that channel is closed by the main
 * site never mutating on GET, not by this policy.
 */
const WEBAPP_DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; form-action 'self'; frame-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'";

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
 * calls after its cookie gate): the request already carries a pass the origin
 * VERIFIED — this module receives the verified userId and finds the session's
 * row BY (id, userId) — #358 repair: the ownership re-check. A pass is the
 * authentication, the verified claim is the authorization: a row the userId
 * no longer owns (reassigned / restart-deleted) is the same honest 404, and a
 * dial never happens for it. Then the same sandbox facts the main-site proxy
 * uses, ATTACHED (probe, never spawn), forwarded through proxyWebappRequest
 * with the same header hygiene, CSP and refusal shapes as the same-origin
 * route. A down dev server is the same not-running sentence the pane already
 * shows.
 */
export function createPreviewProxy(deps: {
  config: CraftConfig;
  /** The bump-free (id, owner) row lookup (routing, not use). */
  store: Pick<CraftStore, "findSession">;
  botIdFor: (sessionId: string) => Promise<string | null>;
  sandboxConnectionFor: (
    botId: string,
  ) => { baseUrl: string; token: string | null } | null;
  fetchImpl?: typeof fetch;
  /** The memo clock; injectable so tests advance past the TTL instead of sleeping. */
  now?: () => number;
}): ServePreview {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  // fix-ocr27 #8: the readiness memo — every preview-source request used to
  // pay a serial probe (a 2s-timeout dial) before its forward, doubling the
  // RTT of the production path across a whole page load (chunks, CSS, Server
  // Actions). A recent successful probe or forward carries the next requests
  // across READY_MEMO_TTL_MS without dialing; a failed probe is never
  // memoized (the next request re-probes, so a recovered server is served
  // the moment it recovers), and expiry re-probes too. Refusal semantics are
  // unchanged: a memo MISS runs the exact same probe and refusal; a memo HIT
  // skips only the dial whose answer ("up") is already known.
  const READY_MEMO_TTL_MS = 3_000;
  const readyUntil = new Map<string, number>();
  return async ({ sessionId, userId, request, appPath, query }) => {
    const session = await deps.store.findSession(sessionId, userId);
    if (!session) {
      // fix-ocr28 #5: the deleted session's memo entries die with the row.
      // The 404 branch used to leave them behind — dead-session keys whose
      // values only the TTL would retire, and a re-created row (or a
      // re-reserved port for a new session) could ride a readiness verdict
      // minted for a DIFFERENT process's lifetime. sessionId is cs-<hex> —
      // no ":" — so the `${sessionId}:` prefix can only match this
      // session's own keys. (The other residual — entries whose VALUES have
      // expired but whose keys linger until overwritten — is a bounded,
      // per-session-const count and stays out of scope here.)
      for (const key of readyUntil.keys()) {
        if (key.startsWith(`${sessionId}:`)) readyUntil.delete(key);
      }
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
    const memoKey = `${sessionId}:${port}`;
    if ((readyUntil.get(memoKey) ?? 0) <= now()) {
      if (
        !(await webappDevServerReady({ host: upstreamHost, port }, fetchImpl))
      ) {
        // A failed probe writes nothing (and clears any stale entry): a
        // memoized DOWN verdict would refuse a recovered app for the
        // TTL's remainder.
        readyUntil.delete(memoKey);
        return refuseResponse(request, WEBAPP_NOT_RUNNING_ERROR);
      }
      readyUntil.set(memoKey, now() + READY_MEMO_TTL_MS);
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
    // A forwarded answer is itself a readiness observation: the upstream just
    // answered, so the memo rides for the TTL — except a 502/504, which is
    // THIS proxy's own transport verdict (connection failure / timeout),
    // i.e. the upstream dying between the memo and the forward. Those clear
    // the entry so the next request re-probes and gets the honest refusal.
    if (result.status === 502 || result.status === 504) {
      readyUntil.delete(memoKey);
    } else {
      readyUntil.set(memoKey, now() + READY_MEMO_TTL_MS);
    }
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
      // fix-ocr20 #4: a missing injection is a WIRING bug, and the old
      // fallback answered it with a silently GUESSED address — the dev port
      // root (`http://127.0.0.1:<port>`), which carries no session label, is
      // not routable to any session's app, and the webapp-info mount
      // cross-check (review-367 H) would flag it stale. The comment above it
      // claimed "refuses loudly": that was only true when the port failed to
      // parse. Fail loud in BOTH branches, isomorphic with the closed branch:
      // production always injects (index.ts wires the real preview origin
      // here), so a call without the injection throws instead of guessing.
      throw new Error(
        "The preview origin is not wired into this route surface (previewOriginFor injection missing) — refusing to guess an address.",
      );
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
    // D10 (#367) closed on the API face (fix-ocr24 #5): a legacy app is
    // mounted on the OLD same-origin prefix, so the preview address this
    // ticket binds to would 404 the moment it was redeemed — the entry the
    // pane never walks (webapp-info answers the old path there) but a direct
    // API call could. The mint reads the SAME readWebappGeneration judgment
    // webapp-info answers from, one branch over; the mirror is the
    // discipline (webapp-generation.ts's header), not a shared abstraction.
    const generation = await readWebappGeneration(
      deps.gateway.fileApiFor(botId),
      sessionDirectory(sessionId, deps.config.sessionDirectoryMode),
    );
    if (generation === "legacy") {
      // fix-ocr27 #3: the mint mirrors webapp-info's healed legacy branch.
      // "Legacy" has a hole the marker's write point never closes: an app
      // assembled OUTSIDE the template-copy branch (an agent hand-creating
      // outputs/web per the script's own error hint) carries no marker, but
      // its provisioning-era script still mounts /<label> — and the RUNNING
      // server's .webapp-mount record is the proof of which mount it
      // actually serves. A record naming exactly the derived label mount
      // means the address this ticket binds is served — the D10 refusal's
      // premise (the redeemed address would 404) does not hold, and the
      // mint proceeds. Any other record (empty, absent, unreadable, another
      // mount) keeps the refusal: the conservative answer for every
      // population the record cannot vouch for, byte-for-byte unchanged.
      const expectedMount = expectedMountFor(origin);
      // The one shared read (readMountRecord, fix-ocr28 #4) — the SAME shape
      // as webapp-info's cross-check: null (no fileApi, no record, or a
      // thrown read) is NOT proof, only a READ non-empty record naming the
      // derived mount is.
      const recorded = await readMountRecord(
        deps.gateway.fileApiFor(botId),
        sessionDirectory(sessionId, deps.config.sessionDirectoryMode),
      );
      const recordProvesMount =
        recorded !== null && recorded !== "" && recorded === expectedMount;
      if (!recordProvesMount) {
        return context.json({ error: PREVIEW_TICKET_LEGACY_ERROR }, 409);
      }
    }
    if (generation === "unknown") {
      // fix-ocr26 #8: the read flaked — 503 + retry, never the legacy 409
      // (a generational fact the flake never established).
      return context.json({ error: PREVIEW_TICKET_UNVERIFIABLE_ERROR }, 503);
    }
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

  // ── GET /sessions/:id/preview-origin-live — the pane's same-origin probe ──
  //
  // fix-ocr13 (round13 H): the frame-load liveness probe used to be a
  // CROSS-ORIGIN credentialed fetch of the preview address, which cannot read
  // its own status without CORS headers (TypeError — indistinguishable from
  // network death), and in the dev form a restart-empty registry drops the old
  // address onto the MAIN site's no-CORS 200/404 — a clean misjudgment. The
  // probe is therefore an endpoint on THIS surface: same-origin by construction
  // (default credentials ride it), answering the registry's restart verdict
  // directly. Registered label + open admission → 204 (no body); anything else
  // → 503 with the sentence the pane treats as "re-enter". Ticket/cookie
  // semantics untouched — this reads registry state, never credentials.
  app.get("/sessions/:sessionId/preview-origin-live", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    // A ROUTE-CLASS READ DOES NOT FEED THE IDLE CLOCK (fix-ocr18 #1): the
    // panel polls this endpoint for as long as the pane exists, and resolve
    // reads through store.getSession — the owning read that STAMPS
    // lastActivityAt — so an idle session under an open pane would never be
    // reaped. findSession answers the same ownership-checked row without
    // the bump (the sandbox-status poll's precedent); 404 for a stranger's
    // id is unchanged. The muting surfaces (POST preview-ticket, the proxy
    // itself) keep resolve: a preview actually in use IS activity.
    const session = await deps.store.findSession(sessionId, actor.id);
    if (!session) return context.json({ error: "Session not found" }, 404);
    const admission = previewOriginAdmission();
    if (!admission.ok) {
      return context.json({ error: admission.reason }, 503);
    }
    if (!deps.previewOriginHas) {
      // fix-ocr27 #5: isomorphic with previewOriginFor's fix-ocr20 #4 — a
      // missing injection is a WIRING bug. The old `?.() ?? false` answered
      // it with the restart sentence forever: the pane drops the entry and
      // re-enters, but re-entry re-registers the label through originFor,
      // which never runs when the injection itself is missing — a permanent
      // 503 loop wearing a restart mask. Production always injects (index.ts
      // wires craftPreviewOrigin.hasSession); a call without one throws
      // instead of looping.
      throw new Error(
        "previewOriginHas is not wired into this route surface — refusing to disguise a wiring bug as a restart.",
      );
    }
    if (!deps.previewOriginHas(sessionId)) {
      return context.json({ error: PREVIEW_ORIGIN_RESTARTED_ERROR }, 503);
    }
    // 204 is heuristically cacheable per RFC 7234 — a probe's answer never is.
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store" },
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
    // fix-ocr27 #4: fix-ocr21 #3's gate, one read earlier in the answer.
    // When hasWebapp is false the app is not assembled — readWebappGeneration's
    // own app-body probe is doomed to answer "current" (the next start copies
    // the current template) — while the panel polls this endpoint every 5s
    // through exactly that build window, so the unconditional read was pure
    // per-poll overhead. Short-circuit to the same verdict; the same caliber
    // as fix-ocr26 #8's "unknown answers the current shape".
    const generation = hasWebapp
      ? await readWebappGeneration(fileApi, directory)
      : "current";
    if (generation === "legacy") {
      // fix-ocr27 #3: the legacy branch used to bypass the mount cross-check
      // the current branch runs — and "legacy" has a hole the marker's write
      // point never closes: an app assembled OUTSIDE the template-copy branch
      // (an agent hand-creating outputs/web per the script's own error hint)
      // never gets a marker, so the judgment reads legacy forever, while its
      // provisioning-era script mounts /<label> and the RUNNING server serves
      // there. Handing that session the old same-origin path is the silent,
      // never-self-healing 404 #367 exists to prevent, re-read every 5s
      // poll. The record decides, under the SAME ready gate as the current
      // branch's verdict (fix-ocr18 #2 / fix-ocr21 #3 — a not-yet-serving
      // session has no frame to misroute and pays no read):
      // - non-empty and equal to the derived label mount → the RUNNING
      //   server serves the preview address's mount — issue the address in
      //   the current shape;
      // - non-empty and different → the WEBAPP_MOUNT_STALE repair sentence;
      // - empty, absent, or unreadable → the true legacy answer, unchanged.
      if (ready) {
        // The one shared read (readMountRecord, fix-ocr28 #4): readFile's
        // null is an ANSWER ("no record was ever written"), undefined (no
        // fileApi at all) cannot verify, a throw is a gateway flake — all
        // three fold to null: only a READ record cross-checks, everything
        // else keeps the conservative path.
        const recordedMount = await readMountRecord(fileApi, directory);
        if (recordedMount !== null && recordedMount !== "") {
          const admission = previewOriginAdmission();
          if (!admission.ok) {
            // A closed origin with a label-mounted server: the old path would
            // be the same silent 404, so it stays withheld and the closed
            // gate's own reason answers — the same precedent as the current
            // branch's "a closed origin skips the cross-check". Self-heals
            // when admission reopens (the next poll derives the address).
            return context.json({
              has_webapp: hasWebapp,
              webapp_url: null,
              previewOrigin: null,
              previewOriginClosedReason: admission.reason,
              webappGeneration: "current" as const,
              status: "running",
              ready,
            });
          }
          const previewAddress = previewOriginFor(sessionId);
          const expectedMount = expectedMountFor(previewAddress);
          if (recordedMount === expectedMount) {
            // The manual-assembly middle state heals: the app carries no
            // marker, but the server it runs is label-mounted exactly
            // where the preview address points — the current shape's
            // answer, honestly labeled so the pane walks the preview
            // path (and the mint's mirror below admits the exchange).
            return context.json({
              has_webapp: hasWebapp,
              webapp_url: previewAddress,
              previewOrigin: previewAddress,
              previewOriginClosedReason: null,
              webappGeneration: "current" as const,
              status: "running",
              ready,
            });
          }
          // The server serves SOMEWHERE, just not where the address
          // points: no address, the same repair channel the current
          // branch's mismatch verdict uses.
          return context.json({
            has_webapp: hasWebapp,
            webapp_url: null,
            previewOrigin: null,
            previewOriginClosedReason: WEBAPP_MOUNT_STALE_REASON,
            webappGeneration: "current" as const,
            status: "running",
            ready,
          });
        }
      }
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
    // fix-ocr26 #8: "unknown" (the generation read flaked) falls through to
    // the CURRENT-shape answer — the address below is the one the origin
    // already minted, and rewriting it to the old same-origin path on a
    // gateway hiccup pointed the pane's frame at a 404 until a full reload.

    // #362 (m-5/D11): `webapp_url` is the ABSOLUTE preview address (D11 — the
    // same-origin path is retired), mirrored as `previewOrigin`; a closed origin
    // answers no address and the displayable reason instead. The pane gates on
    // `ready` before ever pointing a frame at the address, unchanged.
    const admission = previewOriginAdmission();
    const previewAddress = admission.ok ? previewOriginFor(sessionId) : null;

    // review-367 H: the generation marker is stamped at template-copy time by
    // WHATEVER script ran — a legacy-era script (written before the mount env
    // existed) that rebuilds the app re-stamps "2" without gaining the env, so
    // its dev server stays on the port root while the fresh marker reads
    // current, and no script write point runs on a rebuild to correct it. The
    // script's own mount record (.webapp-mount, written beside .nextjs-port by
    // every run) is the second signal: it names the mount the RUNNING server
    // was actually spawned under. An address whose path the record does not
    // name would 404 silently — refuse the address and surface the state
    // through the same displayable channel the closed origin uses.
    if (previewAddress !== null) {
      const expectedMount = expectedMountFor(previewAddress);
      // A read that CANNOT happen is not a record that came back wrong
      // (fix-ocr5 M-1): a sandbox-gateway flake on exactly this call used to
      // collapse into "no record" — indistinguishable from the rebuild
      // window — and withheld the address behind the needs-restart sentence
      // even while ready=true, sending the person into an unnecessary repair
      // loop. An unverifiable record now SKIPS the cross-check (the ready
      // probe owns availability); only a record that was READ and names a
      // different mount refuses the address — the same direction as
      // readWebappGeneration one branch up, where an unreadable workspace
      // degrades to the conservative-but-working path instead of a verdict.
      // fix-ocr21 #3: the read lives inside the ready branch its verdict
      // guards. The verdict is ready-gated (fix-ocr18 #2 below), so while
      // has_webapp && !ready the read's answer had no consumer — and the
      // panel polls webapp-info every 5s, each poll paying a sandbox-gateway
      // file read for nothing. Only a serving session's judgment reads.
      if (ready) {
        // The one shared read (readMountRecord, fix-ocr28 #4): readFile's
        // null is an ANSWER — "no record was ever written", the rebuild
        // window's whole signal — so it keeps comparing as the empty mount;
        // only undefined (no fileApi at all) means "cannot verify", and a
        // throw (the gateway flaked: unverifiable, not mismatched) folds
        // the same way.
        const recordedMount = await readMountRecord(fileApi, directory);
        // fix-ocr18 #2: the mismatch VERDICT is a ready-gated judgment. An
        // absent record on a not-yet-serving session is the first-build
        // window, not a stale script — no frame is pointed at the address
        // (the pane gates on ready), so refusing buys nothing and only
        // accuses a rebuild that never happened. A SERVING server whose
        // record names another mount remains the broken contract.
        if (recordedMount !== null && recordedMount !== expectedMount) {
          return context.json({
            has_webapp: hasWebapp,
            webapp_url: null,
            previewOrigin: null,
            previewOriginClosedReason: WEBAPP_MOUNT_STALE_REASON,
            webappGeneration: "current" as const,
            // fix-ocr19 #12: inside this branch `ready` is already known true
            // (it guards the verdict) — the ternary's "stopped" arm was dead
            // code. "running" is the honest status: the server IS serving,
            // on the wrong mount.
            status: "running",
            ready,
          });
        }
      }
    }

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
 * The preview-origin resolver's deps (#363): the (id, owner) row the preview
 * seam reads (#358 repair — findSession with the pass's verified userId, so a
 * reassigned/deleted row is a 404 before any upgrade commits) plus the SAME
 * pass judgment the HTTP gate runs (verifyPass, injected from the origin — one
 * codec, one cookie iteration, one acceptance) and the sandbox facts every
 * upstream resolution shares.
 */
export type PreviewWebappHmrDeps = {
  config: CraftConfig;
  store: Pick<CraftStore, "findSession">;
  /**
   * THE pass judgment — the origin's own verifyPass method (the boot file
   * injects it), so the upgrade applies exactly the acceptance the HTTP gate
   * ran, never a second derivation of it.
   */
  verifyPass: (
    sessionId: string,
    request: Request,
  ) => { userId: string } | null;
  botIdFor: (sessionId: string) => Promise<string | null>;
  /** Connection facts for a Bot's sandbox gateway (baseUrl + token). */
  sandboxConnectionFor: (
    botId: string,
  ) => { baseUrl: string; token: string | null } | null;
};

/**
 * The HMR upgrade's authorization + target resolution ON A PREVIEW HOST (#363) —
 * the host-routed twin of resolveWebappHmrUpgrade. The authorization is the
 * preview pass (#358 repair): the SAME signed-pass judgment the HTTP proxy
 * applies — injected as deps.verifyPass, the origin's own verify — and its
 * verified userId then re-checks the row BY (id, owner): a pass minted before
 * a reassignment or restart-deletion dies here as the same 404 the HTTP seam
 * answers. A platform session is never in scope on these hosts (that is the
 * origin split's whole point), and a ticket in the query is not a credential:
 * the redemption hop consumed it, and its only legal lifetime was that one
 * 302. Refusals keep the proxy's 401/404/503 shapes and land BEFORE the caller
 * commits `server.upgrade`.
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
  const verified = deps.verifyPass(input.sessionId, input.request);
  if (verified === null) {
    return { ok: false, status: 401, error: PREVIEW_PASS_REFUSAL };
  }
  const session = await deps.store.findSession(input.sessionId, verified.userId);
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
