// #366 — the rejection-path suite (R5, spec: craft-preview-origin AC3/AC4, D4/D9).
//
// One reproducible catalog of EVERY refusal the preview surface can answer, so
// an agent picking this up cannot miss the refusal semantics. Four acceptance
// fronts, each its own describe:
//
//   AC4-1  逐条拒绝 — no ticket / expired ticket (clock advanced, never slept) /
//          replayed ticket / cross-session ticket (A's ticket on B's host) /
//          another's session ticket (the redemption re-check) / unknown host —
//          each refusal carries a DISPLAYABLE reason and leaks neither the
//          ticket value nor the planted cookie value (the security red line).
//   AC4-2  并发兑换竞争 — two concurrent redemptions of ONE ticket: exactly one
//          302 + cookie, one refusal (Promise.all, real concurrency).
//   AC4-3  准入关闭 — a closed origin answers its reason on EVERY preview route:
//          host resolution, the redemption leg, the traffic leg, originFor (no
//          address may exist), and the main-site minting route (nothing minted).
//   AC4-4  附着模型 — a down upstream dev server is the established 503, with NO
//          spawn side effect: only the attach probe dials, and the bootstrap
//          script (the process-spawn channel) is never written.
//
// Follows craft-preview-ticket.test.ts / craft-preview-origin.test.ts style:
// steppable fake clock, minimal store seams, hono `app.request` for routes.

import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { loadCraftConfig } from "../src/craft/config";
import {
  createPreviewOrigin,
  PREVIEW_PASS_REFUSAL,
  type PreviewOrigin,
  type ServePreview,
} from "../src/craft/preview-origin";
import {
  createPreviewTickets,
  PREVIEW_SESSION_COOKIE,
  PREVIEW_TICKET_TTL_MS,
  type PreviewTickets,
} from "../src/craft/preview-ticket";
import type {
  AgentSandboxFileApi,
  SandboxGateway,
} from "../src/craft/sandbox-gateway";
import type { CraftSessionRow, CraftStore } from "../src/craft/store";
import {
  createPreviewProxy,
  createWebappProxyRoutes,
} from "../src/craft/webapp-proxy";

const SESSION_A = "cs-aaaaaaaaaaaa";
const SESSION_B = "cs-bbbbbbbbbbbb";
const USER_ID = "u1";
const OTHER_USER_ID = "u2";
const SECRET = "test-rejection-suite-secret";
const TEMPLATE = "https://{session}.preview.example.com";
const DIRECTORY = `/workspace/sessions/${SESSION_A}`;
const WEBAPP = `${DIRECTORY}/outputs/web`;

/** The redemption leg's one refusal sentence — exact, so drift is loud. */
const TICKET_REFUSAL =
  "The preview ticket is invalid, expired, or already used.";
/** The unknown-host refusal sentence (resolvePreviewRequest, both forms). */
const UNKNOWN_HOST_REFUSAL = "Unknown preview host.";

/** A steppable clock — expiry is tested by advancing it, never by sleeping. */
function fakeClock(startMs = 1_700_000_000_000) {
  let at = startMs;
  return {
    now: () => new Date(at),
    advance: (ms: number) => {
      at += ms;
    },
  };
}

/**
 * The store seams the surface touches, all answering through one mutable owner:
 * getSession (the issuing route's ownership check), findSession (the redemption
 * re-check), findSessionById (the preview proxy's by-id row lookup). Flipping
 * `state.owner` simulates reassignment/deletion AFTER issue.
 */
function fakeStore() {
  const state = { owner: USER_ID as string | null };
  const row = (sessionId: string) => ({ id: sessionId, userId: state.owner });
  const store = {
    async getSession(sessionId: string, userId: string) {
      return state.owner === userId ? row(sessionId) : undefined;
    },
    async findSession(sessionId: string, userId: string) {
      return state.owner === userId ? row(sessionId) : undefined;
    },
    async findSessionById(sessionId: string) {
      return state.owner !== null ? row(sessionId) : undefined;
    },
  } as unknown as CraftStore;
  return { store, state };
}

type OriginOverrides = Partial<{
  enabled: boolean;
  webappProxyEnabled: boolean;
  previewOriginEnabled: boolean;
  previewOriginTemplate: string;
}>;

/**
 * A servePreview that must never be reached: every test in this file lives on
 * refusal paths, so accidental proxying explodes instead of passing quietly.
 */
