// #365/#366 — the real-socket acceptance harness (craft-preview-origin remediation
// plan T3, item 1; absorbed from the audit-era /tmp harness, adapted to the
// signed-pass implementation the #358 repair shipped).
//
// WHY a second suite beside craft-preview-rejection.test.ts: that suite drives
// hono's `app.request`, which serializes neither a real listener's wire
// behavior nor a browser's redemption hop — the Set-Cookie on a 302, header
// casing on the upstream dial, the URL form the fetch actually presents. This
// file boots REAL Bun.serve listeners (preview dispatcher + fake dev server)
// and drives plain fetch() over sockets, pinning the end-to-end refusal and
// pass semantics on the wire an iframe actually rides:
//
//   AC4  redeem → 302 + the literal cookie attribute string (D9: session-level
//        HttpOnly None; Secure, Path=/<label>), replay/expiry/deletion/foreign-
//        host refusals, the ticket value echoing nowhere, and the atomic take.
//   AC3  session B's redeemed pass cannot open session A's preview over the
//        same shared dev host.
//   AC2  the four verbs reach the real upstream with the label mount intact
//        (F-2), no platform identity rides along, and the CSP lands on the
//        proxied response.
//   M-2  a restarted origin no longer claims the old label — the request falls
//        to the main-site routes.
//
// Steppable fake clock: expiry is tested by advancing it, never by sleeping.

import {
  afterAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import {
  createPreviewOrigin,
  PREVIEW_PASS_REFUSAL,
} from "../src/craft/preview-origin";
import { PREVIEW_PASS_COOKIE_SHAPE } from "../src/craft/preview-pass";
import {
  createPreviewTickets,
  PREVIEW_SESSION_COOKIE,
  PREVIEW_TICKET_TTL_MS,
} from "../src/craft/preview-ticket";
import type { CraftStore } from "../src/craft/store";
import { proxyWebappRequest } from "../src/craft/webapp-proxy";

const PORT = 39711; // the preview listener
const UP_PORT = 39712; // the fake dev server
const RESTART_PORT = 39713; // the M-2 restart listener
const SECRET = "socket-suite-deployment-secret";
const TICKET_REFUSAL =
  "The preview ticket is invalid, expired, or already used.";

// ── the deployment seams, faked at the same joints production wires ──────────

let clockMs = 1_700_000_000_000;
const now = () => new Date(clockMs);

/** sessionId → owner (null = the row is gone); the store reads it live. */
const owners = new Map<string, string | null>([
  ["sess-A", "user-A"],
  ["sess-B", "user-B"],
  ["sess-Gone", "user-A"],
]);

const store = {
  async findSession(sessionId: string, userId: string) {
    return owners.get(sessionId) === userId
      ? { id: sessionId, userId }
      : undefined;
  },
} as unknown as CraftStore;

const tickets = createPreviewTickets({ store, now });

/** What the fake dev server saw — method, path+query, and the headers it got. */
const upstreamSeen: { method: string; url: string; headers: Headers }[] = [];

const upstreamServer = Bun.serve({
  hostname: "127.0.0.1",
  port: UP_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    upstreamSeen.push({
      method: req.method,
      url: `${url.pathname}${url.search}`,
      headers: req.headers,
    });
    const body = req.body ? await req.text() : null;
    return Response.json({
      ok: true,
      path: url.pathname,
      method: req.method,
      body,
    });
  },
});

/**
 * The production serving shape: proxyWebappRequest against the session's dev
 * server (attach model — this suite's upstream only ever ANSWERS; nothing
 * spawns anything).
 */
const servePreview = async (input: {
  request: Request;
  appPath: string;
  query: string;
}) => {
  const r = await proxyWebappRequest({
    upstreamBaseUrl: `http://127.0.0.1:${UP_PORT}`,
    path: input.appPath,
    query: input.query,
    method: input.request.method,
    requestHeaders: input.request.headers,
    body:
      input.request.method === "GET" || input.request.method === "HEAD"
        ? undefined
        : await input.request.clone().text(),
  });
  return new Response(r.body, { status: r.status, headers: r.headers });
};

