// #360 — the preview-ticket auth primitive (spec: craft-preview-origin D4/D9).
//
// Cross-host previews lose the platform session cookie by design (F2/D1), so the
// main-site cookie exchanges for a short-lived, single-use ticket bound to the
// triple (userId, sessionId, previewHost); redeeming it on the preview origin
// yields the issuing userId and plants the preview domain's own session cookie.
//
// D9 locks the shape: TTL 30s, single use, no idle invalidation, and a
// session-level HttpOnly cookie (no Max-Age/Expires) on redeem. The clock is
// injectable throughout — expiry is tested by advancing a fake clock, never by
// sleeping.

import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { loadCraftConfig } from "../src/craft/config";
import {
  createPreviewTickets,
  defaultPreviewOrigin,
  PREVIEW_SESSION_COOKIE,
  PREVIEW_TICKET_TTL_MS,
  previewSessionCookieHeader,
  type PreviewTickets,
} from "../src/craft/preview-ticket";
import type { CraftStore } from "../src/craft/store";
import { createWebappProxyRoutes } from "../src/craft/webapp-proxy";

const SESSION_ID = "cs-444455556666";
const USER_ID = "u1";
const PREVIEW_HOST = "127.0.0.1:3010";

/** A steppable clock — the expiry paths advance it instead of sleeping. */
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
 * The minimal store seam redemption re-checks: the session row by (id, owner).
 * Flipping `owner` or nulling the row simulates deletion / owner change AFTER
 * issue — the in-memory ticket root alone must never suffice.
 */
function fakeStore(ownerUserId: string | null = USER_ID) {
  const state = { owner: ownerUserId };
  const owned = (sessionId: string, userId: string) =>
    sessionId === SESSION_ID && state.owner === userId
      ? { id: SESSION_ID, userId: state.owner }
      : undefined;
  const store = {
    // The issuing route's ownership judgment (resolve(): getSession).
    async getSession(sessionId: string, userId: string) {
      return owned(sessionId, userId);
    },
    // The bump-free ownership lookup redemption re-checks with (store.ts: the
    // reads that must not feed the idle clock).
    async findSession(sessionId: string, userId: string) {
      return owned(sessionId, userId);
    },
  } as unknown as CraftStore;
  return { store, state };
}

function ticketsWith(
  store: CraftStore,
  clock: ReturnType<typeof fakeClock>,
) {
  return createPreviewTickets({ store, now: clock.now });
}

const boundIssue = (tickets: ReturnType<typeof ticketsWith>) =>
  tickets.issuePreviewTicket({
    sessionId: SESSION_ID,
    userId: USER_ID,
    previewHost: PREVIEW_HOST,
  });

// ── the service: issue → redeem ───────────────────────────────────────────────

