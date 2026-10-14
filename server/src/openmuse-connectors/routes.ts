import { type Context, Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { getLogger } from "../../../shared/logger";
import type { AppVariables } from "../auth/guards";
import {
  OPENMUSE_GOOGLE_PROVIDERS,
  OpenConnectorOAuthError,
  type OpenMuseGoogleProvider,
} from "./client";
import {
  OpenMuseConnectionMissingError,
  OpenMuseConnectionRefusedError,
  OpenMuseGoogleCallbackError,
  type OpenMuseGoogleOAuth,
  OpenMuseOwnerDisabledError,
  OpenMuseVendorUnavailableError,
} from "./google-oauth";
import type { StoredOpenMuseGoogleConnection } from "./store";

const log = getLogger("server");

/** The path segment names the provider (G03); anything else is no provider this deployment grants. */
function providerParam(value: string): OpenMuseGoogleProvider | null {
  return (OPENMUSE_GOOGLE_PROVIDERS as readonly string[]).includes(value)
    ? (value as OpenMuseGoogleProvider)
    : null;
}

/**
 * `/api/mobile/openmuse-google` (G01 gmail, G03 calendar): start a consent
 * and read its outcome, behind the same session guard as every other mobile
 * surface. Gmail keeps its G01 path shape (`/connect`, `/status`); every
 * provider — gmail included — is reachable with the provider in the path
 * (`/:provider/connect`, `/:provider/status`), and the root `GET /` answers
 * the combined status of both providers.
 *
 * The caller's return URI is validated rather than stored blind: the browser
 * is redirected there at the end of a consent, so it must be the app's own
 * scheme (`openmuse://`) or an http(s) origin this deployment named.
 */
export function createOpenMuseGoogleRoutes(deps: {
  service: OpenMuseGoogleOAuth;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  /** The one http(s) origin a returnUri may name, when the deployment published one. */
  allowedHttpOrigin?: string;
}): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);
  routes.onError((error, context) => {
    if (error instanceof OpenMuseOwnerDisabledError) {
      return context.json(
        { error: "This owner's connectors are unavailable." },
        403,
      );
    }
    if (error instanceof OpenMuseVendorUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    if (error instanceof OpenConnectorOAuthError) {
      return context.json(
        { error: "The connection service refused. Try again." },
        502,
      );
    }
    if (error instanceof OpenMuseConnectionRefusedError) {
      // §4: a provider call without that provider's consent stops here, 409.
      return context.json({ error: error.message }, error.status);
    }
    if (error instanceof OpenMuseConnectionMissingError) {
      // G04: nothing of THIS caller's to refresh — also the foreign owner's
      // answer, which must not learn that somebody else's seat exists.
      return context.json({ error: error.message }, error.status);
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return context.json(
        {
          error:
            "Supply a valid returnUri (openmuse:// or this deployment's own https origin).",
        },
        400,
      );
    }
    log.error(
      {
        type: "openmuse-google-route-error",
        error: error.name,
        context: { route: context.req.path },
      },
      "openmuse-google-route-error",
    );
    return context.json(
      { error: "Google connection is unavailable right now. Try again." },
      503,
    );
  });

  async function startConsent(
    context: Context<{ Variables: AppVariables }>,
    provider: OpenMuseGoogleProvider,
  ) {
    const input = z
      .strictObject({ returnUri: z.string().min(1) })
      .parse(await context.req.json());
    if (!allowedReturnUri(input.returnUri, deps.allowedHttpOrigin)) {
      return context.json(
        {
          error:
            "The returnUri must use the openmuse:// scheme or this deployment's own https origin.",
        },
        400,
      );
    }
    const started = await deps.service.start({
      userId: context.var.actor.id,
      provider,
      returnUri: input.returnUri,
    });
    // The state stays server-side; the caller gets only the URL to open.
    return context.json(started);
  }

  // Gmail keeps its G01 route shape.
  routes.post("/connect", (context) => startConsent(context, "gmail"));

  routes.post("/:provider/connect", async (context) => {
    const provider = providerParam(context.req.param("provider"));
    if (provider === null) {
      return context.json({ error: "Unknown provider." }, 404);
    }
    return startConsent(context, provider);
  });

  /** The §4 connection shape; internal ids and aliases are not the caller's. */
  const connectionBody = (connection: StoredOpenMuseGoogleConnection) => ({
    provider: connection.provider,
    accountEmail: connection.accountEmail,
    status: connection.status,
    grantedScopes: connection.grantedScopes,
    generation: connection.generation,
    connectedAt: connection.connectedAt.toISOString(),
    // G04: the sanitized refresh sentence, present only while it is set (§4
    // calls the shape `lastError?` — a healthy connection carries no key).
    ...(connection.lastError !== null
      ? { lastError: connection.lastError }
      : {}),
  });

  routes.get("/status", async (context) => {
    context.header("Cache-Control", "no-store");
    const status = await deps.service.status(context.var.actor.id, "gmail");
    return context.json(
      "accountEmail" in status
        ? connectionBody(status)
        : { status: status.status },
    );
  });

  routes.get("/:provider/status", async (context) => {
    const provider = providerParam(context.req.param("provider"));
    if (provider === null) {
      return context.json({ error: "Unknown provider." }, 404);
    }
    context.header("Cache-Control", "no-store");
    const status = await deps.service.status(context.var.actor.id, provider);
    return context.json(
      "accountEmail" in status
        ? connectionBody(status)
        : { status: status.status },
    );
  });

  // The explicit refresh (G04): re-run the vendor's token refresh for the
  // caller's own connection — a foreign owner's probe hears only the 404.
  routes.post("/:provider/refresh", async (context) => {
    const provider = providerParam(context.req.param("provider"));
    if (provider === null) {
      return context.json({ error: "Unknown provider." }, 404);
    }
    context.header("Cache-Control", "no-store");
    const connection = await deps.service.refresh(
      context.var.actor.id,
      provider,
    );
    return context.json(connectionBody(connection));
  });

  // The withdrawal (G05): the vendor's connection under the derived alias
  // goes first, then the local row — disconnected, generation preserved so
  // the next connect lands a new one. Idempotent for the same caller.
  routes.post("/:provider/disconnect", async (context) => {
    const provider = providerParam(context.req.param("provider"));
    if (provider === null) {
      return context.json({ error: "Unknown provider." }, 404);
    }
    const connection = await deps.service.disconnect(
      context.var.actor.id,
      provider,
    );
    return context.json(connectionBody(connection));
  });

  // The combined status (G03): every provider this deployment grants, in
  // catalog order, connected or disconnected.
  routes.get("/", async (context) => {
    context.header("Cache-Control", "no-store");
    const connections = await deps.service.allStatuses(context.var.actor.id);
    return context.json({
      connections: connections.map((connection) =>
        "accountEmail" in connection
          ? connectionBody(connection)
          : { provider: connection.provider, status: connection.status },
      ),
    });
  });

  return routes;
}