const unreachableServePreview: ServePreview = async () => {
  throw new Error("servePreview must not be reached on a rejection path");
};

function originWith(
  overrides: OriginOverrides = {},
  env: Record<string, string | undefined> = {},
  tickets: PreviewTickets = createPreviewTickets({ store: fakeStore().store }),
  servePreview: ServePreview = unreachableServePreview,
): PreviewOrigin {
  return createPreviewOrigin({
    config: {
      enabled: true,
      webappProxyEnabled: true,
      previewOriginEnabled: true,
      previewOriginTemplate: "",
      ...overrides,
    },
    previewTickets: tickets,
    secret: SECRET,
    env,
    servePreview,
  });
}

/** An open origin, its address for one session, and a ticket bound to that host. */
function entryCase(
  options: {
    overrides?: OriginOverrides;
    env?: Record<string, string | undefined>;
    sessionId?: string;
  } = {},
) {
  const clock = fakeClock();
  const { store, state } = fakeStore();
  const tickets = createPreviewTickets({ store, now: clock.now });
  const origin = originWith(
    options.overrides ?? {},
    options.env ?? {},
    tickets,
  );
  const sessionId = options.sessionId ?? SESSION_A;
  const address = origin.originFor(sessionId); // registers the label
  const host = new URL(address).host;
  const { ticket } = tickets.issuePreviewTicket({
    sessionId,
    userId: USER_ID,
    previewHost: host,
  });
  return { clock, store, state, tickets, origin, address, host, ticket, sessionId };
}

/** The redemption request a browser would land on: previewEntryUrl's exact
 * shape — `${origin}?ticket=…`. The pathname is the minted address's own
 * (dev form: /<label>, no trailing slash) — the entry-root shape redemption
 * is pinned to (fix-ocr20 #2); a trailing slash here would be a different
 * pathname that no browser hop ever presents. */
const redeemRequest = (address: string, ticket: string) =>
  new Request(`${address}?ticket=${encodeURIComponent(ticket)}`);

/** A refusal body must be a displayable sentence and leak no credential. */
async function expectCleanRefusal(
  response: Response,
  secrets: string[],
): Promise<{ error: string }> {
  const text = await response.text();
  for (const secret of secrets) {
    expect(text).not.toContain(secret);
  }
  const body = JSON.parse(text) as { error: string };
  // Displayable: a real sentence a person can read, not an empty stub.
  expect(body.error.length).toBeGreaterThan(20);
  return body;
}

function signedInAs(userId: string): MiddlewareHandler<{
  Variables: AppVariables;
}> {
  return async (context, next) => {
    context.set("actor", {
      id: userId,
      email: `${userId}@example.com`,
      role: "user",
    });
    await next();
  };
}

function sessionRow(sessionId: string, nextjsPort: number | null): CraftSessionRow {
  return {
    id: sessionId,
    userId: USER_ID,
    name: "app",
    status: "active",
    lastActivityAt: new Date(),
    createdAt: new Date(),
    nextjsPort,
    sharingScope: "private",
    origin: "INTERACTIVE",
    opencodeSessionId: null,
    agentProvider: null,
    agentModel: null,
    skillsHash: null,
    mcpConfigHash: null,
  };
}

/** A file API that records every write — the process-spawn channel to spy on. */
function recordingFileApi() {
  const writes: string[] = [];
  const api: AgentSandboxFileApi = {
    async listFiles() {
      throw new Error("listFiles must not be called on a rejection path");
    },
    async writeFile(path: string) {
      writes.push(path);
    },
    async writeFileBytes(path: string) {
      writes.push(path);
    },
    async deletePath() {
      return false;
    },
    async readFile() {
      return null;
    },
    async readFileBytes() {
      return null;
    },
  };
  return { writes, api };
}

const gatewayWith = (api: AgentSandboxFileApi): SandboxGateway =>
  ({ fileApiFor: () => api }) as unknown as SandboxGateway;

// ── AC4-1: the per-case refusal catalog ───────────────────────────────────────