describe("issuePreviewTicket / redeemPreviewTicket", () => {
  test("round-trips the issuing userId for the bound triple", async () => {
    const clock = fakeClock();
    const { store } = fakeStore();
    const tickets = ticketsWith(store, clock);

    const issued = boundIssue(tickets);
    expect(typeof issued.ticket).toBe("string");
    expect(issued.expiresAt.getTime()).toBe(
      clock.now().getTime() + PREVIEW_TICKET_TTL_MS,
    );

    expect(
      await tickets.redeemPreviewTicket({
        ticket: issued.ticket,
        sessionId: SESSION_ID,
        previewHost: PREVIEW_HOST,
      }),
    ).toEqual({ userId: USER_ID });
  });

  test("issues distinct, unguessable tickets (32 random bytes)", () => {
    const clock = fakeClock();
    const { store } = fakeStore();
    const tickets = ticketsWith(store, clock);
    const first = boundIssue(tickets);
    const second = boundIssue(tickets);
    expect(first.ticket).not.toBe(second.ticket);
    // base64url of 32 bytes ≈ 43 chars; never a short guessable string.
    expect(first.ticket.length).toBeGreaterThanOrEqual(32);
  });

  // ── single use (D9) ────────────────────────────────────────────────────────
  test("a redeemed ticket is dead: replay is refused as unknown", async () => {
    const clock = fakeClock();
    const { store } = fakeStore();
    const tickets = ticketsWith(store, clock);
    const issued = boundIssue(tickets);

    expect(
      await tickets.redeemPreviewTicket({
        ticket: issued.ticket,
        sessionId: SESSION_ID,
        previewHost: PREVIEW_HOST,
      }),
    ).toEqual({ userId: USER_ID });
    expect(
      await tickets.redeemPreviewTicket({
        ticket: issued.ticket,
        sessionId: SESSION_ID,
        previewHost: PREVIEW_HOST,
      }),
    ).toEqual({ reason: "unknown" });
  });

  test("a mismatched triple consumes the ticket too — probing with another session or host burns it", async () => {
    const clock = fakeClock();
    const { store } = fakeStore();
    const tickets = ticketsWith(store, clock);
    const issued = boundIssue(tickets);

    // Wrong session: refused…
    expect(
      await tickets.redeemPreviewTicket({
        ticket: issued.ticket,
        sessionId: "cs-someone-else",
        previewHost: PREVIEW_HOST,
      }),
    ).toEqual({ reason: "mismatch" });
    // …and the ticket is gone, so the RIGHT triple no longer works either.
    expect(
      await tickets.redeemPreviewTicket({
        ticket: issued.ticket,
        sessionId: SESSION_ID,
        previewHost: PREVIEW_HOST,
      }),
    ).toEqual({ reason: "unknown" });
  });

  // ── the triple's host element ──────────────────────────────────────────────
  test("a ticket redeemed against a different preview host is refused (triple: host)", async () => {
    const clock = fakeClock();
    const { store } = fakeStore();
    const tickets = ticketsWith(store, clock);
    const issued = boundIssue(tickets);
    expect(
      await tickets.redeemPreviewTicket({
        ticket: issued.ticket,
        sessionId: SESSION_ID,
        previewHost: "evil.example:443",
      }),
    ).toEqual({ reason: "mismatch" });
  });

  // ── TTL (D9: 30s window, clock-advanced — never sleep) ─────────────────────
  test("a ticket survives anywhere inside the 30s window and dies at exactly 30s", async () => {
    const clock = fakeClock();
    const { store } = fakeStore();
    const tickets = ticketsWith(store, clock);

    // Half the window elapsed with NO redemption activity in between — D9 has
    // no idle rule, so passage of time alone inside the window changes nothing.
    const mid = boundIssue(tickets);
    clock.advance(PREVIEW_TICKET_TTL_MS / 2);
    expect(
      await tickets.redeemPreviewTicket({
        ticket: mid.ticket,
        sessionId: SESSION_ID,
        previewHost: PREVIEW_HOST,
      }),
    ).toEqual({ userId: USER_ID });

    // The last instant inside the window still redeems…
    const late = boundIssue(tickets);
    clock.advance(PREVIEW_TICKET_TTL_MS - 1);
    expect(
      await tickets.redeemPreviewTicket({
        ticket: late.ticket,
        sessionId: SESSION_ID,
        previewHost: PREVIEW_HOST,
      }),
    ).toEqual({ userId: USER_ID });

    // …and the window's edge itself does not.
    const expired = boundIssue(tickets);
    clock.advance(PREVIEW_TICKET_TTL_MS);
    expect(
      await tickets.redeemPreviewTicket({
        ticket: expired.ticket,
        sessionId: SESSION_ID,
        previewHost: PREVIEW_HOST,
      }),
    ).toEqual({ reason: "expired" });
  });

  // ── the store re-check: deletion / owner change voids unredeemed tickets ────
  test("a session deleted after issue is refused at redeem", async () => {
    const clock = fakeClock();
    const { store, state } = fakeStore();
    const tickets = ticketsWith(store, clock);
    const issued = boundIssue(tickets);

    state.owner = null; // the row is gone
    expect(
      await tickets.redeemPreviewTicket({
        ticket: issued.ticket,
        sessionId: SESSION_ID,
        previewHost: PREVIEW_HOST,
      }),
    ).toEqual({ reason: "session" });
  });

  test("a session reassigned to another user is refused at redeem", async () => {
    const clock = fakeClock();
    const { store, state } = fakeStore();
    const tickets = ticketsWith(store, clock);
    const issued = boundIssue(tickets);

    state.owner = "u2"; // userId changed under the ticket
    expect(
      await tickets.redeemPreviewTicket({
        ticket: issued.ticket,
        sessionId: SESSION_ID,
        previewHost: PREVIEW_HOST,
      }),
    ).toEqual({ reason: "session" });
  });

  test("an unknown ticket is refused without touching the store", async () => {
    const clock = fakeClock();
    let findCalls = 0;
    const store = {
      async findSession() {
        findCalls++;
        return { id: SESSION_ID, userId: USER_ID };
      },
    } as unknown as CraftStore;
    const tickets = ticketsWith(store, clock);

    expect(
      await tickets.redeemPreviewTicket({
        ticket: "totally-made-up",
        sessionId: SESSION_ID,
        previewHost: PREVIEW_HOST,
      }),
    ).toEqual({ reason: "unknown" });
    expect(findCalls).toBe(0);
  });

  test("expired entries are swept on issue — the TTL table does not accumulate", () => {
    const clock = fakeClock();
    const { store } = fakeStore();
    const tickets = ticketsWith(store, clock);
    for (let i = 0; i < 5; i++) boundIssue(tickets);
    clock.advance(PREVIEW_TICKET_TTL_MS * 10);
    boundIssue(tickets);
    // One live entry remains; the five expired ones were dropped at sweep time.
    expect(tickets.size()).toBe(1);
  });

  // ── no ticket value in any refusal (AC4: 错误响应不回显票据值) ───────────────
  test("every refusal is ticket-free — no echo in any failure shape", async () => {
    const clock = fakeClock();
    const { store, state } = fakeStore();
    const tickets = ticketsWith(store, clock);

    const unknown = boundIssue(tickets);
    const expired = boundIssue(tickets);
    const mismatched = boundIssue(tickets);
    const orphaned = boundIssue(tickets);

    clock.advance(PREVIEW_TICKET_TTL_MS); // expire `expired` and free others
    state.owner = null; // orphan `orphaned` from its session
    const refusals = [
      await tickets.redeemPreviewTicket({
        ticket: "no-such-ticket",
        sessionId: SESSION_ID,
        previewHost: PREVIEW_HOST,
      }),
      await tickets.redeemPreviewTicket({
        ticket: unknown.ticket,
        sessionId: "cs-wrong",
        previewHost: PREVIEW_HOST,
      }),
      await tickets.redeemPreviewTicket({
        ticket: expired.ticket,
        sessionId: SESSION_ID,
        previewHost: PREVIEW_HOST,
      }),
      await tickets.redeemPreviewTicket({
        ticket: orphaned.ticket,
        sessionId: SESSION_ID,
        previewHost: PREVIEW_HOST,
      }),
    ];
    const serialized = JSON.stringify(refusals);
    expect(serialized).not.toContain(unknown.ticket);
    expect(serialized).not.toContain(expired.ticket);
    expect(serialized).not.toContain(mismatched.ticket);
    expect(serialized).not.toContain(orphaned.ticket);
  });
});

