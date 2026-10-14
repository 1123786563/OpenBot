import { getLogger } from "../../../shared/logger";
import { sanitizeLastError } from "../openmuse-deletion/retention";

const log = getLogger("server");

/**
 * The OpenConnector OAuth seam for Google consent (G01 gmail, G03 calendar),
 * split the way
 * `plugins/openconnector-adapter.ts` is split: {@link buildOpenConnectorOAuthClient}
 * is pure assembly over an injectable dial, so every test below it is an
 * object literal and no socket is ever opened; {@link createOpenConnectorOAuthClient}
 * is the thin layer that owns the real `fetch` and the base address. Nothing
 * else in this module's callers may construct a URL, header or body that
 * reaches OpenConnector.
 *
 * The vendor API shape is the one its docs/credentials.md publishes (fetched
 * 2026-10-12, excerpts authoritative in the G01 plan): authorizations are
 * started with `POST /api/oauth/authorizations {service, connectionName}`,
 * the OAuth client is registered with `PUT /api/oauth/configs/gmail`, the
 * app owning the redirect forwards `{code, state}` to the vendor's
 * `/oauth/callback`, and `GET /api/connections` lists each connection's
 * `{accountId, displayName, grantedScopes, oauthAuthorizationId}`.
 */
export type OAuthWireDial = (
  path: string,
  init: { method: string; headers: Record<string, string>; body?: unknown },
) => Promise<{
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
}>;

/**
 * The Google services this deployment grants consent for (G01 gmail, G03
 * calendar). The ids ARE the vendor's service ids — `src/providers/<service>`
 * in OpenConnector — so the same string names the authorization's service,
 * the OAuth config path (`/api/oauth/configs/<service>`) and the connection
 * row's provider.
 */
export type OpenMuseGoogleProvider = "gmail" | "googlecalendar";

/** Every provider this deployment knows, in the order the combined status lists them. */
export const OPENMUSE_GOOGLE_PROVIDERS = [
  "gmail",
  "googlecalendar",
] as const satisfies readonly OpenMuseGoogleProvider[];

/**
 * THE BODY IS A JSON VALUE RATHER THAN A STRING, for the adapter's own reason:
 * the assembly layer composes objects and hands them over intact, so a test's
 * stub sees exactly what this deployment built, and the serialization is the
 * transport layer's business.
 */
export type OpenConnectorOAuthClient = {
  /** Start one consent under a connection name this deployment minted. */
  startAuthorization(
    service: OpenMuseGoogleProvider,
    connectionName: string,
  ): Promise<{ authorizationUrl: string }>;
  /** Forward Google's `{code, state}` to the vendor's own callback, as query. */
  forwardCallback(code: string, state: string): Promise<void>;
  /** The vendor's profile for one connection, found by name in the listing. */
  connectionProfile(connectionName: string): Promise<{
    accountId: string;
    displayName: string | null;
    grantedScopes: string[];
  }>;
  /**
   * Run one provider action in the person's connection (G04): the generic
   * action-call seam `plugins/openconnector-adapter.ts` models for every
   * service — `POST /v1/actions/<actionId>` with the connection's alias —
   * so Mail/Calendar provider calls can run through the connectors client
   * and have the vendor's auth-expired answer classified here.
   */
  callAction(input: {
    alias: string;
    actionId: string;
    body?: unknown;
  }): Promise<unknown>;
  /**
   * Register this deployment's Google OAuth client for one service; called
   * once at boot for every provider in {@link OPENMUSE_GOOGLE_PROVIDERS}.
   */
  putClientConfig(
    service: OpenMuseGoogleProvider,
    config: {
      clientId: string;
      clientSecret: string;
      redirectUri: string;
    },
  ): Promise<void>;
  /**
   * Delete the vendor's connection under one alias (G05) — the adapter's
   * delete-by-alias shape (`DELETE /api/connections/<service>?connectionName=`).
   * Best-effort on absence: a 404 answers "nothing was there to withdraw"
   * (the adapter's established tolerance for 404-on-delete); every other
   * refusal propagates, because a refused withdrawal must not look like a
   * finished one.
   */
  deleteConnection(
    service: OpenMuseGoogleProvider,
    connectionName: string,
  ): Promise<void>;
};

/** A vendor failure, named so routes can answer 502 rather than 500. */
export class OpenConnectorOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenConnectorOAuthError";
  }
}

/**
 * The vendor's EXPIRED-CREDENTIAL answer (G04 Task 0, recorded for O02's
 * live check): a provider action that came back 401 — the credential the
 * alias runs on is no longer authorized, which OpenConnector surfaces as
 * `{success:false, error:{code:"token_expired", message}}` per
 * docs/credentials.md's answer shape. The classification below keys on the
 * 401 ALONE; the nested code string is the documented placeholder, verified
 * against the live deployment at O02. A SUBCLASS of the OAuth error so every
 * existing catch keeps working, while the refresh seam can pick it out.
 */
