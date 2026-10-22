import { createHash } from "node:crypto";
import {
  OPENMUSE_GOOGLE_PROVIDERS,
  OpenConnectorAuthExpiredError,
  type OpenConnectorOAuthClient,
  type OpenMuseGoogleProvider,
} from "./client";
import type {
  OpenMuseGoogleRows,
  StoredOpenMuseGoogleConnection,
} from "./store";

export type { OpenMuseGoogleProvider };
export { OPENMUSE_GOOGLE_PROVIDERS };

/** The scopes a Gmail consent asks for; the state is bound to them (§4). */
export const GMAIL_GRANT_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
] as const;

/**
 * The scopes a Calendar consent asks for (G03): read-only events, the branch
 * §4 keeps separate from Gmail's consent.
 */
export const GOOGLE_CALENDAR_GRANT_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;

function grantScopesFor(provider: OpenMuseGoogleProvider): string[] {
  return provider === "gmail"
    ? [...GMAIL_GRANT_SCOPES]
    : [...GOOGLE_CALENDAR_GRANT_SCOPES];
}

/** How long a pending consent stays answerable. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * The ONE sentence a failed refresh persists (G04, §4): FIXED, never the
 * vendor's own message, because a vendor error may quote the credential it
 * failed on, and this value is exposed to the owner through the status route.
 */
export const OpenMUSE_REFRESH_FAILED_MESSAGE =
  "Refreshing this connection failed. Try again, or reconnect it.";

/**
 * The ONE sentence a scope-narrowed consent persists: Google's consent screen
 * lets the person uncheck scopes, and a connection recorded `connected`
 * without them only fails later, at the provider, in ways nothing maps back
 * to "re-consent". The row answers refresh_required with this FIXED sentence
 * (the sanitized-discipline twin of {@link OpenMUSE_REFRESH_FAILED_MESSAGE});
 * a fresh consent over the same seat is what re-opens it.
 */
export const OPENMUSE_SCOPE_NARROWED_MESSAGE =
  "This connection granted fewer permissions than it was asked for. Reconnect it.";

/**
 * The vendor action that refreshes one connection's token (G04) — a
 * PLACEHOLDER id in M01's discipline: invoked through the generic action
 * seam (`POST /v1/actions/<id>` with the alias header, the shape
 * `plugins/openconnector-adapter.ts` models for every action), with the
 * real OpenConnector action ids recorded as unverified until O02's live
 * deployment check (S16).
 */
export function openmuseRefreshActionId(
  provider: OpenMuseGoogleProvider,
): string {
  return `${provider}.refresh`;
}

/**
 * The connection name the vendor holds the consent under — SERVER-DERIVED,
 * never client-selected (§4): `openmuse-` + the first 16 hex of
 * sha256(userId + provider). One seat per person PER PROVIDER, deterministic
 * so a reconnect reuses the vendor's one connection seat rather than minting
 * a second one beside it.
 */
export function openmuseAlias(
  userId: string,
  provider: OpenMuseGoogleProvider,
): string {
  return `openmuse-${createHash("sha256").update(`${userId}${provider}`).digest("hex").slice(0, 16)}`;
}

/** The §9 kinds a Google connection row enumerates as (D03/D04's manifest). */
export type OpenMuseConnectionKind =
  | "openmuse-google-connection"
  | "openmuse-google-calendar-connection";

/**
 * The §9 kind↔provider bijection — the ONE source. This module's own
 * `enumerateOwner` reads it kind-ward below; openmuse-deletion's manifest
 * (D04) and connector purge (D07) read it provider-ward, so no copy of the
 * mapping can drift apart.
 */
export const PROVIDER_BY_CONNECTION_KIND: Record<
  string,
  OpenMuseGoogleProvider
> = {
  "openmuse-google-connection": "gmail",
  "openmuse-google-calendar-connection": "googlecalendar",
};

