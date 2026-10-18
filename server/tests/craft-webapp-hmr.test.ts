import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { loadCraftConfig } from "../src/craft/config";
import {
  createPreviewOrigin,
  samePreviewOrigin,
  type ServePreview,
} from "../src/craft/preview-origin";
import {
  createPreviewTickets,
  PREVIEW_SESSION_COOKIE,
} from "../src/craft/preview-ticket";
import { createPreviewPassCodec } from "../src/craft/preview-pass";
import type { CraftSessionRow, CraftStore } from "../src/craft/store";
import {
  type PreviewWebappHmrDeps,
  resolvePreviewWebappHmrUpgrade,
  resolveWebappHmrUpgrade,
  type WebappHmrDeps,
  type WebappHmrSocketData,
  webappHmrIsAppPath,
  webappHmrQueryString,
  webappHmrSessionIdFromPath,
  webappHmrSocketHandlers,
  webappHmrUpstreamUrl,
} from "../src/craft/webapp-proxy";

const SESSION_ID = "cs-aaaabbbbcccc";
const HMR_PATH = `/api/craft/sessions/${SESSION_ID}/webapp/_next/webpack-hmr`;

function sessionRow(nextjsPort: number | null): CraftSessionRow {
  return {
    id: SESSION_ID,
    userId: "u1",
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

function hmrDeps(input: {
  ownerUserId?: string;
  nextjsPort?: number | null;
  connBaseUrl?: string | null;
  gatewayBaseUrl?: string;
}): WebappHmrDeps {
  const owner = input.ownerUserId ?? "u1";
  const port = input.nextjsPort === undefined ? 3011 : input.nextjsPort;
  return {
    config: loadCraftConfig(
      input.gatewayBaseUrl
        ? { OPENBOT_CRAFT_SANDBOX_GATEWAY_URL: input.gatewayBaseUrl }
        : {},
    ),
    store: {
      async getSession(id: string, userId: string) {
        return id === SESSION_ID && userId === owner
          ? sessionRow(port)
          : undefined;
      },
      async updateSessionActivity() {},
    } as unknown as CraftStore,
    botIdFor: async () => "craft-bot",
    sandboxConnectionFor: () =>
      input.connBaseUrl === null
        ? null
        : {
            baseUrl: input.connBaseUrl ?? "http://sbox.internal:4300",
            token: null,
          },
  };
}

/** The preview-origin twin of hmrDeps (#363): the (id,userId) row lookup the
 * preview seam reads plus the SAME verifyPass judgment the HTTP gate applies —
 * one codec instance per test file, keyed by the file's own secret. Flipping
 * `owner` simulates a reassignment AFTER the pass was issued: the signature
 * still verifies, the row lookup must not. */
const HMR_PASS_SECRET = "test-preview-hmr-secret";
const hmrPassCodec = createPreviewPassCodec(HMR_PASS_SECRET);

/** The (sessionId, request) → claim judgment the origin's verifyPass method
 * provides — the fixture's stand-in for the injected method, iterating the
 * same-named candidates exactly like the origin's gate (fix-ocr20 #3's jar
 * rule). The resolver's deps receive THE origin's method in production; this
 * is its faithful test twin, not a second implementation of the crypto. */
function testVerifyPass(
  sessionId: string,
  request: Request,
): { userId: string } | null {
  for (const part of request.headers.get("cookie")?.split(";") ?? []) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${PREVIEW_SESSION_COOKIE}=`)) {
      const verified = hmrPassCodec.verify(
        sessionId,
        trimmed.slice(PREVIEW_SESSION_COOKIE.length + 1),
      );
      if (verified !== null) return verified;
    }
  }
  return null;
}

function previewHmrDeps(
  input: {
    sessionExists?: boolean;
    ownerUserId?: string;
    nextjsPort?: number | null;
    connBaseUrl?: string | null;
    gatewayBaseUrl?: string;
  } = {},
): PreviewWebappHmrDeps {
  const port = input.nextjsPort === undefined ? 3011 : input.nextjsPort;
  const owner = input.ownerUserId ?? "u1";
  return {
    config: loadCraftConfig(
      input.gatewayBaseUrl
        ? { OPENBOT_CRAFT_SANDBOX_GATEWAY_URL: input.gatewayBaseUrl }
        : {},
    ),
    store: {
      async findSession(id: string, userId: string) {
        return id === SESSION_ID && userId === owner && input.sessionExists !== false
          ? sessionRow(port)
          : undefined;
      },
    } as unknown as CraftStore,
    botIdFor: async () => "craft-bot",
    sandboxConnectionFor: () =>
      input.connBaseUrl === null
        ? null
        : {
            baseUrl: input.connBaseUrl ?? "http://sbox.internal:4300",
            token: null,
          },
    verifyPass: testVerifyPass,
  };
}

/** An upgrade request the way a browser sends it to the preview origin —
 * carrying the preview pass value the redemption hop planted. */
function previewHmrRequest(url: string, passValue?: string) {
  return new Request(url, {
    headers:
      passValue === undefined
        ? {}
        : { cookie: `${PREVIEW_SESSION_COOKIE}=${passValue}` },
  });
}

describe("webappHmrSessionIdFromPath", () => {
  test("matches only the HMR endpoint under the session's webapp prefix", () => {
    expect(webappHmrSessionIdFromPath(HMR_PATH)).toBe(SESSION_ID);
    expect(
      webappHmrSessionIdFromPath(`/api/craft/sessions/${SESSION_ID}/webapp`),
    ).toBeNull();
    expect(
      webappHmrSessionIdFromPath(
        `/api/craft/sessions/${SESSION_ID}/webapp/_next/static/chunk.js`,
      ),
    ).toBeNull();
    expect(
      webappHmrSessionIdFromPath(`/api/craft/sessions/${SESSION_ID}/events`),
    ).toBeNull();
  });
});

describe("webappHmrQueryString / webappHmrUpstreamUrl (onyx _webapp_hmr_*)", () => {
  test("keeps only the id entries — every other query key is dropped", () => {
    // onyx parse_qsl(keep_blank_values=True) + key == "id" filter.
    expect(webappHmrQueryString("?id=abc&foo=1&bar=&id=def")).toBe(
      "?id=abc&id=def",
    );
    expect(webappHmrQueryString("?foo=1")).toBe("");
    expect(webappHmrQueryString("")).toBe("");
  });

  test("the upstream path carries the scaffold's basePath — Next serves HMR under it, not at the port root", () => {
    // The scaffold sets basePath to this route's own mount (web-template/
    // next.config.ts), and a Next dev server with a basePath serves
    // /_next/webpack-hmr UNDER it. Dialing the port root connects to nothing:
    // measured live against a running session, `ws://127.0.0.1:3012/_next/
    // webpack-hmr` timed out with 0 frames while the basePath-joined URL opened
    // and streamed. Turbopack's dev client gates its chunk loading on that
    // socket, so the preview never hydrated — 17 scripts and then silence for
    // 90s, where the same page loaded direct from the dev server pulls 187 and
    // hydrates. The HTML was byte-identical either way, which is what made this
    // invisible from the response side.
    expect(
      webappHmrUpstreamUrl({
        host: "sbox.internal",
        port: 3011,
        path: HMR_PATH,
        query: "?id=x&z=1",
      }),
    ).toBe(`ws://sbox.internal:3011${HMR_PATH}?id=x`);
  });

  test("the template's basePath is env-driven only — the cwd sniff and root redirect stay retired (F-2/#365)", async () => {
    // Pinned against the shipped scaffold rather than restated in a comment.
    // #365 restores ONE half of what #364 retired: an EXPLICIT env basePath
    // (ONYX_WEBAPP_BASE_PATH) the session's start script injects for the dev
    // form's /<label> mount, mirrored into basePath/assetPrefix and handed to
    // client code through the NEXT_PUBLIC_BASE_PATH env field. The other half
    // stays retired: no resolveWebappBasePath cwd sniff, no root → prefix
    // redirects — a path shape no controlled start side asked for. Without the
    // env half, the dev form's asset URLs resolve at the preview origin's root
    // (404 — the app never hydrates); with a resurrected cwd half, any dev
    // server anywhere guesses a mount. allowedDevOrigins stays the survival
    // this socket depends on: the relay dials the sandbox host, so the dev
    // origin it presents must stay allowed or Next 16 blocks
    // /_next/webpack-hmr cross-origin and live reload dies silently.
    const source = await readFile(
      new URL("../assets/craft/web-template/next.config.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("ONYX_WEBAPP_BASE_PATH");
    expect(source).toContain("basePath");
    expect(source).toContain("assetPrefix");
    expect(source).toContain("NEXT_PUBLIC_BASE_PATH");
    expect(source).not.toContain("resolveWebappBasePath");
    expect(source).not.toContain("redirects");
    expect(source).not.toContain("process.cwd()");
    expect(source).toContain("allowedDevOrigins");
  });
});

describe("resolveWebappHmrUpgrade — the hand-applied webapp-proxy auth", () => {
  test("an unauthenticated upgrade is refused 401 before any session lookup", async () => {
    const decision = await resolveWebappHmrUpgrade(hmrDeps({}), {
      sessionId: SESSION_ID,
      actor: null,
      path: HMR_PATH,
      query: "",
    });
    expect(decision).toMatchObject({ ok: false, status: 401 });
  });

  test("another user's session is refused 404 — the HTTP proxy's indistinct absence", async () => {
    const decision = await resolveWebappHmrUpgrade(
      hmrDeps({ ownerUserId: "somebody-else" }),
      { sessionId: SESSION_ID, actor: { id: "u1" }, path: HMR_PATH, query: "" },
    );
    expect(decision).toMatchObject({ ok: false, status: 404 });

    const unknown = await resolveWebappHmrUpgrade(hmrDeps({}), {
      sessionId: "never-heard-of",
      actor: { id: "u1" },
      path: HMR_PATH,
      query: "",
    });
    expect(unknown).toMatchObject({ ok: false, status: 404 });
  });

  test("no sandbox connection is 503, and so is a session without a reserved port", async () => {
    const noConn = await resolveWebappHmrUpgrade(
      hmrDeps({ connBaseUrl: null }),
      {
        sessionId: SESSION_ID,
        actor: { id: "u1" },
        path: HMR_PATH,
        query: "",
      },
    );
    expect(noConn).toMatchObject({ ok: false, status: 503 });

    const noPort = await resolveWebappHmrUpgrade(
      hmrDeps({ nextjsPort: null }),
      {
        sessionId: SESSION_ID,
        actor: { id: "u1" },
        path: HMR_PATH,
        query: "",
      },
    );
    expect(noPort).toMatchObject({ ok: false, status: 503 });
  });

  test("the owner's upgrade resolves the sandbox host + reserved port with the id-only query", async () => {
    const decision = await resolveWebappHmrUpgrade(hmrDeps({}), {
      sessionId: SESSION_ID,
      actor: { id: "u1" },
      path: HMR_PATH,
      query: "?id=hmr-1&unrelated=drop",
    });
    expect(decision).toEqual({
      ok: true,
      upstreamUrl: `ws://sbox.internal:3011${HMR_PATH}?id=hmr-1`,
    });
  });

  test("the config gateway URL wins over the connection baseUrl (F-E parity)", async () => {
    const decision = await resolveWebappHmrUpgrade(
      hmrDeps({ gatewayBaseUrl: "http://gateway.host:4300" }),
      { sessionId: SESSION_ID, actor: { id: "u1" }, path: HMR_PATH, query: "" },
    );
    expect(decision).toEqual({
      ok: true,
      upstreamUrl: `ws://gateway.host:3011${HMR_PATH}`,
    });
  });
});

// ── #363: the HMR upgrade on the preview origin ──────────────────────────────
//
// Host routing moved the session's identity out of the path and into the Host
// (or the dev form's leading label), and moved the auth off the platform session
// onto the preview pass the redemption hop planted. These tests pin that gate.

describe("webappHmrIsAppPath — the HMR endpoint as the app itself sees it (#363)", () => {
  test("matches the HMR endpoint at root and under one mount label, and only it", () => {
    // The host form's app lives at the origin root; the dev form's app lives
    // under its /<label> basePath mount (F-2/#365) — the appPath the origin
    // derives is the upstream-resolvable path either way.
    expect(webappHmrIsAppPath("/_next/webpack-hmr")).toBe(true);
    expect(webappHmrIsAppPath("/abc123label/_next/webpack-hmr")).toBe(true);
    // The same-origin mount — the OTHER dispatcher's shape, session id and all.
    expect(webappHmrIsAppPath(HMR_PATH)).toBe(false);
    expect(webappHmrIsAppPath("/_next/webpack-hmr/extra")).toBe(false);
    expect(webappHmrIsAppPath("/label/_next/webpack-hmr/extra")).toBe(false);
    expect(webappHmrIsAppPath("/label/deep/_next/webpack-hmr")).toBe(false);
    expect(webappHmrIsAppPath("/_next/static/chunk.js")).toBe(false);
    expect(webappHmrIsAppPath("/")).toBe(false);
  });
});

describe("resolvePreviewWebappHmrUpgrade — the preview origin's upgrade gate (#363)", () => {
  const APP_HMR = "/_next/webpack-hmr";
  const PASS_SENTENCE =
    "Open this preview from its craft session — its preview pass is missing or no longer valid.";

  test("dev form: the pass opens the session's upgrade; the label rides to the upstream mount", async () => {
    // F-2/#365: the dev server is basePath-mounted at /<label>, so the HMR
    // socket must dial the label-ful path — the appPath the origin derives
    // (no strip) forwarded verbatim, same as the HTTP seam.
    const LABEL = "/some-label";
    const decision = await resolvePreviewWebappHmrUpgrade(previewHmrDeps({}), {
      sessionId: SESSION_ID,
      request: previewHmrRequest(
        `http://127.0.0.1:3001${LABEL}${APP_HMR}?id=hmr-1&junk=drop`,
        hmrPassCodec.issue(SESSION_ID, "u1"),
      ),
      path: `${LABEL}${APP_HMR}`,
      query: "?id=hmr-1&junk=drop",
    });
    expect(decision).toEqual({
      ok: true,
      upstreamUrl: `ws://sbox.internal:3011${LABEL}${APP_HMR}?id=hmr-1`,
    });
  });

  test("host form: the pathname rides verbatim (the app lives at the origin root)", async () => {
    const decision = await resolvePreviewWebappHmrUpgrade(previewHmrDeps({}), {
      sessionId: SESSION_ID,
      request: previewHmrRequest(
        `https://abc123.preview.example.com${APP_HMR}`,
        hmrPassCodec.issue(SESSION_ID, "u1"),
      ),
      path: APP_HMR,
      query: "",
    });
    expect(decision).toEqual({
      ok: true,
      upstreamUrl: `ws://sbox.internal:3011${APP_HMR}`,
    });
  });

  test("#358 repair: a pass signed by the deps' own codec opens the upgrade", async () => {
    const decision = await resolvePreviewWebappHmrUpgrade(previewHmrDeps({}), {
      sessionId: SESSION_ID,
      request: previewHmrRequest(
        `https://abc123.preview.example.com${APP_HMR}`,
        hmrPassCodec.issue(SESSION_ID, "u1"),
      ),
      path: APP_HMR,
      query: "",
    });
    expect(decision).toEqual({
      ok: true,
      upstreamUrl: `ws://sbox.internal:3011${APP_HMR}`,
    });
  });

  test("#358 repair Review Focus 1: a forged plaintext session-id cookie is 401 — the upgrade never commits", async () => {
    // Pre-repair this cookie WAS the credential (value-equality with the id);
    // now it is an unsigned forgery. The store must not even be consulted:
    // a 401 at the pass gate, before any row lookup.
    let storeConsults = 0;
    const deps = previewHmrDeps({});
    const consultingStore = {
      ...deps,
      store: {
        async findSession() {
          storeConsults += 1;
          return undefined;
        },
      },
    } as unknown as typeof deps;
    const decision = await resolvePreviewWebappHmrUpgrade(consultingStore, {
      sessionId: SESSION_ID,
      request: previewHmrRequest(
        `https://abc123.preview.example.com${APP_HMR}`,
        SESSION_ID, // the forgery: the bare session id, unsigned
      ),
      path: APP_HMR,
      query: "",
    });
    expect(decision).toMatchObject({ ok: false, status: 401 });
    expect(storeConsults).toBe(0);
  });

  test("#358 repair Review Focus 2: a one-byte MAC flip is 401 on the upgrade too", async () => {
    const pass = hmrPassCodec.issue(SESSION_ID, "u1");
    const parts = pass.split(".");
    const mac = parts[2] ?? "";
    const flipped = `${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`;
    const decision = await resolvePreviewWebappHmrUpgrade(previewHmrDeps({}), {
      sessionId: SESSION_ID,
      request: previewHmrRequest(
        `https://abc123.preview.example.com${APP_HMR}`,
        `${parts[0]}.${parts[1]}.${flipped}`,
      ),
      path: APP_HMR,
      query: "",
    });
    expect(decision).toMatchObject({ ok: false, status: 401 });
  });

  test("#358 repair Review Focus 3: a valid pass for a session reassigned after issue is the row miss — 404", async () => {
    const decision = await resolvePreviewWebappHmrUpgrade(
      previewHmrDeps({ ownerUserId: "u2" }),
      {
        sessionId: SESSION_ID,
        request: previewHmrRequest(
          `https://abc123.preview.example.com${APP_HMR}`,
          hmrPassCodec.issue(SESSION_ID, "u1"),
        ),
        path: APP_HMR,
        query: "",
      },
    );
    expect(decision).toMatchObject({
      ok: false,
      status: 404,
      error: "This preview session no longer exists.",
    });
  });

  test("no pass → 401 with the HTTP gate's own sentence", async () => {
    const decision = await resolvePreviewWebappHmrUpgrade(previewHmrDeps({}), {
      sessionId: SESSION_ID,
      request: previewHmrRequest(`http://127.0.0.1:3001/x${APP_HMR}`),
      path: APP_HMR,
      query: "",
    });
    expect(decision).toMatchObject({ ok: false, status: 401 });
    if (!decision.ok) expect(decision.error).toBe(PASS_SENTENCE);
  });

  test("another session's pass does not open this host's upgrade", async () => {
    const decision = await resolvePreviewWebappHmrUpgrade(previewHmrDeps({}), {
      sessionId: SESSION_ID,
      request: previewHmrRequest(
        `https://abc123.preview.example.com${APP_HMR}`,
        hmrPassCodec.issue("cs-somebody-else", "u1"),
      ),
      path: APP_HMR,
      query: "",
    });
    expect(decision).toMatchObject({ ok: false, status: 401 });
  });

  test("a ticket in the upgrade query is not a credential — and never an echo", async () => {
    const decision = await resolvePreviewWebappHmrUpgrade(previewHmrDeps({}), {
      sessionId: SESSION_ID,
      request: previewHmrRequest(
        `https://abc123.preview.example.com${APP_HMR}?ticket=super-secret-ticket`,
      ),
      path: APP_HMR,
      query: "?ticket=super-secret-ticket",
    });
    expect(decision).toMatchObject({ ok: false, status: 401 });
    if (!decision.ok) {
      expect(decision.error).not.toContain("super-secret-ticket");
    }
  });

  test("a restart-deleted session is the HTTP seam's own 404", async () => {
    const decision = await resolvePreviewWebappHmrUpgrade(
      previewHmrDeps({ sessionExists: false }),
      {
        sessionId: SESSION_ID,
        request: previewHmrRequest(
          `https://abc123.preview.example.com${APP_HMR}`,
          hmrPassCodec.issue(SESSION_ID, "u1"),
        ),
        path: APP_HMR,
        query: "",
      },
    );
    expect(decision).toMatchObject({
      ok: false,
      status: 404,
      error: "This preview session no longer exists.",
    });
  });

  test("no sandbox connection is 503, and so is a session without a reserved port", async () => {
    const noConn = await resolvePreviewWebappHmrUpgrade(
      previewHmrDeps({ connBaseUrl: null }),
      {
        sessionId: SESSION_ID,
        request: previewHmrRequest(
          `https://abc123.preview.example.com${APP_HMR}`,
          hmrPassCodec.issue(SESSION_ID, "u1"),
        ),
        path: APP_HMR,
        query: "",
      },
    );
    expect(noConn).toMatchObject({ ok: false, status: 503 });

    const noPort = await resolvePreviewWebappHmrUpgrade(
      previewHmrDeps({ nextjsPort: null }),
      {
        sessionId: SESSION_ID,
        request: previewHmrRequest(
          `https://abc123.preview.example.com${APP_HMR}`,
          hmrPassCodec.issue(SESSION_ID, "u1"),
        ),
        path: APP_HMR,
        query: "",
      },
    );
    expect(noPort).toMatchObject({ ok: false, status: 503 });
  });

  test("the config gateway URL wins over the connection baseUrl (parity with the same-origin resolver)", async () => {
    const decision = await resolvePreviewWebappHmrUpgrade(
      previewHmrDeps({ gatewayBaseUrl: "http://gateway.host:4300" }),
      {
        sessionId: SESSION_ID,
        request: previewHmrRequest(
          `https://abc123.preview.example.com${APP_HMR}`,
          hmrPassCodec.issue(SESSION_ID, "u1"),
        ),
        path: APP_HMR,
        query: "",
      },
    );
    expect(decision).toEqual({
      ok: true,
      upstreamUrl: `ws://gateway.host:3011${APP_HMR}`,
    });
  });
});

// ── #363: the upgrade behind a boot-file-shaped preview dispatcher ───────────
//
// The boot file's serve() cannot be imported by tests (binding a port is what it
// does), so this wires a real listener with EXACTLY the branch the dispatcher
// adds in #363 — preview-origin gate first, then the HMR upgrade sub-branch —
// over a real upstream socket server, the same pattern the same-origin bridge
// tests above rest on. If the seam contract between the pieces drifts, this
// fails before the boot file ever ships it.

describe("the preview upgrade behind a boot-file-shaped dispatcher (#363)", () => {
  function servePreviewStub(): ServePreview {
    return async ({ appPath, query }) =>
      new Response(`unproxied ${appPath}${query}`, { status: 503 });
  }

  async function withPreviewFront(
    run: (input: {
      port: number;
      label: string;
      upstreamPaths: string[];
      upgradeAttempts: () => number;
    }) => Promise<void>,
  ) {
    const upstreamPaths: string[] = [];
    let upgradeAttempts = 0;
    const upstream = Bun.serve({
      port: 0,
      fetch(req, server) {
        upstreamPaths.push(new URL(req.url).pathname);
        if (server.upgrade(req)) return undefined;
        return new Response("nope", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          ws.send(String(raw)); // echo: upstream → client frames flow too
        },
      },
    });
    let origin: ReturnType<typeof createPreviewOrigin> | undefined;
    const hmrDepsForFront = () =>
      // The reserved port is the upstream listener's own — the session row names
      // the port the bridge dials (the connection baseUrl only names the host).
      previewHmrDeps({
        connBaseUrl: `http://127.0.0.1:${upstream.port}`,
        nextjsPort: upstream.port,
      });
    const front = Bun.serve<WebappHmrSocketData>({
      port: 0,
      async fetch(req, server) {
        const url = new URL(req.url);
        // ── the boot file's preview branch, verbatim in shape (#363) ──────────
        if (origin?.handlesRequest(req)) {
          const resolved = origin.resolvePreviewRequest(req);
          if ("sessionId" in resolved) {
            if (
              req.headers.get("upgrade")?.toLowerCase() === "websocket" &&
              webappHmrIsAppPath(origin.appPathFor(req))
            ) {
              const decision = await resolvePreviewWebappHmrUpgrade(
                hmrDepsForFront(),
                {
                  sessionId: resolved.sessionId,
                  request: req,
                  path: origin.appPathFor(req),
                  query: url.search,
                },
              );
              if (!decision.ok) {
                return new Response(decision.error, {
                  status: decision.status,
                });
              }
              upgradeAttempts += 1;
              if (
                server.upgrade(req, {
                  data: { upstream: decision.upstreamUrl, hmr: true as const },
                })
              ) {
                return undefined as unknown as Response;
              }
              return new Response("Expected a WebSocket upgrade.", {
                status: 400,
              });
            }
            return origin.handlePreviewRequest(resolved.sessionId, req);
          }
          return Response.json(
            { error: resolved.refuse.reason },
            { status: resolved.refuse.status },
          );
        }
        return new Response("main-site", { status: 200 });
      },
      websocket: webappHmrSocketHandlers,
    });
    // The dev-form origin must claim the listener's own port — built after the
    // listener exists, exactly like a deployment whose PORT names its listener.
    origin = createPreviewOrigin({
      config: {
        enabled: true,
        webappProxyEnabled: true,
        previewOriginEnabled: true,
        previewOriginTemplate: "",
      },
      previewTickets: createPreviewTickets({
        store: {
          async findSession() {
            return undefined;
          },
        } as unknown as ConstructorParameters<
          typeof createPreviewTickets
        >[0]["store"],
      }),
      secret: HMR_PASS_SECRET,
      env: { PORT: String(front.port) },
      servePreview: servePreviewStub(),
    });
    const address = origin.originFor(SESSION_ID);
    const label = new URL(address).pathname.replace(/^\//, "");
    try {
      await run({
        port: front.port,
        label,
        upstreamPaths,
        upgradeAttempts: () => upgradeAttempts,
      });
    } finally {
      front.stop(true);
      upstream.stop(true);
    }
  }

  test("dev form: the pass opens the socket, frames flow both ways, the label rides to the upstream mount", async () => {
    await withPreviewFront(async ({ port, label, upstreamPaths }) => {
      const client = new WebSocket(
        `ws://127.0.0.1:${port}/${label}/_next/webpack-hmr?id=1`,
        {
          headers: {
            cookie: `${PREVIEW_SESSION_COOKIE}=${hmrPassCodec.issue(SESSION_ID, "u1")}`,
          },
        } as never,
      );
      const received: string[] = [];
      await new Promise<void>((resolve, reject) => {
        client.onopen = () => resolve();
        client.onerror = () => reject(new Error("upgrade was refused"));
        setTimeout(() => reject(new Error("connect timeout")), 5000);
      });
      client.onmessage = (event) => received.push(String(event.data));
      client.send("ping");
      for (let i = 0; i < 50 && received.length === 0; i++) {
        await Bun.sleep(20);
      }
      expect(received).toEqual(["ping"]);
      client.close();
      // The upstream the bridge dialed carried the full path: the dev form's
      // label included (the dev server's basePath mount), exactly like the
      // HTTP seam's appPath (F-2/#365).
      expect(upstreamPaths).toEqual([`/${label}/_next/webpack-hmr`]);
    });
  });

  test("#358 repair Review Focus 1: a forged plaintext session-id cookie never commits an upgrade", async () => {
    await withPreviewFront(async ({ port, label, upgradeAttempts }) => {
      const client = new WebSocket(
        `ws://127.0.0.1:${port}/${label}/_next/webpack-hmr`,
        {
          headers: { cookie: `${PREVIEW_SESSION_COOKIE}=${SESSION_ID}` },
        } as never,
      );
      await new Promise<void>((resolve) => {
        // Either the handshake errors or it times out — a forgery must never
        // see onopen.
        client.onerror = () => resolve();
        setTimeout(() => resolve(), 2500);
        client.onopen = () => {
          client.close();
          resolve();
        };
      });
      // The commitment counter is the proof: zero upgrades behind a forged
      // cookie, whatever the socket surfaced.
      expect(upgradeAttempts()).toBe(0);
    });
  });

  test("a passless upgrade is an HTTP 401 answered BEFORE the socket commits", async () => {
    await withPreviewFront(async ({ port, label }) => {
      const response = await fetch(
        `http://127.0.0.1:${port}/${label}/_next/webpack-hmr`,
        {
          headers: {
            upgrade: "websocket",
            connection: "Upgrade",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            "sec-websocket-version": "13",
          },
        },
      );
      expect(response.status).toBe(401);
      expect(await response.text()).toContain("preview pass");
    });
  });

  test("a non-HMR path on the preview host still lands on the HTTP entry — the gate is not a swallow-all", async () => {
    await withPreviewFront(async ({ port, label }) => {
      const response = await fetch(
        `http://127.0.0.1:${port}/${label}/some/app/path?q=1`,
        {
          headers: {
            cookie: `${PREVIEW_SESSION_COOKIE}=${hmrPassCodec.issue(SESSION_ID, "u1")}`,
          },
        },
      );
      expect(response.status).toBe(503);
      // The appPath the HTTP entry receives carries the label (F-2: the dev
      // server is mounted at /<label>, so that IS the upstream-resolvable path).
      expect(await response.text()).toBe(
        `unproxied /${label}/some/app/path?q=1`,
      );
    });
  });
});

// ── the socket bridge: real sockets both ways, real close propagation ──────────

describe("webappHmrSocketHandlers — the client↔upstream bridge", () => {
  /**
   * A real front server wired exactly the way the boot file wires it (upgrade with
   * WebappHmrSocketData, the shared handlers), in front of a real upstream socket server
   * that echoes text and closes on demand.
   */
  async function withBridge(
    run: (input: { port: number; upstream: URL }) => Promise<void>,
    upstreamBehavior?: "echo-and-close",
  ) {
    const upstream = Bun.serve<{ echo: boolean }>({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req, { data: { echo: true } })) return undefined;
        return new Response("nope", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          ws.send(String(raw));
          if (upstreamBehavior === "echo-and-close" && String(raw) === "die") {
            ws.close(1000, "upstream done");
          }
        },
      },
    });
    const front = Bun.serve<WebappHmrSocketData>({
      port: 0,
      fetch(req, server) {
        const url = new URL(req.url);
        // The front server is handed the upstream the way index.ts's dispatcher resolves it.
        const target = `ws://127.0.0.1:${upstream.port}/_next/webpack-hmr${url.search}`;
        if (server.upgrade(req, { data: { upstream: target, hmr: true } })) {
          return undefined;
        }
        return new Response("nope", { status: 400 });
      },
      websocket: webappHmrSocketHandlers,
    });
    try {
      await run({
        port: front.port,
        upstream: new URL(`ws://127.0.0.1:${upstream.port}`),
      });
    } finally {
      front.stop(true);
      upstream.stop(true);
    }
  }

  test("frames forward in both directions, unbuffered and unaltered", async () => {
    await withBridge(async ({ port }) => {
      const client = new WebSocket(`ws://127.0.0.1:${port}/hmr?id=1`);
      const received: string[] = [];
      const opened = new Promise<void>((resolve, reject) => {
        client.onopen = () => resolve();
        client.onerror = () => reject(new Error("client failed to connect"));
      });
      client.onmessage = (event) => received.push(String(event.data));
      await opened;

      // Client → upstream → back.
      client.send("hello hmr");
      await Bun.sleep(100);
      expect(received).toEqual(["hello hmr"]);
      client.close();
    });
  });

  test("an upstream close ends the client socket", async () => {
    await withBridge(async ({ port }) => {
      const client = new WebSocket(`ws://127.0.0.1:${port}/hmr?id=1`);
      const opened = new Promise<void>((resolve, reject) => {
        client.onopen = () => resolve();
        client.onerror = () => reject(new Error("client failed to connect"));
      });
      const closed = new Promise<number>((resolve) => {
        client.onclose = (event) => resolve(event.code);
      });
      await opened;
      client.send("die");
      const code = await closed;
      expect(code).toBe(1000);
    }, "echo-and-close");
  });

  test("a client close closes the upstream socket", async () => {
    let upstreamClosed = false;
    const upstream = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response("nope", { status: 400 });
      },
      websocket: {
        open() {},
        message() {},
        close() {
          upstreamClosed = true;
        },
      },
    });
    const front = Bun.serve<WebappHmrSocketData>({
      port: 0,
      fetch(req, server) {
        const target = `ws://127.0.0.1:${upstream.port}/_next/webpack-hmr`;
        if (server.upgrade(req, { data: { upstream: target, hmr: true } })) {
          return undefined;
        }
        return new Response("nope", { status: 400 });
      },
      websocket: webappHmrSocketHandlers,
    });
    try {
      const client = new WebSocket(`ws://127.0.0.1:${front.port}/hmr`);
      await new Promise<void>((resolve, reject) => {
        client.onopen = () => resolve();
        client.onerror = () => reject(new Error("client failed to connect"));
      });
      client.close();
      // The bridge's close handler runs synchronously on the client close; give the
      // inward close a tick to land on the upstream server.
      for (let i = 0; i < 50 && !upstreamClosed; i++) await Bun.sleep(20);
      expect(upstreamClosed).toBe(true);
    } finally {
      front.stop(true);
      upstream.stop(true);
    }
  });

  test("an unreachable upstream fails the client socket instead of hanging it", async () => {
    const front = Bun.serve<WebappHmrSocketData>({
      port: 0,
      fetch(req, server) {
        // Nothing listens on this port — the inward dial must error and close the client.
        if (
          server.upgrade(req, {
            data: { upstream: "ws://127.0.0.1:1/_next/webpack-hmr", hmr: true },
          })
        ) {
          return undefined;
        }
        return new Response("nope", { status: 400 });
      },
      websocket: webappHmrSocketHandlers,
    });
    try {
      const client = new WebSocket(`ws://127.0.0.1:${front.port}/hmr`);
      const closed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("client socket was left hanging")),
          5000,
        );
        client.onclose = () => {
          clearTimeout(timer);
          resolve();
        };
        client.onerror = () => {
          /* the close that follows is the assertion */
        };
      });
      await closed;
    } finally {
      front.stop(true);
    }
  });
});

