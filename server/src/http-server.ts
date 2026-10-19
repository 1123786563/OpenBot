import { DICTATION_HTTP_IDLE_SECONDS } from "@openbot/shared/dictation";
import { getLogger } from "@openbot/shared/logger";
import { serve } from "bun";
import type { OpenBotRole } from "./auth/roles";
import { websocket as channelSocket } from "./channels/socket";
import type { StreamDecision } from "./computer/stream-auth";
import { type PreviewOrigin, samePreviewOrigin } from "./craft/preview-origin";
import {
  type PreviewWebappHmrDeps,
  resolvePreviewWebappHmrUpgrade,
  resolveWebappHmrUpgrade,
  type WebappHmrDeps,
  type WebappHmrSocketData,
  webappHmrIsAppPath,
  webappHmrSessionIdFromPath,
  webappHmrSocketHandlers,
} from "./craft/webapp-proxy";
import type { DemonstrationRecorder } from "./demonstrations/recording";
import type { DemonstrationStore } from "./demonstrations/store";

/**
 * The server's front door: one Bun server that hands ordinary requests to the Hono app, serves the
 * craft preview origins, proxies the computer's live stream and the craft webapp's HMR socket, and
 * carries channel activity over websockets.
 *
 * Upstream extracted this out of index.ts (#798); the fork's front door grew three duties upstream's
 * version never saw — the craft preview origin gate, the webapp HMR proxy, and authorizeStream's
 * token-header stream decisions — so they all live here now, passed in as deps.
 */

type StreamData = {
  upstream: string;
  /** The computer token, handed to the inward socket as a header, never on the URL. */
  token: string;
  ownerUserId: string;
  botId: string;
  recordingId?: string;
  inward?: WebSocket;
};

/**
 * Bun takes exactly one WebSocket handler for the server, and three features need one: the app
 * proxies the computer stream and the craft webapp's HMR socket, and it pushes channel activity
 * through Hono's adapter. So this one dispatches on what the upgrade attached — an HMR socket
 * carries `hmr`, a stream proxy socket carries `upstream` without it, a Hono socket carries
 * neither — rather than any feature quietly taking the slot and breaking the others on connect.
 */
type ChannelSocket = Parameters<typeof channelSocket.open>[0];
type SocketData = StreamData | WebappHmrSocketData | ChannelSocket["data"];

const isProxiedStream = (data: SocketData): data is StreamData =>
  typeof (data as StreamData).upstream === "string" &&
  (data as WebappHmrSocketData).hmr !== true;

const isHmrSocket = (data: SocketData): data is WebappHmrSocketData =>
  (data as WebappHmrSocketData).hmr === true;

// Hono owns the socket's data once it has upgraded it; this hands its own back to it.
const asChannelSocket = (ws: { data: SocketData }) =>
  ws as unknown as ChannelSocket;