/** The §9 marker kind one connection row enumerates as (D03/D04's manifest). */
function connectionKindOf(
  provider: OpenMuseGoogleProvider,
): OpenMuseConnectionKind {
  for (const [kind, mapped] of Object.entries(PROVIDER_BY_CONNECTION_KIND)) {
    if (mapped === provider) return kind as OpenMuseConnectionKind;
  }
  throw new Error(`No §9 connection kind for provider ${provider}.`);
}

/**
 * A §9 lifecycle refusal: this owner's connector surface is switched off.
 * THE ONE identity (the reviewed-actions surface re-exports it): same-name
 * classes beside this one would fall through every 403 instanceof branch
 * that checks it. The userId is optional so callers that have only the
 * surface, not the id, can still raise the shared identity.
 */
export class OpenMuseOwnerDisabledError extends Error {
  constructor(userId?: string) {
    super(
      userId === undefined
        ? "This owner is disabled."
        : `Owner ${userId} is disabled.`,
    );
    this.name = "OpenMuseOwnerDisabledError";
  }
}

/** The vendor dial was never built (bad or absent OPENCONNECTOR_URL). */
export class OpenMuseVendorUnavailableError extends Error {
  constructor() {
    super(
      "Google connection is unavailable on this deployment. Set OPENCONNECTOR_URL.",
    );
    this.name = "OpenMuseVendorUnavailableError";
  }
}

/**
 * A §4 provider-call refusal: the provider's connection is not connected, so
 * Mail/Calendar calls must stop with a stable 409 BEFORE reaching the vendor.
 * A grant for one provider never satisfies the guard for the other (G03).
 */
export class OpenMuseConnectionRefusedError extends Error {
  readonly status: 409;
  constructor(message: string) {
    super(message);
    this.name = "OpenMuseConnectionRefusedError";
    this.status = 409;
  }
}

/**
 * A §4 provider-call refusal for a connection whose refresh failed (G04): a
 * SUBCLASS of the connect-refusal so every existing catch keeps its 409,
 * while the message names the door that is actually shut — this one opens
 * again through the refresh route, not a new consent.
 */
export class OpenMuseRefreshRequiredError extends OpenMuseConnectionRefusedError {
  constructor(provider: OpenMuseGoogleProvider) {
    super(`Refresh ${provider} before using it.`);
    this.name = "OpenMuseRefreshRequiredError";
  }
}

/**
 * The person has no connection row for this provider (G04): the refresh
 * route answers 404 — nothing of theirs is there, which is also the answer
 * a foreign owner's probe hears, rather than a leak that somebody else's
 * seat exists.
 */
export class OpenMuseConnectionMissingError extends Error {
  readonly status: 404;
  constructor() {
    super("There is no such connection to refresh.");
    this.name = "OpenMuseConnectionMissingError";
    this.status = 404;
  }
}

/** A refused callback, carrying the status the matrix assigns its cause. */
export class OpenMuseGoogleCallbackError extends Error {
  readonly status: 400 | 403 | 410;
  constructor(message: string, status: 400 | 403 | 410) {
    super(message);
    this.name = "OpenMuseGoogleCallbackError";
    this.status = status;
  }
}

