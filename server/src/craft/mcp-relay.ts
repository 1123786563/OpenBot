/**
 * The craft MCP relay — OpenBot's environment-equivalent of onyx's egress-proxy
 * credential injection (the contract's C3/C4 rulings).
 *
 * onyx's sandbox MCP client dials the server's own url and the egress proxy
 * intercepts the wire, attaching the owner's credential and gating the call.
 * OpenBot has no egress proxy; the session's opencode.json mcp block points
 * HERE instead (`/api/craft/mcp/{serverId}`, mcp-servers.ts stamps the urls),
 * and this route is the trusted side:
 *
 * - a call attributes itself with the session-tag header the mcp block stamps
 *   (`X-Onyx-Mcp-Session` — the same hint-header contract onyx uses; not a
 *   security boundary by itself, the checks below are);
 * - the tag must name an ACTIVE session, and the server must be in THAT
 *   session's resolved MCP set (a call cannot ride another session's tag into
 *   a server its owner never connected);
 * - the owner's connection resolves through the deployment's connector domain
 *   (plugins store) — the credential is decrypted for this one forwarded call
 *   and never leaves this process: not into the workspace config (the mcp
 *   block carries only the relay url + tag header), not into responses, not
 *   into logs (this module logs ids only).
 *
 * Every refusal answers onyx's proxy observable — HTTP 403 with
 * `{"error": "not_authorized"}` — and NEVER dials the vendor: deny paths do
 * not execute the external action, and the agent is instructed (AGENTS.md) to
 * surface it and not retry.
 *
 * Wire shape: MCP streamable-HTTP is POST (JSON-RPC) with optional GET (server
 * stream) and DELETE (session end). POST and DELETE forward; GET answers 405
 * so the SDK falls back to HTTP-only mode (its documented behavior on 405).
 */

import { Hono } from "hono";
import { getLogger } from "../../../shared/logger";
import { craftMcpServerIdOfRelayUrl } from "./mcp-servers";
import { MCP_SESSION_TAG_HEADER } from "./opencode-config";
import type { CraftSessionRow, CraftStore } from "./store";

const logger = getLogger("server");

/** Generous bound for one forwarded MCP round trip (the plugins domain's call timeout is 60s). */
const UPSTREAM_TIMEOUT_MS = 120_000;

/**
 * Whose connection a forwarded call goes out on, as the connector domain
 * resolves it: the vendor url and the decrypted credential for one call, or
 * null when this owner has no usable connection for this server.
 */
export type CraftMcpConnectionResolver = (
  userId: string,
  serverId: string,
) => Promise<{ url: string; token: string | null } | null>;

export type CraftMcpRelayDeps = {
  /** Session reads without the activity bump (relay polling must not feed the idle clock). */
  store: Pick<CraftStore, "findSessionById">;
  /** The session's resolved MCP set (the relay's membership check). */
  sessionMcpServersFor: (
    session: CraftSessionRow,
  ) => Promise<readonly { url: string }[]>;
  /** The connector domain's credential resolution (the trusted side). */
  resolveConnection: CraftMcpConnectionResolver;
  fetchImpl?: typeof fetch;
};

/** The 403 body: onyx's proxy payload, verbatim shape. */
const notAuthorized = () =>
  Response.json({ error: "not_authorized" }, { status: 403 });

/**
 * The relay app. Mounted FIRST in the craft tree — before requireUser — because
 * its caller is the sandbox's opencode MCP client, which has no user session:
 * its credential is the session tag, validated per request above.
 */