// ── the preview-domain cookie (D9: session-level HttpOnly) ────────────────────
//
// Redeeming plants the preview origin's OWN session credential — HttpOnly, and
// deliberately WITHOUT Max-Age/Expires: their absence is what makes it a
// session cookie the browser drops at close (D9). The routing that actually
// sets this header is #361's; this is the shape that routing must not get wrong.

// ── defaultPreviewOrigin: the PORT/SERVER_PORT convergence (#362, #360 review Nit 3/4) ──
//
// config.ts's serverPort is the deployment's one port authority: PORT and
// SERVER_PORT name one number, empty means absent, a non-whole value refuses,
// and two that disagree refuse together. The #360 default silently preferred
// PORT via parseInt — '3001x' parsed to 3001, and a disagreeing SERVER_PORT was
// ignored. #362 converges the fallback on the same rules, as a refusal with a
// displayable reason (never a silent pick, never a truncated parse).

describe("defaultPreviewOrigin: PORT/SERVER_PORT semantics (serverPort convergence)", () => {
  test("agreement and the single-name forms answer the dev origin on that port", () => {
    expect(defaultPreviewOrigin({ PORT: "3001" })).toEqual({
      origin: "http://127.0.0.1:3001",
    });
    expect(defaultPreviewOrigin({ SERVER_PORT: "3002" })).toEqual({
      origin: "http://127.0.0.1:3002",
    });
    expect(defaultPreviewOrigin({ PORT: "3001", SERVER_PORT: "3001" })).toEqual({
      origin: "http://127.0.0.1:3001",
    });
    // Unset everywhere: the documented D5 default port.
    expect(defaultPreviewOrigin({})).toEqual({
      origin: "http://127.0.0.1:3001",
    });
  });

  test("fix-ocr27 #6: PORT=80 spells the origin the same way originFor does — the scheme-default port omitted", () => {
    // originFor (preview-origin.ts) drops an http :80 portSuffix because
    // WHATWG serialization presents no scheme-default port and the
    // browser-presented host must match the ticket binding (#363). The
    // hand-synced twin here still spelled `:80` unconditionally — the exact
    // twin shape fix-ocr19 #11 / fix-ocr23 #8 retired. RED: the twin
    // answered `http://127.0.0.1:80`.
    expect(defaultPreviewOrigin({ PORT: "80" })).toEqual({
      origin: "http://127.0.0.1",
    });
    expect(defaultPreviewOrigin({ SERVER_PORT: "80" })).toEqual({
      origin: "http://127.0.0.1",
    });
  });

  test("empty is absent, not zero: an empty PORT falls through to SERVER_PORT", () => {
    expect(defaultPreviewOrigin({ PORT: "", SERVER_PORT: "3002" })).toEqual({
      origin: "http://127.0.0.1:3002",
    });
    expect(defaultPreviewOrigin({ PORT: "" })).toEqual({
      origin: "http://127.0.0.1:3001",
    });
  });

  test("disagreement refuses with a reason naming both, never a silent PORT preference", () => {
    expect(defaultPreviewOrigin({ PORT: "3001", SERVER_PORT: "3002" })).toEqual({
      reason: expect.stringContaining("PORT"),
    });
    const refused = defaultPreviewOrigin({ PORT: "3001", SERVER_PORT: "3002" });
    expect("reason" in refused && refused.reason).toContain("SERVER_PORT");
  });

  test("a value that is not a whole port refuses instead of parsing to its prefix", () => {
    // "30o1" must NOT become 30 — the exact trap config.ts's caps document.
    expect(defaultPreviewOrigin({ PORT: "30o1" })).toEqual({
      reason: expect.any(String),
    });
    expect(defaultPreviewOrigin({ SERVER_PORT: "70000" })).toEqual({
      reason: expect.any(String),
    });
    expect(defaultPreviewOrigin({ PORT: "0" })).toEqual({
      reason: expect.any(String),
    });
  });
});