export type OpenMuseGoogleOAuth = {
  /** Start one consent: vendor authorization under the derived alias, pending row recorded. */
  start(input: {
    userId: string;
    provider: OpenMuseGoogleProvider;
    returnUri: string;
  }): Promise<{ authorizationUrl: string }>;
  /**
   * Finish one consent: verify, consume-once, forward, record. Never retries.
   * A replay of a COMPLETED consent re-answers its recorded result; the nonce
   * is OpenBot's own `openmuse_nonce`, which a started consent requires back.
   */
  callback(input: {
    actorId: string;
    code: string;
    state: string;
    nonce?: string | null;
  }): Promise<{
    returnUri: string;
    connection: StoredOpenMuseGoogleConnection;
  }>;
  /** The person's current connection for one provider, or disconnected. */
  status(
    userId: string,
    provider: OpenMuseGoogleProvider,
  ): Promise<StoredOpenMuseGoogleConnection | { status: "disconnected" }>;
  /** Every provider's state in catalog order — the combined status (G03). */
  allStatuses(
    userId: string,
  ): Promise<
    Array<
      | StoredOpenMuseGoogleConnection
      | { provider: OpenMuseGoogleProvider; status: "disconnected" }
    >
  >;
  /**
   * The provider-call guard (§4): the caller's connection for one provider,
   * or a stable 409 refusal when that provider is not connected — checked
   * BEFORE any provider call reaches OpenConnector. This is the seam M01/A01
   * call; a Gmail grant does not satisfy a calendar guard, nor the reverse.
   * The returned row EXPOSES `generation` (G04) so Reviewed-action callers
   * (R03+) can bind their proposals to it and refuse as stale when a refresh
   * changed the credential identity; a refresh-required connection refuses
   * with {@link OpenMuseRefreshRequiredError} until a refresh succeeds.
   */
  requireConnection(
    userId: string,
    provider: OpenMuseGoogleProvider,
  ): Promise<StoredOpenMuseGoogleConnection>;
  /**
   * Run one provider call inside the §4 refresh fence (G04): the guard runs
   * first, and a vendor auth-expired answer marks the row refresh_required
   * (with the sanitized sentence) and re-refuses 409 — the call stops at the
   * boundary, never half-executed, and the next attempt refuses before
   * dialing at all.
   */
  runProviderCall<T>(
    userId: string,
    provider: OpenMuseGoogleProvider,
    call: (connection: StoredOpenMuseGoogleConnection) => Promise<T>,
  ): Promise<T>;
  /**
   * The explicit refresh (G04): run the vendor's refresh action in the
   * person's connection, then heal the row — status connected, generation
   * UNCHANGED for the same identity and incremented when the refreshed
   * credential belongs to a different account. A failure leaves the row
   * refresh_required with the sanitized sentence and rethrows, so the route
   * answers the vendor's refusal while the state stays visible and retryable.
   */
  refresh(
    userId: string,
    provider: OpenMuseGoogleProvider,
  ): Promise<StoredOpenMuseGoogleConnection>;
  /**
   * Disconnect (G05): withdraw the vendor's connection under the derived
   * alias, then mark the local row disconnected with the generation
   * PRESERVED — the NEXT connect increments it (§4), so actions bound before
   * the disconnect are stale the moment the seat reconnects. Idempotent: an
   * already-disconnected seat answers its row without dialing the vendor
   * again. A foreign owner hears the 404, a disabled owner the 403; a vendor
   * refusal other than the nothing-to-withdraw 404 propagates and the row
   * stays exactly as it was.
   */
  disconnect(
    userId: string,
    provider: OpenMuseGoogleProvider,
  ): Promise<StoredOpenMuseGoogleConnection>;
  /**
   * D03 (§9): revoke every connection seat this owner holds at deletion —
   * vendor deleteConnection under each alias BEST-EFFORT, then the local row
   * revoked. Unlike {@link disconnect} it serves the deleted owner
   * themselves (the disabled-owner fence does not apply here), it covers
   * every seat in catalog order rather than one provider, and it NEVER
   * throws on a vendor refusal: the refused seat records `retryable`, its
   * row stays exactly as it was for a later pass, and the next seat
   * proceeds. An already-revoked seat answers revoked without dialing
   * (idempotent, the recorded choice G05's disconnect makes).
   */
  revokeOwner(userId: string): Promise<
    Array<{
      kind:
        | "openmuse-google-connection"
        | "openmuse-google-calendar-connection";
      id: string;
      provider: OpenMuseGoogleProvider;
      outcome: "revoked" | "retryable";
    }>
  >;
  /**
   * Mark abandoned consents (started, never answered, TTL passed) expired.
   * Returns the rows swept; `start` runs this along the way so no scheduler
   * wiring is needed for the sweep to keep happening.
   */
  sweepExpired(): Promise<number>;
  /** §9 hooks: refuse work for a disabled owner; name this owner's resources. */
  disableOwner(userId: string): Promise<void>;
  restoreOwner(userId: string): Promise<void>;
  enumerateOwner(userId: string): Promise<
    Array<{
      kind:
        | "openmuse-google-connection"
        | "openmuse-google-calendar-connection";
      id: string;
    }>
  >;
};

