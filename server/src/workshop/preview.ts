import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import type { BotAccessCheck } from "../agents/profile-policy";

/**
 * The workshop's preview door: a Bot's webapp artifact, served to the person who owns it.
 *
 * TWO ROADS (§3.6.3): the static road serves the artifact's built files (the snapshot the
 * gallery already indexes — no container needed, works everywhere); the dev road proxies the
 * Bot's live dev server (S8's per-bot vite), which needs the sandbox's runtime and is the
 * road `devserver` mode exists for. `auto` serves the dev road when the sandbox is ready and
 * falls back to static when it is not; `off` answers 404 for everything below — the switch
 * is the deployment's, not the caller's.
 *
 * THE CSP IS TWO-TIERED ON PURPOSE: the dev road's policy is looser (a dev server injects
 * HMR clients and reload scripts the artifact itself never carries), and it is locked to the
 * deployment's allow-listed origins; the static road ships the tight one. A preview that
 * cannot run its own dev tools is useless, and a preview that ships dev tools to the world
 * is worse.
 *
 * The WS upgrade (101) is deliberately NOT here: it is the B15 dev-road completion, and this
 * batch ships the HTTP shape (the lifecycle and the proxying) with the upgrade refused —
 * honestly, with a 426, rather than half-upgraded.
 */

export type PreviewMode = "auto" | "static" | "devserver" | "off";

export function parsePreviewMode(raw: string | undefined): PreviewMode {
  const trimmed = raw?.trim();
  if (trimmed === "static" || trimmed === "devserver" || trimmed === "off" || trimmed === "auto")
    return trimmed;
  return "auto";
}

/**
 * The dev road's allow-list: PREVIEW_ALLOWED_DEV_ORIGINS, split and normalized. An empty list
 * trusts no dev origin — the dev road then answers 403 rather than guessing.
 */
export function parseAllowedDevOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** The static road's CSP: an artifact is a finished thing; it needs no dev tools. */
export const STATIC_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'";

/** The dev road's CSP: the dev tools in, everything that is not them out. */
export const DEV_CSP_ALLOW_LISTED =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; font-src 'self'; object-src 'none'; base-uri 'none'";

/** What the preview asks its supervisor: is there a dev server for this Bot right now? */
export type PreviewSandbox = {
  /** The dev road's target, when the sandbox is ready and its dev server runs. */
  devServerFor(botId: string): Promise<{ port: number } | null>;
};

export type PreviewRoutesInput = {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  canUseBot: BotAccessCheck;
  mode: PreviewMode;
  /** The allow-list the dev road's CSP and origin check share. */
  allowedDevOrigins: string[];
  /** The static road's file reader: the artifact's bytes, keyed by its path under the build. */
  readArtifactFile: (
    channelId: string,
    path: string,
  ) => Promise<{ bytes: Uint8Array; contentType: string } | null>;
  /** The dev road's supervisor probe (S8's state through the sandbox client). */
  sandbox: PreviewSandbox;
};

export function createPreviewRoutes(input: PreviewRoutesInput): Hono<{
  Variables: AppVariables;
}> {
  const { requireUser, canUseBot, mode, allowedDevOrigins } = input;
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  app.get("/:channelId/preview/*", async (context) => {
    if (mode === "off") {
      // The switch is the deployment's: off means the road does not exist, not "denied".
      return context.notFound();
    }

    const channelId = context.req.param("channelId");
    const botId = context.req.query("botId") ?? "";
    if (!botId) {
      return context.json({ error: "botId is required for a preview." }, 400);
    }

    // The same gate every workshop route holds: who may act as this Bot. The check is the
    // profile-policy pair (actor + botId → boolean), answered before any road runs.
    if (!(await canUseBot(context.var.actor, botId))) {
      return context.json(
        { error: "You may not preview this Bot's workshop." },
        403,
      );
    }

    const path = context.req.path.replace(
      new RegExp(`^/api/workshop/[^/]+/preview/`),
      "",
    );

    // The dev road: pinned in devserver mode; in auto, when the sandbox answers. The probe's
    // answer is kept — it decides between the dev road and the fallback below.
    const devTarget =
      mode === "devserver" || mode === "auto"
        ? await input.sandbox.devServerFor(botId)
        : null;
    const wantsDev = mode === "devserver" || devTarget !== null;
    if (wantsDev) {
      if (allowedDevOrigins.length === 0) {
        return context.json(
          { error: "The dev preview is not configured on this deployment." },
          403,
        );
      }
      const origin = context.req.header("origin") ?? "";
      const allowed = allowedDevOrigins.includes(origin);
      if (!allowed) {
        return context.json({ error: "Origin is not allowed for the dev preview." }, 403);
      }
      const target = devTarget;
      if (!target) {
        return context.json(
          { error: "The Bot's dev server is not running." },
          503,
        );
      }
      // The HTTP proxy: this batch's shape. The WS upgrade answers 426 (B15's completion).
      if (context.req.header("upgrade")?.toLowerCase() === "websocket") {
        return context.json(
          { error: "Websocket previews arrive with the dev-road completion." },
          426,
        );
      }
      const upstream = await fetch(
        `http://127.0.0.1:${target.port}/${path}`,
        { signal: context.req.raw.signal, redirect: "manual" },
      ).catch(() => null);
      if (!upstream) {
        return context.json({ error: "The dev server did not answer." }, 502);
      }
      const headers = new Headers();
      headers.set("content-type", upstream.headers.get("content-type") ?? "text/html");
      headers.set("content-security-policy", DEV_CSP_ALLOW_LISTED);
      return new Response(upstream.body, { status: upstream.status, headers });
    }

    // Pinned to the dev road and it is not there: honest 503, never a silent static fallback
    // the deployment did not ask for. (The narrowed literal is widened on purpose: this arm
    // is the not-wantsDev remainder, which for a devserver mode is exactly "the road is gone".)
    const modeNow: string = mode;
    if (modeNow === "devserver") {
      return context.json({ error: "The dev preview is not available." }, 503);
    }

    // The static road: the artifact's bytes, with the tight CSP.
    const file = await input.readArtifactFile(channelId, path || "index.html");
    if (!file) return context.notFound();
    const headers = new Headers();
    headers.set("content-type", file.contentType);
    headers.set("content-security-policy", STATIC_CSP);
    return new Response(file.bytes as BodyInit, { status: 200, headers });
  });

  return app;
}