const origin = createPreviewOrigin({
  config: {
    enabled: true,
    webappProxyEnabled: true,
    previewOriginEnabled: true,
    previewOriginTemplate: "",
  },
  previewTickets: tickets,
  secret: SECRET,
  env: { PORT: String(PORT), SERVER_PORT: String(PORT) },
  servePreview: async ({ request, appPath, query }) =>
    servePreview({ request, appPath, query }),
});

/** The boot file's dispatcher shape: claimed requests NEVER fall through. */
const dispatch = async (req: Request, o: typeof origin): Promise<Response> => {
  if (o.handlesRequest(req)) {
    const resolved = o.resolvePreviewRequest(req);
    if ("refuse" in resolved) {
      return Response.json(
        { error: resolved.refuse.reason },
        {
          status: resolved.refuse.status,
        },
      );
    }
    return o.handlePreviewRequest(resolved.sessionId, req);
  }
  // The main-site stand-in: platform routes demand the platform cookie
  // (absent on this listener → 401); everything else is "main".
  if (new URL(req.url).pathname.startsWith("/api/craft/sessions")) {
    return Response.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }
  return new Response("main", { status: 200 });
};

const previewServer = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch: (req) => dispatch(req, origin),
});

const base = `http://127.0.0.1:${PORT}`;
const addressA = origin.originFor("sess-A"); // registers A's label
const addressB = origin.originFor("sess-B"); // registers B's label
const labelA = new URL(addressA).pathname.slice(1);

afterAll(() => {
  previewServer.stop(true);
  upstreamServer.stop(true);
});

/** Mint a ticket bound to (sessionId, its own preview host). */
const issue = (sessionId: string, userId: string) =>
  tickets.issuePreviewTicket({
    sessionId,
    userId,
    previewHost: new URL(sessionId === "sess-A" ? addressA : addressB).host,
  });

/** The hop a browser makes: the entry root with the ticket on the query. */
const redeem = (address: string, ticket: string) =>
  fetch(`${address}?ticket=${encodeURIComponent(ticket)}`, {
    redirect: "manual",
  });

/** The pass value out of a redemption's Set-Cookie — what a browser would store. */
const passFrom = (setCookie: string): string => {
  const first = setCookie.split(";")[0] ?? "";
  expect(first.startsWith(`${PREVIEW_SESSION_COOKIE}=`)).toBe(true);
  return first.slice(PREVIEW_SESSION_COOKIE.length + 1);
};

/** Redeem A for real and hand back the cookie header a browser would carry. */
const passCookieForA = async (): Promise<string> => {
  const { ticket } = issue("sess-A", "user-A");
  const red = await redeem(addressA, ticket);
  expect(red.status).toBe(302);
  const cookie = red.headers.get("set-cookie")?.split(";")[0] ?? "";
  return cookie;
};

// ── AC4: the redemption hop on the wire ───────────────────────────────────────

