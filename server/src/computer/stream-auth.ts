import { getLogger } from "../../../shared/logger";
import { computerAccessCheck } from "../agents/computer-access";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import { ComputerCapacityError } from "./capacity";
import { streamPathBotId } from "./stream-path";

const log = getLogger("server");

export const toStreamUrl = (baseUrl: string, botId: string) =>
  // The Bot travels in the query, because a websocket upgrade carries no custom header a
  // BROWSER could set and every call it serves is per Bot. The secret does NOT travel the
  // same way: this URL's only consumer is the server-side proxy below, which opens the
  // inward socket with headers (Bun's WebSocket constructor carries them) — the same
  // x-openbot-computer-token header every HTTP call to the computer already uses — because
  // a query string lands the deployment token in intermediate proxies' and the computer's
  // access logs. The computer still accepts the query form (authorisation.ts) so a browser
  // that ever dials the stream directly keeps working.
  `${baseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/stream?bot=${encodeURIComponent(botId)}`;

/** What the upgrade handler does with a request: hand it to the app, answer it, or proxy it. */
export type StreamDecision =
  | { kind: "passthrough" }
  | { kind: "refuse"; status: number; message: string }
  | {
      kind: "proxy";
      upstream: string;
      /** The computer token, carried to the inward socket as a header, never on the URL. */
      token: string;
      botId: string;
      actorId: string;
    };

/**
 * Whether this socket may watch this Bot's screen, decided before any socket is opened.
 *
 * The decision lived inline in index.ts's fetch handler; extracted here so it can be tested without
 * binding a port (index.ts serves at module scope). The refusal order is the contract: a computer
 * that is off refuses everything (503), then the session (401), then which Bot (404) — a caller
 * with no right to ask learns nothing about which Bots exist — then the route inward (503/502).
 * The actorId rides along on the proxy decision so index.ts opens the socket once, on one resolve.
 */
export function createStreamAuthorizer(deps: {
  resolveRequestActor: (
    request: Request,
  ) => Promise<{ id: string; role: AgentActor["role"] }>;
  agentProfileStore: Pick<AgentProfileStore, "get">;
  computerGateway?: { locate(botId: string): Promise<string> };
  config: { computer?: { token?: string } };
  /** Same defence the sensitive writes use (learning/routes.ts): origins an upgrade may come from. */
  trustedOrigins?: readonly string[];
}) {
  return async function authorize(request: Request): Promise<StreamDecision> {
    const url = new URL(request.url);
    const streamBotId = streamPathBotId(url.pathname);
    if (
      streamBotId === null ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket"
    ) {
      return { kind: "passthrough" };
    }
    if (!deps.config.computer) {
      return {
        kind: "refuse",
        status: 503,
        message: "No computer is configured.",
      };
    }
    // The session guard, applied by hand because middleware does not run on an upgrade. An
    // unauthenticated socket here would be the whole point of the proxy defeated.
    const actor = await deps.resolveRequestActor(request).catch(
      (error: unknown) => {
        // A session-store outage must be visible as itself: folding it into "not signed
        // in" tells the caller to log in again and hides the incident.
        log.warn({ err: error }, "Could not resolve the computer stream actor.");
        return null;
      },
    );
    if (!actor) {
      return { kind: "refuse", status: 401, message: "Sign in first." };
    }
    /*
     * Same defence the sensitive writes use (learning/routes.ts): browsers send an Origin on every
     * WebSocket handshake, and the cookie above is what a hostile page would ride. SameSite=Lax
     * already holds cross-site handshakes on default deployments; this is the guard for the
     * SameSite=None ones (multi-origin serves, mobile H5), where without it a hostile page opens
     * this socket with the victim's session and watches their Bot's screen. Non-browser clients
     * send no Origin and are judged by the session and Bot-access checks above; the COMPUTER_TOKEN
     * below authenticates this server to the computer, not the caller to this server.
     */
    const origin = request.headers.get("origin");
    if (origin) {
      const allowed = new Set([url.origin, ...(deps.trustedOrigins ?? [])]);
      if (!allowed.has(origin)) {
        return {
          kind: "refuse",
          status: 403,
          message: "Cross-origin sockets are not accepted.",
        };
      }
    }
    // And which Bot, which the guard above does not answer. This socket carries that Bot's screen,
    // so signing in is not enough: without this, anybody signed in watches anybody's Bot work. And
    // seeing a Team Bot is not enough either: its screen is its owner's signed-in browser.
    if (
      !(await computerAccessCheck(deps.agentProfileStore)(
        { id: actor.id, role: actor.role },
        streamBotId,
      ))
    ) {
      return { kind: "refuse", status: 404, message: "There is no such Bot." };
    }
    /*
     * Through the gateway, not the provider.
     *
     * `gateway.locate` runs checkComputerAddress; `provider.locate` does not. (The computer
     * token now rides a request header, not the URL's query string — but the rule is the same:)
     * A provider that answered with a foreign
     * host was handed the deployment's computer token, which is the case that check was written
     * for. Every acting path already went through the gateway; this one did not.
     */
    let upstream: string;
    try {
      const streamBase = deps.computerGateway
        ? await deps.computerGateway.locate(streamBotId)
        : undefined;
      if (!streamBase) {
        return {
          kind: "refuse",
          status: 503,
          message: "No computer address is configured.",
        };
      }
      upstream = toStreamUrl(streamBase, streamBotId);
    } catch (error) {
      // At capacity is not unreachable, and the env guidance in the refusal is for an operator,
      // not a browser: same mapping as routes.ts's statusFor (503), no OPENMUSE_* advice sent out.
      if (error instanceof ComputerCapacityError) {
        return {
          kind: "refuse",
          status: 503,
          message: "Every computer this deployment allows is running.",
        };
      }
      // Said out loud rather than falling back to another Bot's computer, which is the failure this
      // whole path exists to prevent. The detail goes to the server's log only: these errors carry
      // internal topology (a supervisor's raw address, an internal URL) that a browser has no
      // business reading — the same neutrality the capacity branch above keeps.
      log.warn(
        `stream proxy could not locate a computer for ${streamBotId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        kind: "refuse",
        status: 502,
        message: "That Bot's computer could not be reached.",
      };
    }
    // A deployment with no COMPUTER_TOKEN configured has no credential to present, and
    // config.ts states the intended failure for that: every call to a computer is refused.
    // Forwarding an empty token would let the computer side decide whether "" counts as one.
    const token = deps.config.computer.token;
    if (!token) {
      return {
        kind: "refuse",
        status: 503,
        message: "That Bot's computer is not configured on this deployment.",
      };
    }
    return {
      kind: "proxy",
      upstream,
      token,
      botId: streamBotId,
      actorId: actor.id,
    };
  };
}