export function createOpenMuseGoogleOAuth(deps: {
  /** Absent when the vendor base URL could not be built — start answers 503. */
  client?: OpenConnectorOAuthClient;
  rows: OpenMuseGoogleRows;
  /** Injectable clock; the expiry test drives it past the TTL. */
  now?: () => Date;
}): OpenMuseGoogleOAuth {
  const now = deps.now ?? (() => new Date());
  const client = () => {
    if (!deps.client) throw new OpenMuseVendorUnavailableError();
    return deps.client;
  };

  /*
   * Closure constants, not methods: the repo already destructures
   * `requireConnection` off the service (reviewed-action executors), and a
   * destructured method would lose its `this` — these seams must stay safe
   * to pass detached, so nothing below reaches for `this`.
   */
  const requireConnection = async (
    userId: string,
    provider: OpenMuseGoogleProvider,
  ): Promise<StoredOpenMuseGoogleConnection> => {
    const connection = await deps.rows.getConnection(userId, provider);
    if (connection === null || connection.status !== "connected") {
      throw connection?.status === "refresh_required"
        ? new OpenMuseRefreshRequiredError(provider)
        : new OpenMuseConnectionRefusedError(
            `Connect ${provider} before using it.`,
          );
    }
    return connection;
  };

  const sweepExpired = async (): Promise<number> =>
    deps.rows.sweepExpired(now());

  return {
    async start(input) {
      if (await deps.rows.ownerDisabled(input.userId)) {
        throw new OpenMuseOwnerDisabledError(input.userId);
      }
      // Lazy sweep: every start is a free chance to retire abandoned consents,
      // so the sweep needs no scheduler wiring of its own.
      await sweepExpired();
      const alias = openmuseAlias(input.userId, input.provider);
      const { authorizationUrl } = await client().startAuthorization(
        input.provider,
        alias,
      );
      const state = new URL(authorizationUrl).searchParams.get("state");
      if (state === null || state === "") {
        throw new Error(
          "OpenConnector's authorization URL carries no state this deployment could bind.",
        );
      }
      const at = now();
      /*
       * OpenBot's own one-time binding (G02), minted and stored per consent.
       * ROUND 6 (H4) RECORDED: Google's redirect returns only code/scope/state
       * to the registered redirect_uri — an unknown query parameter appended to
       * the authorization URL NEVER comes back, so a callback that DEMANDS the
       * nonce would refuse every real consent. The nonce therefore rides the
       * authorization URL as a marker only (a vendor that ever echoes unknown
       * parameters re-arms the binding), and the callback enforces it
       * one-sidedly: a callback that NAMES a nonce must name the one this
       * consent was started with. The hard bindings are the session (§4) and
       * the vendor-bound, spent-once `state`.
       */
      const nonce = crypto.randomUUID();
      await deps.rows.insertPending({
        state,
        userId: input.userId,
        provider: input.provider,
        scopes: grantScopesFor(input.provider),
        returnUri: input.returnUri,
        createdAt: at,
        expiresAt: new Date(at.getTime() + OAUTH_STATE_TTL_MS),
        consumedAt: null,
        nonce,
        outcome: null,
        connectionId: null,
      });
      const withNonce = new URL(authorizationUrl);
      withNonce.searchParams.set("openmuse_nonce", nonce);
      return { authorizationUrl: withNonce.toString() };
    },

    async callback(input) {
      const pending = await deps.rows.getPending(input.state);
      if (pending === null) {
        throw new OpenMuseGoogleCallbackError(
          "That consent is not one this deployment started.",
          400,
        );
      }
      const at = now();
      // A consent past its TTL — or one the sweep already retired — never
      // exchanges, not even to re-answer a replay.
      if (
        pending.outcome === "expired" ||
        (pending.consumedAt === null &&
          at.getTime() > pending.expiresAt.getTime())
      ) {
        throw new OpenMuseGoogleCallbackError(
          "That consent expired. Start again.",
          410,
        );
      }
      // Session binding BEFORE anything that spends or re-answers: a foreign
      // session must not be able to burn (or hear) somebody else's consent (§4).
      if (pending.userId !== input.actorId) {
        throw new OpenMuseGoogleCallbackError(
          "That consent belongs to a different session.",
          403,
        );
      }
      if (
        pending.nonce !== null &&
        input.nonce !== undefined &&
        pending.nonce !== input.nonce
      ) {
        throw new OpenMuseGoogleCallbackError(
          "That callback carries the wrong nonce for its consent.",
          400,
        );
      }
      // §9 (D03): a deleted owner's consent never completes — not the
      // exchange, not a new connection row, not even the re-answer of a
      // consent completed before the deletion. The callback is public (the
      // fence does not stand before it), so the marker check lives HERE.
      if (await deps.rows.ownerDisabled(pending.userId)) {
        throw new OpenMuseGoogleCallbackError(
          "This OpenMuse account has been deleted.",
          403,
        );
      }
      // A completed consent replays its recorded result: same redirect, same
      // connection, no second exchange (§4 / G02).
      if (pending.outcome === "completed" && pending.connectionId !== null) {
        const recorded = await deps.rows.getConnectionById(
          pending.connectionId,
        );
        if (recorded === null) {
          throw new OpenMuseGoogleCallbackError(
            "That consent was already completed.",
            400,
          );
        }
        return { returnUri: pending.returnUri, connection: recorded };
      }
      if (pending.consumedAt !== null) {
        throw new OpenMuseGoogleCallbackError(
          "That consent was already completed.",
          400,
        );
      }
      const consumed = await deps.rows.consumePending(input.state, at);
      if (!consumed) {
        throw new OpenMuseGoogleCallbackError(
          "That consent was already completed.",
          400,
        );
      }
      // From here the state is spent whatever happens next: a failed exchange
      // answers 502 with NO row, and a fresh start is required — no auto retry.
      await client().forwardCallback(input.code, input.state);
      const provider = pending.provider as OpenMuseGoogleProvider;
      const alias = openmuseAlias(pending.userId, provider);
      const profile = await client().connectionProfile(alias);
      // The consent's grant must cover what the start registered: Google's
      // screen lets the person narrow it, and a `connected` row holding a
      // partial grant would only fail later at the provider, unmappable back
      // to "re-consent". Narrowed answers refresh_required with the fixed
      // sentence; a fresh consent over the same seat re-opens it.
      const narrowed = grantScopesFor(provider).some(
        (scope) => !profile.grantedScopes.includes(scope),
      );
      const connection: StoredOpenMuseGoogleConnection = {
        id: `openmuse-google-${crypto.randomUUID()}`,
        userId: pending.userId,
        provider,
        accountEmail: profile.displayName ?? profile.accountId,
        status: narrowed ? "refresh_required" : "connected",
        grantedScopes: profile.grantedScopes,
        generation: 1,
        alias,
        connectedAt: at,
        lastError: narrowed ? OPENMUSE_SCOPE_NARROWED_MESSAGE : null,
      };
      await deps.rows.saveConnection(connection);
      // Re-read: on a reconnect the row seam's upsert keeps the persisted id
      // (and bumps its generation), so the recorded outcome and the answered
      // connection must be the row that actually landed — a replay of this
      // consent re-answers through that recorded id (G02).
      const stored =
        (await deps.rows.getConnection(pending.userId, provider)) ?? connection;
      await deps.rows.recordOutcome(input.state, {
        connectionId: stored.id,
      });
      return { returnUri: pending.returnUri, connection: stored };
    },

    sweepExpired,

    async status(userId, provider) {
      return (
        (await deps.rows.getConnection(userId, provider)) ?? {
          provider,
          status: "disconnected" as const,
        }
      );
    },

    async allStatuses(userId) {
      return Promise.all(
        OPENMUSE_GOOGLE_PROVIDERS.map(
          async (provider) =>
            (await deps.rows.getConnection(userId, provider)) ?? {
              provider,
              status: "disconnected" as const,
            },
        ),
      );
    },

    requireConnection,

    runProviderCall: async <T>(
      userId: string,
      provider: OpenMuseGoogleProvider,
      call: (connection: StoredOpenMuseGoogleConnection) => Promise<T>,
    ): Promise<T> => {
      // The guard runs FIRST: a refresh-required connection never dials.
      const connection = await requireConnection(userId, provider);
      try {
        return await call(connection);
      } catch (error) {
        if (error instanceof OpenConnectorAuthExpiredError) {
          await deps.rows.overwriteConnection(
            {
              ...connection,
              status: "refresh_required",
              lastError: OpenMUSE_REFRESH_FAILED_MESSAGE,
            },
            // CAS on the SNAPSHOT this call read, not just the status: a
            // concurrent refresh that healed the row in place (same status, a
            // new generation when the identity changed) must not be rolled
            // back by this late write — the generation equality holds it off.
            connection.status,
            connection.generation,
          );
          throw new OpenMuseRefreshRequiredError(provider);
        }
        throw error;
      }
    },

    async refresh(userId, provider) {
      if (await deps.rows.ownerDisabled(userId)) {
        throw new OpenMuseOwnerDisabledError(userId);
      }
      const connection = await deps.rows.getConnection(userId, provider);
      if (connection === null) {
        throw new OpenMuseConnectionMissingError();
      }
      if (
        connection.status !== "connected" &&
        connection.status !== "refresh_required"
      ) {
        // A disconnected or revoked seat is beyond a refresh: reconnect it.
        throw new OpenMuseConnectionRefusedError(
          `Connect ${provider} before using it.`,
        );
      }
      try {
        await client().callAction({
          alias: connection.alias,
          actionId: openmuseRefreshActionId(provider),
          body: {},
        });
        const profile = await client().connectionProfile(connection.alias);
        // The consent's grant must STILL cover what the start registered
        // (callback's own narrowed fence): a refresh action succeeds on a
        // valid token that lacks scopes, and healing such a row to
        // `connected` would only fail at the provider, unmappable back to
        // "re-consent" — exactly what the narrowed fence exists to prevent.
        const narrowed = grantScopesFor(provider).some(
          (scope) => !profile.grantedScopes.includes(scope),
        );
        if (narrowed) {
          await deps.rows.overwriteConnection(
            {
              ...connection,
              status: "refresh_required",
              grantedScopes: profile.grantedScopes,
              lastError: OPENMUSE_SCOPE_NARROWED_MESSAGE,
            },
            connection.status,
          );
          throw new OpenMuseRefreshRequiredError(provider);
        }
        const accountEmail = profile.displayName ?? profile.accountId;
        // Generation is identity arithmetic (§4): unchanged for the same
        // account, incremented when the refreshed credential is a different
        // person's — old-generation bindings are stale from here on.
        const identityChanged = accountEmail !== connection.accountEmail;
        await deps.rows.overwriteConnection(
          {
            ...connection,
            accountEmail,
            status: "connected",
            grantedScopes: profile.grantedScopes,
            generation: identityChanged
              ? connection.generation + 1
              : connection.generation,
            connectedAt: identityChanged ? now() : connection.connectedAt,
            lastError: null,
          },
          connection.status,
        );
      } catch (error) {
        // Only the vendor naming the credential as expired may downgrade the
        // row: a transient refusal (an unknown action's 404, a 5xx, a
        // timeout) leaves the recorded state untouched, so the route stays
        // retryable and a healthy connection is not degraded by vendor noise.
        if (error instanceof OpenConnectorAuthExpiredError) {
          // Sanitized on purpose: the vendor's sentence may carry the token
          // it failed on, so the row keeps this deployment's own words. The
          // generation CAS is the same snapshot guard runProviderCall uses.
          await deps.rows.overwriteConnection(
            {
              ...connection,
              status: "refresh_required",
              lastError: OpenMUSE_REFRESH_FAILED_MESSAGE,
            },
            connection.status,
            connection.generation,
          );
        }
        throw error;
      }
      // Re-read: the row seam owns the persisted shape (ids included).
      const healed = await deps.rows.getConnection(userId, provider);
      if (healed === null) {
        throw new Error(
          "The refreshed connection disappeared while being recorded.",
        );
      }
      return healed;
    },

    async disconnect(userId, provider) {
      if (await deps.rows.ownerDisabled(userId)) {
        throw new OpenMuseOwnerDisabledError(userId);
      }
      const connection = await deps.rows.getConnection(userId, provider);
      if (connection === null) {
        throw new OpenMuseConnectionMissingError();
      }
      // Idempotent (the recorded choice): a disconnected seat has nothing
      // left to withdraw at the vendor — the second press answers the same
      // row, no second dial.
      if (connection.status === "disconnected") {
        return connection;
      }
      // Vendor first: a refused withdrawal (anything but the tolerated 404)
      // propagates and leaves the local row standing, connected.
      await client().deleteConnection(provider, connection.alias);
      const disconnected: StoredOpenMuseGoogleConnection = {
        ...connection,
        status: "disconnected",
        lastError: null,
      };
      await deps.rows.overwriteConnection(disconnected, connection.status);
      return disconnected;
    },

    async revokeOwner(userId) {
      const outcomes: Array<{
        kind:
          | "openmuse-google-connection"
          | "openmuse-google-calendar-connection";
        id: string;
        provider: OpenMuseGoogleProvider;
        outcome: "revoked" | "retryable";
      }> = [];
      for (const provider of OPENMUSE_GOOGLE_PROVIDERS) {
        const connection = await deps.rows.getConnection(userId, provider);
        if (connection === null) continue;
        if (connection.status === "revoked") {
          outcomes.push({
            kind: connectionKindOf(provider),
            id: connection.id,
            provider,
            outcome: "revoked",
          });
          continue;
        }
        try {
          // Vendor first, best-effort (G05's delete-by-alias seam; the 404
          // "nothing to withdraw" is tolerated inside the client).
          await client().deleteConnection(provider, connection.alias);
        } catch {
          // Recorded, not thrown: a refused withdrawal must never fail the
          // delete route, and the row must stay as it was for the retry.
          outcomes.push({
            kind: connectionKindOf(provider),
            id: connection.id,
            provider,
            outcome: "retryable",
          });
          continue;
        }
        await deps.rows.overwriteConnection(
          {
            ...connection,
            status: "revoked",
            lastError: null,
          },
          connection.status,
        );
        outcomes.push({
          kind: connectionKindOf(provider),
          id: connection.id,
          provider,
          outcome: "revoked",
        });
      }
      return outcomes;
    },

    disableOwner: (userId) => deps.rows.disableOwner(userId),
    restoreOwner: (userId) => deps.rows.restoreOwner(userId),
    async enumerateOwner(userId) {
      return (await deps.rows.listIdsByOwner(userId)).map((row) => ({
        kind: connectionKindOf(row.provider),
        id: row.id,
      }));
    },
  };
}