describe("AC4 兑换（real socket）: 302 + the literal cookie string, the ticket echoing nowhere", () => {
  test("redeem → 302 to the clean path; Set-Cookie carries the D9 attribute string verbatim; the pass is a SIGNED value, not the session id", async () => {
    const { ticket } = issue("sess-A", "user-A");
    const red = await redeem(addressA, ticket);
    expect(red.status).toBe(302);
    expect(red.headers.get("location")).toBe(`/${labelA}`);

    const setCookie = red.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=None");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain(`Path=/${labelA}`);
    expect(setCookie).not.toMatch(/Max-Age/i);
    expect(setCookie).not.toMatch(/Expires/i);

    const pass = passFrom(setCookie);
    expect(pass).not.toBe("sess-A"); // #358 repair: the forgeable echo is gone
    expect(pass).toMatch(PREVIEW_PASS_COOKIE_SHAPE);
  });

  test("the ticket value appears in no header of the redemption response", async () => {
    const { ticket } = issue("sess-A", "user-A");
    const red = await redeem(addressA, ticket);
    expect(JSON.stringify([...red.headers])).not.toContain(ticket);
    expect(red.headers.get("location")).not.toContain("ticket");
  });

  test("replayed on a fresh client → 401 with the displayable reason; no ticket echo", async () => {
    const { ticket } = issue("sess-A", "user-A");
    await redeem(addressA, ticket); // the first hop consumes it
    const replay = await redeem(addressA, ticket);
    expect(replay.status).toBe(401);
    const body = (await replay.json()) as { error: string };
    expect(body.error).toBe(TICKET_REFUSAL);
    expect(body.error).not.toContain(ticket);
  });

  test("a browser-shaped replay gets the readable page, not bare JSON (fix-ocr28 #6)", async () => {
    const { ticket } = issue("sess-A", "user-A");
    await redeem(addressA, ticket);
    const replay = await fetch(
      `${addressA}?ticket=${encodeURIComponent(ticket)}`,
      {
        redirect: "manual",
        headers: { accept: "text/html" },
      },
    );
    expect(replay.status).toBe(401);
    expect(replay.headers.get("content-type")).toContain("text/html");
    const page = await replay.text();
    expect(page).toContain("The preview ticket is invalid");
    expect(page).not.toContain(ticket);
  });

  test("clock advanced past the 30s window → 401 (injected clock, no sleep)", async () => {
    const { ticket } = issue("sess-A", "user-A");
    clockMs += PREVIEW_TICKET_TTL_MS + 1_000;
    const expired = await redeem(addressA, ticket);
    expect(expired.status).toBe(401);
    expect(((await expired.json()) as { error: string }).error).toBe(
      TICKET_REFUSAL,
    );
  });

  test("session deleted after issue → the store re-check refuses the redeem", async () => {
    owners.set("sess-Gone", null);
    const { ticket } = issue("sess-Gone", "user-A");
    const addressGone = origin.originFor("sess-Gone");
    const gone = await redeem(addressGone, ticket);
    expect(gone.status).toBe(401);
    expect(((await gone.json()) as { error: string }).error).toBe(
      TICKET_REFUSAL,
    );
  });

  test("A's ticket presented on B's address → 401 (the attempt burns it); B's own ticket still redeems", async () => {
    const { ticket } = issue("sess-A", "user-A");
    const wrongHost = await redeem(addressB, ticket);
    expect(wrongHost.status).toBe(401);

    const own = issue("sess-B", "user-B");
    const control = await redeem(addressB, own.ticket);
    expect(control.status).toBe(302);
  });
});

// ── AC3/AC4: the pass gate on the wire ────────────────────────────────────────

describe("AC3/AC4 通行证门（real socket）: foreign and missing passes never reach the upstream", () => {
  test("no pass → 401 with the pass refusal, and the upstream is never dialed", async () => {
    upstreamSeen.length = 0;
    const noPass = await fetch(`${base}/${labelA}/api/probe`, {
      method: "POST",
    });
    expect(noPass.status).toBe(401);
    expect(((await noPass.json()) as { error: string }).error).toBe(
      PREVIEW_PASS_REFUSAL,
    );
    expect(upstreamSeen).toHaveLength(0);
  });

  test("B's redeemed pass cannot open A's preview; A's own pass opens A (AC3, both faces)", async () => {
    // B redeems for real → B's pass cookie, exactly as a browser holds it.
    const { ticket: ticketB } = issue("sess-B", "user-B");
    const redB = await redeem(addressB, ticketB);
    expect(redB.status).toBe(302);
    const passB = passFrom(redB.headers.get("set-cookie") ?? "");

    upstreamSeen.length = 0;
    const foreign = await fetch(`${base}/${labelA}/api/probe`, {
      method: "POST",
      headers: { cookie: `${PREVIEW_SESSION_COOKIE}=${passB}` },
    });
    expect(foreign.status).toBe(401);
    expect(((await foreign.json()) as { error: string }).error).toBe(
      PREVIEW_PASS_REFUSAL,
    );
    expect(upstreamSeen).toHaveLength(0);

    const ownCookie = await passCookieForA();
    const own = await fetch(`${base}/${labelA}/api/probe`, {
      method: "POST",
      headers: { cookie: ownCookie },
    });
    expect(own.status).toBe(200);
  });
});