describe("previewSessionCookieHeader", () => {
  test("is HttpOnly, Path=/, SameSite=None; Secure, with NO Max-Age and NO Expires", () => {
    const header = previewSessionCookieHeader("some-session-credential");
    expect(header).toContain(
      `${PREVIEW_SESSION_COOKIE}=some-session-credential`,
    );
    expect(header).toContain("HttpOnly");
    // Pinned to the exact attribute boundary: a scoped Path must never pose
    // as the default root ("Path=/abc…" also substring-matches "Path=/").
    expect(header).toContain("Path=/;");
    // #365 F-1: the panel embeds the preview origin in a CROSS-SITE iframe, so
    // the redemption 302's Set-Cookie must be SameSite=None or the browser
    // refuses to store it at all; None is only honored with Secure, so the two
    // attributes arrive and are asserted together.
    expect(header).toContain("SameSite=None");
    expect(header).toContain("Secure");
    // D9: session cookie — the absence of both is what makes the browser drop
    // it at close; either one would turn it persistent.
    expect(header).not.toContain("Max-Age");
    expect(header).not.toContain("Expires");
  });

  test("scopes to a caller-given Path (R-9): /<label> for the dev form, / by default", () => {
    // The dev form's sessions all share ONE host (127.0.0.1:<port>, D5), so a
    // Path=/ pass is a single cookie-jar slot the LAST redeemer overwrites —
    // the dev form plants the pass at the session's own /<label> instead,
    // while the host form (one host per session) keeps the root. The caller
    // decides; the default must stay the root and never leak into a scoped
    // header or vice versa.
    expect(previewSessionCookieHeader("some-session-credential")).toContain(
      "Path=/;",
    );
    expect(
      previewSessionCookieHeader("some-session-credential", "/abc123def456"),
    ).toContain("Path=/abc123def456;");
    // F-1's semantics ride along the scoped path unchanged (#365: the iframe
    // is cross-site; None is the only attribute that crosses the hop, Secure
    // its escort) — and the scoping must not perturb the session-level shape.
    const scoped = previewSessionCookieHeader(
      "some-session-credential",
      "/abc123def456",
    );
    expect(scoped).toContain("HttpOnly");
    expect(scoped).toContain("SameSite=None");
    expect(scoped).toContain("Secure");
    expect(scoped).not.toContain("Max-Age");
    expect(scoped).not.toContain("Expires");
  });

  test("fix-ocr22 #3: a path outside the /<label> whitelist folds back to '/' — never an attribute injection", () => {
    // The path lands in a Set-Cookie ATTRIBUTE position verbatim; the only
    // legitimate caller shapes are "/" (host form) and the dev form's
    // /<label> (20 lowercase hex). The export API is its own last line of
    // defense: anything outside the `^/[0-9a-zA-Z._~-]{0,64}$` whitelist —
    // an injection shape like `/x; Path=/evil` above all — folds to the root
    // scope instead of ever reaching the attribute position.
    for (const hostile of [
      "/abc; Path=/evil",
      "/abc; HttpOnly; Domain=evil.com",
      "/ab!c",
      "relative",
      "",
      `/${"a".repeat(65)}`, // one past the length bound
    ]) {
      const header = previewSessionCookieHeader("cred", hostile);
      expect(header).toContain("Path=/;");
      expect(header).not.toContain("/evil");
      expect(header).not.toContain("Domain=");
      expect(header.endsWith("; Secure")).toBe(true);
    }
    // The legitimate dev-form label rides through untouched (20-char hex
    // sits inside the whitelist's alphabet and length).
    expect(
      previewSessionCookieHeader("cred", "/abcdef0123456789abcdef"),
    ).toContain("Path=/abcdef0123456789abcdef;");
  });

  test("fix-ocr23 #6: a value outside the [A-Za-z0-9_-] whitelist folds to empty — never a value-side attribute injection", () => {
    // The value sits in the NAME=VALUE position of the Set-Cookie header, the
    // same attribute-bearing position the path guards (fix-ocr22 #3, its
    // dual): a `;` or `,` in the value can rewrite Path/Secure/etc. just as a
    // hostile path can. The export API is its own last line of defense: a
    // value outside the `[A-Za-z0-9_-]{1,128}` whitelist folds to EMPTY —
    // fail-safe, because an empty pass can never equal a session id, so the
    // preview gate refuses with 401 forever after.
    for (const hostile of [
      "abc; x=1",
      "abc, sid=1",
      "abc Path=/evil",
      "abc\nSet-Cookie: x=1",
      `${"a".repeat(129)}`, // one past the length bound
      "",
    ]) {
      const header = previewSessionCookieHeader(
        hostile,
        "/abcdef0123456789abcdef",
      );
      expect(header).toContain(`${PREVIEW_SESSION_COOKIE}=;`);
      expect(header).not.toContain("x=1");
      expect(header).not.toContain("sid=1");
      expect(header).not.toContain("/evil");
      expect(header.endsWith("; Secure")).toBe(true);
    }
    // The real credential shape rides through: the caller passes the store's
    // session id (cs-… — `-` is inside the whitelist's alphabet).
    const ok = previewSessionCookieHeader("cs-444455556666");
    expect(ok).toContain(`${PREVIEW_SESSION_COOKIE}=cs-444455556666;`);
    expect(ok).toContain("Path=/;");
  });
});