export function startHttpServer(deps: {
  port: number;
  app: {
    fetch: (
      request: Request,
      env: { server: unknown },
    ) => Response | Promise<Response>;
  };
  authorizeStream: (request: Request) => Promise<StreamDecision>;
  resolveRequestActor: (
    request: Request,
  ) => Promise<{ id: string; name: string; role: OpenBotRole }>;
  demonstrationStore: DemonstrationStore;
  demonstrationRecorder: DemonstrationRecorder;
  craftPreviewOrigin: PreviewOrigin | undefined;
  craftWebappHmrDeps: WebappHmrDeps | undefined;
  craftPreviewWebappHmrDeps: PreviewWebappHmrDeps | undefined;
}): void {
  const {
    port,
    app,
    authorizeStream,
    resolveRequestActor,
    demonstrationStore,
    demonstrationRecorder,
    craftPreviewOrigin,
    craftWebappHmrDeps,
    craftPreviewWebappHmrDeps,
  } = deps;
  const log = getLogger("server");

  serve<SocketData>({
    port,
    async fetch(request, server) {
      const url = new URL(request.url);
      // The craft preview origin (#361/#362): claimed hosts NEVER fall through to
      // the main-site branches below — unknown preview hosts 404 right here, closed
      // admission answers 503 with its displayable reason, and a resolved session
      // lands on the preview entry: a `?ticket=` hop redeems and plants the D9
      // cookie, every further request is gated on that cookie and proxied to the
      // session's dev server (no platform session is ever in scope on these
      // hosts — AC1). Bun derives request.url's host from the Host header on this
      // listener for plain HTTP and websocket upgrades alike (verified against a
      // live listener).
      if (craftPreviewOrigin?.handlesRequest(request)) {
        const resolved = craftPreviewOrigin.resolvePreviewRequest(request);
        if ("sessionId" in resolved) {
          // #363: the HMR websocket upgrade on a preview host. An upgrade is not a
          // request/response, so the HTTP entry below cannot carry it — the session
          // comes from the Host (never the path: host routing moved identity out of
          // the URL), and the authorization is the preview pass the redemption hop
          // planted, the SAME judgment the HTTP entry's cookie gate makes. Every
          // refusal lands BEFORE `server.upgrade` commits the socket, in the
          // proxy's own 401/404/503 shapes; the upstream path is the pathname
          // VERBATIM (the dev form's leading label INCLUDED — the basePath-mounted
          // dev server serves under it), exactly what the HTTP entry requests —
          // see appPathFor and webappHmrUpstreamUrl for why forwarding the
          // app's own path verbatim is load-bearing.
          // fix-ocr28 #2: the app path is derived ONCE here — the branch gate and
          // the resolver's path argument used to call appPathFor twice for one
          // request (two URL parses for one pathname, and a silent seam if either
          // call ever grew a judgment of its own).
          const appPath = craftPreviewOrigin.appPathFor(request);
          if (
            craftPreviewWebappHmrDeps !== undefined &&
            request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
            webappHmrIsAppPath(appPath)
          ) {
            // fix-ocr28 #1 (CSWSH): the Origin gate. A WS handshake is not
            // CORS-gated and the preview pass is SameSite=None, so a malicious
            // page's `new WebSocket("wss://<preview-host>/…")` would otherwise
            // ride the pass cookie into the live HMR channel. Origin present →
            // it must be the session's own preview origin; absent (a
            // non-browser client) → the pre-existing behavior. originFor is
            // safe here: "sessionId" in resolved means admission already
            // answered open (resolvePreviewRequest refuses 503 when closed),
            // and originFor throws on a closed origin.
            const origin = request.headers.get("origin");
            if (
              !samePreviewOrigin(
                origin,
                craftPreviewOrigin.originFor(resolved.sessionId),
              )
            ) {
              return new Response(
                "Cross-origin WebSocket upgrades are refused.",
                { status: 403 },
              );
            }
            const decision = await resolvePreviewWebappHmrUpgrade(
              craftPreviewWebappHmrDeps satisfies PreviewWebappHmrDeps,
              {
                sessionId: resolved.sessionId,
                request,
                path: appPath,
                query: url.search,
              },
            );
            if (!decision.ok) {
              return new Response(decision.error, { status: decision.status });
            }
            if (
              server.upgrade(request, {
                data: { upstream: decision.upstreamUrl, hmr: true as const },
              })
            ) {
              return undefined as unknown as Response;
            }
            return new Response("Expected a WebSocket upgrade.", {
              status: 400,
            });
          }
          return craftPreviewOrigin.handlePreviewRequest(
            resolved.sessionId,
            request,
          );
        }
        return Response.json(
          { error: resolved.refuse.reason },
          { status: resolved.refuse.status },
        );
      }
      if (url.pathname === "/api/audio/transcriptions") {
        server.timeout(request, DICTATION_HTTP_IDLE_SECONDS);
      }
      // The workshop's and craft's event streams outlive the default request timeout by design:
      // their connection is the subscription, held open by a 15s keepalive against Bun's 10s idle
      // default — without this raise, every quiet stream is cut before its first keepalive
      // (craft's turn attach, parked on a connect_app ask, is exactly that quiet stream).
      if (
        (url.pathname.startsWith("/api/workshop/") ||
          url.pathname.startsWith("/api/craft/")) &&
        url.pathname.endsWith("/events")
      ) {
        server.timeout(request, 255);
      }
      if (url.pathname === "/api/voice/calls") server.timeout(request, 30);
      if (url.pathname === "/api/voice/sessions") server.timeout(request, 30);
      const decision = await authorizeStream(request);
      if (decision.kind === "refuse") {
        return new Response(decision.message, { status: decision.status });
      }
      if (decision.kind === "proxy") {
        const recording = await demonstrationStore.active(
          decision.actorId,
          decision.botId,
        );
        const upstream = recording
          ? `${decision.upstream}&recording=${encodeURIComponent(recording.id)}`
          : decision.upstream;
        if (
          server.upgrade(request, {
            data: {
              upstream,
              token: decision.token,
              ownerUserId: decision.actorId,
              botId: decision.botId,
              ...(recording ? { recordingId: recording.id } : {}),
            },
          })
        ) {
          return undefined as unknown as Response;
        }
        return new Response("Expected a WebSocket upgrade.", { status: 400 });
      }
      const hmrSessionId =
        craftWebappHmrDeps !== undefined
          ? webappHmrSessionIdFromPath(url.pathname)
          : null;
      if (
        hmrSessionId !== null &&
        craftWebappHmrDeps !== undefined &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket"
      ) {
        // The webapp proxy's own auth, applied by hand because middleware does not run on an
        // upgrade (the stream branch above sets the precedent). Every refusal lands BEFORE the
        // upgrade commits — onyx's `_check_webapp_access` → WebSocketException(1008), answered
        // here as plain HTTP statuses while the request is still a request.
        const actor = await resolveRequestActor(request).catch(() => null);
        const decision = await resolveWebappHmrUpgrade(craftWebappHmrDeps, {
          sessionId: hmrSessionId,
          actor,
          // Verbatim, not a rebuilt "/_next/webpack-hmr": the scaffold's basePath IS
          // this mount, so the dev server serves HMR under it. See webappHmrUpstreamUrl.
          path: url.pathname,
          query: url.search,
        });
        if (!decision.ok) {
          return new Response(decision.error, { status: decision.status });
        }
        if (
          server.upgrade(request, {
            data: { upstream: decision.upstreamUrl, hmr: true as const },
          })
        ) {
          return undefined as unknown as Response;
        }
        return new Response("Expected a WebSocket upgrade.", { status: 400 });
      }
      return app.fetch(request, { server });
    },
    websocket: {
      open(ws) {
        if (isHmrSocket(ws.data)) {
          webappHmrSocketHandlers.open(
            ws as Bun.ServerWebSocket<WebappHmrSocketData>,
          );
          return;
        }
        if (!isProxiedStream(ws.data)) {
          channelSocket.open(asChannelSocket(ws));
          return;
        }
        const stream = ws.data;
        /*
         * The token rides the upgrade's headers (Bun's options form — the DOM
         * types only know the protocols argument, hence the cast), matching
         * every HTTP call the transport makes to the computer, so it stays out
         * of any proxy or computer access log the URL would land in.
         */
        const inward = new WebSocket(stream.upstream, {
          headers: { "x-openbot-computer-token": stream.token },
        } as unknown as string | string[]);
        stream.inward = inward;
        // Frames outward, input inward. Buffered by neither side: a frame the browser is too slow for
        // should be dropped, not queued, because a stale frame is worse than a missing one.
        inward.onmessage = (event) => {
          if (stream.recordingId) {
            let recorded: unknown;
            try {
              recorded = JSON.parse(String(event.data));
            } catch {
              recorded = null;
            }
            if (
              recorded &&
              typeof recorded === "object" &&
              "type" in recorded &&
              recorded.type === "demonstration.action"
            ) {
              const data = stream;
              const message = recorded as {
                recordingId?: unknown;
                action?: unknown;
              };
              if (message.recordingId !== data.recordingId) {
                ws.send(
                  JSON.stringify({
                    type: "error",
                    error:
                      "The recording identity changed. Stop and restart recording.",
                  }),
                );
                return;
              }
              demonstrationRecorder
                .capture(
                  data.ownerUserId,
                  data.botId,
                  data.recordingId ?? "",
                  message.action,
                )
                .catch((error) => {
                  log.error(
                    {
                      type: "demonstration-capture-error",
                      error:
                        error instanceof Error ? error.name : "UnknownError",
                      context: { recordingId: data.recordingId },
                      timestamp: new Date().toISOString(),
                    },
                    "demonstration-capture-error",
                  );
                  try {
                    ws.send(
                      JSON.stringify({
                        type: "error",
                        error:
                          "A browser step could not be saved. Stop and review the demonstration before continuing.",
                      }),
                    );
                  } catch {
                    /* A closed viewer cannot receive the already logged failure. */
                  }
                });
              return;
            }
          }
          try {
            ws.send(String(event.data));
          } catch {
            inward.close();
          }
        };
        inward.onclose = () => ws.close();
        inward.onerror = () => ws.close();
      },
      message(ws, raw) {
        if (isHmrSocket(ws.data)) {
          webappHmrSocketHandlers.message(
            ws as Bun.ServerWebSocket<WebappHmrSocketData>,
            raw,
          );
          return;
        }
        if (!isProxiedStream(ws.data)) {
          channelSocket.message(asChannelSocket(ws), raw);
          return;
        }
        if (ws.data.inward?.readyState === 1) ws.data.inward.send(String(raw));
      },
      close(ws, code, reason) {
        if (isHmrSocket(ws.data)) {
          webappHmrSocketHandlers.close(
            ws as Bun.ServerWebSocket<WebappHmrSocketData>,
          );
          return;
        }
        if (!isProxiedStream(ws.data)) {
          channelSocket.close(asChannelSocket(ws), code, reason);
          return;
        }
        ws.data.inward?.close();
      },
    },
  });
}
