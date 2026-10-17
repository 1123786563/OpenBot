import { beforeEach, describe, expect, test } from "../../tests/support/e2e-compat";
import { createHash } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  buildOpenConnectorOAuthClient,
  type OAuthWireDial,
} from "../src/openmuse-connectors/client";
import {
  createOpenMuseGoogleOAuth,
  GMAIL_GRANT_SCOPES,
  GOOGLE_CALENDAR_GRANT_SCOPES,
  OPENMUSE_GOOGLE_PROVIDERS,
  OPENMUSE_SCOPE_NARROWED_MESSAGE,
  OpenMUSE_REFRESH_FAILED_MESSAGE,
  OpenMuseConnectionRefusedError,
  type OpenMuseGoogleProvider,
  OpenMuseRefreshRequiredError,
  openmuseRefreshActionId,
  openmuseAlias,
} from "../src/openmuse-connectors/google-oauth";
import {
  createOpenMuseGoogleCallbackRoutes,
  createOpenMuseGoogleRoutes,
} from "../src/openmuse-connectors/routes";
import type {
  OpenMuseGoogleRows,
  StoredOpenMuseGoogleConnection,
  StoredOpenMusePending,
} from "../src/openmuse-connectors/store";

const actorOne: AuthenticatedActor = {
  id: "user-1",
  email: "one@openbot.test",
  role: "user",
};

const actorTwo: AuthenticatedActor = {
  id: "user-2",
  email: "two@openbot.test",
  role: "user",
};

let currentActor: AuthenticatedActor = actorOne;
let guardAdmits = true;
/** What the PUBLIC callback resolves from the request: null stands for no session cookie. */
let callbackSession: AuthenticatedActor | null = actorOne;

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  if (!guardAdmits) {
    return context.json({ error: "Sign in first." }, 401);
  }
  context.set("actor", currentActor);
  await next();
};

const resolveActor = async () =>
  callbackSession === null ? null : { id: callbackSession.id };

const T0 = new Date("2026-10-13T10:00:00Z");

function clock(start: Date = T0) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

/** In-memory row seam: same contract as the drizzle rows, rows live as data. */
function fakeRows(): OpenMuseGoogleRows & {
  pendings: StoredOpenMusePending[];
  connections: StoredOpenMuseGoogleConnection[];
} {
  const pendings: StoredOpenMusePending[] = [];
  const connections: StoredOpenMuseGoogleConnection[] = [];
  const disabled = new Set<string>();
  return {
    pendings,
    connections,
    insertPending: async (pending) => {
      pendings.push({ ...pending, scopes: [...pending.scopes] });
    },
    getPending: async (state) =>
      pendings.find((row) => row.state === state) ?? null,
    consumePending: async (state, consumedAt) => {
      const row = pendings.find((candidate) => candidate.state === state);
      if (!row || row.consumedAt !== null) return false;
      row.consumedAt = consumedAt;
      return true;
    },
    recordOutcome: async (state, outcome) => {
      const row = pendings.find((candidate) => candidate.state === state);
      if (!row) throw new Error(`no pending row for ${state}`);
      row.outcome = "completed";
      row.connectionId = outcome.connectionId;
    },
    sweepExpired: async (now) => {
      let swept = 0;
      for (const row of pendings) {
        if (
          row.consumedAt === null &&
          row.outcome === null &&
          row.expiresAt.getTime() < now.getTime()
        ) {
          row.outcome = "expired";
          swept += 1;
        }
      }
      return swept;
    },
    overwriteConnection: async (connection, expectStatus, expectGeneration) => {
      const existing = connections.find(
        (row) =>
          row.userId === connection.userId &&
          row.provider === connection.provider,
      );
      if (!existing) {
        throw new Error(`no connection row for ${connection.provider}`);
      }
      // The compare-and-set halves, mirrored from the drizzle rows: a row that
      // moved off the status this writer read is left to whoever moved it,
      // and so is a row a concurrent refresh healed to a new generation (M14).
      if (expectStatus !== undefined && existing.status !== expectStatus) {
        return;
      }
      if (
        expectGeneration !== undefined &&
        existing.generation !== expectGeneration
      ) {
        return;
      }
      Object.assign(existing, connection, {
        grantedScopes: [...connection.grantedScopes],
      });
    },
    getConnectionById: async (id) =>
      connections.find((row) => row.id === id) ?? null,
    getConnection: async (userId, provider) =>
      connections.find(
        (row) => row.userId === userId && row.provider === provider,
      ) ?? null,
    saveConnection: async (connection) => {
      const existing = connections.find(
        (row) =>
          row.userId === connection.userId &&
          row.provider === connection.provider,
      );
      if (existing) {
        Object.assign(existing, connection, {
          id: existing.id,
          generation: existing.generation + 1,
        });
        return;
      }
      connections.push({
        ...connection,
        grantedScopes: [...connection.grantedScopes],
      });
    },
    listIdsByOwner: async (userId) =>
      connections
        .filter((row) => row.userId === userId)
        .map((row) => ({ id: row.id, provider: row.provider })),
    hardDeleteConnection: async (userId, connectionId) => {
      const index = connections.findIndex(
        (row) => row.userId === userId && row.id === connectionId,
      );
      if (index >= 0) connections.splice(index, 1);
    },
    ownerDisabled: async (userId) => disabled.has(userId),
    disableOwner: async (userId) => {
      disabled.add(userId);
    },
    restoreOwner: async (userId) => {
      disabled.delete(userId);
    },
  };
}

type RecordedCall = {
  method: string;
  path: string;
  /** The connection the call ran in (`x-oo-connector-alias`), when it ran in one. */
  alias?: string;
  body?: unknown;
};

/**
 * The vendor as a stub: every dial answered from data, every request recorded,
 * so a test sees exactly what this deployment built.
 */