// ── fix-ocr18 #3: the preview origin's HMR half must not share the main site's gate ──
// src/index.ts gates `craftWebappHmrDeps` on `enabled && webappProxyEnabled`, but
// the preview origin's HTTP half lives on `enabled` alone — so with
// `enabled && !webappProxyEnabled` the preview origin serves HTTP while its HMR
// upgrade check short-circuits on the undefined deps and falls through to
// handlePreviewRequest, which forwards the upgrade as an ORDINARY HTTP request
// (upgrade headers stripped): live reload dies silently on a deployment whose
// only webapp surface IS the preview origin. The boot file must build the
// preview branch its own deps, gated on `enabled` ONLY; the main-site path
// keeps the conjunction (its half is the same gate the HTTP webapp proxy
// answers to). The boot file is not importable (it starts a listener), so the
// wiring is pinned at the source level — the same shape the qa-batch1 pins use.
describe("the boot file's preview HMR wiring (fix-ocr18 #3 — source pin)", () => {
  const source = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");

  test("the preview-origin branch dispatches upgrades through its OWN deps const", () => {
    // The preview branch (inside `craftPreviewOrigin?.handlesRequest`) must
    // gate on the preview-specific deps, not the main-site's.
    expect(source).toMatch(/craftPreviewWebappHmrDeps !== undefined/);
    // …and the preview branch must no longer consult the main-site deps.
    const previewBranch = source.slice(
      source.indexOf("craftPreviewOrigin?.handlesRequest"),
      source.indexOf('url.pathname === "/api/audio/transcriptions"'),
    );
    expect(previewBranch).toContain("craftPreviewWebappHmrDeps !== undefined");
    expect(previewBranch).not.toContain("craftWebappHmrDeps !== undefined");
  });

  test("the preview deps are gated on craft being enabled — NOT on webappProxyEnabled", () => {
    // The whole point: the preview origin's HTTP half lives on `enabled`
    // alone, so its upgrade half must too — or the combination above dies.
    // (#358 repair adds the fix-ocr20 #1 narrowing conjunct — the deps exist
    // exactly when the origin they borrow verifyPass from exists — but the
    // gate must still not widen to webappProxyEnabled.)
    const declaration = source.match(
      /const craftPreviewWebappHmrDeps =[\S\s]*?:\s*undefined;/,
    );
    expect(declaration).not.toBeNull();
    expect(declaration?.[0]).toContain("craftEffectiveConfig.enabled");
    expect(declaration?.[0]).toContain("craftPreviewOrigin !== undefined");
    expect(declaration?.[0]).not.toContain("webappProxyEnabled");
  });

  test("the main-site HMR path keeps its enabled && webappProxyEnabled gate", () => {
    // The conjunction is CORRECT for the main site (its half is the same
    // gate the HTTP webapp proxy answers to) — the fix must not widen it.
    const mainGate = source.match(
      /const craftWebappHmrDeps =\s*\n\s*craftEffectiveConfig\.enabled && craftEffectiveConfig\.webappProxyEnabled/,
    );
    expect(mainGate).not.toBeNull();
  });
});