/**
 * `/api/public/openmuse-google/callback` (G01, G03): where Google lands the
 * browser at the end of a consent. PUBLIC — no requireUser, because the
 * referrer is Google — but never anonymous: the session is resolved by hand
 * and a callback with no session is refused (§4 session binding), because
 * the state alone must not be enough to spend somebody's consent.
 *
 * ONE callback shape serves every provider: the pending row the state
 * resolves already knows which provider the consent was started for.
 */
export function createOpenMuseGoogleCallbackRoutes(deps: {
  service: OpenMuseGoogleOAuth;
  resolveActor: (headers: Headers) => Promise<{ id: string } | null>;
}): Hono {
  const routes = new Hono();
  routes.onError((error, context) => {
    context.header("Cache-Control", "no-store");
    if (error instanceof OpenMuseGoogleCallbackError) {
      return context.json({ error: error.message }, error.status);
    }
    if (
      error instanceof OpenMuseVendorUnavailableError ||
      error instanceof OpenConnectorOAuthError
    ) {
      return context.json(
        { error: "The connection service refused the consent. Start again." },
        error instanceof OpenMuseVendorUnavailableError ? 503 : 502,
      );
    }
    log.error(
      {
        type: "openmuse-google-callback-error",
        error: error.name,
        context: { route: context.req.path },
      },
      "openmuse-google-callback-error",
    );
    return context.json(
      { error: "Google connection is unavailable right now. Try again." },
      503,
    );
  });

  routes.get("/callback", async (context) => {
    context.header("Cache-Control", "no-store");
    const code = context.req.query("code");
    const state = context.req.query("state");
    if (!code || !state) {
      return context.json(
        { error: "The callback needs a code and a state." },
        400,
      );
    }
    const actor = await deps.resolveActor(context.req.raw.headers);
    if (actor === null) {
      return context.json(
        { error: "Finish the consent in the session that started it." },
        403,
      );
    }
    const finished = await deps.service.callback({
      actorId: actor.id,
      code,
      state,
      nonce: context.req.query("openmuse_nonce"),
    });
    return context.redirect(finished.returnUri, 302);
  });

  return routes;
}

/**
 * The return-URI policy: `openmuse://…` always (the native app's scheme), an
 * http(s) URI only when its origin is the one origin the deployment named.
 * Everything else — another host, another scheme — is refused, because this
 * value ends up in a 302 the browser follows.
 */
function allowedReturnUri(
  value: string,
  allowedHttpOrigin: string | undefined,
): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "openmuse:") return true;
  if (
    (url.protocol === "https:" || url.protocol === "http:") &&
    allowedHttpOrigin !== undefined &&
    `${url.protocol}//${url.host}` === allowedHttpOrigin
  ) {
    return true;
  }
  return false;
}