// ── POST /sessions/:id/preview-ticket — the issuing route ─────────────────────
//
// The route rides the webapp proxy's own requireUser: the main-site session
// cookie is the ONLY way in (401 without it), and the refusals reuse the
// surface's established shapes — 404 for a session that is not the actor's,
// 503 when the sandbox behind the session is unavailable.

function signedInAs(
  userId: string,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id: userId,
      email: `${userId}@example.com`,
      role: "user",
    });
    await next();
  };
}

const refusedSignIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
) => context.json({ error: "Authentication required." }, 401);

function ticketRoutes(options: {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  store: CraftStore;
  previewTickets?: PreviewTickets;
  previewOriginFor?: (sessionId: string) => string;
  botIdFor?: (sessionId: string) => Promise<string | null>;
  sandboxConnectionFor?: (
    botId: string,
  ) => { baseUrl: string; token: string | null } | null;
}) {
  return createWebappProxyRoutes(options.requireUser, {
    config: loadCraftConfig({}),
    store: options.store,
    // fix-ocr24 #5: the mint now reads the webapp generation (the D10 gate).
    // This harness's workspace answers current — readWebappGeneration probes
    // the app body first and an absent one (readFile → null) is "current" —
    // so these tests keep exercising the ticket semantics, not the gate
    // (the gate's own coverage lives in craft-webapp-proxy.test.ts).
    gateway: {
      fileApiFor: () => ({ readFile: async () => null }),
    } as never,
    botIdFor: options.botIdFor ?? (async () => "craft-bot"),
    sandboxConnectionFor:
      options.sandboxConnectionFor ??
      (() => ({ baseUrl: "http://sbox.internal:4300", token: null })),
    previewTickets: options.previewTickets,
    previewOriginFor: options.previewOriginFor,
  });
}