describe("逐条拒绝: every refusal answers its status with a displayable, credential-free reason", () => {
  test("无票 — no ticket and no pass → 401 with the pass refusal, nothing planted", async () => {
    const { origin, address } = entryCase();

    const response = await origin.handlePreviewRequest(
      SESSION_A,
      new Request(`${address}/`),
    );
    expect(response.status).toBe(401);
    expect(await expectCleanRefusal(response, [])).toEqual({
      error: PREVIEW_PASS_REFUSAL,
    });
    // Nothing plants a pass on a refusal.
    expect(response.headers.get("set-cookie")).toBeNull();

    // The iframe-shaped caller lands on a readable page — same refusal, same
    // status, still free of the cookie name.
    const framed = await origin.handlePreviewRequest(
      SESSION_A,
      new Request(`${address}/`, {
        headers: { accept: "text/html,application/xhtml+xml" },
      }),
    );
    expect(framed.status).toBe(401);
    expect(framed.headers.get("content-type")).toContain("text/html");
    const page = await framed.text();
    expect(page).toContain("<!");
    expect(page).toContain("preview pass");
    expect(page).not.toContain(PREVIEW_SESSION_COOKIE);
  });

  test("过期票 — clock advanced past the 30s window → 401, ticket value never echoed", async () => {
    const { origin, address, ticket, clock } = entryCase();
    // D9: the window closes at exactly TTL — the clock advances, never sleeps.
    clock.advance(PREVIEW_TICKET_TTL_MS);

    const response = await origin.handlePreviewRequest(
      SESSION_A,
      redeemRequest(address, ticket),
    );
    expect(response.status).toBe(401);
    expect(await expectCleanRefusal(response, [ticket])).toEqual({
      error: TICKET_REFUSAL,
    });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("已重放票 — the second redemption of one ticket → 401, and neither the ticket nor the planted pass leaks", async () => {
    const { origin, address, ticket } = entryCase();

    const first = await origin.handlePreviewRequest(
      SESSION_A,
      redeemRequest(address, ticket),
    );
    expect(first.status).toBe(302);
    const planted = first.headers.get("set-cookie") ?? "";
    expect(planted).toContain(`${PREVIEW_SESSION_COOKIE}=`);
    const passValue = planted
      .split(";")[0]
      .slice(`${PREVIEW_SESSION_COOKIE}=`.length);

    const replay = await origin.handlePreviewRequest(
      SESSION_A,
      redeemRequest(address, ticket),
    );
    expect(replay.status).toBe(401);
    // The red line: the replayed ticket AND the already-planted pass value
    // appear nowhere in the refusal.
    expect(await expectCleanRefusal(replay, [ticket, passValue])).toEqual({
      error: TICKET_REFUSAL,
    });
    expect(replay.headers.get("set-cookie")).toBeNull();
  });

  test("fix-ocr28 #6: the redemption 401 answers the iframe's dual shape — a browser-shape caller gets the readable page, not bare JSON", async () => {
    // The ticket-invalid 401 was this file's one refusal outside the
    // refuseResponse family: an iframe re-navigating to the spent entry URL
    // (the ticket already consumed by the first hop) landed on raw JSON.
    // The dual shape is the family's discipline (fix-ocr27 #7's no-store
    // stays: refuseResponse answers no-store in both branches).
    const { origin, address, ticket } = entryCase();
    // Burn the ticket once — the second redemption is the 401 under test.
    const first = await origin.handlePreviewRequest(
      SESSION_A,
      redeemRequest(address, ticket),
    );
    expect(first.status).toBe(302);

    const replay = await origin.handlePreviewRequest(
      SESSION_A,
      new Request(`${address}?ticket=${encodeURIComponent(ticket)}`, {
        headers: { accept: "text/html,application/xhtml+xml" },
      }),
    );
    expect(replay.status).toBe(401);
    expect(replay.headers.get("content-type")).toContain("text/html");
    expect(replay.headers.get("cache-control")).toBe("no-store");
    const page = await replay.text();
    expect(page).toContain("<!");
    // The sentence renders on the page; the ticket never does.
    expect(page).toContain("preview ticket is invalid");
    expect(page).not.toContain(ticket);
  });

  test("跨会话票 — session A's ticket on session B's host → 401; the attempt burns it; B's own ticket still works", async () => {
    const { tickets, origin, address, ticket } = entryCase();
    const addressB = origin.originFor(SESSION_B); // registers B's label

    // A's ticket, presented on B's preview host: refused with the same
    // credential-free sentence…
    const stranger = await origin.handlePreviewRequest(
      SESSION_B,
      redeemRequest(addressB, ticket),
    );
    expect(stranger.status).toBe(401);
    expect(await expectCleanRefusal(stranger, [ticket])).toEqual({
      error: TICKET_REFUSAL,
    });
    expect(stranger.headers.get("set-cookie")).toBeNull();

    // …one attempt is one burn: the ticket no longer works on A's host either.
    const burned = await origin.handlePreviewRequest(
      SESSION_A,
      redeemRequest(address, ticket),
    );
    expect(burned.status).toBe(401);

    // Control: the refusal is the binding, not a broken origin — B's own
    // ticket redeems on B's host.
    const { ticket: ticketB } = tickets.issuePreviewTicket({
      sessionId: SESSION_B,
      userId: USER_ID,
      previewHost: new URL(addressB).host,
    });
    const own = await origin.handlePreviewRequest(
      SESSION_B,
      redeemRequest(addressB, ticketB),
    );
    expect(own.status).toBe(302);
    expect(own.headers.get("set-cookie")).toContain(
      `${PREVIEW_SESSION_COOKIE}=${SESSION_B}`,
    );
  });

  test("他人会话票 — the session reassigned after issue refuses at redeem; another user cannot mint for it either", async () => {
    const { origin, address, ticket, state } = entryCase();

    // The session's ownership changes UNDER the live ticket (reassignment /
    // deletion): the ticket root alone is never authority — redemption
    // re-checks the store and refuses.
    state.owner = OTHER_USER_ID;
    const response = await origin.handlePreviewRequest(
      SESSION_A,
      redeemRequest(address, ticket),
    );
    expect(response.status).toBe(401);
    expect(await expectCleanRefusal(response, [ticket])).toEqual({
      error: TICKET_REFUSAL,
    });
    expect(response.headers.get("set-cookie")).toBeNull();

    // The minting leg refuses too: another user's session is 404 to the
    // issuing route, and nothing is minted for it.
    const { store } = fakeStore();
    const freshTickets = createPreviewTickets({ store });
    const app = createWebappProxyRoutes(signedInAs(OTHER_USER_ID), {
      config: loadCraftConfig({}),
      store,
      gateway: gatewayWith(
        recordingFileApi().api,
      ),
      botIdFor: async () => "craft-bot",
      sandboxConnectionFor: () => ({
        baseUrl: "http://sbox.internal:4300",
        token: null,
      }),
      previewTickets: freshTickets,
      previewOriginFor: () => "http://127.0.0.1:3001/label",
    });
    const mint = await app.request(`/sessions/${SESSION_A}/preview-ticket`, {
      method: "POST",
    });
    expect(mint.status).toBe(404);
    expect(await mint.json()).toEqual({ error: "Session not found" });
    expect(freshTickets.size()).toBe(0);
  });

  test("未知 Host — an unregistered label under the preview namespace 404s with the displayable sentence, never main routes", () => {
    // Wildcard form: inside the claimed base, an unknown label dies at the
    // resolution seam with the exact sentence…
    const wildcard = originWith({ previewOriginTemplate: TEMPLATE });
    const strangerHost = new Request(
      "https://nobody-registered-this.preview.example.com/",
    );
    expect(wildcard.handlesRequest(strangerHost)).toBe(true);
    expect(wildcard.resolvePreviewRequest(strangerHost)).toEqual({
      refuse: { status: 404, reason: UNKNOWN_HOST_REFUSAL },
    });

    // …and the dev form answers identically for an unknown path label. Since
    // fix-ocr3 it does NOT claim the request first — the dev form claims only
    // registered label paths, so install-form (app/serve.ts) /api traffic on
    // 127.0.0.1 falls back to the main site; the 404 below is the defensive
    // resolution answer for a direct resolvePreviewRequest call.
    const dev = originWith({}, { PORT: "3001" });
    const devHost = new Request("http://127.0.0.1:3001/never-registered/");
    expect(dev.handlesRequest(devHost)).toBe(false);
    expect(dev.resolvePreviewRequest(devHost)).toEqual({
      refuse: { status: 404, reason: UNKNOWN_HOST_REFUSAL },
    });
  });
});

// ── AC4-2: the concurrent-redemption race ─────────────────────────────────────

describe("并发兑换竞争: two concurrent redemptions of one ticket — exactly one winner", () => {
  test("the HTTP entry: one 302 + pass cookie, one 401, across repeated rounds", async () => {
    for (let round = 0; round < 5; round++) {
      const { origin, address, ticket } = entryCase();

      const [first, second] = await Promise.all([
        origin.handlePreviewRequest(SESSION_A, redeemRequest(address, ticket)),
        origin.handlePreviewRequest(SESSION_A, redeemRequest(address, ticket)),
      ]);
      const responses = [first, second];

      const winners = responses.filter((r) => r.status === 302);
      const losers = responses.filter((r) => r.status === 401);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);

      // Only the winner plants the pass; the loser plants nothing.
      expect(winners[0]?.headers.get("set-cookie") ?? "").toContain(
        `${PREVIEW_SESSION_COOKIE}=`,
      );
      expect(losers[0]?.headers.get("set-cookie")).toBeNull();
    }
  });

  test("the primitive: one {userId}, one {reason:'unknown'} — the take is atomic", async () => {
    const clock = fakeClock();
    const { store } = fakeStore();
    const tickets = createPreviewTickets({ store, now: clock.now });
    const host = "127.0.0.1:3001";
    const { ticket } = tickets.issuePreviewTicket({
      sessionId: SESSION_A,
      userId: USER_ID,
      previewHost: host,
    });

    const [first, second] = await Promise.all([
      tickets.redeemPreviewTicket({ ticket, sessionId: SESSION_A, previewHost: host }),
      tickets.redeemPreviewTicket({ ticket, sessionId: SESSION_A, previewHost: host }),
    ]);
    const outcomes = [first, second].map((outcome) =>
      "userId" in outcome ? "redeemed" : outcome.reason,
    );
    expect(outcomes).toContain("redeemed");
    expect(outcomes).toContain("unknown");
    expect(outcomes).toHaveLength(2);
  });
});

// ── AC4-3: closed admission — the reason on every preview route ───────────────

describe("准入关闭: a closed origin answers its displayable reason on EVERY preview route", () => {
  type Closure = {
    name: string;
    /** The OPEN twin's overrides (mints the address + ticket). */
    open: OriginOverrides;
    /** The OPEN twin's env — a VALID port when the closure is a port conflict. */
    openEnv?: Record<string, string | undefined>;
    /** What the CLOSED twin adds on top of the open overrides. */
    closed: OriginOverrides;
    /** The CLOSED twin's env. */
    env?: Record<string, string | undefined>;
    reasonPart: string;
  };

  const closures: Closure[] = [
    {
      name: "craft disabled",
      open: { previewOriginTemplate: TEMPLATE },
      closed: { enabled: false },
      reasonPart: "Craft is disabled",
    },
    {
      name: "webapp proxy disabled",
      open: { previewOriginTemplate: TEMPLATE },
      closed: { webappProxyEnabled: false },
      reasonPart: "disabled on this deployment",
    },
    {
      name: "preview origin disabled",
      open: { previewOriginTemplate: TEMPLATE },
      closed: { previewOriginEnabled: false },
      reasonPart: "OPENBOT_CRAFT_PREVIEW_ORIGIN_ENABLED",
    },
    {
      name: "malformed template",
      open: { previewOriginTemplate: TEMPLATE },
      closed: { previewOriginTemplate: "not a url" },
      reasonPart: "OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE",
    },
    {
      name: "PORT/SERVER_PORT disagree",
      open: {},
      openEnv: { PORT: "3001" },
      closed: {},
      env: { PORT: "3001", SERVER_PORT: "3002" },
      reasonPart: "SERVER_PORT",
    },
  ];

  test.each(closures)(
    "$name: 503 with the reason on resolution + the redemption leg; no address exists; the ticket survives the gate",
    async ({ open, openEnv = {}, closed, env = {}, reasonPart }) => {
      const clock = fakeClock();
      const { store } = fakeStore();
      const tickets = createPreviewTickets({ store, now: clock.now });

      // The OPEN twin mints the address and a ticket bound to it — the state a
      // person holds when the origin closes under them.
      const openOrigin = originWith(
        { previewOriginTemplate: "", ...open },
        openEnv,
        tickets,
      );
      const address = openOrigin.originFor(SESSION_A);
      const { ticket } = tickets.issuePreviewTicket({
        sessionId: SESSION_A,
        userId: USER_ID,
        previewHost: new URL(address).host,
      });

      // The CLOSED twin shares ONLY the ticket table — one origin closing.
      const closedOrigin = originWith(
        { previewOriginTemplate: "", ...open, ...closed },
        env,
        tickets,
      );

      // The gate's reason is displayable and names its cause.
      const admission = closedOrigin.admission();
      expect(admission.ok).toBe(false);
      const reason = admission.ok ? "" : admission.reason;
      expect(reason).toContain(reasonPart);

      // Host resolution: 503 + the same reason — never a silent fallback.
      const resolution = closedOrigin.resolvePreviewRequest(
        new Request(`${address}/`),
      );
      expect(resolution).toEqual({ refuse: { status: 503, reason } });

      // No address exists to route around the gate: originFor throws.
      expect(() => closedOrigin.originFor(SESSION_A)).toThrow(/closed/);

      // The redemption leg: 503 with the reason, and the ticket is NOT
      // consumed — the gate refuses before the burn. The open twin proves it
      // by redeeming the same ticket afterwards.
      const redemption = await closedOrigin.handlePreviewRequest(
        SESSION_A,
        redeemRequest(address, ticket),
      );
      expect(redemption.status).toBe(503);
      expect(await redemption.json()).toEqual({ error: reason });
      expect(tickets.size()).toBe(1);

      const stillValid = await openOrigin.handlePreviewRequest(
        SESSION_A,
        redeemRequest(address, ticket),
      );
      expect(stillValid.status).toBe(302);
    },
  );

  test.each(closures)(
    "$name: the traffic leg is 503 with the reason too — a planted pass opens nothing while closed",
    async ({ open, openEnv = {}, closed, env = {} }) => {
      const { store } = fakeStore();
      const tickets = createPreviewTickets({ store });
      const openOrigin = originWith(
        { previewOriginTemplate: "", ...open },
        openEnv,
        tickets,
      );
      const address = openOrigin.originFor(SESSION_A);
      const closedOrigin = originWith(
        { previewOriginTemplate: "", ...open, ...closed },
        env,
        tickets,
      );

      const response = await closedOrigin.handlePreviewRequest(
        SESSION_A,
        new Request(`${address}/`, {
          headers: { cookie: `${PREVIEW_SESSION_COOKIE}=${SESSION_A}` },
        }),
      );
      const admission = closedOrigin.admission();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: admission.ok ? expect.anything() : admission.reason,
      });
    },
  );

  test("the minting leg refuses into a closed origin: 503 with the reason, nothing minted (real origin wired in)", async () => {
    const { store } = fakeStore();
    const tickets = createPreviewTickets({ store });
    const closedOrigin = originWith(
      { previewOriginEnabled: false },
      { PORT: "3001" },
      tickets,
    );

    const app = createWebappProxyRoutes(signedInAs(USER_ID), {
      config: loadCraftConfig({}),
      store,
      gateway: gatewayWith(recordingFileApi().api),
      botIdFor: async () => "craft-bot",
      sandboxConnectionFor: () => ({
        baseUrl: "http://sbox.internal:4300",
        token: null,
      }),
      previewTickets: tickets,
      previewOriginFor: (sessionId) => closedOrigin.originFor(sessionId),
      previewOriginAdmission: () => closedOrigin.admission(),
    });

    const response = await app.request(`/sessions/${SESSION_A}/preview-ticket`, {
      method: "POST",
    });
    expect(response.status).toBe(503);
    const admission = closedOrigin.admission();
    expect(await response.json()).toEqual({
      error: admission.ok ? expect.anything() : admission.reason,
    });
    // Nothing minted into the closed origin.
    expect(tickets.size()).toBe(0);

    // Control: the same wiring with an OPEN origin mints, and the minted
    // ticket redeems on that very origin — one table, one gate.
    const openTickets = createPreviewTickets({ store });
    const openOrigin = originWith({}, { PORT: "3001" }, openTickets);
    const openApp = createWebappProxyRoutes(signedInAs(USER_ID), {
      config: loadCraftConfig({}),
      store,
      gateway: gatewayWith(recordingFileApi().api),
      botIdFor: async () => "craft-bot",
      sandboxConnectionFor: () => ({
        baseUrl: "http://sbox.internal:4300",
        token: null,
      }),
      previewTickets: openTickets,
      previewOriginFor: (sessionId) => openOrigin.originFor(sessionId),
      previewOriginAdmission: () => openOrigin.admission(),
    });
    const minted = await openApp.request(
      `/sessions/${SESSION_A}/preview-ticket`,
      { method: "POST" },
    );
    expect(minted.status).toBe(200);
    const { ticket, origin } = (await minted.json()) as {
      ticket: string;
      origin: string;
    };
    expect(origin).toBe(openOrigin.originFor(SESSION_A));
    const redeemed = await openOrigin.handlePreviewRequest(
      SESSION_A,
      redeemRequest(origin, ticket),
    );
    expect(redeemed.status).toBe(302);
  });
});