export function createCraftMcpRelayApp(deps: CraftMcpRelayDeps): Hono {
  const app = new Hono();
  const doFetch = deps.fetchImpl ?? fetch;

  app.all("/mcp/:serverId", async (context) => {
    const serverId = context.req.param("serverId");
    const method = context.req.method;
    if (method !== "POST" && method !== "DELETE") {
      // GET (server-initiated stream) is not relayed: 405 makes the SDK fall
      // back to HTTP-only. Other verbs are simply not this surface.
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }

    // ── attribution: the tag must name a live session ──────────────────────
    const sessionTag = context.req.header(MCP_SESSION_TAG_HEADER);
    if (!sessionTag) {
      return notAuthorized();
    }
    const session = await deps.store
      .findSessionById(sessionTag)
      .catch(() => undefined);
    if (session?.status !== "active") {
      logger.warn(
        { sessionTag: sessionTag.slice(0, 8) },
        "[craft] mcp relay: unattributable session tag",
      );
      return notAuthorized();
    }

    // ── membership: the server must be in THAT session's resolved set ──────
    const servers = await deps.sessionMcpServersFor(session).catch(
      (error: unknown) => {
        // An empty set and a failed resolution both land on the same 403 below;
        // without this line a transient failure is indistinguishable from a
        // real revocation in the logs — and the agent does not retry a 403.
        logger.warn(
          {
            sessionTag: sessionTag.slice(0, 8),
            error: error instanceof Error ? error.message : String(error),
          },
          "[craft] mcp relay: member resolution failed; refusing",
        );
        return [];
      },
    );
    const member = servers.some(
      (server) => craftMcpServerIdOfRelayUrl(server.url) === serverId,
    );
    if (!member) {
      logger.warn(
        { sessionTag: sessionTag.slice(0, 8), serverId },
        "[craft] mcp relay: server not in the session's resolved set",
      );
      return notAuthorized();
    }

    // ── the owner's connection (the credential stays on this side) ─────────
    // Wrapped like every other resolution above: a connector decrypt failure is
    // an answered 403 here, not an uncontrolled 500 through the framework.
    const connection = await deps
      .resolveConnection(session.userId, serverId)
      .catch((error: unknown) => {
        logger.warn(
          {
            sessionTag: sessionTag.slice(0, 8),
            serverId,
            error: error instanceof Error ? error.message : String(error),
          },
          "[craft] mcp relay: connection resolution failed; refusing",
        );
        return null;
      });
    if (connection === null) {
      logger.warn(
        { sessionTag: sessionTag.slice(0, 8), serverId },
        "[craft] mcp relay: no usable connection for the owner",
      );
      return notAuthorized();
    }

    // ── forward ────────────────────────────────────────────────────────────
    // Passthrough: the JSON-RPC body untouched, the streamable-HTTP session
    // headers (mcp-session-id, mcp-protocol-version) and accept as the client
    // sent them; Authorization attaches HERE and nowhere else.
    const upstreamHeaders = new Headers();
    upstreamHeaders.set(
      "content-type",
      context.req.header("content-type") ?? "application/json",
    );
    const accept = context.req.header("accept");
    if (accept) upstreamHeaders.set("accept", accept);
    const mcpSessionId = context.req.header("mcp-session-id");
    if (mcpSessionId) upstreamHeaders.set("mcp-session-id", mcpSessionId);
    const protocolVersion = context.req.header("mcp-protocol-version");
    if (protocolVersion) {
      upstreamHeaders.set("mcp-protocol-version", protocolVersion);
    }
    if (connection.token) {
      const token = connection.token.trim();
      // A token naming its own scheme travels as written (the same rule the
      // plugins domain's authorizationHeader applies — some vendors forward
      // the header straight to an API that only speaks Basic).
      upstreamHeaders.set(
        "authorization",
        /^(basic|bearer)\s+\S/i.test(token) ? token : `Bearer ${token}`,
      );
    }

    try {
      // The timeout bounds the ROUND TRIP (connect plus response headers), not the body:
      // a streamable-HTTP POST often answers a long-lived SSE stream that outlives any
      // one timer, and aborting mid-stream would hand the client a truncated response.
      const upstreamAbort = new AbortController();
      const timeout = setTimeout(
        () => upstreamAbort.abort(),
        UPSTREAM_TIMEOUT_MS,
      );
      let upstream: Response;
      try {
        upstream = await doFetch(connection.url, {
          method,
          headers: upstreamHeaders,
          body: method === "POST" ? await context.req.arrayBuffer() : undefined,
          signal: upstreamAbort.signal,
        });
      } catch (error) {
        clearTimeout(timeout);
        throw error;
      }
      clearTimeout(timeout);
      const headers = new Headers();
      headers.set(
        "content-type",
        upstream.headers.get("content-type") ?? "application/json",
      );
      const upstreamSession = upstream.headers.get("mcp-session-id");
      if (upstreamSession) headers.set("mcp-session-id", upstreamSession);
      // The response bytes pass through unexamined — a credential never rides
      // them (none was sent), and logging them would put vendor data in logs.
      return new Response(upstream.body, {
        status: upstream.status,
        headers,
      });
    } catch (error) {
      logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          serverId,
        },
        "[craft] mcp relay: upstream call failed",
      );
      return Response.json(
        { error: { code: -32603, message: "Upstream MCP call failed" } },
        { status: 502 },
      );
    }
  });

  return app;
}
