import { DICTATION_HTTP_IDLE_SECONDS } from "@openbot/shared/dictation";
import { getLogger } from "@openbot/shared/logger";
import { serve } from "bun";
import type { OpenBotRole } from "./auth/roles";
import { websocket as channelSocket } from "./channels/socket";
import type { StreamDecision } from "./computer/stream-auth";
import type { CraftPreviewFrontDoor } from "./craft/preview";
import {
  type WebappHmrSocketData,
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
  /**
   * MOD22 (#642): the ONE craft preview dep — the seam (craft/preview.ts) owns
   * every preview/HMR judgment (host dispatch, CSWSH Origin gate, both upgrade
   * resolvers); this file keeps only the Bun plumbing: the upgrade commit it
   * hands the seam as a callback, and the socket pump below.
   */
  craftPreviewFrontDoor: CraftPreviewFrontDoor | undefined;
}): void {
  const {
    port,
    app,
    authorizeStream,
    resolveRequestActor,
    demonstrationStore,
    demonstrationRecorder,
    craftPreviewFrontDoor,
  } = deps;
  const log = getLogger("server");

  serve<SocketData>({
    port,
    async fetch(request, server) {
      const url = new URL(request.url);
      // The craft preview namespace (#361/#362/#363): claimed preview hosts NEVER
      // fall through to the main-site branches below. The seam (craft/preview.ts)
      // owns the whole judgment — host claim, session resolution, the CSWSH
      // Origin gate, the HMR upgrade's authorization and target; the only thing
      // left here is the Bun upgrade commit it is handed as a callback.
      const previewVerdict = await craftPreviewFrontDoor?.dispatch(
        request,
        url,
        (data) => server.upgrade(request, { data }),
      );
      if (previewVerdict?.claimed) {
        return previewVerdict.response as Response;
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
      // The craft webapp's main-site HMR upgrade (onyx webapp_proxy.py:387-398),
      // judged by the same seam — this branch keeps its old slot behind the
      // computer-stream authorizeStream branch; the seam answers claimed:false
      // for anything that is not the HMR endpoint upgrade.
      const hmrVerdict = await craftPreviewFrontDoor?.dispatchWebappHmr(
        request,
        url,
        resolveRequestActor,
        (data) => server.upgrade(request, { data }),
      );
      if (hmrVerdict?.claimed) {
        return hmrVerdict.response as Response;
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