// ── AC2: the proxied traffic on the wire ─────────────────────────────────────

describe("AC2 透传与卫生（real socket）: verbs, the label mount, header hygiene, CSP", () => {
  test("POST/PUT/PATCH/DELETE reach the real upstream 200; the /<label> mount is preserved (F-2); bodies arrive intact", async () => {
    const cookie = await passCookieForA();
    upstreamSeen.length = 0;
    const methods = ["POST", "PUT", "PATCH", "DELETE"] as const;
    const statuses: string[] = [];
    for (const method of methods) {
      const r = await fetch(`${base}/${labelA}/api/probe`, {
        method,
        headers: { cookie },
        body: method === "DELETE" ? undefined : `payload-${method}`,
      });
      statuses.push(`${method}:${r.status}`);
      const body = (await r.json()) as { body: string | null };
      if (method !== "DELETE") expect(body.body).toBe(`payload-${method}`);
    }
    expect(statuses.join(",")).toBe("POST:200,PUT:200,PATCH:200,DELETE:200");
    expect(upstreamSeen.map((u) => u.url)).toEqual([
      `/${labelA}/api/probe`,
      `/${labelA}/api/probe`,
      `/${labelA}/api/probe`,
      `/${labelA}/api/probe`,
    ]);
  });

  test("the upstream sees no cookie, no authorization, no origin — platform identity never rides to the app", async () => {
    const cookie = await passCookieForA();
    upstreamSeen.length = 0;
    await fetch(`${base}/${labelA}/api/probe`, {
      method: "POST",
      headers: {
        cookie,
        authorization: "Bearer platform-session",
        origin: base,
      },
    });
    expect(upstreamSeen).toHaveLength(1);
    const seen = upstreamSeen[0];
    expect(seen?.headers.get("cookie")).toBeNull();
    expect(seen?.headers.get("authorization")).toBeNull();
    expect(seen?.headers.get("origin")).toBeNull();
  });

  test("the CSP lands on proxied responses: connect-src self + ws, form-action and frame-src self (F-1)", async () => {
    const cookie = await passCookieForA();
    const r = await fetch(`${base}/${labelA}/`, { headers: { cookie } });
    expect(r.status).toBe(200);
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'self' ws: wss:");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-src 'self'");
    expect(csp).toContain("object-src 'none'");
  });
});

// ── the dev host's claim discipline + M-2 ─────────────────────────────────────

describe("dev host 分流与 M-2 重启（real socket）", () => {
  test("an unregistered first segment on the dev host falls through to the main-site routes — never 'Unknown preview host.'", async () => {
    const fall = await fetch(`${base}/api/craft/sessions`);
    expect(fall.status).toBe(401);
    const body = (await fall.json()) as { error: string };
    expect(body.error).toBe("Authentication required.");
    expect(body.error).not.toBe("Unknown preview host.");
  });

  test("after a restart (fresh origin, same secret) the old label is no longer claimed — the address falls to the main routes", async () => {
    const fresh = createPreviewOrigin({
      config: {
        enabled: true,
        webappProxyEnabled: true,
        previewOriginEnabled: true,
        previewOriginTemplate: "",
      },
      previewTickets: tickets,
      secret: SECRET,
      env: { PORT: String(RESTART_PORT), SERVER_PORT: String(RESTART_PORT) },
      servePreview: async () => new Response("x"),
    });
    expect(fresh.hasSession("sess-A")).toBe(false);
    const restartServer = Bun.serve({
      hostname: "127.0.0.1",
      port: RESTART_PORT,
      fetch: (req) => dispatch(req, fresh),
    });
    try {
      const after = await fetch(
        `${base.replace(String(PORT), String(RESTART_PORT))}/${labelA}/`,
      );
      expect(await after.text()).toBe("main"); // not 404, not proxied
    } finally {
      restartServer.stop(true);
    }
  });
});