function fakeVendor() {
  const calls: RecordedCall[] = [];
  const issued = new Map<
    string,
    { service: OpenMuseGoogleProvider; state: string }
  >();
  let stateCounter = 0;
  let exchangeFailures = 0;
  let authExpiries = 0;
  let refreshFailures = 0;
  let absentDeletes = 0;
  let refusedDeletes = 0;
  const reidentified = new Map<string, string>();
  /** A consent the person narrowed on Google's screen: fewer scopes granted. */
  const narrowedScopes = new Map<string, string[]>();
  const wire = (body: unknown, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => body,
  });
  const dial: OAuthWireDial = async (path, init) => {
    const alias = init.headers["x-oo-connector-alias"];
    calls.push({
      method: init.method,
      path,
      ...(alias === undefined ? {} : { alias }),
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    const url = new URL(path, "http://openconnector.test");
    if (
      init.method === "POST" &&
      url.pathname === "/api/oauth/authorizations"
    ) {
      const body = init.body as {
        service: OpenMuseGoogleProvider;
        connectionName: string;
      };
      const state = `vendor-state-${String(++stateCounter).padStart(2, "0")}`;
      issued.set(body.connectionName, { service: body.service, state });
      return wire({
        authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?client_id=fake&response_type=code&scope=email&state=${state}`,
      });
    }
    if (url.pathname === "/oauth/callback") {
      if (exchangeFailures > 0) {
        exchangeFailures -= 1;
        return wire({ error: "exchange failed" }, 500);
      }
      return wire({ connected: true });
    }
    if (init.method === "GET" && url.pathname === "/api/connections") {
      // One profile row per alias this fake has issued an authorization for,
      // carrying the service that authorization was started under.
      return wire(
        [...issued.entries()].map(([connectionName, { service }], index) => ({
          service,
          connectionName,
          accountId: `${service}-account-${index + 1}`,
          displayName: reidentified.get(connectionName) ?? "person@gmail.com",
          grantedScopes: narrowedScopes.get(connectionName) ?? [
            ...grantScopesForTest(service),
          ],
          oauthAuthorizationId: `oauth-auth-${index + 1}`,
        })),
      );
    }
    if (
      init.method === "PUT" &&
      url.pathname.startsWith("/api/oauth/configs/")
    ) {
      return wire({ stored: true });
    }
    /*
     * The G05 delete seam (the adapter's delete-by-alias shape): DELETE
     * /api/connections/<service>?connectionName=<alias>. A 404 here is the
     * vendor saying "nothing under that name" — the adapter's established
     * nothing-to-withdraw answer — while any other refusal is a real failure.
     */
    if (
      init.method === "DELETE" &&
      url.pathname.startsWith("/api/connections/")
    ) {
      if (absentDeletes > 0) {
        absentDeletes -= 1;
        return wire({ message: "no connection under that name" }, 404);
      }
      if (refusedDeletes > 0) {
        refusedDeletes -= 1;
        return wire({ message: "the withdrawal was refused" }, 500);
      }
      return wire({ deleted: true });
    }
    /*
     * The G04 action seam (the shape `plugins/openconnector-adapter.ts` models
     * for every action): POST /v1/actions/<id> with the alias header. The
     * EXPIRED-CREDENTIAL ERROR SHAPE this fake defines — the vendor contract
     * recorded for O02's live check — is a 401 whose body carries
     * `{success:false, error:{code:"token_expired", message}}`; the client
     * classifies on the 401 alone, the nested code is the recorded placeholder.
     */
    if (init.method === "POST" && url.pathname.startsWith("/v1/actions/")) {
      if (authExpiries > 0) {
        authExpiries -= 1;
        return wire(
          {
            success: false,
            error: {
              code: "token_expired",
              message: "The stored credential is no longer authorized.",
            },
          },
          401,
        );
      }
      const actionId = decodeURIComponent(
        url.pathname.slice("/v1/actions/".length),
      );
      if (/\.refresh$/.test(actionId) && refreshFailures > 0) {
        refreshFailures -= 1;
        return wire(
          {
            message:
              "refresh failed: refresh_token=secret-refresh-token-42 invalid_grant",
          },
          500,
        );
      }
      return wire({ success: true, output: { actionId } });
    }
    return wire({ error: "unexpected vendor call" }, 404);
  };
  return {
    calls,
    dial,
    failNextExchange() {
      exchangeFailures += 1;
    },
    failNextActionWithExpiredCredential() {
      authExpiries += 1;
    },
    failNextRefresh() {
      refreshFailures += 1;
    },
    failNextDeleteWith404() {
      absentDeletes += 1;
    },
    failNextDelete() {
      refusedDeletes += 1;
    },
    reidentify(connectionName: string, accountEmail: string) {
      reidentified.set(connectionName, accountEmail);
    },
    narrowScopes(connectionName: string, granted: string[]) {
      narrowedScopes.set(connectionName, granted);
    },
    actionCalls: () =>
      calls.filter((call) => call.path.startsWith("/v1/actions/")),
    refreshCalls: (provider: OpenMuseGoogleProvider) =>
      calls.filter(
        (call) =>
          call.path === `/v1/actions/${openmuseRefreshActionId(provider)}`,
      ),
    authorizationCalls: () =>
      calls.filter((call) => call.path === "/api/oauth/authorizations"),
    exchangeCalls: () =>
      calls.filter((call) => call.path.startsWith("/oauth/callback")),
    deleteCalls: () => calls.filter((call) => call.method === "DELETE"),
    stateFor: (alias: string) => issued.get(alias)?.state ?? null,
  };
}

/** The grant scopes a fake profile answers, mirroring the module's own map. */
function grantScopesForTest(provider: OpenMuseGoogleProvider): string[] {
  return provider === "gmail"
    ? [...GMAIL_GRANT_SCOPES]
    : [...GOOGLE_CALENDAR_GRANT_SCOPES];
}

/** The same two mounts app.ts performs, on a root the tests can call. */
function assemble(
  options: {
    /** Build no client at all — the deployment-with-no-vendor-dial case. */
    vendorless?: boolean;
    now?: () => Date;
  } = {},
) {
  const rows = fakeRows();
  const vendor = fakeVendor();
  const client = options.vendorless
    ? undefined
    : buildOpenConnectorOAuthClient({ dial: vendor.dial });
  const service = createOpenMuseGoogleOAuth({
    ...(client === undefined ? {} : { client }),
    rows,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const app: Hono = new Hono();
  app.route(
    "/api/mobile/openmuse-google",
    createOpenMuseGoogleRoutes({
      service,
      requireUser,
      allowedHttpOrigin: "https://app.openmuse.test",
    }),
  );
  app.route(
    "/api/public/openmuse-google",
    createOpenMuseGoogleCallbackRoutes({ service, resolveActor }),
  );
  return { app, rows, vendor, service, client };
}

async function connect(
  app: Hono,
  returnUri = "openmuse://gmail-connected",
  provider: OpenMuseGoogleProvider = "gmail",
): Promise<Response> {
  // Gmail keeps its G01 route shape; the provider is in the path otherwise.
  const path =
    provider === "gmail"
      ? "/api/mobile/openmuse-google/connect"
      : `/api/mobile/openmuse-google/${provider}/connect`;
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ returnUri }),
  });
}

/**
 * One consent started end-to-end: the state the vendor bound, plus the nonce
 * OpenBot appended to the authorization URL it handed the client.
 */
async function connectConsent(
  app: Hono,
  returnUri = "openmuse://gmail-connected",
  provider: OpenMuseGoogleProvider = "gmail",
): Promise<{ state: string; nonce: string }> {
  const answer = await connect(app, returnUri, provider);
  expect(answer.status).toBe(200);
  const body = (await answer.json()) as { authorizationUrl: string };
  const url = new URL(body.authorizationUrl);
  return {
    state: url.searchParams.get("state") ?? "",
    nonce: url.searchParams.get("openmuse_nonce") ?? "",
  };
}

const callbackRequest = (
  app: Hono,
  params: { state: string; nonce?: string },
) =>
  app.request(
    `/api/public/openmuse-google/callback?code=test-code&state=${encodeURIComponent(params.state)}` +
      (params.nonce === undefined
        ? ""
        : `&openmuse_nonce=${encodeURIComponent(params.nonce)}`),
  );

/** The alias formula, computed independently of the module under test. */
function expectedAlias(
  userId: string,
  provider: OpenMuseGoogleProvider = "gmail",
): string {
  return `openmuse-${createHash("sha256").update(`${userId}${provider}`).digest("hex").slice(0, 16)}`;
}

describe("openmuse google oauth (G01, G02)", () => {
  beforeEach(() => {
    currentActor = actorOne;
    guardAdmits = true;
    callbackSession = actorOne;
  });

  test("start: vendor authorization under the server-derived alias, pending row with a 10-minute TTL", async () => {
    const time = clock();
    const { app, rows, vendor } = assemble({ now: time.now });

    const answer = await connect(app);

    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { authorizationUrl: string };
    expect(Object.keys(body)).toEqual(["authorizationUrl"]);
    const state = new URL(body.authorizationUrl).searchParams.get("state");
    expect(state).toBe(vendor.stateFor(expectedAlias("user-1")));
    expect(openmuseAlias("user-1", "gmail")).toBe(expectedAlias("user-1"));
    expect(vendor.authorizationCalls()).toEqual([
      {
        method: "POST",
        path: "/api/oauth/authorizations",
        body: {
          service: "gmail",
          connectionName: expectedAlias("user-1"),
        },
      },
    ]);
    expect(rows.pendings).toEqual([
      {
        state,
        userId: "user-1",
        provider: "gmail",
        scopes: GMAIL_GRANT_SCOPES,
        returnUri: "openmuse://gmail-connected",
        createdAt: T0,
        expiresAt: new Date(T0.getTime() + 10 * 60 * 1000),
        consumedAt: null,
        nonce: expect.any(String),
        outcome: null,
        connectionId: null,
      },
    ]);
  });

  test("callback happy path: forwards the exchange, records the connection, redirects to the return URI", async () => {
    const time = clock();
    const { app, rows, vendor } = assemble({ now: time.now });
    const { state, nonce } = await connectConsent(app);

    const answer = await callbackRequest(app, { state, nonce });

    expect(answer.status).toBe(302);
    expect(answer.headers.get("location")).toBe("openmuse://gmail-connected");
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(vendor.exchangeCalls()).toEqual([
      { method: "GET", path: `/oauth/callback?code=test-code&state=${state}` },
    ]);
    expect(rows.pendings[0]?.consumedAt).toEqual(T0);
    expect(rows.pendings[0]?.outcome).toBe("completed");
    expect(rows.pendings[0]?.connectionId).toBe(rows.connections[0]?.id);
    expect(rows.connections).toEqual([
      {
        id: expect.any(String),
        userId: "user-1",
        provider: "gmail",
        accountEmail: "person@gmail.com",
        status: "connected",
        grantedScopes: [
          "openid",
          "email",
          "https://www.googleapis.com/auth/gmail.readonly",
        ],
        generation: 1,
        alias: expectedAlias("user-1"),
        connectedAt: T0,
        lastError: null,
      },
    ]);
  });

  test("status: a recorded consent answers its row; no consent answers disconnected", async () => {
    const time = clock();
    const { app } = assemble({ now: time.now });

    const empty = await app.request("/api/mobile/openmuse-google/status");
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ status: "disconnected" });

    const { state, nonce } = await connectConsent(app);
    const finished = await callbackRequest(app, { state, nonce });
    expect(finished.status).toBe(302);

    const status = await app.request("/api/mobile/openmuse-google/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      provider: "gmail",
      accountEmail: "person@gmail.com",
      status: "connected",
      grantedScopes: [
        "openid",
        "email",
        "https://www.googleapis.com/auth/gmail.readonly",
      ],
      generation: 1,
      connectedAt: T0.toISOString(),
    });
  });

  test("wrong state: 400, the exchange is never called, no connection row", async () => {
    const { app, rows, vendor } = assemble();
    await connectConsent(app);

    const answer = await callbackRequest(app, {
      state: "not-a-pending-state",
    });

    expect(answer.status).toBe(400);
    expect(vendor.exchangeCalls()).toEqual([]);
    expect(rows.connections).toEqual([]);
  });

  test("expired state: 410, no exchange, no connection row", async () => {
    const time = clock();
    const { app, rows, vendor } = assemble({ now: time.now });
    const { state } = await connectConsent(app);

    time.advance(10 * 60 * 1000 + 1);
    const answer = await callbackRequest(app, { state });

    expect(answer.status).toBe(410);
    expect(vendor.exchangeCalls()).toEqual([]);
    expect(rows.connections).toEqual([]);
  });

  test("cross-session callback: 403, no exchange, no row, the pending state stays usable", async () => {
    const { app, rows, vendor } = assemble();
    const { state, nonce } = await connectConsent(app);

    callbackSession = actorTwo;
    const refused = await callbackRequest(app, { state, nonce });

    expect(refused.status).toBe(403);
    expect(vendor.exchangeCalls()).toEqual([]);
    expect(rows.connections).toEqual([]);
    expect(rows.pendings[0]?.consumedAt).toBeNull();

    // The legitimate session can still finish the consent it started.
    callbackSession = actorOne;
    const finished = await callbackRequest(app, { state, nonce });
    expect(finished.status).toBe(302);
  });

  test("replay: a completed callback re-answers the recorded result — no second exchange, generation unchanged, one row", async () => {
    const { app, rows, vendor } = assemble();
    const { state, nonce } = await connectConsent(app);

    const first = await callbackRequest(app, { state, nonce });
    expect(first.status).toBe(302);
    const recordedId = rows.connections[0]?.id;

    const second = await callbackRequest(app, { state, nonce });

    expect(second.status).toBe(302);
    expect(second.headers.get("location")).toBe("openmuse://gmail-connected");
    expect(vendor.exchangeCalls()).toHaveLength(1);
    expect(rows.connections).toHaveLength(1);
    expect(rows.connections[0]?.id).toBe(recordedId);
    expect(rows.connections[0]?.generation).toBe(1);
    expect(rows.pendings[0]?.connectionId).toBe(recordedId);
  });

  test("replay in another session is refused, not re-answered", async () => {
    const { app, vendor } = assemble();
    const { state, nonce } = await connectConsent(app);
    expect((await callbackRequest(app, { state, nonce })).status).toBe(302);

    callbackSession = actorTwo;
    const refused = await callbackRequest(app, { state, nonce });

    expect(refused.status).toBe(403);
    expect(vendor.exchangeCalls()).toHaveLength(1);
  });

  test("unauthenticated connect is 401; a callback with no session cookie is 403", async () => {
    const { app } = assemble();

    guardAdmits = false;
    const connectAnswer = await connect(app);
    expect(connectAnswer.status).toBe(401);

    callbackSession = null;
    const callbackAnswer = await callbackRequest(app, {
      state: "any-state",
    });
    expect(callbackAnswer.status).toBe(403);
  });

  test("vendor exchange failure: 502, pending consumed, no connection row — and no replay later", async () => {
    const { app, rows, vendor } = assemble();
    const { state, nonce } = await connectConsent(app);

    vendor.failNextExchange();
    const answer = await callbackRequest(app, { state, nonce });

    expect(answer.status).toBe(502);
    expect(rows.pendings[0]?.consumedAt).not.toBeNull();
    expect(rows.pendings[0]?.outcome).toBeNull();
    expect(rows.connections).toEqual([]);

    // The state was spent without a recorded outcome, so a replay is refused —
    // only a COMPLETED consent re-answers.
    const replay = await callbackRequest(app, { state, nonce });
    expect(replay.status).toBe(400);
    expect(vendor.exchangeCalls()).toHaveLength(1);
  });

  test("§9 hooks: a disabled owner cannot connect; enumerateOwner names the connections", async () => {
    const { app, rows, service } = assemble();
    const { state, nonce } = await connectConsent(app);
    const finished = await callbackRequest(app, { state, nonce });
    expect(finished.status).toBe(302);

    await service.disableOwner("user-1");
    const refused = await connect(app);

    expect(refused.status).toBe(403);
    expect(await service.enumerateOwner("user-1")).toEqual([
      { kind: "openmuse-google-connection", id: rows.connections[0]?.id },
    ]);
  });

  test("no vendor dial configured: connect answers 503 with a deployment message", async () => {
    const { app, rows } = assemble({ vendorless: true });

    const answer = await connect(app);

    expect(answer.status).toBe(503);
    expect(await answer.json()).toEqual({
      error:
        "Google connection is unavailable on this deployment. Set OPENCONNECTOR_URL.",
    });
    expect(rows.pendings).toEqual([]);
  });

  test("returnUri is restricted to the openmuse scheme or the deployment's own origin", async () => {
    const { app, rows } = assemble();

    const foreign = await connect(app, "https://evil.example/steal");
    expect(foreign.status).toBe(400);

    const notAUrl = await connect(app, "javascript:alert(1)");
    expect(notAUrl.status).toBe(400);

    const sameOrigin = await connect(
      app,
      "https://app.openmuse.test/settings/gmail",
    );
    expect(sameOrigin.status).toBe(200);

    expect(rows.pendings).toHaveLength(1);
  });

  test("abandoned consent: the sweep expires it, a late callback is 410, a second sweep no-ops", async () => {
    const time = clock();
    const { app, rows, vendor, service } = assemble({ now: time.now });
    const { state } = await connectConsent(app);
    expect(rows.pendings[0]?.outcome).toBeNull();

    time.advance(10 * 60 * 1000 + 1);
    const swept = await service.sweepExpired();

    expect(swept).toBe(1);
    expect(rows.pendings[0]?.outcome).toBe("expired");
    const late = await callbackRequest(app, { state });
    expect(late.status).toBe(410);
    expect(vendor.exchangeCalls()).toEqual([]);

    expect(await service.sweepExpired()).toBe(0);
  });

  test("start sweeps abandoned pendings along the way", async () => {
    const time = clock();
    const { app, rows } = assemble({ now: time.now });
    await connectConsent(app);

    time.advance(10 * 60 * 1000 + 1);
    currentActor = actorTwo;
    await connectConsent(app);

    expect(rows.pendings[0]?.userId).toBe("user-1");
    expect(rows.pendings[0]?.outcome).toBe("expired");
    expect(rows.pendings[1]?.userId).toBe("user-2");
    expect(rows.pendings[1]?.outcome).toBeNull();
  });

  test("nonce: issued on the authorization URL; one-sided on the callback (round 6 H4)", async () => {
    const { app, rows, vendor } = assemble();

    const answer = await connect(app);
    const url = new URL(
      ((await answer.json()) as { authorizationUrl: string }).authorizationUrl,
    );
    const nonce = url.searchParams.get("openmuse_nonce");
    expect(nonce).toEqual(expect.any(String));
    const state = url.searchParams.get("state") ?? "";
    expect(nonce).not.toBe(state);

    /*
     * Google's redirect returns only code/scope/state to the registered
     * redirect_uri — an unknown query parameter never round-trips, so a real
     * consent's callback arrives with NO nonce. Demanding it refused every
     * real consent (H4); the hard bindings are the session and the
     * vendor-bound, spent-once state, and a callback that NAMES a nonce must
     * name the right one.
     */
    const realConsent = await callbackRequest(app, { state });
    expect(realConsent.status).toBe(302);
    expect(vendor.exchangeCalls()).toHaveLength(1);

    // A named-but-wrong nonce is refused even on the now-completed consent
    // (the one-sided check precedes the replay), and the replay below answers
    // without a second exchange.
    const wrong = await callbackRequest(app, {
      state,
      nonce: "not-the-nonce",
    });
    expect(wrong.status).toBe(400);

    const right = await callbackRequest(app, {
      state,
      nonce: nonce ?? undefined,
    });
    expect(right.status).toBe(302);
    expect(vendor.exchangeCalls()).toHaveLength(1);
  });

  test("reconnect: the recorded outcome and the row are the PERSISTED ones — a replay re-answers, no dangling id", async () => {
    const { app, rows } = assemble();
    const first = await connectConsent(app);
    expect((await callbackRequest(app, first)).status).toBe(302);
    const persistedId = rows.connections[0]?.id;

    // A second consent over the same seat: the row seam's upsert keeps the
    // persisted id and bumps the generation — the callback must record and
    // answer THAT row, not the in-memory candidate it built before saving.
    const second = await connectConsent(app);
    const answer = await callbackRequest(app, second);

    expect(answer.status).toBe(302);
    expect(rows.connections).toHaveLength(1);
    expect(rows.connections[0]?.id).toBe(persistedId);
    expect(rows.connections[0]?.generation).toBe(2);
    expect(rows.pendings[1]?.connectionId).toBe(persistedId);

    // G02's replay contract survives the reconnect: the recorded id resolves.
    const replay = await callbackRequest(app, second);
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toBe("openmuse://gmail-connected");
  });

  test("a consent returned with fewer scopes than asked records refresh_required, not connected", async () => {
    const { app, rows, service, vendor } = assemble();
    // The person narrowed the grant on Google's consent screen: the profile
    // comes back without the gmail.readonly scope the start registered.
    vendor.narrowScopes(
      expectedAlias("user-1", "gmail"),
      GMAIL_GRANT_SCOPES.filter((scope) => scope !== GMAIL_GRANT_SCOPES[2]),
    );

    const consent = await connectConsent(app);
    const answer = await callbackRequest(app, consent);

    // The consent itself completed — but the row must not claim `connected`
    // with a grant it does not hold.
    expect(answer.status).toBe(302);
    expect(rows.connections[0]).toMatchObject({
      status: "refresh_required",
      grantedScopes: GMAIL_GRANT_SCOPES.filter(
        (scope) => scope !== GMAIL_GRANT_SCOPES[2],
      ),
    });
    expect(rows.connections[0]?.lastError).not.toBeNull();
    await expect(service.requireConnection("user-1", "gmail")).rejects.toThrow(
      OpenMuseRefreshRequiredError,
    );
  });

  test("the browser lands on the stored returnUri exactly, query string included", async () => {
    const { app } = assemble();
    const { state, nonce } = await connectConsent(
      app,
      "https://app.openmuse.test/settings/gmail?tab=gmail",
    );

    const answer = await callbackRequest(app, { state, nonce });

    expect(answer.status).toBe(302);
    expect(answer.headers.get("location")).toBe(
      "https://app.openmuse.test/settings/gmail?tab=gmail",
    );
  });
});

/** One provider's connection, granted end-to-end through its own consent. */
async function grant(
  app: Hono,
  provider: OpenMuseGoogleProvider,
  returnUri = "openmuse://connected",
): Promise<void> {
  const consent = await connectConsent(app, returnUri, provider);
  const answer = await callbackRequest(app, consent);
  expect(answer.status).toBe(302);
}

describe("openmuse calendar grant (G03)", () => {
  beforeEach(() => {
    currentActor = actorOne;
    guardAdmits = true;
    callbackSession = actorOne;
  });

  test("calendar after gmail: a second consent under its own alias, its own row; the gmail row untouched", async () => {
    const time = clock();
    const { app, rows, vendor } = assemble({ now: time.now });
    await grant(app, "gmail", "openmuse://gmail-connected");
    const gmailRow = rows.connections[0];

    const calendar = await connectConsent(
      app,
      "openmuse://calendar-connected",
      "googlecalendar",
    );
    const calendarAlias = expectedAlias("user-1", "googlecalendar");
    expect(calendarAlias).not.toBe(expectedAlias("user-1", "gmail"));
    expect(vendor.authorizationCalls()[1]?.body).toEqual({
      service: "googlecalendar",
      connectionName: calendarAlias,
    });
    expect(rows.pendings[1]).toMatchObject({
      userId: "user-1",
      provider: "googlecalendar",
      scopes: [...GOOGLE_CALENDAR_GRANT_SCOPES],
      returnUri: "openmuse://calendar-connected",
      consumedAt: null,
    });

    const answer = await callbackRequest(app, calendar);

    expect(answer.status).toBe(302);
    expect(answer.headers.get("location")).toBe(
      "openmuse://calendar-connected",
    );
    expect(rows.connections).toHaveLength(2);
    expect(rows.connections[1]).toEqual({
      id: expect.any(String),
      userId: "user-1",
      provider: "googlecalendar",
      accountEmail: "person@gmail.com",
      status: "connected",
      grantedScopes: [...GOOGLE_CALENDAR_GRANT_SCOPES],
      generation: 1,
      alias: calendarAlias,
      connectedAt: T0,
      lastError: null,
    });
    expect(rows.connections[1]?.id).not.toBe(gmailRow?.id);
    // The gmail consent's row is exactly what it was before the calendar grant.
    expect(gmailRow).toEqual({
      id: gmailRow?.id,
      userId: "user-1",
      provider: "gmail",
      accountEmail: "person@gmail.com",
      status: "connected",
      grantedScopes: [...GMAIL_GRANT_SCOPES],
      generation: 1,
      alias: expectedAlias("user-1", "gmail"),
      connectedAt: T0,
      lastError: null,
    });
  });

  test("a calendar grant does not authorize gmail: requireConnection refuses with a stable 409", async () => {
    const { app, service } = assemble();
    await grant(app, "googlecalendar");

    // Gmail is disconnected even though calendar is connected…
    const gmailStatus = await app.request("/api/mobile/openmuse-google/status");
    expect(await gmailStatus.json()).toEqual({ status: "disconnected" });

    // …and the provider-call guard refuses gmail with a stable 409 (§4).
    await expect(
      service.requireConnection("user-1", "gmail"),
    ).rejects.toBeInstanceOf(OpenMuseConnectionRefusedError);
    await expect(
      service.requireConnection("user-1", "gmail"),
    ).rejects.toMatchObject({
      status: 409,
      message: "Connect gmail before using it.",
    });
    // The provider that WAS granted passes the same guard.
    await expect(
      service.requireConnection("user-1", "googlecalendar"),
    ).resolves.toMatchObject({
      provider: "googlecalendar",
      alias: expectedAlias("user-1", "googlecalendar"),
      status: "connected",
    });
    // Symmetrically, a gmail-only grant does not authorize calendar calls.
    const { app: gmailOnly, service: gmailOnlyService } = assemble();
    await grant(gmailOnly, "gmail");
    await expect(
      gmailOnlyService.requireConnection("user-1", "googlecalendar"),
    ).rejects.toMatchObject({
      status: 409,
      message: "Connect googlecalendar before using it.",
    });
  });

  test("combined status: both providers with distinct statuses, scopes and generations", async () => {
    const time = clock();
    const { app } = assemble({ now: time.now });

    const empty = await app.request("/api/mobile/openmuse-google");
    expect(empty.status).toBe(200);
    expect(empty.headers.get("cache-control")).toBe("no-store");
    expect(await empty.json()).toEqual({
      connections: [
        { provider: "gmail", status: "disconnected" },
        { provider: "googlecalendar", status: "disconnected" },
      ],
    });

    await grant(app, "gmail", "openmuse://gmail-connected");
    const one = await app.request("/api/mobile/openmuse-google");
    expect(await one.json()).toEqual({
      connections: [
        {
          provider: "gmail",
          accountEmail: "person@gmail.com",
          status: "connected",
          grantedScopes: [...GMAIL_GRANT_SCOPES],
          generation: 1,
          connectedAt: T0.toISOString(),
        },
        { provider: "googlecalendar", status: "disconnected" },
      ],
    });

    await grant(app, "googlecalendar", "openmuse://calendar-connected");
    // A second gmail consent reconnects the same seat: gmail generation 2,
    // calendar still on its first — one generation per provider, per §4.
    await grant(app, "gmail", "openmuse://gmail-reconnected");
    const both = await app.request("/api/mobile/openmuse-google");
    const body = (await both.json()) as {
      connections: Array<{
        provider: string;
        status: string;
        grantedScopes: string[];
        generation: number;
      }>;
    };
    expect(body.connections).toHaveLength(2);
    expect(body.connections[0]).toMatchObject({
      provider: "gmail",
      status: "connected",
      grantedScopes: [...GMAIL_GRANT_SCOPES],
      generation: 2,
    });
    expect(body.connections[1]).toMatchObject({
      provider: "googlecalendar",
      status: "connected",
      grantedScopes: [...GOOGLE_CALENDAR_GRANT_SCOPES],
      generation: 1,
    });
  });

  // The G02 fault matrix, parameterized over BOTH providers: a calendar
  // consent is refused by exactly the same causes as a gmail one.
  for (const provider of OPENMUSE_GOOGLE_PROVIDERS) {
    describe(`${provider} consent faults (G02 matrix, parameterized)`, () => {
      test("wrong state: 400, the exchange is never called, no connection row", async () => {
        const { app, rows, vendor } = assemble();
        await connectConsent(app, "openmuse://connected", provider);

        const answer = await callbackRequest(app, {
          state: "not-a-pending-state",
        });

        expect(answer.status).toBe(400);
        expect(vendor.exchangeCalls()).toEqual([]);
        expect(rows.connections).toEqual([]);
      });

      test("expired state: 410, no exchange, no connection row", async () => {
        const time = clock();
        const { app, rows, vendor } = assemble({ now: time.now });
        const { state } = await connectConsent(
          app,
          "openmuse://connected",
          provider,
        );

        time.advance(10 * 60 * 1000 + 1);
        const answer = await callbackRequest(app, { state });

        expect(answer.status).toBe(410);
        expect(vendor.exchangeCalls()).toEqual([]);
        expect(rows.connections).toEqual([]);
      });

      test("cross-session callback: 403, no exchange, no row, the pending state stays usable", async () => {
        const { app, rows, vendor } = assemble();
        const { state, nonce } = await connectConsent(
          app,
          "openmuse://connected",
          provider,
        );

        callbackSession = actorTwo;
        const refused = await callbackRequest(app, { state, nonce });

        expect(refused.status).toBe(403);
        expect(vendor.exchangeCalls()).toEqual([]);
        expect(rows.connections).toEqual([]);
        expect(rows.pendings[0]?.consumedAt).toBeNull();

        callbackSession = actorOne;
        const finished = await callbackRequest(app, { state, nonce });
        expect(finished.status).toBe(302);
        expect(rows.connections).toHaveLength(1);
        expect(rows.connections[0]?.provider).toBe(provider);
      });

      test("replay: a completed callback re-answers the recorded result — no second exchange, generation unchanged, one row", async () => {
        const { app, rows, vendor } = assemble();
        const { state, nonce } = await connectConsent(
          app,
          "openmuse://connected",
          provider,
        );

        const first = await callbackRequest(app, { state, nonce });
        expect(first.status).toBe(302);
        const recordedId = rows.connections[0]?.id;

        const second = await callbackRequest(app, { state, nonce });

        expect(second.status).toBe(302);
        expect(second.headers.get("location")).toBe("openmuse://connected");
        expect(vendor.exchangeCalls()).toHaveLength(1);
        expect(rows.connections).toHaveLength(1);
        expect(rows.connections[0]?.id).toBe(recordedId);
        expect(rows.connections[0]?.generation).toBe(1);
      });

      test("nonce: one-sided on the callback — Google's redirect carries no unknown query (round 6 H4)", async () => {
        const { app, rows, vendor } = assemble();

        const answer = await connect(app, "openmuse://connected", provider);
        const url = new URL(
          ((await answer.json()) as { authorizationUrl: string })
            .authorizationUrl,
        );
        const nonce = url.searchParams.get("openmuse_nonce");
        const state = url.searchParams.get("state") ?? "";
        expect(nonce).toEqual(expect.any(String));
        expect(nonce).not.toBe(state);

        // A real consent arrives with no nonce (Google drops unknown
        // parameters): the session and the spent-once state are the hard
        // bindings, and it completes.
        const realConsent = await callbackRequest(app, { state });
        expect(realConsent.status).toBe(302);
        expect(vendor.exchangeCalls()).toHaveLength(1);

        // A named-but-wrong nonce is still refused, even on the completed
        // consent (the one-sided check precedes the replay).
        const wrong = await callbackRequest(app, {
          state,
          nonce: "not-the-nonce",
        });
        expect(wrong.status).toBe(400);

        const right = await callbackRequest(app, {
          state,
          nonce: nonce ?? undefined,
        });
        expect(right.status).toBe(302);
        expect(rows.connections[0]?.provider).toBe(provider);
      });
    });
  }

  test("§9 hooks: enumerateOwner names refs of both kinds", async () => {
    const { app, rows, service } = assemble();
    await grant(app, "gmail");
    await grant(app, "googlecalendar");

    expect(await service.enumerateOwner("user-1")).toEqual([
      { kind: "openmuse-google-connection", id: rows.connections[0]?.id },
      {
        kind: "openmuse-google-calendar-connection",
        id: rows.connections[1]?.id,
      },
    ]);
  });

  test("an unknown provider in the path is a 404, not a gmail connect", async () => {
    const { app, rows } = assemble();

    const connectAnswer = await app.request(
      "/api/mobile/openmuse-google/yahoo/connect",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ returnUri: "openmuse://connected" }),
      },
    );
    expect(connectAnswer.status).toBe(404);

    const statusAnswer = await app.request(
      "/api/mobile/openmuse-google/yahoo/status",
    );
    expect(statusAnswer.status).toBe(404);
    expect(rows.pendings).toEqual([]);
  });
});

describe("openmuse refresh (G04)", () => {
  beforeEach(() => {
    currentActor = actorOne;
    guardAdmits = true;
    callbackSession = actorOne;
  });

  /** One provider action run through the G04 seam, as Mail/Calendar will. */
  function listThroughProvider(
    service: ReturnType<typeof createOpenMuseGoogleOAuth>,
    client: NonNullable<ReturnType<typeof buildOpenConnectorOAuthClient>>,
    provider: OpenMuseGoogleProvider = "gmail",
  ) {
    return service.runProviderCall("user-1", provider, (connection) =>
      client.callAction({
        alias: connection.alias,
        actionId: provider === "gmail" ? "gmail.list" : "googlecalendar.list",
        body: {},
      }),
    );
  }

  test("a provider call hitting the vendor's expired-credential answer flips the row refresh_required; later calls refuse 409 without dialing", async () => {
    const { app, rows, vendor, service, client } = assemble();
    if (client === undefined) throw new Error("assemble without a client");
    await grant(app, "gmail");
    expect(rows.connections[0]?.status).toBe("connected");

    vendor.failNextActionWithExpiredCredential();
    await expect(listThroughProvider(service, client)).rejects.toMatchObject({
      name: "OpenMuseRefreshRequiredError",
      status: 409,
      message: "Refresh gmail before using it.",
    });

    expect(rows.connections[0]?.status).toBe("refresh_required");
    expect(rows.connections[0]?.lastError).toBe(
      OpenMUSE_REFRESH_FAILED_MESSAGE,
    );

    // The refusal now happens at the guard — no provider dial at all.
    const dialed = vendor.actionCalls().length;
    await expect(listThroughProvider(service, client)).rejects.toBeInstanceOf(
      OpenMuseRefreshRequiredError,
    );
    expect(vendor.actionCalls().length).toBe(dialed);

    // The state is visible: per-provider status and the combined listing.
    const status = await app.request(
      "/api/mobile/openmuse-google/gmail/status",
    );
    expect(await status.json()).toMatchObject({
      status: "refresh_required",
      generation: 1,
      lastError: OpenMUSE_REFRESH_FAILED_MESSAGE,
    });
    const combined = await app.request("/api/mobile/openmuse-google");
    const combinedBody = (await combined.json()) as {
      connections: Array<{ status: string; lastError?: string }>;
    };
    expect(combinedBody.connections[0]).toMatchObject({
      status: "refresh_required",
      lastError: OpenMUSE_REFRESH_FAILED_MESSAGE,
    });
  });

  test("refresh success: connected again, provider calls resume, generation unchanged for the same identity", async () => {
    const { app, rows, vendor, service, client } = assemble();
    if (client === undefined) throw new Error("assemble without a client");
    await grant(app, "gmail");
    vendor.failNextActionWithExpiredCredential();
    await expect(listThroughProvider(service, client)).rejects.toBeInstanceOf(
      OpenMuseRefreshRequiredError,
    );

    const answer = await app.request(
      "/api/mobile/openmuse-google/gmail/refresh",
      {
        method: "POST",
      },
    );

    expect(answer.status).toBe(200);
    const body = (await answer.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      provider: "gmail",
      accountEmail: "person@gmail.com",
      status: "connected",
      generation: 1,
    });
    expect(body).not.toHaveProperty("lastError");
    // The dial is the vendor's refresh action, in the person's connection.
    expect(vendor.refreshCalls("gmail")).toEqual([
      {
        method: "POST",
        path: `/v1/actions/${openmuseRefreshActionId("gmail")}`,
        alias: expectedAlias("user-1", "gmail"),
        body: { input: {} },
      },
    ]);
    expect(rows.connections[0]).toMatchObject({
      status: "connected",
      generation: 1,
      lastError: null,
    });

    // Provider calls resume through the same seam.
    await expect(listThroughProvider(service, client)).resolves.toMatchObject({
      success: true,
    });
  });

  test("refresh success with a changed identity increments generation; a generation-1 binding is stale via requireConnection", async () => {
    const { app, rows, vendor, service } = assemble();
    await grant(app, "gmail");
    vendor.reidentify(
      expectedAlias("user-1", "gmail"),
      "other.person@gmail.com",
    );

    const answer = await app.request(
      "/api/mobile/openmuse-google/gmail/refresh",
      {
        method: "POST",
      },
    );

    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({
      accountEmail: "other.person@gmail.com",
      status: "connected",
      generation: 2,
    });
    expect(rows.connections[0]).toMatchObject({
      accountEmail: "other.person@gmail.com",
      generation: 2,
    });
    // The seam Reviewed actions bind (R03+): a proposal bound to generation 1
    // compares against what requireConnection now exposes and is stale.
    const connection = await service.requireConnection("user-1", "gmail");
    expect(connection).toMatchObject({ status: "connected", generation: 2 });
    expect(connection.generation).not.toBe(1);
  });

  test("refresh answered by a transient vendor refusal: 502 out, the healthy row UNTOUCHED, retryable", async () => {
    const { app, rows, vendor } = assemble();
    await grant(app, "gmail");

    vendor.failNextRefresh();
    const failed = await app.request(
      "/api/mobile/openmuse-google/gmail/refresh",
      {
        method: "POST",
      },
    );

    expect(failed.status).toBe(502);
    // A 5xx is vendor noise, not a dead credential: the row keeps its
    // recorded state so the route stays retryable without degrading a
    // healthy connection to a 409 refusal.
    expect(rows.connections[0]?.status).toBe("connected");
    expect(rows.connections[0]?.lastError).toBeNull();

    // Retryable: a second attempt dials the vendor again.
    vendor.failNextRefresh();
    const retried = await app.request(
      "/api/mobile/openmuse-google/gmail/refresh",
      {
        method: "POST",
      },
    );
    expect(retried.status).toBe(502);
    expect(vendor.refreshCalls("gmail")).toHaveLength(2);
    expect(rows.connections[0]?.status).toBe("connected");
  });

  test("refresh answered by the vendor's expired-credential 401: row flips refresh_required with the sanitized sentence", async () => {
    const { app, rows, vendor } = assemble();
    await grant(app, "gmail");

    vendor.failNextActionWithExpiredCredential();
    const failed = await app.request(
      "/api/mobile/openmuse-google/gmail/refresh",
      {
        method: "POST",
      },
    );

    // The expired-credential class rides the OAuth error's 502 out of the
    // refresh route; the row's own downgrade is what the next call sees.
    expect(failed.status).toBe(502);
    expect(rows.connections[0]?.status).toBe("refresh_required");
    expect(rows.connections[0]?.lastError).toBe(
      OpenMUSE_REFRESH_FAILED_MESSAGE,
    );
    // Sanitized: the vendor's own sentence never reaches the row.
    expect(rows.connections[0]?.lastError).not.toContain(
      "no longer authorized",
    );
  });

  test("refresh on a scope-narrowed consent keeps the row refresh_required — only a fresh consent re-opens it", async () => {
    const { app, rows, vendor } = assemble();
    await grant(app, "gmail");
    const alias = expectedAlias("user-1", "gmail");
    // The refresh action succeeds, but the seat's grant no longer covers the
    // scopes the start registered.
    vendor.narrowScopes(alias, ["openid", "email"]);

    const answer = await app.request(
      "/api/mobile/openmuse-google/gmail/refresh",
      {
        method: "POST",
      },
    );

    expect(answer.status).toBe(409);
    expect(rows.connections[0]?.status).toBe("refresh_required");
    expect(rows.connections[0]?.lastError).toBe(
      OPENMUSE_SCOPE_NARROWED_MESSAGE,
    );
    // The narrowed grant itself is recorded, so the status route shows what
    // the seat actually holds.
    expect(rows.connections[0]?.grantedScopes).toEqual(["openid", "email"]);
  });

  test("overwriteConnection is a compare-and-set: a stale snapshot cannot roll a newer state back", async () => {
    const { app, rows } = assemble();
    await grant(app, "gmail");
    const read = rows.connections[0];
    if (read === undefined) throw new Error("no connection row");
    // A concurrent disconnect moves the row first...
    await rows.overwriteConnection(
      { ...read, status: "disconnected", lastError: null },
      "connected",
    );
    // ...then the stale writer (holding the old connected snapshot) tries to
    // heal the row: the WHERE status = 'connected' misses, and the row keeps
    // the disconnect instead of reviving a ghost connection.
    await rows.overwriteConnection(
      { ...read, status: "connected", lastError: null },
      "connected",
    );
    expect(rows.connections[0]?.status).toBe("disconnected");
  });

  test("overwriteConnection's generation CAS: a concurrent same-status heal is not rolled back (round 6 M14)", async () => {
    const { app, rows } = assemble();
    await grant(app, "gmail");
    const read = rows.connections[0];
    if (read === undefined) throw new Error("no connection row");
    // A concurrent refresh healed the row IN PLACE: status still connected,
    // but the identity change bumped the generation.
    await rows.saveConnection({ ...read, accountEmail: "new-person@x.test" });
    // The late downgrade writer (holding the gen-1 connected snapshot) must
    // not clobber the healed row: the generation half of the CAS holds it off.
    await rows.overwriteConnection(
      { ...read, status: "refresh_required" },
      "connected",
      1,
    );
    expect(rows.connections[0]?.status).toBe("connected");
    expect(rows.connections[0]?.accountEmail).toBe("new-person@x.test");
    // Without the generation expectation the write still lands (the plain
    // status CAS stays available to callers that read the CURRENT row).
    await rows.overwriteConnection(
      { ...rows.connections[0]!, status: "refresh_required" },
      "connected",
    );
    expect(rows.connections[0]?.status).toBe("refresh_required");
  });

  test("connectionProfile refuses a connection row carrying no identity at all", async () => {
    const dial = async () => ({
      ok: true,
      status: 200,
      json: async () => [
        { connectionName: "openmuse-no-identity", grantedScopes: [] },
      ],
    });
    const client = buildOpenConnectorOAuthClient({ dial });
    await expect(
      client.connectionProfile("openmuse-no-identity"),
    ).rejects.toMatchObject({
      name: "OpenConnectorOAuthError",
      message:
        "OpenConnector's connection row carries no identity this deployment could read.",
    });
  });

  test("callAction unwraps the runtime face's `{ data: ... }` envelope once", async () => {
    const dial = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { hello: "payload" } }),
    });
    const client = buildOpenConnectorOAuthClient({ dial });
    await expect(
      client.callAction({
        alias: "openmuse-alias-one",
        actionId: "gmail.list",
        body: {},
      }),
    ).resolves.toEqual({ hello: "payload" });
  });

  test("refresh on a disconnected row: 409 — reconnect, do not refresh", async () => {
    const { app, rows } = assemble();
    rows.connections.push({
      id: "seeded-row",
      userId: "user-1",
      provider: "gmail",
      accountEmail: "person@gmail.com",
      status: "disconnected",
      grantedScopes: [],
      generation: 1,
      alias: expectedAlias("user-1", "gmail"),
      connectedAt: T0,
      lastError: null,
    });

    const answer = await app.request(
      "/api/mobile/openmuse-google/gmail/refresh",
      {
        method: "POST",
      },
    );

    expect(answer.status).toBe(409);
    expect(await answer.json()).toEqual({
      error: "Connect gmail before using it.",
    });
  });

  test("a foreign owner's refresh is a 404; a disabled owner's is a 403", async () => {
    const { app, service } = assemble();
    await grant(app, "gmail");

    currentActor = actorTwo;
    const foreign = await app.request(
      "/api/mobile/openmuse-google/gmail/refresh",
      { method: "POST" },
    );
    expect(foreign.status).toBe(404);

    currentActor = actorOne;
    await service.disableOwner("user-1");
    const disabled = await app.request(
      "/api/mobile/openmuse-google/gmail/refresh",
      { method: "POST" },
    );
    expect(disabled.status).toBe(403);
  });

  test("an unknown provider's refresh is a 404, not a gmail refresh", async () => {
    const { app, vendor } = assemble();
    await grant(app, "gmail");

    const answer = await app.request(
      "/api/mobile/openmuse-google/yahoo/refresh",
      { method: "POST" },
    );

    expect(answer.status).toBe(404);
    expect(vendor.actionCalls()).toEqual([]);
  });
});

describe("openmuse disconnect and reconnect (G05)", () => {
  beforeEach(() => {
    currentActor = actorOne;
    guardAdmits = true;
    callbackSession = actorOne;
  });

  const disconnect = (app: Hono, provider: OpenMuseGoogleProvider = "gmail") =>
    app.request(`/api/mobile/openmuse-google/${provider}/disconnect`, {
      method: "POST",
    });

  /** One provider action run through the §4 seam, as Mail/Calendar will. */
  function callThroughProvider(
    service: ReturnType<typeof createOpenMuseGoogleOAuth>,
    client: NonNullable<ReturnType<typeof buildOpenConnectorOAuthClient>>,
    provider: OpenMuseGoogleProvider,
  ) {
    return service.runProviderCall("user-1", provider, (connection) =>
      client.callAction({
        alias: connection.alias,
        actionId: provider === "gmail" ? "gmail.list" : "googlecalendar.list",
        body: {},
      }),
    );
  }

  /**
   * The R03+ binding a Reviewed action carries (contract §4): the generation
   * the proposal was bound to, compared against what the seam exposes — a
   * mismatch is the stale 409, before any provider dial.
   */
  async function actUnlessStale(
    service: ReturnType<typeof createOpenMuseGoogleOAuth>,
    provider: OpenMuseGoogleProvider,
    boundGeneration: number,
  ) {
    const connection = await service.requireConnection("user-1", provider);
    if (connection.generation !== boundGeneration) {
      throw new OpenMuseConnectionRefusedError(
        `This action was bound to an older ${provider} connection.`,
      );
    }
    return connection;
  }

  test("disconnect: vendor delete by alias, local row disconnected, provider calls refuse 409 without dialing", async () => {
    const { app, rows, vendor, service, client } = assemble();
    if (client === undefined) throw new Error("assemble without a client");
    await grant(app, "gmail");

    const answer = await disconnect(app);

    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({
      provider: "gmail",
      status: "disconnected",
      generation: 1,
    });
    expect(vendor.deleteCalls()).toEqual([
      {
        method: "DELETE",
        path: `/api/connections/gmail?connectionName=${expectedAlias("user-1", "gmail")}`,
      },
    ]);
    // The row survives disconnected — generation preserved, the NEXT connect
    // increments it (§4).
    expect(rows.connections[0]).toMatchObject({
      status: "disconnected",
      generation: 1,
    });

    // §4: the disconnected seat refuses BEFORE the vendor — no dial at all.
    const dialed = vendor.actionCalls().length;
    await expect(
      callThroughProvider(service, client, "gmail"),
    ).rejects.toMatchObject({
      name: "OpenMuseConnectionRefusedError",
      status: 409,
      message: "Connect gmail before using it.",
    });
    expect(vendor.actionCalls().length).toBe(dialed);

    // The state is visible: per-provider status answers the §4 shape.
    const status = await app.request(
      "/api/mobile/openmuse-google/gmail/status",
    );
    expect(await status.json()).toMatchObject({
      provider: "gmail",
      status: "disconnected",
      generation: 1,
    });
  });

  test("disconnect when the vendor already forgot the connection: the 404 on delete is nothing-to-withdraw, still disconnects", async () => {
    const { app, rows, vendor } = assemble();
    await grant(app, "gmail");

    vendor.failNextDeleteWith404();
    const answer = await disconnect(app);

    expect(answer.status).toBe(200);
    expect(rows.connections[0]?.status).toBe("disconnected");
    expect(vendor.deleteCalls()).toHaveLength(1);
  });

  test("a vendor refusal on delete is not a disconnect: 502 and the row stays connected", async () => {
    const { app, rows, vendor } = assemble();
    await grant(app, "gmail");

    vendor.failNextDelete();
    const answer = await disconnect(app);

    expect(answer.status).toBe(502);
    expect(rows.connections[0]?.status).toBe("connected");
    expect(vendor.deleteCalls()).toHaveLength(1);
  });

  test("disconnect is idempotent: a second press answers the same state and dials the vendor at most once", async () => {
    const { app, rows, vendor } = assemble();
    await grant(app, "gmail");
    expect((await disconnect(app)).status).toBe(200);

    const second = await disconnect(app);

    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      status: "disconnected",
      generation: 1,
    });
    expect(vendor.deleteCalls()).toHaveLength(1);
    expect(rows.connections[0]).toMatchObject({
      status: "disconnected",
      generation: 1,
    });

    // An unknown provider in the path is a 404, not a gmail disconnect.
    const unknown = await disconnect(app, "yahoo" as OpenMuseGoogleProvider);
    expect(unknown.status).toBe(404);
  });

  test("reconnect after disconnect is a NEW generation; a generation-1-bound action is stale", async () => {
    const { app, rows, service } = assemble();
    await grant(app, "gmail");
    expect((await disconnect(app)).status).toBe(200);

    await grant(app, "gmail", "openmuse://reconnected");

    expect(rows.connections[0]).toMatchObject({
      status: "connected",
      generation: 2,
    });
    // The seam R03+ binds against: a proposal bound to generation 1 is stale —
    // the compare refuses 409 before any provider dial.
    await expect(actUnlessStale(service, "gmail", 1)).rejects.toMatchObject({
      status: 409,
      message: "This action was bound to an older gmail connection.",
    });
    await expect(actUnlessStale(service, "gmail", 2)).resolves.toMatchObject({
      status: "connected",
      generation: 2,
    });
  });

  test("per-provider independence: disconnecting gmail leaves googlecalendar connected and callable", async () => {
    const { app, rows, vendor, service, client } = assemble();
    if (client === undefined) throw new Error("assemble without a client");
    await grant(app, "gmail");
    await grant(app, "googlecalendar");

    const answer = await disconnect(app, "gmail");

    expect(answer.status).toBe(200);
    expect(vendor.deleteCalls()).toHaveLength(1);
    expect(vendor.deleteCalls()[0]?.path).toContain(
      `connectionName=${expectedAlias("user-1", "gmail")}`,
    );
    expect(rows.connections[0]).toMatchObject({
      provider: "gmail",
      status: "disconnected",
    });
    // The other provider's seat is untouched: connected, callable, dials.
    expect(rows.connections[1]).toMatchObject({
      provider: "googlecalendar",
      status: "connected",
    });
    await expect(
      callThroughProvider(service, client, "googlecalendar"),
    ).resolves.toMatchObject({ success: true });
    await expect(
      service.requireConnection("user-1", "gmail"),
    ).rejects.toMatchObject({ status: 409 });
  });

  test("a foreign owner's disconnect is a 404; a disabled owner's is a 403; §9 enumerate still names the disconnected row", async () => {
    const { app, rows, service } = assemble();
    await grant(app, "gmail");
    await grant(app, "googlecalendar");
    expect((await disconnect(app, "gmail")).status).toBe(200);

    // Cleanup must still find a disconnected row's alias (§9).
    expect(await service.enumerateOwner("user-1")).toEqual([
      { kind: "openmuse-google-connection", id: rows.connections[0]?.id },
      {
        kind: "openmuse-google-calendar-connection",
        id: rows.connections[1]?.id,
      },
    ]);

    currentActor = actorTwo;
    const foreign = await disconnect(app, "googlecalendar");
    expect(foreign.status).toBe(404);

    currentActor = actorOne;
    await service.disableOwner("user-1");
    const disabled = await disconnect(app, "googlecalendar");
    expect(disabled.status).toBe(403);
  });
});