export class OpenConnectorAuthExpiredError extends OpenConnectorOAuthError {
  constructor(message: string) {
    super(message);
    this.name = "OpenConnectorAuthExpiredError";
  }
}

export function buildOpenConnectorOAuthClient(deps: {
  dial: OAuthWireDial;
}): OpenConnectorOAuthClient {
  const request = async (
    path: string,
    init: { method: string; body?: unknown },
    options?: {
      alias?: string;
      classifyAuthExpiry?: boolean;
      /** The delete seam's tolerance: a 404 is absence, not failure (G05). */
      absentOk?: boolean;
    },
  ): Promise<unknown> => {
    const wire = await deps.dial(path, {
      method: init.method,
      headers:
        options?.alias === undefined
          ? {}
          : { "x-oo-connector-alias": options.alias },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    let body: unknown;
    try {
      // 204 answers nothing by definition; everything else is attempted.
      body = wire.status === 204 ? null : await wire.json();
    } catch {
      /*
       * An empty body on a success (or on the delete seam's tolerated 404) is
       * ABSENCE, not an unreadable vendor answer: without this, a 204/empty
       * 200 — and the 404 deleteConnection documents tolerating — threw as a
       * vendor fault, so disconnect 502'd with its row still connected and
       * D07's purge recorded the seat retryable forever.
       */
      if (wire.ok || (options?.absentOk === true && wire.status === 404)) {
        body = null;
      } else {
        throw new OpenConnectorOAuthError(
          "OpenConnector answered with something this deployment could not read as JSON. Check the container and the address in OPENCONNECTOR_URL.",
        );
      }
    }
    if (!wire.ok) {
      const record =
        body !== null && typeof body === "object"
          ? (body as Record<string, unknown>)
          : null;
      const vendorMessage =
        record !== null &&
        typeof record.message === "string" &&
        record.message !== ""
          ? record.message
          : null;
      // Only the action seam classifies: a 401 on a provider action is an
      // expired credential (G04), while the OAuth endpoints keep their one
      // failure class — a 401 there is a misconfigured client config, not a
      // consent this deployment should mark refresh_required.
      if (options?.classifyAuthExpiry === true && wire.status === 401) {
        throw new OpenConnectorAuthExpiredError(
          vendorMessage ??
            "OpenConnector refused the action because this connection's credential is no longer authorized.",
        );
      }
      // Only the delete seam tolerates absence: a 404 there is the vendor
      // answering "nothing was there to withdraw" (G05).
      if (options?.absentOk === true && wire.status === 404) {
        return body;
      }
      throw new OpenConnectorOAuthError(
        vendorMessage ??
          `OpenConnector answered this deployment's request with a failure (${wire.status ?? "an unreadable status"}).`,
      );
    }
    return body;
  };

  return {
    async startAuthorization(service, connectionName) {
      const body = await request("/api/oauth/authorizations", {
        method: "POST",
        body: { service, connectionName },
      });
      const record =
        body !== null && typeof body === "object"
          ? (body as Record<string, unknown>)
          : null;
      const authorizationUrl =
        record !== null && typeof record.authorizationUrl === "string"
          ? record.authorizationUrl
          : null;
      if (authorizationUrl === null || authorizationUrl === "") {
        throw new OpenConnectorOAuthError(
          "OpenConnector started the authorization but answered no authorization URL this deployment could read.",
        );
      }
      return { authorizationUrl };
    },
    async forwardCallback(code, state) {
      await request(
        `/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
        { method: "GET" },
      );
    },
    async connectionProfile(connectionName) {
      const body = await request("/api/connections", { method: "GET" });
      if (!Array.isArray(body)) {
        throw new OpenConnectorOAuthError(
          "OpenConnector's connection list came back in a shape this deployment could not read.",
        );
      }
      const row = body.find(
        (candidate) =>
          candidate !== null &&
          typeof candidate === "object" &&
          (candidate as Record<string, unknown>).connectionName ===
            connectionName,
      ) as Record<string, unknown> | undefined;
      if (row === undefined) {
        throw new OpenConnectorOAuthError(
          `OpenConnector has no connection under ${connectionName} this deployment could read.`,
        );
      }
      const accountId =
        typeof row.accountId === "string" && row.accountId !== ""
          ? row.accountId
          : null;
      const displayName =
        typeof row.displayName === "string" && row.displayName !== ""
          ? row.displayName
          : null;
      if (accountId === null && displayName === null) {
        // An unreadable identity is an unreadable answer, not a silent ""
        // email: callback would persist an empty accountEmail and refresh's
        // identity comparison would read two blanks as "unchanged".
        throw new OpenConnectorOAuthError(
          "OpenConnector's connection row carries no identity this deployment could read.",
        );
      }
      return {
        accountId: accountId ?? "",
        displayName,
        grantedScopes: Array.isArray(row.grantedScopes)
          ? row.grantedScopes.filter(
              (scope): scope is string => typeof scope === "string",
            )
          : [],
      };
    },
    async callAction(input) {
      const body = await request(
        `/v1/actions/${encodeURIComponent(input.actionId)}`,
        { method: "POST", body: { input: input.body ?? {} } },
        { alias: input.alias, classifyAuthExpiry: true },
      );
      // THE RUNTIME FACE ANSWERS `{ data: ... }` — the same envelope the
      // adapter's answerOf and the mail/calendar clients unwrap once; this
      // seam answers the payload like they do, never the envelope.
      return body !== null && typeof body === "object" && "data" in body
        ? (body as Record<string, unknown>).data
        : body;
    },
    async putClientConfig(service, config) {
      await request(`/api/oauth/configs/${service}`, {
        method: "PUT",
        body: {
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          redirectUri: config.redirectUri,
        },
      });
    },
    async deleteConnection(service, connectionName) {
      await request(
        `/api/connections/${encodeURIComponent(service)}?connectionName=${encodeURIComponent(connectionName)}`,
        { method: "DELETE" },
        { absentOk: true },
      );
    },
  };
}

/**
 * The transport layer: the real `fetch`, the base address the DEPLOYER set,
 * `redirect: "manual"` so no in-path redirect can move a code to a second
 * host. The base is validated at construction for the adapter's reasons (an
 * absolute http/https URL carrying no user info), so a mis-set variable
 * surfaces at boot, not at somebody's first connect attempt.
 */
export function createOpenConnectorOAuthClient(config: {
  url: string;
}): OpenConnectorOAuthClient {
  let base: URL;
  try {
    base = new URL(config.url);
  } catch {
    throw new Error(
      "OPENCONNECTOR_URL does not parse as a URL this deployment can dial.",
    );
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error(
      "OPENCONNECTOR_URL resolved to a scheme this deployment refuses to dial; only http and https are allowed.",
    );
  }
  if (base.username !== "" || base.password !== "") {
    throw new Error(
      "OPENCONNECTOR_URL carries user info, which would embed a credential in every URL string derived from it.",
    );
  }
  const dial: OAuthWireDial = (path, init) =>
    fetch(new URL(path, base), {
      method: init.method,
      redirect: "manual",
      // The house rule (billing/lago.ts): a hung provider must not hang us —
      // the public callback route dials through this seam, so an unbounded
      // wait would pin unauthenticated request handlers open.
      signal: AbortSignal.timeout(15_000),
      headers: {
        ...init.headers,
        ...(init.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  return buildOpenConnectorOAuthClient({ dial });
}

/**
 * The Google OAuth client credentials, read here rather than in config.ts
 * (G01 does not edit that file): both variables or none. The caller decides
 * what an absent client means — this seam only answers what the process
 * environment holds.
 */
export function gmailClientCredentialsFromEnv(): {
  clientId: string;
  clientSecret: string;
} | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * Register the deployment's Google OAuth client with the vendor for EVERY
 * provider (G01 gmail, G03 googlecalendar), once at boot — the name keeps
 * G01's wiring in index.ts unchanged. A failure is logged, never fatal: a
 * deployment whose vendor is not up yet must still boot, and the connect
 * route will surface the vendor's absence when somebody tries to use it.
 */
export async function pushGmailClientConfig(
  client: OpenConnectorOAuthClient,
  config: { clientId: string; clientSecret: string; redirectUri: string },
): Promise<void> {
  for (const service of OPENMUSE_GOOGLE_PROVIDERS) {
    try {
      await client.putClientConfig(service, config);
      log.info(
        { type: "openmuse-google-client-config-stored", service },
        "openmuse-google-client-config-stored",
      );
    } catch (error) {
      // §4, the same discipline retention.ts states: an operator signal
      // carries no token, and the vendor's sentence may quote the credential
      // it failed on (invalid_client, a redirect mismatch) — sanitized
      // before it reaches the log.
      log.warn(
        {
          type: "openmuse-google-client-config-failed",
          service,
          error:
            sanitizeLastError(
              error instanceof Error ? error.message : String(error),
            ) ?? "unprintable failure",
        },
        "openmuse-google-client-config-failed",
      );
    }
  }
}