// ── fix-ocr28 #1 (round28 CSWSH): the preview HMR upgrade's Origin gate ───────
//
// The preview pass cookie is SameSite=None, and a WebSocket handshake is NOT
// subject to CORS: a malicious page could `new WebSocket("wss://<preview-host>/
// _next/webpack-hmr")` and the pass cookie would ride the cross-site handshake,
// handing it the live HMR channel (source frames in, protocol messages out).
// The upgrade must therefore check Origin by hand — the same manual-discipline
// shape the rest of this surface applies. The judgment is a pure function in
// preview-origin.ts (beside holdsPreviewSessionPass, its sibling gate), and
// the boot file wires it INSIDE the preview HMR branch, before the upgrade
// resolver — pinned at source level like every other index.ts wiring above.
describe("the preview HMR upgrade's Origin gate (fix-ocr28 #1 — CSWSH)", () => {
  const origin = createPreviewOrigin({
    config: {
      enabled: true,
      webappProxyEnabled: true,
      previewOriginEnabled: true,
      previewOriginTemplate: "",
    },
    previewTickets: createPreviewTickets({ store: {} as never }),
    secret: "same-origin-suite-secret",
    env: { PORT: "3221" },
    servePreview: async () => new Response("unused"),
  });
  const address = origin.originFor(SESSION_ID); // registers the label

  test("no Origin header (a non-browser client) is waved through — existing behavior unchanged", () => {
    expect(samePreviewOrigin(null, address)).toBe(true);
  });

  test("the session's own origin passes — including the dev form, where originFor carries the /<label> path an Origin header never spells", () => {
    // originFor answers the ADDRESS (path included in the dev form); a
    // browser's Origin header is scheme://host[:port] only. The comparison
    // must normalize both sides through new URL(x).origin or every
    // legitimate dev-form browser upgrade would be refused.
    expect(address).toBe(
      `http://127.0.0.1:3221/${new URL(address).pathname.slice(1)}`,
    );
    expect(samePreviewOrigin("http://127.0.0.1:3221", address)).toBe(true);
    // The exact originFor string passes too (host form: it IS an origin).
    expect(samePreviewOrigin(address, address)).toBe(true);
  });

  test('any other origin is refused — cross-site pages, port neighbors, and the opaque "null" origin', () => {
    expect(samePreviewOrigin("https://evil.example", address)).toBe(false);
    // A port neighbor on the same host is a different origin — and the
    // main site's own origin (the panel's page) is NOT the preview origin.
    expect(samePreviewOrigin("http://127.0.0.1:3220", address)).toBe(false);
    // A suffix host is not the same host.
    expect(
      samePreviewOrigin("http://127.0.0.1:3221.evil.example", address),
    ).toBe(false);
    // Opaque origins (sandboxed frames serialize "null") parse-fail and
    // must refuse, never throw.
    expect(samePreviewOrigin("null", address)).toBe(false);
  });

  test("the host form's address compares as a plain origin (port normalization is a no-op there)", () => {
    const hostForm = createPreviewOrigin({
      config: {
        enabled: true,
        webappProxyEnabled: true,
        previewOriginEnabled: true,
        previewOriginTemplate: "https://{session}.preview.example.com",
      },
      previewTickets: createPreviewTickets({ store: {} as never }),
      secret: "same-origin-suite-secret",
      env: {},
      servePreview: async () => new Response("unused"),
    });
    const hostAddress = hostForm.originFor(SESSION_ID);
    expect(samePreviewOrigin(hostAddress, hostAddress)).toBe(true);
    expect(samePreviewOrigin("https://evil.example", hostAddress)).toBe(false);
    // A would-be sibling label is a DIFFERENT origin: subdomain enumeration
    // through the HMR channel stops here.
    expect(
      samePreviewOrigin("https://deadbeef.preview.example.com", hostAddress),
    ).toBe(false);
  });

  test("a trailing-dot FQDN Origin of the session's own host passes — the dotted page IS this host (fix-ocr29 #1)", () => {
    // WHATWG KEEPS a hostname's trailing dot when serializing an origin: a
    // page loaded from the dotted FQDN form (`https://<label>.<base>.`)
    // sends an Origin header THAT CARRIES THE DOT, while originFor mints
    // from the template — which refuses a trailing dot, so its address
    // never has one. The strict `new URL(x).origin` comparison therefore
    // 403s a legitimate page's HMR upgrade and live reload silently dies.
    // Every host-side comparison in this module (handlesRequest,
    // resolvePreviewRequest, the ticket binding) dot-folds through
    // normalizeHostname (fix-ocr22); the origin gate folds the same way.
    const hostForm = createPreviewOrigin({
      config: {
        enabled: true,
        webappProxyEnabled: true,
        previewOriginEnabled: true,
        previewOriginTemplate: "https://{session}.preview.example.com",
      },
      previewTickets: createPreviewTickets({ store: {} as never }),
      secret: "same-origin-suite-secret",
      env: {},
      servePreview: async () => new Response("unused"),
    });
    const hostAddress = hostForm.originFor(SESSION_ID);
    // The dotted spelling of the session's own host is the SAME host to
    // DNS and to certificates — the gate must admit it.
    expect(samePreviewOrigin(`${hostAddress}.`, hostAddress)).toBe(true);
    // The fold is host-scoped, not dot-blind: a sibling label in the
    // dotted form is still a different host and still refused.
    expect(
      samePreviewOrigin("https://deadbeef.preview.example.com.", hostAddress),
    ).toBe(false);
  });

  test("the boot file gates the upgrade on Origin inside the preview HMR branch, BEFORE the resolver (source pin)", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/index.ts"),
      "utf8",
    );
    const branch = source.slice(
      source.indexOf("craftPreviewOrigin?.handlesRequest"),
      source.indexOf('url.pathname === "/api/audio/transcriptions"'),
    );
    // The gate reads the Origin header and consults the session's own
    // origin, and its 403 lands before the resolver can commit anything.
    expect(branch).toContain('request.headers.get("origin")');
    expect(branch).toContain("samePreviewOrigin");
    expect(branch.indexOf("samePreviewOrigin")).toBeLessThan(
      branch.indexOf("resolvePreviewWebappHmrUpgrade("),
    );
    expect(branch).toContain("Cross-origin WebSocket upgrades are refused.");
  });
});