// ── AC4-4: the attach model — a down upstream is 503, never a second process ──

describe("附着模型: upstream dev server absent → the established 503, no spawn side effect", () => {
  test("the preview proxy: probe fails → 503 'not running', ONE dial (the probe), no bootstrap script written", async () => {
    const { writes, api } = recordingFileApi();
    const dials: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      dials.push(String(input));
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    const serve = createPreviewProxy({
      config: loadCraftConfig({}),
      store: {
        async findSessionById(sessionId: string) {
          return sessionRow(sessionId, 3011);
        },
      } as unknown as CraftStore,
      botIdFor: async () => "craft-bot",
      sandboxConnectionFor: () => ({
        baseUrl: "http://sbox.internal:4300",
        token: null,
      }),
      fetchImpl,
    });

    const response = await serve({
      sessionId: SESSION_A,
      request: new Request(`http://127.0.0.1:3001/label/`, {
        headers: { cookie: `${PREVIEW_SESSION_COOKIE}=${SESSION_A}` },
      }),
      appPath: "/label/",
      query: "",
    });

    // The established 503 semantics, displayable in the JSON shape.
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: expect.stringContaining("not running"),
    });

    // Attach, never spawn — the observable contract:
    // exactly ONE dial (the attach probe), no upstream forward, no retry;
    expect(dials).toEqual(["http://sbox.internal:3011/"]);
    // and the spawn channel is untouched: no start-webapp.sh bootstrap ever
    // written for a second process to run.
    expect(writes).toEqual([]);
    void api;
  });

  test("the preview proxy, iframe-shaped: the same 503 as a readable HTML page", async () => {
    const { writes } = recordingFileApi();
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const serve = createPreviewProxy({
      config: loadCraftConfig({}),
      store: {
        async findSessionById(sessionId: string) {
          return sessionRow(sessionId, 3011);
        },
      } as unknown as CraftStore,
      botIdFor: async () => "craft-bot",
      sandboxConnectionFor: () => ({
        baseUrl: "http://sbox.internal:4300",
        token: null,
      }),
      fetchImpl,
    });

    const framed = await serve({
      sessionId: SESSION_A,
      request: new Request(`http://127.0.0.1:3001/label/`, {
        headers: {
          accept: "text/html,application/xhtml+xml",
          cookie: `${PREVIEW_SESSION_COOKIE}=${SESSION_A}`,
        },
      }),
      appPath: "/label/",
      query: "",
    });
    expect(framed.status).toBe(503);
    expect(framed.headers.get("content-type")).toContain("text/html");
    const page = await framed.text();
    expect(page).toContain("<!");
    expect(page).toContain("not running");
    // No pass value, no spawn channel writes.
    expect(page).not.toContain(SESSION_A);
    expect(writes).toEqual([]);
  });

  test("the same-origin webapp route: down upstream → 503 'not running', one probe dial, no bootstrap write", async () => {
    const { writes, api } = recordingFileApi();
    const dials: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) => {
      dials.push(String(input));
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    try {
      const store = {
        async getSession(sessionId: string, userId: string) {
          return sessionId === SESSION_A && userId === USER_ID
            ? sessionRow(sessionId, 3011)
            : undefined;
        },
      } as unknown as CraftStore;
      const app = createWebappProxyRoutes(signedInAs(USER_ID), {
        config: loadCraftConfig({}),
        store,
        gateway: gatewayWith(api),
        botIdFor: async () => "craft-bot",
        sandboxConnectionFor: () => ({
          baseUrl: "http://sbox.internal:4300",
          token: null,
        }),
      });
      // The session row must exist for the actor and carry the reserved port,
      // so the request reaches the attach probe (not the no-support refusal).
      const response = await app.request(
        `/sessions/${SESSION_A}/webapp/index.html`,
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: expect.stringContaining("not running"),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    // The probe dialed the sandbox host's reserved port — once. No upstream
    // forward, no fallback dial, no bootstrap script written.
    expect(dials).toEqual(["http://sbox.internal:3011/"]);
    expect(writes).toEqual([]);
  });
});