describe("POST /sessions/:id/preview-ticket (issuing route)", () => {
  test("answers { ticket, expiresAt, origin } for the session's owner, redeemable on the bound host", async () => {
    const clock = fakeClock();
    const { store } = fakeStore();
    const previewTickets = createPreviewTickets({ store, now: clock.now });
    const app = ticketRoutes({
      requireUser: signedInAs(USER_ID),
      store,
      previewTickets,
      previewOriginFor: () => `http://${PREVIEW_HOST}`,
    });

    const response = await app.request(
      `/sessions/${SESSION_ID}/preview-ticket`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ticket: string;
      expiresAt: string;
      origin: string;
    };
    expect(body.ticket.length).toBeGreaterThanOrEqual(32);
    expect(body.origin).toBe(`http://${PREVIEW_HOST}`);
    // The countdown is the injected clock's — exact, not wall-clock-loose.
    expect(body.expiresAt).toBe(
      new Date(clock.now().getTime() + PREVIEW_TICKET_TTL_MS).toISOString(),
    );
    // The route-minted ticket binds the origin's host, so redemption on the
    // preview origin (presented with that host) succeeds.
    expect(
      await previewTickets.redeemPreviewTicket({
        ticket: body.ticket,
        sessionId: SESSION_ID,
        previewHost: PREVIEW_HOST,
      }),
    ).toEqual({ userId: USER_ID });
  });

  test("no main-site session cookie → 401, no ticket minted", async () => {
    const clock = fakeClock();
    const { store } = fakeStore();
    const previewTickets = createPreviewTickets({ store, now: clock.now });
    const app = ticketRoutes({
      requireUser: refusedSignIn,
      store,
      previewTickets,
    });

    const response = await app.request(
      `/sessions/${SESSION_ID}/preview-ticket`,
      { method: "POST" },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Authentication required.",
    });
    expect(previewTickets.size()).toBe(0);
  });

  test("another user's session, or an unknown one → 404 Session not found", async () => {
    const { store } = fakeStore();
    const app = ticketRoutes({ requireUser: signedInAs("u2"), store });

    const response = await app.request(
      `/sessions/${SESSION_ID}/preview-ticket`,
      { method: "POST" },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });

    const unknown = await ticketRoutes({
      requireUser: signedInAs(USER_ID),
      store,
    }).request(`/sessions/never-heard-of/preview-ticket`, { method: "POST" });
    expect(unknown.status).toBe(404);
  });

  test("no sandbox behind the session → 503, the surface's unavailable shape, no ticket minted", async () => {
    const clock = fakeClock();
    const { store } = fakeStore();
    const previewTickets = createPreviewTickets({ store, now: clock.now });
    const app = ticketRoutes({
      requireUser: signedInAs(USER_ID),
      store,
      previewTickets,
      sandboxConnectionFor: () => null,
    });

    const response = await app.request(
      `/sessions/${SESSION_ID}/preview-ticket`,
      { method: "POST" },
    );
    expect(response.status).toBe(503);
    const body = await response.json();
    expect((body as { error: string }).error).toBeTruthy();
    // A refusal never carries a ticket — not even the word.
    expect(JSON.stringify(body)).not.toContain("ticket");
    expect(previewTickets.size()).toBe(0);
  });
});
